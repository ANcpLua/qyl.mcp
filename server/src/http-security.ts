import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface McpAppOptions {
  bindHost: string;
  allowedHosts?: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function loopbackOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
}

/**
 * The official MCP Express middleware owns Host validation. In hosted mode
 * the allowlist is explicit; with the loopback default the SDK supplies its
 * built-in localhost protection.
 */
export function createMcpApp({ bindHost, allowedHosts }: McpAppOptions) {
  return createMcpExpressApp({
    host: bindHost,
    allowedHosts: allowedHosts === undefined ? undefined : unique(allowedHosts),
  });
}

/**
 * The transport owns Origin validation. Host validation stays in the
 * Express middleware so hostnames remain port-agnostic behind a proxy.
 */
export function createMcpTransport(
  allowedOrigins: readonly string[],
): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedOrigins: unique(allowedOrigins),
  });
}

/**
 * Returns the configured static token, rejecting values that cannot safely be
 * represented as a Bearer credential. An unset token deliberately remains
 * undefined so the loopback-only local default stays convenient.
 */
export function readMcpAuthToken(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.MCP_AUTH_TOKEN;
  if (configured === undefined) return undefined;

  const token = configured.trim();
  if (token.length === 0) {
    throw new Error("MCP_AUTH_TOKEN must not be empty");
  }
  if (/\s/u.test(token)) {
    throw new Error("MCP_AUTH_TOKEN must not contain whitespace");
  }
  return token;
}

function hasExpectedBearer(
  authorization: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof authorization !== "string") return false;

  const match = /^Bearer[ \t]+([^ \t]+)$/iu.exec(authorization);
  if (match === null) return false;

  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendUnauthorized(response: Response): void {
  response.setHeader("WWW-Authenticate", 'Bearer realm="qyl-mcp"');
  response.setHeader("Cache-Control", "no-store");
  response.status(401).json({ error: "Unauthorized" });
}

/**
 * Protects the public MCP route with the first hosted-mode authentication
 * mechanism. The token is intentionally static and environment-backed; a
 * production OAuth provider can replace this middleware without changing the
 * MCP transport boundary.
 */
export function requireMcpAuthentication(
  token: string | undefined = readMcpAuthToken(),
): RequestHandler {
  return (
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    // No token is the deliberate local loopback mode. Hosted startup rejects
    // this configuration before the listener is created.
    if (token === undefined) {
      next();
      return;
    }

    if (!hasExpectedBearer(request.headers.authorization, token)) {
      sendUnauthorized(response);
      return;
    }

    next();
  };
}

export function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** @deprecated Use createMcpApp({ bindHost }) for hosted deployments. */
export function createLoopbackMcpApp() {
  return createMcpApp({ bindHost: "127.0.0.1" });
}

/** @deprecated Use createMcpTransport(allowedOrigins) for hosted deployments. */
export function createLoopbackMcpTransport(
  port: number,
): StreamableHTTPServerTransport {
  return createMcpTransport(loopbackOrigins(port));
}
