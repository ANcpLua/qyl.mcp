#!/usr/bin/env node
/**
 * Standalone entry point for the qyl telemetry MCP server.
 * Run with: node dist/main.js [--stdio]
 *
 * The qyl.mcp runner does NOT go through this file — it hosts createServer()
 * in-process over an in-memory transport (runner/main.ts). This entry exists
 * for direct chat-client wiring (stdio) and hosted HTTP deployments.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import type { Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";
import {
  createMcpApp,
  createMcpTransport,
  isLoopbackBindHost,
  loopbackOrigins,
  readMcpAuthToken,
  requireMcpAuthentication,
} from "./http-security.js";
import { mcpErrorResponse, mcpRequestId } from "./mcp-errors.js";

interface CleanupFailure {
  resource: "server" | "transport";
  errorType: string;
}

export function sanitizedErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
}

/**
 * McpServer owns its connected transport. A direct transport close is only a
 * fallback when the server-owned close fails, avoiding duplicate close races.
 */
export async function closeMcpRequestResources(
  server: Pick<McpServer, "close">,
  transport: Pick<Transport, "close">,
): Promise<CleanupFailure[]> {
  try {
    await server.close();
    return [];
  } catch (error) {
    const failures: CleanupFailure[] = [
      { resource: "server", errorType: sanitizedErrorType(error) },
    ];
    try {
      await transport.close();
    } catch (fallbackError) {
      failures.push({
        resource: "transport",
        errorType: sanitizedErrorType(fallbackError),
      });
    }
    return failures;
  }
}

function logCleanupFailures(failures: readonly CleanupFailure[]): void {
  for (const failure of failures) {
    console.error(
      `Standalone MCP ${failure.resource} cleanup failed (${failure.errorType}); secret details omitted`,
    );
  }
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
  allowedOrigins: string[];
  authToken?: string;
  hosted: boolean;
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

  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
    throw new Error("MCP_PUBLIC_URL must use HTTP or HTTPS");
  }
  return publicUrl;
}

/**
 * Reads the standalone HTTP configuration without exposing secret values in
 * errors or logs. The default remains loopback-only; a non-loopback bind or a
 * public URL is an explicit hosted mode and requires authentication.
 */
export function readStreamableHTTPConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StreamableHTTPServerConfig {
  const port = Number.parseInt(environment.PORT ?? "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }

  const bindHost = environment.MCP_BIND_HOST?.trim() || "127.0.0.1";
  const publicUrl = configuredPublicUrl(environment);
  const additionalHosts = commaSeparated(environment.MCP_ALLOWED_HOSTS);
  const additionalOrigins = commaSeparated(environment.MCP_ALLOWED_ORIGINS);
  const allowedHosts = publicUrl
    ? unique([publicUrl.hostname, ...additionalHosts])
    : undefined;
  const allowedOrigins = publicUrl
    ? unique([publicUrl.origin, ...additionalOrigins])
    : loopbackOrigins(port);
  const authToken = readMcpAuthToken(environment);
  const hosted = publicUrl !== undefined || !isLoopbackBindHost(bindHost);

  if (hosted && authToken === undefined) {
    throw new Error(
      "MCP_AUTH_TOKEN must be configured when MCP_BIND_HOST is non-loopback or MCP_PUBLIC_URL is set",
    );
  }

  return {
    port,
    bindHost,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    allowedOrigins,
    ...(authToken === undefined ? {} : { authToken }),
    hosted,
  };
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 *
 * @param createServer - Factory function that creates a new McpServer instance per request.
 */
export async function startStreamableHTTPServer(
  createServer: () => McpServer,
): Promise<void> {
  const config = readStreamableHTTPConfig();

  const app = createMcpApp({
    bindHost: config.bindHost,
    allowedHosts: config.allowedHosts,
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.all("/mcp", requireMcpAuthentication(config.authToken), async (req: Request, res: Response) => {
    const server = createServer();
    const transport = createMcpTransport(config.allowedOrigins);

    res.once("close", () => {
      void closeMcpRequestResources(server, transport).then(logCleanupFailures);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(
        `Standalone MCP request failed (${sanitizedErrorType(error)}); secret details omitted`,
      );
      if (!res.headersSent) {
        res
          .status(500)
          .json(
            mcpErrorResponse(
              ErrorCode.InternalError,
              "Internal server error",
              mcpRequestId(req.body),
            ),
          );
      }
    }
  });

  const httpServer = app.listen(config.port, config.bindHost);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const endpoint = config.publicUrl
    ? new URL("/mcp", config.publicUrl).href
    : `http://${urlHost(config.bindHost)}:${config.port}/mcp`;
  console.log(`MCP server listening on ${endpoint}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    void closeHttpListener(httpServer).catch((error: unknown) => {
      console.error(
        `Standalone MCP HTTP listener cleanup failed (${sanitizedErrorType(error)}); secret details omitted`,
      );
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/**
 * Starts an MCP server with stdio transport.
 *
 * @param createServer - Factory function that creates a new McpServer instance.
 */
export async function startStdioServer(
  createServer: () => McpServer,
): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeMcpRequestResources(server, transport).then(logCleanupFailures);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main() {
  if (process.argv.includes("--stdio")) {
    await startStdioServer(createServer);
  } else {
    await startStreamableHTTPServer(createServer);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      `Standalone MCP startup failed (${sanitizedErrorType(error)}); secret details omitted`,
    );
    process.exitCode = 1;
  });
}
