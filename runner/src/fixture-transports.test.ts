import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFixtureHttpServer } from "./fixture-http.js";

function client(name: string): Client {
  return new Client({ name, version: "1.0.0" });
}

test("stdio fixture interoperates through official client and server transports", { timeout: 10_000 }, async () => {
  const scriptPath = fileURLToPath(
    new URL("../../fixtures/mcp-conformance-stdio.mjs", import.meta.url),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scriptPath],
    stderr: "pipe",
  });
  const mcpClient = client("stdio-fixture-client");
  await mcpClient.connect(transport);
  try {
    const tools = await mcpClient.listTools();
    assert.equal(tools.tools[0]?.name, "fixture.safe_lookup");
    assert.equal(typeof tools.nextCursor, "string");
  } finally {
    await mcpClient.close();
  }
});

test("authenticated Streamable HTTP fixture rejects missing credentials and serves MCP", { timeout: 10_000 }, async () => {
  const token = "streamable-http-test-secret";
  const running = await startFixtureHttpServer({ bearerToken: token });
  const unauthorized = await fetch(running.streamableUrl);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.text()).includes(token), false);

  const transport = new StreamableHTTPClientTransport(running.streamableUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  const mcpClient = client("streamable-http-fixture-client");

  try {
    await mcpClient.connect(transport);
    const prompts = await mcpClient.listPrompts();
    assert.equal(prompts.prompts[0]?.name, "fixture.safe_summary");
    assert.equal(typeof prompts.nextCursor, "string");
  } finally {
    await mcpClient.close();
    await running.close();
  }
});

test("authenticated legacy SSE fixture remains interoperable", { timeout: 10_000 }, async () => {
  const token = "legacy-sse-test-secret";
  const running = await startFixtureHttpServer({ bearerToken: token });
  const addAuthorization = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const transport = new SSEClientTransport(running.sseUrl, {
    eventSourceInit: { fetch: addAuthorization },
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const mcpClient = client("legacy-sse-fixture-client");

  try {
    await mcpClient.connect(transport);
    const resources = await mcpClient.listResources();
    assert.equal(resources.resources[0]?.name, "fixture-summary");
    assert.equal(typeof resources.nextCursor, "string");
  } finally {
    await mcpClient.close();
    await running.close();
  }
});
