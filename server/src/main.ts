#!/usr/bin/env node
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
  type McpHttpHandler,
  type McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";
import { assertCollectorContractRevision } from "./contract-handshake.js";
import { dnsRebindingResponse, isLoopbackBindHost } from "./http-security.js";
import { loadHostedOAuth } from "./oauth.js";
import { closeDefaultNativeExecutionRuntime } from "./native-execution.js";

export function sanitizedErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
}

function reportError(scope: string, error: unknown): void {
  console.error(
    `${scope} failed (${sanitizedErrorType(error)}); secret details omitted`,
  );
}

export interface StreamableHTTPServerConfig {
  port: number;
  bindHost: string;
  publicUrl?: URL;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

function commaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function configuredPublicUrl(environment: NodeJS.ProcessEnv): URL | undefined {
  const configured = environment.MCP_PUBLIC_URL?.trim();
  if (!configured) return undefined;

  let publicUrl: URL;
  try {
    publicUrl = new URL(configured);
  } catch {
    throw new Error("MCP_PUBLIC_URL must be an absolute URL");
  }

  if (publicUrl.protocol !== "https:") {
    throw new Error("MCP_PUBLIC_URL must use HTTPS");
  }
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error("MCP_PUBLIC_URL must not contain credentials, a query, or a fragment");
  }
  if (publicUrl.pathname !== "/") {
    throw new Error("MCP_PUBLIC_URL must be an origin without a path");
  }
  return publicUrl;
}

export function readStreamableHTTPConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StreamableHTTPServerConfig {
  const port = Number.parseInt(environment.PORT ?? "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }

  const bindHost = environment.MCP_BIND_HOST?.trim() || "127.0.0.1";
  const publicUrl = configuredPublicUrl(environment);

  if (!isLoopbackBindHost(bindHost) && publicUrl === undefined) {
    throw new Error(
      "MCP_PUBLIC_URL must be set when MCP_BIND_HOST is a non-loopback address",
    );
  }

  const additionalHosts = commaSeparated(environment.MCP_ALLOWED_HOSTS);
  const additionalOrigins = commaSeparated(environment.MCP_ALLOWED_ORIGIN_HOSTS);

  const allowedHosts =
    publicUrl !== undefined ? unique([publicUrl.hostname, ...additionalHosts]) : undefined;
  const allowedOrigins =
    publicUrl !== undefined ? unique([publicUrl.hostname, ...additionalOrigins]) : undefined;

  return {
    port,
    bindHost,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  };
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export interface HostedAuth {
  gate: (request: Request) => Promise<AuthInfo | Response>;
  metadata: AuthMetadataOptions;
}

export interface McpFetchOptions {
  handler: McpHttpHandler;
  landingPage: string;
  allowedHosts?: readonly string[] | undefined;
  allowedOrigins?: readonly string[] | undefined;
  auth?: HostedAuth | undefined;
}

function landingResponse(request: Request, html: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

function healthResponse(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();
  return Response.json({ status: "ok" });
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// A browser client cannot read the challenge that starts its OAuth flow
// without CORS. The preflight carries no credentials, so it must be answered
// before the gate; answering it there is a 401 the browser reports as a
// network failure.
const EXPOSED_HEADERS = "WWW-Authenticate";

function corsPreflightResponse(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (request.method !== "OPTIONS" || origin === null) return undefined;

  const requestedHeaders = request.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      ...(requestedHeaders === null ? {} : { "access-control-allow-headers": requestedHeaders }),
      "access-control-expose-headers": EXPOSED_HEADERS,
      "access-control-max-age": "600",
      vary: "Origin, Access-Control-Request-Headers",
    },
  });
}

function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (origin === null) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", EXPOSED_HEADERS);
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The endpoint as one web-standard function. The order is the contract: the
 * discovery documents answer before the gate, or an unauthenticated client
 * has no way to learn where its token comes from; the rebinding guards answer
 * before any route, because the handler validates no header; the gate resolves
 * to verified `AuthInfo` or to a finished challenge, and only the first of
 * those reaches the handler.
 */
export function createFetch(options: McpFetchOptions): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const discovery = options.auth === undefined
      ? undefined
      : oauthMetadataResponse(request, options.auth.metadata);
    if (discovery !== undefined) return discovery;

    const rejected = dnsRebindingResponse(
      request,
      options.allowedHosts,
      options.allowedOrigins,
    );
    if (rejected !== undefined) return rejected;

    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return healthResponse(request);
    if (pathname === "/") return landingResponse(request, options.landingPage);
    if (pathname !== "/mcp") return notFound();

    const preflight = corsPreflightResponse(request);
    if (preflight !== undefined) return preflight;

    if (options.auth === undefined) {
      return withCors(request, await options.handler.fetch(request));
    }

    const authInfo = await options.auth.gate(request);
    if (authInfo instanceof Response) return withCors(request, authInfo);
    return withCors(request, await options.handler.fetch(request, { authInfo }));
  };
}

async function hostedAuth(publicUrl: URL): Promise<HostedAuth> {
  const resourceServerUrl = new URL("/mcp", publicUrl);
  const oauth = await loadHostedOAuth(resourceServerUrl);
  return {
    gate: requireBearerAuth({
      verifier: oauth.verifier,
      requiredScopes: oauth.requiredScopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    }),
    metadata: {
      oauthMetadata: oauth.oauthMetadata,
      resourceServerUrl,
      scopesSupported: oauth.scopesSupported,
    },
  };
}

