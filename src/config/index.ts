import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

dotenv.config();

const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) return currentDir;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find project root (package.json) starting from ${startDir}`);
    }
    currentDir = parentDir;
  }
};

let projectRoot: string;
try {
  const currentModuleDir = dirname(fileURLToPath(import.meta.url));
  projectRoot = findProjectRoot(currentModuleDir);
} catch (error: any) {
  console.error(`FATAL: Error determining project root: ${error.message}`);
  projectRoot = process.cwd();
  console.warn(`Warning: Using process.cwd() (${projectRoot}) as fallback project root.`);
}

const pkgPath = join(projectRoot, "package.json");
let pkg = { name: "perplexity-mcp-server", version: "0.0.0" };

try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
} catch (error) {
  console.error("Warning: Could not read package.json for default config values. Using hardcoded defaults.", error);
}

const defaultHttpPort = (() => {
  const raw = process.env.PORT;
  if (!raw) return 3010;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3010;
})();

const EnvSchema = z.object({
  MCP_SERVER_NAME: z.string().optional(),
  MCP_SERVER_VERSION: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  LOGS_DIR: z.string().default(path.join(projectRoot, "logs")),
  NODE_ENV: z.string().default("development"),

  // Hosted-friendly defaults:
  MCP_TRANSPORT_TYPE: z.enum(["stdio", "http"]).default("http"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(defaultHttpPort),
  PORT: z.coerce.number().int().positive().optional(),
  MCP_HTTP_HOST: z.string().default("0.0.0.0"),

  // CORS: CSV list or "*" for permissive
  MCP_ALLOWED_ORIGINS: z.string().optional(),

  // Auth: allow disabling auth for scanner/health
  MCP_AUTH_SECRET_KEY: z
    .string()
    .min(32, "MCP_AUTH_SECRET_KEY must be at least 32 characters long for security reasons.")
    .optional(),
  MCP_AUTH_MODE: z.enum(["none", "jwt", "oauth"]).default("none"),

  OAUTH_ISSUER_URL: z.string().url().optional(),
  OAUTH_JWKS_URI: z.string().url().optional(),
  OAUTH_AUDIENCE: z.string().optional(),

  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_DEFAULT_MODEL: z.string().default("sonar-reasoning-pro"),
  PERPLEXITY_DEFAULT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  PERPLEXITY_API_BASE_URL: z.string().url().default("https://api.perplexity.ai"),
  PERPLEXITY_POLLING_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  PERPLEXITY_POLLING_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
});

const parsedEnv = EnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables found:", parsedEnv.error.flatten().fieldErrors);
}

const env = parsedEnv.success ? parsedEnv.data : EnvSchema.parse({});

const effectiveHttpPort = env.MCP_HTTP_PORT ?? env.PORT ?? defaultHttpPort;

// helper: normalize allowed origins
function parseAllowedOrigins(raw?: string): string[] | undefined {
  if (!raw || raw.trim() === "" || raw.trim() === "*") {
    // undefined → our transport will treat as permissive "*"
    return undefined;
  }
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

const ensureDirectory = (dirPath: string, rootDir: string, dirName: string): string | null => {
  const resolvedDirPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(rootDir, dirPath);
  if (!resolvedDirPath.startsWith(rootDir + path.sep) && resolvedDirPath !== rootDir) {
    console.error(
      `Error: ${dirName} path "${dirPath}" resolves to "${resolvedDirPath}", which is outside the project boundary "${rootDir}".`
    );
    return null;
  }
  if (!existsSync(resolvedDirPath)) {
    try {
      mkdirSync(resolvedDirPath, { recursive: true });
    } catch (err: unknown) {
      console.error(
        `Error creating ${dirName} directory at ${resolvedDirPath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  } else {
    try {
      if (!statSync(resolvedDirPath).isDirectory()) {
        console.error(`Error: ${dirName} path ${resolvedDirPath} exists but is not a directory.`);
        return null;
      }
    } catch (statError: any) {
      console.error(`Error accessing ${dirName} path ${resolvedDirPath}: ${statError.message}`);
      return null;
    }
  }
  return resolvedDirPath;
};

let validatedLogsPath: string | null = ensureDirectory(env.LOGS_DIR, projectRoot, "logs");
if (!validatedLogsPath) {
  const defaultLogsDir = path.join(projectRoot, "logs");
  validatedLogsPath = ensureDirectory(defaultLogsDir, projectRoot, "logs");
  if (!validatedLogsPath) {
    console.warn("Warning: Default logs directory could not be created. File logging will be disabled.");
  }
}

export const config = {
  mcpServerName: env.MCP_SERVER_NAME || pkg.name,
  mcpServerVersion: env.MCP_SERVER_VERSION || pkg.version,
  logLevel: env.LOG_LEVEL,
  logsPath: validatedLogsPath,
  environment: env.NODE_ENV,

  // Transport + HTTP binding
  mcpTransportType: env.MCP_TRANSPORT_TYPE, // now defaults to "http"
  mcpHttpPort: effectiveHttpPort,           // prefer PORT/MCP_HTTP_PORT/env default
  mcpHttpHost: env.MCP_HTTP_HOST,           // now defaults to "0.0.0.0"

  // CORS list or undefined (= permissive)
  mcpAllowedOrigins: parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS),

  // Auth mode defaults to "none" for hosted scanner, can be set to "jwt" or "oauth"
  mcpAuthSecretKey: env.MCP_AUTH_SECRET_KEY,
  mcpAuthMode: env.MCP_AUTH_MODE,

  oauthIssuerUrl: env.OAUTH_ISSUER_URL,
  oauthJwksUri: env.OAUTH_JWKS_URI,
  oauthAudience: env.OAUTH_AUDIENCE,

  security: {
    authRequired: false,
  },

  perplexityApiKey: env.PERPLEXITY_API_KEY || "",
  perplexityDefaultModel: env.PERPLEXITY_DEFAULT_MODEL,
  perplexityDefaultEffort: env.PERPLEXITY_DEFAULT_EFFORT,
  perplexityApiBaseUrl: env.PERPLEXITY_API_BASE_URL,
  perplexityPollingIntervalMs: env.PERPLEXITY_POLLING_INTERVAL_MS,
  perplexityPollingTimeoutMs: env.PERPLEXITY_POLLING_TIMEOUT_MS,
};

if (!config.perplexityApiKey) {
  console.warn("PERPLEXITY_API_KEY environment variable is not set. Perplexity API calls will fail.");
}

export const logLevel = config.logLevel;
export const environment = config.environment;
