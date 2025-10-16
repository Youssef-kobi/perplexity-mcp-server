/**
 * Streamable HTTP transport using Hono, adapted for Smithery hosted deployments.
 * - Supports both "/" and "/mcp" endpoints for JSON-RPC (POST/GET/DELETE).
 * - Permissive CORS by default (when no origins configured).
 * - Preflight handling.
 * - Binds 0.0.0.0 and uses env/default port for containers.
 * - Optional auth: set MCP_AUTH_MODE=none to disable for scanner/health.
 */

import { HttpBindings, serve, ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Context, Hono, Next } from "hono";
import { cors } from "hono/cors";
import http from "http";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  logger,
  rateLimiter,
  RequestContext,
  requestContextService,
} from "../../utils/index.js";
import { jwtAuthMiddleware, oauthMiddleware } from "./auth/index.js";
import { httpErrorHandler } from "./httpErrorHandler.js";

const HTTP_PORT = config.mcpHttpPort;           // e.g. 3010
const HTTP_HOST = config.mcpHttpHost;           // e.g. "0.0.0.0"
const PATHS = ["/", "/mcp"];                    // Support scanner ("/") *and* your original ("/mcp")
const MAX_PORT_RETRIES = 15;

// In-memory session store (single-process only)
const transports: Record<string, StreamableHTTPServerTransport> = {};

async function isPortInUse(
  port: number,
  host: string,
  _parentContext: RequestContext,
): Promise<boolean> {
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE");
      })
      .once("listening", () => {
        tempServer.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

function startHttpServerWithRetry(
  app: Hono<{ Bindings: HttpBindings }>,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<ServerType> {
  const startContext = requestContextService.createRequestContext({
    ...parentContext,
    operation: "startHttpServerWithRetry",
  });

  return new Promise((resolve, reject) => {
    const tryBind = (port: number, attempt: number) => {
      if (attempt > maxRetries + 1) {
        reject(new Error("Failed to bind to any port after multiple retries."));
        return;
      }

      const attemptContext = { ...startContext, port, attempt };

      isPortInUse(port, host, attemptContext)
        .then((inUse) => {
          if (inUse) {
            logger.warning(`Port ${port} is in use, retrying...`, attemptContext);
            setTimeout(() => tryBind(port + 1, attempt + 1), 50);
            return;
          }

          try {
            const serverInstance = serve(
              { fetch: app.fetch, port, hostname: host },
              (info: { address: string; port: number }) => {
                logger.info(`HTTP transport listening`, {
                  ...attemptContext,
                  address: `http://${info.address}:${info.port}`,
                  paths: PATHS,
                });
                if (process.stdout.isTTY) {
                  console.log(
                    `\n🚀 MCP Server running at: http://${info.address}:${info.port} (paths: ${PATHS.join(", ")})\n`
                  );
                }
              },
            );
            resolve(serverInstance);
          } catch (err: unknown) {
            if (err && typeof err === "object" && "code" in err && (err as { code: string }).code !== "EADDRINUSE") {
              reject(err);
            } else {
              setTimeout(() => tryBind(port + 1, attempt + 1), 50);
            }
          }
        })
        .catch((err) => reject(err));
    };

    tryBind(initialPort, 1);
  });
}

export async function startHttpTransport(
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
): Promise<ServerType> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const transportContext = requestContextService.createRequestContext({
    ...parentContext,
    component: "HttpTransportSetup",
  });

  // --- CORS ---
  // If no origins configured, allow "*". If you specify origins, we enable credentials.
  const hasCustomOrigins = !!(config.mcpAllowedOrigins && config.mcpAllowedOrigins.length);
  app.use(
    "*",
    cors({
      origin: hasCustomOrigins ? config.mcpAllowedOrigins : "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["*", "Content-Type", "Mcp-Session-Id", "Last-Event-ID", "Authorization"],
      exposeHeaders: ["*"],
      credentials: hasCustomOrigins,  // cannot use credentials with "*"
      maxAge: 600,
    }),
  );

  // Security headers
  app.use("*", async (c: Context, next: Next) => {
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    await next();
  });

  // Health check
  app.get("/healthz", (c) => c.text("ok"));

  // Rate limit on POST/GET/DELETE for our JSON-RPC endpoints
  PATHS.forEach((p) => {
    app.use(p, async (c: Context, next: Next) => {
      const clientIp = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown_ip";
      const context = requestContextService.createRequestContext({
        operation: "httpRateLimitCheck",
        ipAddress: clientIp,
      });
      rateLimiter.check(clientIp, context); // throws on limit; caught by onError
      await next();
    });
  });

  // --- Auth (optional) ---
  // Allow disabling auth for scanner/health by setting MCP_AUTH_MODE=none
  if (config.mcpAuthMode === "oauth") {
    PATHS.forEach((p) => app.use(p, oauthMiddleware));
  } else if (config.mcpAuthMode === "jwt") {
    PATHS.forEach((p) => app.use(p, jwtAuthMiddleware));
  } // else 'none' → no auth middleware

  // Centralized error handler
  app.onError(httpErrorHandler);

  // Shared handler for POST initialize / requests
  const handlePost = async (c: Context) => {
    const postContext = requestContextService.createRequestContext({
      ...transportContext,
      operation: "handlePost",
    });

    const body = await c.req.json();
    const sessionId = c.req.header("mcp-session-id");
    let transport: StreamableHTTPServerTransport | undefined = sessionId
      ? transports[sessionId]
      : undefined;

    if (isInitializeRequest(body)) {
      if (transport) {
        logger.warning("Re-initializing existing session.", { ...postContext, sessionId });
        await transport.close();
      }

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          transports[newId] = newTransport;
          logger.info(`HTTP Session created: ${newId}`, { ...postContext, newSessionId: newId });
        },
      });

      newTransport.onclose = () => {
        const closedSessionId = newTransport.sessionId;
        if (closedSessionId && transports[closedSessionId]) {
          delete transports[closedSessionId];
          logger.info(`HTTP Session closed: ${closedSessionId}`, { ...postContext, closedSessionId });
        }
      };

      const server = await createServerInstanceFn();
      await server.connect(newTransport);
      transport = newTransport;
    } else if (!transport) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "Invalid or expired session ID.");
    }

    return await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
  };

  const handleSessionRequest = async (c: Context<{ Bindings: HttpBindings }>) => {
    const sessionId = c.req.header("mcp-session-id");
    const transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "Session not found or expired.");
    }
    return await transport.handleRequest(c.env.incoming, c.env.outgoing);
  };

  // Wire endpoints for *both* "/" and "/mcp"
  PATHS.forEach((p) => {
    app.post(p, handlePost);
    app.get(p, handleSessionRequest);
    app.delete(p, handleSessionRequest);
    app.options(p, (c) => c.text("", 204)); // explicit preflight
  });

  return startHttpServerWithRetry(app, HTTP_PORT, HTTP_HOST, MAX_PORT_RETRIES, transportContext);
}
