import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createLoopbackMcpApp,
  createLoopbackMcpTransport,
} from "./http-security.js";

interface TestResponse {
  status: number;
  body: string;
}

async function listen(): Promise<{ server: Server; port: number }> {
  const app = createLoopbackMcpApp();
  app.get("/probe", (_request, response) => response.status(204).end());
  app.all("/mcp", async (incoming, response) => {
    const mcpServer = new McpServer({ name: "http-security-test", version: "1.0.0" });
    const transport = createLoopbackMcpTransport(3001);
    response.once("close", () => {
      void mcpServer.close().catch((error: unknown) => {
        console.error(`test MCP cleanup failed (${error instanceof Error ? error.name : "unknown"})`);
      });
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(incoming, response, incoming.body);
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, port: address.port };
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
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
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
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/probe",
        method: "GET",
        headers,
        setHost,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("standalone MCP app accepts loopback Host and local or absent Origin", async (context) => {
  const { server, port } = await listen();
  context.after(() => server.close());

  assert.equal((await get(port)).status, 204);
  assert.equal(
    (await get(port, { host: `localhost:${port}`, origin: "http://localhost:3001" })).status,
    204,
  );
  assert.notEqual((await postMcp(port)).status, 403);
  assert.notEqual((await postMcp(port, "http://localhost:3001")).status, 403);
});

test("standalone MCP app rejects missing and rebound Host", async (context) => {
  const { server, port } = await listen();
  context.after(() => server.close());

  // Node may reject a Host-less HTTP/1.1 request before Express; it must not
  // reach the route in either case.
  assert.notEqual((await get(port, {}, false)).status, 204);

  const response = await get(port, { host: `attacker.example:${port}` });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error.code, -32000);
});

test("standalone MCP app rejects untrusted browser origins", async (context) => {
  const { server, port } = await listen();
  context.after(() => server.close());

  for (const origin of ["https://attacker.example", "null", "http://localhost:9999"]) {
    const response = await postMcp(port, origin);
    assert.equal(response.status, 403);
    const envelope = JSON.parse(response.body);
    assert.equal(envelope.jsonrpc, "2.0");
    assert.equal(envelope.error.code, -32000);
    assert.match(envelope.error.message, /^Invalid Origin header:/);
    assert.equal(envelope.id, null);
  }
});
