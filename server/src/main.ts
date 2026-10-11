#!/usr/bin/env node
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
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
import { loadHostedOAuth, QYL_MCP_ISSUER } from "./oauth.js";
import { createResourceAuthorization } from "./authorization.js";
import { readAuthorizationExtensions } from "./auth-extensions.js";
import { createCloudflareAccessAuth, readAccessConfig } from "./cloudflare-access.js";
import { closeDefaultNativeExecutionRuntime } from "./native-execution.js";
import { EventsRuntime, createEventStore } from "./events.js";
import { hostedEventsAuthorization } from "./events-authorization.js";
import { readCollectorProjects } from "./collector-access.js";
import { hostedUiDomain } from "./ui-domain.js";

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
  metadata?: AuthMetadataOptions;
}

export interface McpFetchOptions {
  handler: McpHttpHandler;
  landingPage: string;
  allowedHosts?: readonly string[] | undefined;
  allowedOrigins?: readonly string[] | undefined;
  auth?: HostedAuth | undefined;
  /** The OpenAI plugin portal's domain-verification token (OPENAI_APPS_CHALLENGE). */
  openaiAppsChallenge?: string | undefined;
}

/**
 * OpenAI's plugin portal verifies the MCP domain by fetching this path and
 * expecting its exact token as plain text, nothing else (OpenAI "Submit
 * plugins", MCP domain verification). Without a configured token the path
 * does not exist.
 */
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

