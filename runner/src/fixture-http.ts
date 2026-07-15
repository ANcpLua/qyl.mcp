import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as NodeHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFixtureMcpServer } from "./fixture-server.js";

export interface FixtureHttpOptions {
  bearerToken: string;
  host?: string;
  port?: number;
}

export interface RunningFixtureHttpServer {
  host: string;
  port: number;
  streamableUrl: URL;
  sseUrl: URL;
  requests: FixtureHttpRequest[];
  close(): Promise<void>;
}

export interface FixtureHttpRequest {
  method: string;
  path: string;
  traceparent?: string;
  body: unknown;
}

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface SseSession {
  server: McpServer;
  transport: SSEServerTransport;
}

export function hasExpectedBearer(authorization: unknown, expectedToken: string): boolean {
  if (typeof authorization !== "string" || expectedToken.length === 0) {
    return false;
  }

  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  const actual = Buffer.from(authorization, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendUnauthorized(response: Response): void {
  response.setHeader("WWW-Authenticate", 'Bearer realm="qyl-mcp-fixture"');
  response.status(401).type("text/plain").send("Bearer authentication required");
}

function sendPlainError(response: Response, status: number, message: string): void {
  if (!response.headersSent) {
    response.status(status).type("text/plain").send(message);
  }
}

export async function startFixtureHttpServer(
  options: FixtureHttpOptions,
): Promise<RunningFixtureHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (options.bearerToken.length === 0 || /[\r\n]/.test(options.bearerToken)) {
    throw new Error("A non-empty, single-line bearer token is required for the HTTP fixture");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("Fixture HTTP port must be an integer from 0 through 65535");
  }

  const app = createMcpExpressApp({ host });
  const streamableSessions = new Map<string, StreamableSession>();
  const sseSessions = new Map<string, SseSession>();
  const requests: FixtureHttpRequest[] = [];

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!hasExpectedBearer(request.headers.authorization, options.bearerToken)) {
      sendUnauthorized(response);
      return;
    }
    const traceparent = request.headers.traceparent;
    requests.push({
      method: request.method,
      path: request.path,
      ...(typeof traceparent === "string" ? { traceparent } : {}),
      body: structuredClone(request.body),
    });
    next();
  });

  app.all("/mcp", async (request, response) => {
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
    let session = sessionId === undefined ? undefined : streamableSessions.get(sessionId);

    try {
      if (session === undefined && request.method === "POST" && isInitializeRequest(request.body)) {
        const fixture = createFixtureMcpServer();
        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            session = { server: fixture.server, transport };
            streamableSessions.set(initializedSessionId, session);
          },
        });
        transport.onclose = () => {
          const initializedSessionId = transport.sessionId;
          if (initializedSessionId !== undefined) {
            streamableSessions.delete(initializedSessionId);
          }
        };
        await fixture.server.connect(transport);
        session = { server: fixture.server, transport };
      }

      if (session === undefined) {
        sendPlainError(response, 400, "A valid MCP session or initialize request is required");
        return;
      }

      await session.transport.handleRequest(request, response, request.body);
    } catch {
      sendPlainError(response, 500, "The MCP fixture could not handle the request");
    }
  });

  app.get("/sse", async (_request, response) => {
    const fixture = createFixtureMcpServer();
    const transport = new SSEServerTransport("/messages", response);
    const session: SseSession = { server: fixture.server, transport };
    sseSessions.set(transport.sessionId, session);
    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };

    try {
      await fixture.server.connect(transport);
    } catch {
      sseSessions.delete(transport.sessionId);
      sendPlainError(response, 500, "The legacy SSE fixture could not start");
    }
  });

  app.post("/messages", async (request, response) => {
    const sessionId = typeof request.query.sessionId === "string" ? request.query.sessionId : undefined;
    const session = sessionId === undefined ? undefined : sseSessions.get(sessionId);
    if (session === undefined) {
      sendPlainError(response, 400, "A valid legacy SSE session is required");
      return;
    }

    try {
      await session.transport.handlePostMessage(request, response, request.body);
    } catch {
      sendPlainError(response, 500, "The legacy SSE fixture could not handle the request");
    }
  });

  const httpServer = await new Promise<NodeHttpServer>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  const baseUrl = new URL(`http://${host}:${address.port}`);

  let closed = false;
  return {
    host,
    port: address.port,
    streamableUrl: new URL("/mcp", baseUrl),
    sseUrl: new URL("/sse", baseUrl),
    requests,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;

      const sessions = [...streamableSessions.values(), ...sseSessions.values()];
      streamableSessions.clear();
      sseSessions.clear();
      await Promise.allSettled(sessions.map(async ({ server }) => server.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
