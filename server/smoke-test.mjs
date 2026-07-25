/**
 * Smoke test for the qyl.mcp telemetry server (demo mode, stdio).
 *
 * Spawns `node dist/main.js --stdio` with QYL_DEMO=1 and asserts the direct
 * tool surface, MCP Apps metadata, trace/log behavior, explicit mode
 * selection, generated-demo invariants, and dashboard aggregation.
 *
 * Run: node smoke-test.mjs   (after `npm run build`)
 */
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args });
}

const temp = await mkdtemp(join(tmpdir(), "qyl-mcp-server-smoke-"));
const nativeStatePath = join(temp, "native-executions.json");
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/main.js", "--stdio"],
  env: {
    ...process.env,
    QYL_DEMO: "1",
    QYL_MCP_TELEMETRY: "0",
    QYL_MCP_NATIVE_STATE_PATH: nativeStatePath,
  },
});
const client = new Client(
  { name: "qyl-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
try {
  await client.connect(transport);

// --- 1. Direct tools/list ----------------------------------------------------
console.log("tools/list");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "exactly the eight supported tools",
  names.length === 8 &&
    JSON.stringify(names) ===
      JSON.stringify(
        [
          "ci_log",
          "display_mcp_dashboard",
          "display_traces",
          "fetch_telemetry",
          "get_trace",
          "list_sessions",
          "list_traces",
          "search_logs",
        ].sort(),
      ),
  `got: ${names.join(", ")}`,
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

const ciLog = await callTool(client, "ci_log", {});
check("ci_log returns native demo evidence", !ciLog.isError && Array.isArray(ciLog.structuredContent?.runs));

// --- 2. Direct read tools + handler error contract ---------------------------
console.log("list_traces / get_trace error");
const listed = await callTool(client, "list_traces", {});
check("list_traces: not isError", !listed.isError, listed.content?.[0]?.text);
check(
  "list_traces returns 8 demo trace summaries without spans",
  listed.structuredContent?.traces?.length === 8 &&
    listed.structuredContent.traces.every((t) => t.spans === undefined),
);
check('mode is "demo"', listed.structuredContent?.mode === "demo");

const missingTrace = await callTool(client, "get_trace", {
  trace_id: "0000000000000000000000000000dead",
});
check("handler failure returns isError:true", missingTrace.isError === true);
check(
  "missing-trace error is descriptive",
  missingTrace.content?.[0]?.text?.includes("trace not found"),
  missingTrace.content?.[0]?.text,
);

// --- 3. display_traces {} ----------------------------------------------------
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

// --- 4. get_trace ------------------------------------------------------------
console.log("get_trace");
const someId = sc.traces[0].trace_id;
const got = await callTool(client, "get_trace", { trace_id: someId });
check("not isError", !got.isError, got.content?.[0]?.text);
check(
  "returns the trace with spans",
  got.structuredContent?.trace?.trace_id === someId &&
    got.structuredContent.trace.spans.length > 0,
);

// --- 5. search_logs severity_min:17 ------------------------------------------
console.log("search_logs { severity_min: 17 }");
const logsRes = await callTool(client, "search_logs", { severity_min: 17 });
const logs = logsRes.structuredContent?.logs;
check("not isError", !logsRes.isError, logsRes.content?.[0]?.text);
check("returns at least one log", Array.isArray(logs) && logs.length > 0);
check(
  "only ERROR+ logs (severity_number >= 17)",
  logs?.every((l) => l.severity_number >= 17),
  JSON.stringify(logs?.map((l) => l.severity_number)),
);

// --- 6. fetch_telemetry view:"logs" for the error trace ----------------------
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
  corrLogs?.some(
    (l) =>
      l.severity_number >= 17 &&
      typeof l.body?.string_value === "string" &&
      l.body.string_value.includes("   at "),
  ),
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

// --- 7. display_mcp_dashboard (demo aggregation) -----------------------------
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
  "by_server / by_transport / by_method populated",
  stats?.by_server?.length === 3 &&
    stats?.by_transport?.length === 2 &&
    stats?.by_method?.length === 3,
);

// --- 8. fetch_telemetry view:"mcp_stats" -------------------------------------
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

// --- 9. resources/read of the dashboard UI -----------------------------------
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

const nativeState = JSON.parse(await readFile(nativeStatePath, "utf8"));
check(
  "native tool execution evidence is automatic and terminal",
  nativeState.version === 2 &&
    nativeState.executions.length >= 9 &&
    nativeState.executions.every((execution) =>
      execution.status !== "running" &&
      execution.durationMs >= 0 &&
      execution.protocolEvents?.length === 2 &&
      execution.telemetryCorrelation?.executionId === execution.id),
);
check(
  "prose-only tool results leave usage and cost unavailable",
  nativeState.executions.every((execution) =>
    execution.tokenUsage === undefined && execution.cost === undefined),
);
} finally {
  await client.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}

// --- 10. Mode selection is explicit; live failures do not become demo data ---
console.log("explicit live/demo mode selection");
const previousDemo = process.env.QYL_DEMO;
const previousCollectorUrl = process.env.QYL_COLLECTOR_URL;
const { collectorGet, resolveMode } = await import("./dist/collector.js");
delete process.env.QYL_DEMO;
process.env.QYL_COLLECTOR_URL = "http://127.0.0.1:1";
check('QYL_DEMO unset selects "live"', (await resolveMode()) === "live");
let liveFailure;
try {
  await collectorGet("/api/v1/traces");
} catch (error) {
  liveFailure = error;
}
check(
  "unreachable live collector remains a connection error",
  liveFailure?.name === "CollectorError" && liveFailure.connectionError === true,
  liveFailure?.message,
);
process.env.QYL_DEMO = "1";
check('QYL_DEMO=1 selects "demo"', (await resolveMode()) === "demo");
if (previousDemo === undefined) delete process.env.QYL_DEMO;
else process.env.QYL_DEMO = previousDemo;
if (previousCollectorUrl === undefined) delete process.env.QYL_COLLECTOR_URL;
else process.env.QYL_COLLECTOR_URL = previousCollectorUrl;

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
