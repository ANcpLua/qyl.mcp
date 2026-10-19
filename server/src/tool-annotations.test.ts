import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { connectModernTestClient } from "./modern-test-client.test-helper.js";
import { createServer } from "./server.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS } from "./tools.js";
import { QYL_MCP_SCOPE } from "./oauth.js";

/** The tools that change annotations or saved queries; write-tools.test.ts pins their hints. */
const WRITE_TOOLS = new Set(["create_annotation", "update_annotation", "create_saved_query", "update_saved_query", "update_failure_status", "delete_record"]);

/** Read tools every client must find. */
const READ_TOOLS = [
  "aggregate_telemetry", "check_telemetry_health", "ci_log", "compare_groups", "compare_traces",
  "discover_attributes", "get_agent_run", "get_failure_context", "get_mcp_stats", "get_metric_series",
  "get_service_map", "get_trace", "list_failures", "list_metrics", "list_releases", "list_saved_queries",
  "list_sessions", "list_traces", "query_metric", "run_saved_query", "search_logs", "triage", "verify_fix",
];

/** Retired names: the viewers and their app-only refresh tool, and `delete` before its rename. */
const RETIRED_TOOLS = ["display_traces", "display_mcp_dashboard", "fetch_telemetry", "delete"];

test("qyl read tools publish read-only safety annotations", async () => {
  const connection = await connectModernTestClient(
    { name: "tool-annotations-test", version: "1.0.0" },
    () => createServer({ nativeExecution: false }),
  );

  try {
    const { tools } = await connection.client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) assert.ok(names.has(name), `${name} is published`);
    for (const name of RETIRED_TOOLS) assert.ok(!names.has(name), `${name} is not published`);
    for (const tool of tools.filter((candidate) => !WRITE_TOOLS.has(candidate.name))) {
      assert.deepEqual(tool.annotations, READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, tool.name);
      assert.deepEqual(tool._meta?.securitySchemes, [
        { type: "oauth2", scopes: [QYL_MCP_SCOPE] },
      ], tool.name);
      assert.equal((tool._meta as { ui?: unknown } | undefined)?.ui, undefined, `${tool.name} names no UI resource`);
    }
  } finally {
    await connection.close();
  }
});

test("qyl server factory serves protocol revision 2026-07-28 over the fetch entry", async () => {
  const handler = createMcpHandler(
    () => createServer({ nativeExecution: false }),
    { legacy: "reject" },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://qyl.test/mcp"),
    {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    },
  );
  const client = new Client(
    { name: "qyl-modern-conformance", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.equal(client.getServerVersion()?.name, "qyl.mcp");

    const toolsResult = await client.listTools() as Awaited<ReturnType<Client["listTools"]>> & {
      ttlMs: number;
      cacheScope: string;
    };
    const names = toolsResult.tools.map((tool) => tool.name);
    assert.ok(names.includes("triage"));
    assert.ok(names.includes("delete_record"));
    for (const name of RETIRED_TOOLS) assert.ok(!names.includes(name), `${name} is not published`);
    assert.equal(toolsResult.ttlMs, 300_000);
    assert.equal(toolsResult.cacheScope, "public");
    const discover = client.getDiscoverResult() as ReturnType<Client["getDiscoverResult"]> & {
      ttlMs: number;
      cacheScope: string;
    };
    assert.equal(discover?.ttlMs, 300_000);
    assert.equal(discover?.cacheScope, "public");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /recorded telemetry/u);
    assert.doesNotMatch(instructions, /viewer|interactive|\b\d+ tools\b/u, "no viewers and no tool count");

    const resourcesResult = await client.listResources() as Awaited<ReturnType<Client["listResources"]>> & {
      ttlMs: number;
      cacheScope: string;
    };
    assert.equal(resourcesResult.ttlMs, 300_000);
    assert.equal(resourcesResult.cacheScope, "public");
    assert.ok(resourcesResult.resources.length > 0, "the skill files are resources");
    for (const resource of resourcesResult.resources) {
      assert.match(resource.uri, /^skill:\/\/qyl\//u);
    }
  } finally {
    await client.close().catch(() => undefined);
    await handler.close().catch(() => undefined);
  }
});
