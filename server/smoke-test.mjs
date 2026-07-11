/**
 * Smoke test for the qyl.mcp telemetry server (demo mode, stdio).
 *
 * Spawns `node dist/main.js --stdio` with QYL_DEMO=1 and asserts the
 * INTERFACE.md contract: the curated tools/list + catalog surface (tool-slot
 * economy with the budget enforced in code), _meta wiring, display_traces,
 * catalog execution (get_trace, search_logs), the isError-never-throw rule,
 * fetch_telemetry correlated logs, demo-data parent/child span time
 * containment, and the MCP dashboard aggregation.
 *
 * Run: node smoke-test.mjs   (after `npm run build`)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run a catalog tool through execute_qyl_tool. */
async function executeCatalog(client, name, args) {
  return client.callTool({
    name: "execute_qyl_tool",
    arguments: { name, arguments: args },
  });
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/main.js", "--stdio"],
  env: { ...process.env, QYL_DEMO: "1" },
});
const client = new Client({ name: "qyl-smoke", version: "1.0.0" });
await client.connect(transport);

// --- 1. Curated tools/list (tool-slot economy) -------------------------------
console.log("tools/list");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "exactly the curated 5-tool surface",
  names.length === 5 &&
    JSON.stringify(names) ===
      JSON.stringify(
        [
          "display_mcp_dashboard",
          "display_traces",
          "execute_qyl_tool",
          "fetch_telemetry",
          "search_qyl_tools",
        ].sort(),
      ),
  `got: ${names.join(", ")}`,
);
check(
  "catalog tools are NOT in tools/list",
  !names.some((n) =>
    ["list_traces", "get_trace", "list_sessions", "search_logs"].includes(n),
  ),
);

const displayTraces = tools.find((t) => t.name === "display_traces");
check(
  "display_traces has _meta.ui.resourceUri",
  displayTraces?._meta?.ui?.resourceUri === "ui://qyl-explorer/mcp-app.html",
  JSON.stringify(displayTraces?._meta),
);

const fetchTelemetry = tools.find((t) => t.name === "fetch_telemetry");
check(
  'fetch_telemetry has _meta.ui.visibility ["app"]',
  JSON.stringify(fetchTelemetry?._meta?.ui?.visibility) === '["app"]',
  JSON.stringify(fetchTelemetry?._meta),
);

const displayDashboard = tools.find((t) => t.name === "display_mcp_dashboard");
check(
  "display_mcp_dashboard has _meta.ui.resourceUri",
  displayDashboard?._meta?.ui?.resourceUri ===
    "ui://qyl-explorer/mcp-dashboard.html",
  JSON.stringify(displayDashboard?._meta),
);

// --- 2. Budget enforced in code (surfaces.ts) --------------------------------
console.log("tool budget (surfaces.js)");
const surfaces = await import("./dist/surfaces.js");
check(
  "MODEL_VISIBLE_TOOL_BUDGET is a hard number",
  Number.isInteger(surfaces.MODEL_VISIBLE_TOOL_BUDGET) &&
    surfaces.MODEL_VISIBLE_TOOL_BUDGET >= 4,
);
let budgetThrew = false;
try {
  surfaces.assertToolSurface(
    Array.from({ length: surfaces.MODEL_VISIBLE_TOOL_BUDGET + 1 }, (_, i) => `tool_${i}`),
  );
} catch {
  budgetThrew = true;
}
check("assertToolSurface throws over budget", budgetThrew);
let curationThrew = false;
try {
  surfaces.assertToolSurface(["display_traces", "rogue_tool"]);
} catch {
  curationThrew = true;
}
check("assertToolSurface throws on curation drift", curationThrew);

// --- 3. search_qyl_tools ------------------------------------------------------
console.log("search_qyl_tools");
const allTools = await client.callTool({
  name: "search_qyl_tools",
  arguments: {},
});
check("not isError", !allTools.isError, allTools.content?.[0]?.text);
const catalogNames = allTools.structuredContent?.tools?.map((t) => t.name).sort();
check(
  "empty query lists the whole 4-tool catalog",
  JSON.stringify(catalogNames) ===
    JSON.stringify(["get_trace", "list_sessions", "list_traces", "search_logs"]),
  `got: ${catalogNames?.join(", ")}`,
);
check(
  "catalog entries carry input schemas",
  allTools.structuredContent?.tools?.every(
    (t) => t.input_schema && typeof t.input_schema === "object",
  ),
);
const logSearch = await client.callTool({
  name: "search_qyl_tools",
  arguments: { query: "logs" },
});
check(
  'query "logs" finds search_logs',
  logSearch.structuredContent?.tools?.some((t) => t.name === "search_logs"),
);

