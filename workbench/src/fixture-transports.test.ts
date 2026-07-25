import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startFixtureHttpServer } from "./fixture-http.js";

function client(name: string): Client {
  return new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
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
    assert.equal(tools.tools.length, 6);
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
    assert.equal(prompts.prompts.length, 3);
  } finally {
    await mcpClient.close();
    await running.close();
  }
});
