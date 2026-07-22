#!/usr/bin/env node
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type AuthMetadataOptions,
  type McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Express, Request, Response } from "express";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import { createMcpApp, isLoopbackBindHost } from "./http-security.js";
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

export function closeHttpListener(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
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

export function mountProtectedResourceMetadata(
  app: Express,
  options: AuthMetadataOptions,
): string {
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(options.resourceServerUrl);
  const metadataPath = new URL(metadataUrl).pathname;
  const metadata = buildOAuthProtectedResourceMetadata(options);

  app.all(metadataPath, (request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      const requestedHeaders = request.get("Access-Control-Request-Headers");
      if (requestedHeaders !== undefined) {
        response.set("Access-Control-Allow-Headers", requestedHeaders);
        response.vary("Access-Control-Request-Headers");
      }
      response.status(204).end();
      return;
    }
    if (request.method === "GET") {
      response.status(200).json(metadata);
      return;
    }
    if (request.method === "HEAD") {
      response.status(200).end();
      return;
    }

    const error = new OAuthError(
      OAuthErrorCode.MethodNotAllowed,
      `The method ${request.method} is not allowed for this endpoint`,
    );
    response
      .set("Allow", "GET, HEAD, OPTIONS")
      .status(405)
      .json(error.toResponseObject());
  });
  return metadataUrl;
}

export function mountLandingPage(app: Express, html: string): void {
  app.get("/", (_request, response) => {
    response
      .set("Cache-Control", "public, max-age=300")
      .status(200)
      .type("html")
      .send(html);
  });
}

export async function startStreamableHTTPServer(
  serverFactory: () => McpServer,
): Promise<void> {
  const config = readStreamableHTTPConfig();
  const handler = createMcpHandler(serverFactory, {
    legacy: "reject",
    onerror: (error) => reportError("Standalone MCP request", error),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => reportError("Standalone MCP adapter", error),
  });
  const app = createMcpApp({
    bindHost: config.bindHost,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });
  mountLandingPage(
    app,
    await readFile(new URL("./mcp-home.html", import.meta.url), "utf8"),
  );

  const handleMcpRequest = async (request: Request, response: Response): Promise<void> => {
    await nodeHandler(request, response, request.body);
  };

  if (config.publicUrl !== undefined) {
    const resourceServerUrl = new URL("/mcp", config.publicUrl);
    const oauth = await loadHostedOAuth(resourceServerUrl);
    const resourceMetadataUrl = mountProtectedResourceMetadata(app, {
      oauthMetadata: oauth.oauthMetadata,
      resourceServerUrl,
      scopesSupported: oauth.requiredScopes,
    });
    const requireAuth = requireBearerAuth({
      verifier: oauth.verifier,
      requiredScopes: oauth.requiredScopes,
      resourceMetadataUrl,
    });
    app.all("/mcp", requireAuth, handleMcpRequest);
  } else {
    app.all("/mcp", handleMcpRequest);
  }

  const httpServer = app.listen(config.port, config.bindHost);
  await new Promise<void>((resolveListening, rejectListening) => {
    httpServer.once("listening", resolveListening);
    httpServer.once("error", rejectListening);
  });
  const endpoint = config.publicUrl
    ? new URL("/mcp", config.publicUrl).href
    : `http://${urlHost(config.bindHost)}:${config.port}/mcp`;
  console.log(`MCP server listening on ${endpoint}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handler.close()
      .then(() => closeHttpListener(httpServer))
      .then(closeDefaultNativeExecutionRuntime)
      .catch((error: unknown) => {
        reportError("Standalone MCP HTTP shutdown cleanup", error);
        process.exitCode = 1;
      });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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

async function main(): Promise<void> {
  if (process.argv.includes("--stdio")) {
    startStdioServer(() => createServer({ transport: "stdio" }));
    return;
  }
  await startStreamableHTTPServer(() => createServer({ transport: "streamable_http" }));
}

function toRealEntryHref(entryPoint: string): string {
  const resolved = resolve(entryPoint);
  try {
    return pathToFileURL(realpathSync(resolved)).href;
  } catch {
    return pathToFileURL(resolved).href;
  }
}

const entryPoint = process.argv[1];
const entryHref = entryPoint === undefined ? undefined : toRealEntryHref(entryPoint);
if (entryHref === import.meta.url) {
  void main().catch((error: unknown) => {
    reportError("Standalone MCP startup", error);
    process.exitCode = 1;
  });
}