// --- 4. execute_qyl_tool + the isError-never-throw rule ------------------------
console.log("execute_qyl_tool");
const listed = await executeCatalog(client, "list_traces", {});
check("list_traces via catalog: not isError", !listed.isError, listed.content?.[0]?.text);
check(
  "list_traces returns 8 demo trace summaries without spans",
  listed.structuredContent?.traces?.length === 8 &&
    listed.structuredContent.traces.every((t) => t.spans === undefined),
);
check('mode is "demo"', listed.structuredContent?.mode === "demo");

const unknown = await executeCatalog(client, "does_not_exist", {});
check("unknown catalog tool → isError:true, no throw", unknown.isError === true);
check(
  "unknown-tool error names the available catalog",
  unknown.content?.[0]?.text?.includes("list_traces"),
  unknown.content?.[0]?.text,
);

const badArgs = await executeCatalog(client, "get_trace", {});
check("invalid arguments → isError:true, no throw", badArgs.isError === true);

const missingTrace = await executeCatalog(client, "get_trace", {
  trace_id: "0000000000000000000000000000dead",
});
check("missing trace id → isError:true, no throw", missingTrace.isError === true);
check(
  "missing-trace error is descriptive",
  missingTrace.content?.[0]?.text?.includes("trace not found"),
  missingTrace.content?.[0]?.text,
);

// --- 5. display_traces {} ----------------------------------------------------
console.log("display_traces {}");
const display = await client.callTool({ name: "display_traces", arguments: {} });
const sc = display.structuredContent;
check("not isError", !display.isError, display.content?.[0]?.text);
check("returns 8 traces", sc?.traces?.length === 8, `got ${sc?.traces?.length}`);
check('mode is "demo"', sc?.mode === "demo", `got ${sc?.mode}`);
check(
  "every trace has full spans (spans.length === span_count > 0)",
  sc?.traces?.every((t) => Array.isArray(t.spans) && t.spans.length === t.span_count && t.span_count > 0),
);

// Demo-data sanity the waterfall depends on: children contained in parents,
// no negative offsets, deep chain and error trace present.
for (const trace of sc.traces) {
  const byId = new Map(trace.spans.map((s) => [s.span_id, s]));
  const contained = trace.spans.every((s) => {
    if (s.end_time_unix_nano < s.start_time_unix_nano) return false;
    if (!s.parent_span_id) return true;
    const parent = byId.get(s.parent_span_id);
    return (
      parent &&
      s.start_time_unix_nano >= parent.start_time_unix_nano &&
      s.end_time_unix_nano <= parent.end_time_unix_nano
    );
  });
  check(`span containment valid in ${trace.trace_id.slice(0, 8)}…`, contained);
}
const errorTrace = sc.traces.find((t) => t.has_error);
check("one trace has has_error", sc.traces.filter((t) => t.has_error).length === 1);
check(
  "error trace has an exception event with stacktrace",
  errorTrace?.spans.some((s) =>
    s.events?.some(
      (e) =>
        e.name === "exception" &&
        e.attributes?.some((a) => a?.key === "exception.stacktrace"),
    ),
  ),
);
check(
  "a deep trace with 10+ spans exists",
  sc.traces.some((t) => t.span_count >= 10),
);
check(
  "gen_ai spans present",
  sc.traces.some((t) =>
    t.spans.some((s) => s.attributes?.some((a) => a.key === "gen_ai.system")),
  ),
);

// --- 6. get_trace via the catalog ---------------------------------------------
console.log("execute_qyl_tool get_trace");
const someId = sc.traces[0].trace_id;
const got = await executeCatalog(client, "get_trace", { trace_id: someId });
check("not isError", !got.isError, got.content?.[0]?.text);
check(
  "returns the trace with spans",
  got.structuredContent?.trace?.trace_id === someId &&
    got.structuredContent.trace.spans.length > 0,
);

// --- 7. search_logs severity_min:17 via the catalog ----------------------------
console.log("execute_qyl_tool search_logs { severity_min: 17 }");
const logsRes = await executeCatalog(client, "search_logs", { severity_min: 17 });
const logs = logsRes.structuredContent?.logs;
check("not isError", !logsRes.isError, logsRes.content?.[0]?.text);
check("returns at least one log", Array.isArray(logs) && logs.length > 0);
check(
  "only ERROR+ logs (severity_number >= 17)",
  logs?.every((l) => l.severity_number >= 17),
  JSON.stringify(logs?.map((l) => l.severity_number)),
);

// --- 8. fetch_telemetry view:"logs" for the error trace -----------------------
console.log('fetch_telemetry { view: "logs", trace_id: <error trace> }');
const corr = await client.callTool({
  name: "fetch_telemetry",
  arguments: { view: "logs", trace_id: errorTrace.trace_id },
});
const corrLogs = corr.structuredContent?.logs;
check("not isError", !corr.isError, corr.content?.[0]?.text);
check(
  "returns correlated logs",
  Array.isArray(corrLogs) && corrLogs.length > 0,
);
check(
  "every log belongs to the error trace",
  corrLogs?.every((l) => l.trace_id === errorTrace.trace_id),
);
check(
  "includes an ERROR log with a stacktrace body",
  corrLogs?.some((l) => l.severity_number >= 17 && l.body.includes("   at ")),
);

