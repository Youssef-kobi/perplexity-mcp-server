# Hosted Deployment Guide

This guide walks through deploying the Perplexity MCP Server on a managed platform such as [Smithery](https://smithery.ai/). It captures the working configuration we validated while fixing the `initializeFailed` errors that can appear when the hosted HTTP transport cannot finish its startup sequence.

## Prerequisites

- Node.js 18 runtime (Smithery's TypeScript runtime targets Node 18 by default).
- A Perplexity API key with access to the Search or Deep Research endpoints.
- `MCP_TRANSPORT_TYPE` set to `http` so the server exposes an HTTP endpoint that Smithery can probe.

## 1. Build Configuration

Smithery runs `npm run build` before starting the service. The command compiles the TypeScript sources into `dist/`. Your deployment will fail if the build step reports any type errors, so always verify the build locally:

```bash
npm install
npm run build
```

If the command succeeds you should see JavaScript artifacts under `dist/`. The stock [`smithery.yaml`](../smithery.yaml) already reflects this build output:

```yaml
build:
  command: ["npm", "run", "build"]
  output: "dist"
```

## 2. Start Command

Smithery executes the `start` command from the same `smithery.yaml`. The default configuration launches the compiled server and binds to port `3010`:

```yaml
start:
  command: ["node", "dist/index.js"]
  port: 3010
```

You can adjust the port if you prefer a different value, but remember to also update the `MCP_HTTP_PORT` environment variable so the Hono server binds to the same port at runtime.

## 3. Required Environment Variables

| Variable | Purpose |
| --- | --- |
| `PERPLEXITY_API_KEY` | Authenticates outbound requests to the Perplexity API. |
| `MCP_TRANSPORT_TYPE` | Must be `http` for hosted deployments. |
| `MCP_HTTP_HOST` | Set to `0.0.0.0` so the container accepts external connections. |
| `MCP_HTTP_PORT` | Matches the port declared in `smithery.yaml` (`3010` by default). |
| `MCP_AUTH_MODE` | Leave as `none` so the Smithery scanner can call the server without a token. |

### Adding your Perplexity API key

- **Smithery hosted deployment** – Open your project on Smithery and go to **Environment**. The platform automatically lists a
  `PERPLEXITY_API_KEY` input for this project; click the field, paste your live token, and press **Save** so the variable is injected when the container boots. You do not need to commit a `.env` file for hosted runs.
- **Local development / self-hosting** – Copy `.env.example` to `.env` in the repository root and edit the file so
  `PERPLEXITY_API_KEY` contains your token. Any other environment variables defined in the file will also be loaded at startup.

Smithery's UI automatically encrypts the value, so you do not need to commit the key to version control.

### Authentication configuration

HTTP authentication is disabled by default when you deploy the stock build. This is intentional: the Smithery scanner does not
send any bearer tokens while it probes your endpoint, so forcing JWT or OAuth will cause every `initialize` request to fail with
`401 Unauthorized`. If you need to secure a self-hosted deployment, set `MCP_AUTH_MODE` to `jwt` and supply a
`MCP_AUTH_SECRET_KEY` that is at least 32 characters long. Hosted Smithery deployments should keep `MCP_AUTH_MODE=none` unless
you front the service with your own gateway that injects credentials on behalf of the client.

## 4. CORS & Smithery Scanner Compatibility

The Smithery scanner performs cross-origin preflight checks when validating your deployment. Version `1.2.1` of this project configures Hono's CORS middleware to:

- Return explicit 204 responses for `OPTIONS` preflight requests.
- Send a wildcard (`*`) origin when no custom allowlist is provided.
- Automatically enable `Access-Control-Allow-Credentials` when you define a custom origin list.

These behaviours allow the scanner to complete its `initialize` request without timing out. You generally do **not** need to modify the defaults unless you are proxying the transport behind your own gateway.

## 5. Health Check

Smithery expects a fast HTTP response during provisioning. The server exposes `GET /healthz` that returns `ok`. You can hit this endpoint manually to confirm the container is reachable.

```bash
curl https://<your-smithery-subdomain>.smithery.ai/healthz
```

## 6. Troubleshooting Tips

- **Initialize request keeps timing out** – Double-check that `npm run build` finishes successfully in your hosted build logs. Type errors prevent Smithery from publishing the `dist/` output.
- **Port already in use** – The transport automatically increments the port up to 15 times. Update `MCP_HTTP_PORT` in the environment panel so Smithery and the server agree on the initial value.
- **Non-text tool calls** – `src/utils/metrics/tokenCounter.ts` now ignores non-function tool calls instead of throwing. This is expected and keeps the build stable.

With these settings applied the Smithery "Hosted" deployment should reach the `Server is ready` state and the scanner will report a healthy MCP endpoint.
