import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import test from "node:test";
import { createLoopbackMcpApp } from "./http-security.js";

interface TestResponse {
  status: number;
  body: string;
}

async function listen(): Promise<{ server: Server; port: number }> {
  const app = createLoopbackMcpApp(3001);
  app.get("/probe", (_request, response) => response.status(204).end());
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, port: address.port };
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
    const response = await get(port, { origin });
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Origin" },
      id: null,
    });
  }
});
