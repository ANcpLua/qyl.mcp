import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type CallToolResult } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { traceQueryForResult, TRACE_QUERY_META_KEY } from "./trace-query.js";
import { getDemo } from "./demo.js";
import { DisplayTracesInputSchema, DisplayTracesOutputSchema } from "./contract-validation.js";

for (const revision of ["2026-07-28", "2025-11-25"] as const) {
  test(`display results retain their refresh query without a host input notification over ${revision}`, async (context) => {
    const previousDemo = process.env.QYL_DEMO;
    const previousProjects = process.env.MCP_COLLECTOR_PROJECTS;
    process.env.QYL_DEMO = "1";
    delete process.env.MCP_COLLECTOR_PROJECTS;
    context.after(() => {
      if (previousDemo === undefined) delete process.env.QYL_DEMO;
      else process.env.QYL_DEMO = previousDemo;
      if (previousProjects === undefined) delete process.env.MCP_COLLECTOR_PROJECTS;
      else process.env.MCP_COLLECTOR_PROJECTS = previousProjects;
    });
    const handler = createMcpHandler(() => createServer({ nativeExecution: false }));
    const client = new Client({ name: "trace-query-test", version: "1.0.0" }, {
      versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://qyl.test/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }));
      const demo = getDemo();
      for (const args of [
        { limit: 2 },
        { session_id: demo.sessions[0]!.session_id, limit: 1 },
        { trace_id: demo.traces[0]!.trace_id },
      ]) {
        const result = await client.callTool({ name: "display_traces", arguments: args }) as CallToolResult;
        assert(!result.isError);
        const expected = DisplayTracesInputSchema.parse(args);
        assert.deepEqual(result._meta?.[TRACE_QUERY_META_KEY], expected);
        // A fresh host can replay only the result, or pair it with empty input.
        const restored = traceQueryForResult(result, DisplayTracesInputSchema.parse({}));
        assert.deepEqual(restored, expected);
        const refreshed = await client.callTool({ name: "display_traces", arguments: { ...restored } });
        assert.deepEqual(refreshed.structuredContent, result.structuredContent);
        const output = DisplayTracesOutputSchema.parse(result.structuredContent);
        assert(output.traces.length <= (args.limit ?? 20));
      }
    } finally {
      await client.close();
      await handler.close();
    }
  });
}

test("invalid or absent result metadata preserves the last valid trace query", () => {
  const previous = DisplayTracesInputSchema.parse({ session_id: "sample-session", limit: 2 });
  for (const metadata of [undefined, null, "invalid", { limit: 0 }, { limit: 101 }]) {
    assert.deepEqual(traceQueryForResult({ _meta: { [TRACE_QUERY_META_KEY]: metadata } }, previous), previous);
  }
  assert.deepEqual(traceQueryForResult({}, previous), previous);
});