export interface ServeOptions {
  port: number;
  hostname: string;
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Revision 2026-07-28 only, on every transport: a 2025-era request is answered
 * with `-32022` UnsupportedProtocolVersion; there is no legacy serving and no session.
 */
export function createHostedHandler(
  factory: Parameters<typeof createMcpHandler>[0],
  onerror: (error: unknown) => void,
): McpHttpHandler {
  return createMcpHandler(factory, { legacy: "reject", onerror });
}

/**
 * Whether this HTTP process may persist native execution evidence.
 *
 * The evidence file is a LOCAL artifact: it records every inbound tools/call —
 * lifecycle, duration, and a redacted JSON-RPC timeline — into a single JSON
 * file under $HOME. That is exactly what an operator running the server on
 * their own machine wants, and exactly what a public deployment must not do:
 * there the callers are other people, the file would blend their requests into
 * one container-local store, nothing rotates it, and nothing ever reads it
 * back. MCP_PUBLIC_URL is the signal that this process serves somebody else, so
 * recording is armed only in its absence — the loopback default keeps it, and
 * so does --stdio, which is a local process by construction.
 */
export function recordsNativeExecutionEvidence(
  config: StreamableHTTPServerConfig,
): boolean {
  return config.publicUrl === undefined;
}

async function createHostedRuntime(
  config: StreamableHTTPServerConfig,
): Promise<ServeOptions> {
  const handler = createHostedHandler(
    () =>
      createServer({
        transport: "streamable_http",
        ...(recordsNativeExecutionEvidence(config) ? {} : { nativeExecution: false }),
      }),
    (error) => reportError("Standalone MCP request", error),
  );

  const options: McpFetchOptions = {
    handler,
    landingPage: await readFile(new URL("./mcp-home.html", import.meta.url), "utf8"),
    ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
    ...(config.allowedOrigins === undefined ? {} : { allowedOrigins: config.allowedOrigins }),
    ...(config.publicUrl === undefined ? {} : { auth: await hostedAuth(config.publicUrl) }),
  };

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handler.close()
      .then(closeDefaultNativeExecutionRuntime)
      .catch((error: unknown) => {
        reportError("Standalone MCP HTTP shutdown cleanup", error);
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const endpoint = config.publicUrl
    ? new URL("/mcp", config.publicUrl).href
    : `http://${urlHost(config.bindHost)}:${config.port}/mcp`;
  console.log(`MCP server serving ${endpoint}`);

  return { port: config.port, hostname: config.bindHost, fetch: createFetch(options) };
}

/**
 * Why `legacy: "reject"` rather than the SDK's default `"serve"`.
 *
 * serveStdio defaults to serving a 2025-era opening from a second, pinned
 * instance of the same factory, so taking the default would make stdio accept
 * old clients for free. It is deliberately not taken: this server is a closed
 * world whose whole surface — the pinned tool manifest, the startup contract
 * handshake against the collector's advertised revision, and the landing page
 * the deployment verifier gates — is stated at exactly one protocol revision,
 * 2026-07-28. `createMcpHandler` cannot serve the 2025 era for the hosted
 * endpoint without also serving a second wire format for the same tools, and a
 * server that answers "only 2026-07-28" over HTTP while quietly answering 2025
 * over stdio has two contracts and one README.
 *
 * The cost is real and accepted: a 2025-era client launching this over npx gets
 * `-32022` naming the revisions this build serves, instead of a working
 * session. That is a legible failure, and the fix is a client upgrade rather
 * than a second serving mode nothing here tests.
 */
export function startStdioServer(serverFactory: () => McpServer): StdioServerHandle {
  const handle = serveStdio(serverFactory, {
    legacy: "reject",
    onerror: (error) => reportError("Standalone MCP stdio", error),
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handle.close()
      .then(closeDefaultNativeExecutionRuntime)
      .catch((error: unknown) => {
        reportError("Standalone MCP stdio shutdown cleanup", error);
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return handle;
}

function toRealEntryHref(entryPoint: string): string {
  const resolved = resolve(entryPoint);
  try {
    return pathToFileURL(realpathSync(resolved)).href;
  } catch {
    return pathToFileURL(resolved).href;
  }
}

function isEntryPoint(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && toRealEntryHref(entryPoint) === import.meta.url;
}

async function bootstrap(): Promise<ServeOptions | undefined> {
  if (!isEntryPoint()) return undefined;

  try {
    // Before either transport accepts a connection: a server that answers tool
    // calls against a contract the collector does not serve is worse than one
    // that refuses to start.
    await assertCollectorContractRevision();

    if (process.argv.includes("--stdio")) {
      startStdioServer(() => createServer({ transport: "stdio" }));
      return undefined;
    }

    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
      console.error(
        "The HTTP entry is a web-standard fetch handler served by its default export; " +
          "run it with Bun. Node serves the stdio entry only (--stdio).",
      );
      process.exitCode = 1;
      return undefined;
    }

    return await createHostedRuntime(readStreamableHTTPConfig());
  } catch (error) {
    reportError("Standalone MCP startup", error);
    process.exitCode = 1;
    return undefined;
  }
}

export default await bootstrap();