function openaiAppsChallengeResponse(request: Request, token: string | undefined): Response {
  if (token === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
    return notFound();
  }
  return new Response(request.method === "HEAD" ? null : token, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
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
    const metadata = options.auth?.metadata;
    // RFC 9728 permits both the resource-path and origin forms. Keep the
    // canonical resource identical in either document and let the SDK handle
    // GET, HEAD, OPTIONS, 405, and CORS for both routes.
    const discoveryRequest = metadata !== undefined
      && new URL(request.url).pathname.replace(/\/$/u, "") === "/.well-known/oauth-protected-resource"
      ? new Request(getOAuthProtectedResourceMetadataUrl(metadata.resourceServerUrl), {
        method: request.method,
        headers: request.headers,
      })
      : request;
    const discovery = metadata === undefined
      ? undefined
      : oauthMetadataResponse(discoveryRequest, metadata);
    if (discovery !== undefined) return discovery;

    const rejected = dnsRebindingResponse(
      request,
      options.allowedHosts,
      options.allowedOrigins,
    );
    if (rejected !== undefined) return rejected;

    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return healthResponse(request);
    if (pathname === OPENAI_APPS_CHALLENGE_PATH) {
      return openaiAppsChallengeResponse(request, options.openaiAppsChallenge);
    }
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

/** Build the selected hosted gate. A public bind still requires MCP_PUBLIC_URL;
 * Access mode must be explicitly configured with its team and application AUD.
 */
export async function hostedAuth(
  config: StreamableHTTPServerConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HostedAuth | undefined> {
  const access = readAccessConfig(environment);
  const projects = readCollectorProjects(environment);
  if (projects !== undefined && (access || config.publicUrl === undefined)) {
    throw new Error("MCP_COLLECTOR_PROJECTS requires hosted Auth0 resource authorization");
  }
  const extensions = readAuthorizationExtensions(environment);
  if (extensions.length > 0 && (access || config.publicUrl === undefined)) {
    throw new Error("MCP_AUTH_EXTENSIONS requires hosted Auth0 resource authorization");
  }
  const publicUrl = config.publicUrl;
  if (publicUrl === undefined) {
    if (access) throw new Error("Cloudflare Access requires MCP_PUBLIC_URL");
    return undefined;
  }

  const resourceServerUrl = new URL("/mcp", publicUrl);
  if (access) return createCloudflareAccessAuth({ ...access, resource: resourceServerUrl });
  const oauth = await loadHostedOAuth(resourceServerUrl, { extensions });
  return {
    gate: createResourceAuthorization({
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

/** The SDK serves modern and stateless 2025 requests from the same factory. */
export function createHostedHandler(
  factory: Parameters<typeof createMcpHandler>[0],
  onerror: (error: unknown) => void,
): McpHttpHandler {
  return createMcpHandler(factory, { onerror });
}

/**
 * Whether this HTTP process may persist native execution evidence.
 *
 * The evidence file is a LOCAL artifact: it records every inbound tools/call —
 * tool name, timing, status and error type — into a bounded JSON file under
 * $HOME. This local developer artifact is not a hosted audit log.
 * MCP_PUBLIC_URL is the signal that this process serves somebody else, so
 * recording is armed only in its absence — the loopback default keeps it, and
 * so does --stdio, which is a local process by construction.
 */
export function recordsNativeExecutionEvidence(
  config: StreamableHTTPServerConfig,
): boolean {
  return config.publicUrl === undefined;
}

/** The portal token from OPENAI_APPS_CHALLENGE, or undefined when unset or blank. */
export function openaiAppsChallenge(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const token = environment["OPENAI_APPS_CHALLENGE"]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/**
 * MCP Events need subscription storage that survives restarts and a caller
 * identity, so they exist only on an authenticated hosted endpoint whose
 * operator named a store file (on a persistent volume): MCP_EVENTS_STORE.
 */
export async function hostedEvents(
  auth: HostedAuth | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EventsRuntime | undefined> {
  const storePath = environment["MCP_EVENTS_STORE"]?.trim();
  if (storePath === undefined || storePath === "") return undefined;
  if (auth === undefined) {
    throw new Error("MCP_EVENTS_STORE requires hosted authorization (MCP_PUBLIC_URL)");
  }
  if (auth.metadata?.oauthMetadata.issuer !== QYL_MCP_ISSUER) {
    throw new Error("MCP_EVENTS_STORE requires the Auth0 authorization provider for ongoing access checks");
  }
  const pollMs = Number(environment["MCP_EVENTS_POLL_MS"] ?? "");
  const events = new EventsRuntime({
    store: createEventStore(resolve(storePath)),
    isAuthorized: hostedEventsAuthorization(environment),
    ...(Number.isInteger(pollMs) && pollMs >= 5_000 ? { pollIntervalMs: pollMs } : {}),
  });
  await events.start();
  return events;
}

async function createHostedRuntime(
  config: StreamableHTTPServerConfig,
): Promise<ServeOptions> {
  const auth = await hostedAuth(config);
  const events = await hostedEvents(auth);
  const uiDomain = config.publicUrl === undefined
    ? undefined
    : hostedUiDomain(new URL("/mcp", config.publicUrl).href);
  const handler = createHostedHandler(
    () =>
      createServer({
        transport: "streamable_http",
        ...(uiDomain === undefined ? {} : { uiDomain }),
        ...(recordsNativeExecutionEvidence(config) ? {} : { nativeExecution: false }),
        ...(events === undefined ? {} : { events }),
      }),
    (error) => reportError("Standalone MCP request", error),
  );

  const options: McpFetchOptions = {
    handler,
    landingPage: await readFile(new URL("./mcp-home.html", import.meta.url), "utf8"),
    ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
    ...(config.allowedOrigins === undefined ? {} : { allowedOrigins: config.allowedOrigins }),
    ...(auth === undefined ? {} : { auth }),
    ...(openaiAppsChallenge() === undefined ? {} : { openaiAppsChallenge: openaiAppsChallenge() }),
  };

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all([handler.close(), events?.stop()])
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
  console.error(`MCP server serving ${endpoint}`);

  return { port: config.port, hostname: config.bindHost, fetch: createFetch(options) };
}

/** The SDK selects the protocol era at the opening exchange of each connection. */
export function startStdioServer(serverFactory: () => McpServer): StdioServerHandle {
  const handle = serveStdio(serverFactory, {
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

  // One reading of argv decides both the handshake's retry posture and which
  // transport is started, so the two cannot disagree. HandshakeOptions.transport
  // exists for exactly this; left unpassed, the handshake re-derived it from the
  // same argv and the branch below duplicated the computation.
  const transport = process.argv.includes("--stdio") ? "stdio" : "http";

  try {
    const projects = readCollectorProjects();
    if (projects !== undefined && transport === "stdio") {
      throw new Error("MCP_COLLECTOR_PROJECTS requires hosted Auth0 resource authorization");
    }
    // Before either transport accepts a connection: a server that answers tool
    // calls against a contract the collector does not serve is worse than one
    // that refuses to start.
    await assertCollectorContractRevision({ transport });

    if (transport === "stdio") {
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
