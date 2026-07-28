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

    if (options.auth === undefined) return options.handler.fetch(request);

    const authInfo = await options.auth.gate(request);
    if (authInfo instanceof Response) return authInfo;
    return options.handler.fetch(request, { authInfo });
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

async function createHostedRuntime(
  config: StreamableHTTPServerConfig,
): Promise<ServeOptions> {
  // No `legacy` option: the default stateless posture serves 2026-07-28 and
  // 2025-era clients from this one factory, and most clients shipping today
  // are still 2025-era.
  const handler = createMcpHandler(
    () => createServer({ transport: "streamable_http" }),
    { onerror: (error) => reportError("Standalone MCP request", error) },
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
