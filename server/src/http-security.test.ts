import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import test from "node:test";
import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpApp } from "./http-security.js";

interface TestResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

async function listen(): Promise<{ server: Server; handler: McpHttpHandler; port: number }> {
  const app = createMcpApp({ bindHost: "127.0.0.1" });
  const handler = createMcpHandler(
    () => new McpServer({ name: "http-security-test", version: "1.0.0" }),
    { legacy: "reject" },
  );
  const nodeHandler = toNodeHandler(handler);
  app.get("/probe", (_request, response) => response.status(204).end());
  app.all("/mcp", async (incoming, response) => {
    await nodeHandler(incoming, response, incoming.body);
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, handler, port: address.port };
}

function postMcp(port: number, origin?: string): Promise<TestResponse> {
  const headers: Record<string, string> = {
    host: "127.0.0.1:3001",
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "content-length": "2",
  };
  if (origin !== undefined) headers.origin = origin;

  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body,
          headers: response.headers,
        }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

function get(
  port: number,
  headers: Readonly<Record<string, string>> = {},
  setHost = true,
  path = "/probe",
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
        setHost,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body,
          headers: response.headers,
        }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("standalone MCP app accepts loopback Host and local or absent Origin", async (context) => {
  const { server, handler, port } = await listen();
  context.after(async () => {
    await handler.close();
    server.close();
  });

  assert.equal((await get(port)).status, 204);
  assert.equal(
    (await get(port, { host: `localhost:${port}`, origin: "http://localhost:3001" })).status,
    204,
  );
  assert.notEqual((await postMcp(port)).status, 403);
  assert.notEqual((await postMcp(port, "http://localhost:3001")).status, 403);
});

test("standalone MCP app rejects missing and rebound Host", async (context) => {
  const { server, handler, port } = await listen();
  context.after(async () => {
    await handler.close();
    server.close();
  });

  // Node may reject a Host-less HTTP/1.1 request before Express; it must not
  // reach the route in either case.
  assert.notEqual((await get(port, {}, false)).status, 204);

  const response = await get(port, { host: `attacker.example:${port}` });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error.code, -32000);
});

test("standalone MCP app accepts loopback origins on any port and rejects other hosts", async (context) => {
  const { server, handler, port } = await listen();
  context.after(async () => {
    await handler.close();
    server.close();
  });

  assert.notEqual((await postMcp(port, "http://localhost:9999")).status, 403);

  for (const origin of ["https://attacker.example", "null"]) {
    const response = await postMcp(port, origin);
    assert.equal(response.status, 403);
    const envelope = JSON.parse(response.body);
    assert.equal(envelope.jsonrpc, "2.0");
    assert.equal(envelope.error.code, -32000);
    assert.match(envelope.error.message, /^Invalid Origin(?: header)?:/);
    assert.equal(envelope.id, null);
  }
});
