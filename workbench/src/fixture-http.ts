import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as NodeHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { NextFunction, Request, Response } from "express";
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
  requests: FixtureHttpRequest[];
  close(): Promise<void>;
}

export interface FixtureHttpRequest {
  method: string;
  path: string;
  traceparent?: string;
  body: unknown;
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
  const modernHandler = createMcpHandler(
    () => createFixtureMcpServer().server,
    { legacy: "reject" },
  );
  const nodeHandler = toNodeHandler(modernHandler);
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
    await nodeHandler(request, response, request.body);
  });

  const httpServer = await new Promise<NodeHttpServer>((resolveListening, rejectListening) => {
    const listener = app.listen(port, host, () => resolveListening(listener));
    listener.once("error", rejectListening);
  });
  const address = httpServer.address() as AddressInfo;
  const baseUrl = new URL(`http://${host}:${address.port}`);

  let closed = false;
  return {
    host,
    port: address.port,
    streamableUrl: new URL("/mcp", baseUrl),
    requests,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;

      await modernHandler.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}
