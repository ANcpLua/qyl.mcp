import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS } from "./tools.js";

test("all qyl telemetry tools publish explicit read-only safety annotations", async () => {
  const server = createServer({ nativeExecution: false });
  const client = new Client({ name: "tool-annotations-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "ci_log",
        "display_mcp_dashboard",
        "display_traces",
        "fetch_telemetry",
        "get_trace",
        "list_sessions",
        "list_traces",
        "search_logs",
      ],
    );
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, tool.name);
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});