// Bonus: fetch_telemetry view "trace" and "traces" shapes.
console.log('fetch_telemetry { view: "trace" } / { view: "traces" }');
const one = await client.callTool({
  name: "fetch_telemetry",
  arguments: { view: "trace", trace_id: errorTrace.trace_id },
});
check(
  'view "trace" returns { trace } with spans',
  one.structuredContent?.trace?.spans?.length > 0,
);
const many = await client.callTool({
  name: "fetch_telemetry",
  arguments: { view: "traces" },
});
check(
  'view "traces" returns { traces } with full spans',
  many.structuredContent?.traces?.length === 8 &&
    many.structuredContent.traces.every((t) => t.spans.length > 0),
);

// --- 9. display_mcp_dashboard (demo aggregation) ------------------------------
console.log("display_mcp_dashboard {}");
const dash = await client.callTool({
  name: "display_mcp_dashboard",
  arguments: {},
});
const stats = dash.structuredContent?.stats;
check("not isError", !dash.isError, dash.content?.[0]?.text);
check('mode is "demo"', stats?.mode === "demo", `got ${stats?.mode}`);
check("truncated is false in demo", stats?.truncated === false);
check(
  "totals.requests > 500 in the 24h demo window",
  stats?.totals?.requests > 500,
  `got ${stats?.totals?.requests}`,
);
check(
  "4 tool rows",
  stats?.tools?.length === 4,
  `got ${stats?.tools?.length}`,
);
check(
  "tools sorted by requests desc",
  stats?.tools?.every(
    (row, i, rows) => i === 0 || rows[i - 1].requests >= row.requests,
  ),
  JSON.stringify(stats?.tools?.map((t) => t.requests)),
);
const byErrorRate = [...(stats?.tools ?? [])].sort(
  (a, b) => b.error_rate - a.error_rate,
);
check(
  "one tool has a meaningfully higher error_rate than the rest",
  byErrorRate.length === 4 && byErrorRate[0].error_rate > byErrorRate[1].error_rate,
  JSON.stringify(byErrorRate.map((t) => `${t.name}=${t.error_rate}`)),
);
check(
  "24-48 buckets",
  stats?.buckets?.length >= 24 && stats?.buckets?.length <= 48,
  `got ${stats?.buckets?.length}`,
);
check(
  "bucket request/error sums equal totals",
  stats?.buckets?.reduce((sum, b) => sum + b.requests, 0) ===
    stats?.totals?.requests &&
    stats?.buckets?.reduce((sum, b) => sum + b.errors, 0) ===
      stats?.totals?.errors,
);
check(
  "p95_ms >= avg_ms for every tool row",
  stats?.tools?.every((row) => row.p95_ms >= row.avg_ms),
  JSON.stringify(stats?.tools?.map((t) => `${t.name}: avg ${t.avg_ms} p95 ${t.p95_ms}`)),
);
check(
  "2 resource rows (mcp.resource.uri)",
  stats?.resources?.length === 2,
  `got ${stats?.resources?.length}`,
);
check(
  "by_server / by_transport / by_method populated",
  stats?.by_server?.length === 3 &&
    stats?.by_transport?.length === 2 &&
    stats?.by_method?.length === 3,
);

// --- 10. fetch_telemetry view:"mcp_stats" ---------------------------------------
console.log('fetch_telemetry { view: "mcp_stats", hours: 24 }');
const mcpStatsRes = await client.callTool({
  name: "fetch_telemetry",
  arguments: { view: "mcp_stats", hours: 24 },
});
check("not isError", !mcpStatsRes.isError, mcpStatsRes.content?.[0]?.text);
check(
  "returns { stats } with the same totals shape",
  mcpStatsRes.structuredContent?.stats?.totals?.requests > 500 &&
    mcpStatsRes.structuredContent.stats.mode === "demo",
);

// --- 11. resources/read of the dashboard UI -------------------------------------
console.log("resources/read ui://qyl-explorer/mcp-dashboard.html");
if (existsSync(new URL("./dist/mcp-dashboard.html", import.meta.url))) {
  const dashRes = await client.readResource({
    uri: "ui://qyl-explorer/mcp-dashboard.html",
  });
  const content = dashRes.contents?.[0];
  check(
    "dashboard resource serves non-empty HTML",
    typeof content?.text === "string" && content.text.length > 0,
  );
  check(
    "dashboard resource has empty-CSP _meta",
    JSON.stringify(content?._meta?.ui?.csp) ===
      '{"connectDomains":[],"resourceDomains":[]}',
    JSON.stringify(content?._meta),
  );
} else {
  console.log("  SKIPPED  dist/mcp-dashboard.html not built yet");
}

await client.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
