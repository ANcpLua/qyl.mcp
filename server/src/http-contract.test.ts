import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHandler, type ListToolsResult } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";

const protocolVersion = "2026-07-28";
const protocolKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";

function toolsRequest(
  id: number,
  meta: Record<string, unknown> = { [protocolKey]: protocolVersion, [capabilitiesKey]: {} },
  headerVersion = protocolVersion,
): Request {
  return new Request("http://qyl-http-contract.invalid/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": headerVersion,
      "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: meta } }),
  });
}

interface ErrorResponse {
  jsonrpc: string;
  id: number;
  error: { code: number; message: string };
}

test("HTTP protocol-version mismatch returns 400 and -32020", async (context) => {
  const handler = createMcpHandler(() => createServer({ nativeExecution: false }));
  context.after(() => handler.close());

  const response = await handler.fetch(toolsRequest(1, undefined, "2025-11-25"));
  assert.equal(response.status, 400);
  const body = await response.json() as ErrorResponse;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  assert.equal(body.error.code, -32020);
});

test("HTTP missing clientCapabilities returns 400 and -32602", async (context) => {
  const handler = createMcpHandler(() => createServer({ nativeExecution: false }));
  context.after(() => handler.close());

  const response = await handler.fetch(toolsRequest(2, { [protocolKey]: protocolVersion }));
  assert.equal(response.status, 400);
  const body = await response.json() as ErrorResponse;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 2);
  assert.equal(body.error.code, -32602);
  assert.ok(body.error.message.includes(capabilitiesKey), body.error.message);
});

test("HTTP tools/list carries cache hints and preserves order across requests", async (context) => {
  const handler = createMcpHandler(() => createServer({ nativeExecution: false }));
  context.after(() => handler.close());
  const catalogs: ListToolsResult[] = [];

  for (const id of [3, 4]) {
    const response = await handler.fetch(toolsRequest(id));
    assert.equal(response.status, 200);
    const body = await response.json() as { jsonrpc: string; id: number; result: ListToolsResult };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, id);
    assert.equal(body.result.ttlMs, 300_000);
    assert.equal(body.result.cacheScope, "public");
    assert.equal(body.result.tools.length, 11);
    catalogs.push(body.result);
  }

  assert.deepEqual(catalogs[0]?.tools.map((tool) => tool.name), catalogs[1]?.tools.map((tool) => tool.name));
});
