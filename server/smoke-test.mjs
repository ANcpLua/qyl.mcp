/**
 * Smoke test for child-process MCP transport and apps with fixed telemetry fixtures.
 *
 * Spawns `bun dist/main.js --stdio` with a local typed fixture collector and asserts the direct
 * tool surface, MCP Apps metadata, trace/log behavior, explicit mode
 * selection, generated-fixture invariants, and dashboard aggregation.
 *
 * Run: node smoke-test.mjs   (after `bun run build`)
 */
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { getTelemetryFixture } from "./src/telemetry-fixtures.test-helper.ts";
import fixtureStats from "./fixtures/dashboard-stats.json" with { type: "json" };

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

// This fixture verifies child-process transport and app rendering only.
// Recorded-telemetry query semantics are verified in verify-answer-key.mjs.
const fixture = getTelemetryFixture();
const context = { window: { start_time: new Date(Date.now()-86_400_000).toISOString(), end_time: new Date().toISOString() }, coverage: { examined: 8, matched: 8, returned: 8, truncated: false, scan_complete: true, as_of: new Date().toISOString() } };
const fullTrace = trace => ({ ...trace, spans: trace.spans.map(span => ({ ...span, role: "matched" })) });
const fixtureCollector = createServer((request, response) => {
 void (async () => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const args = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const operation = request.url.split("/").at(-1);
  response.setHeader("content-type", "application/json");
  let data;
  switch (operation) {
    case "list_traces": data = { traces: fixture.traces.map(({spans: _spans,...trace})=>({ ...trace, root_error: trace.root_span?.status.code === 2, contained_error: trace.has_error, failure_ids: [], annotation_labels: [] })) }; break;
    case "get_trace": {
      const trace = fixture.traces.find(t=>t.trace_id===args.trace_id);
      if (!trace) { response.statusCode=404; response.setHeader("content-type","application/problem+json"); response.end(JSON.stringify({type:"https://qyl.at/problems/not-found",title:"Not Found",code:"not_found",status:404,detail:"trace not found"})); return; }
      data={trace:fullTrace(trace)}; break;
    }
    case "display_traces": data = {traces:fixture.traces.slice(0,args.limit ?? fixture.traces.length).map(fullTrace)}; break;
    case "search_logs": data={logs:fixture.logs.filter(l=>args.severity_min===undefined || l.severity_number>=args.severity_min)}; break;
    case "ci_log": data={runs:[]}; break;
    case "list_metrics": data={items:[0,1,2].map(i=>({name:`fixture.metric.${i}`,kind:"gauge",unit:"1",series_count:1,temporality:"unspecified",monotonic:false,last_seen:new Date().toISOString()}))}; break;
    case "display_mcp_dashboard": data={stats:{...fixtureStats,mode:"live"}}; break;
    case "fetch_telemetry":
      if(args.view==="mcp_stats") data={stats:{...fixtureStats,mode:"live"}};
      else if(args.view==="trace") data={trace:fullTrace(fixture.traces.find(t=>t.trace_id===args.trace_id))};
      else if(args.view==="logs") data={logs:fixture.logs.filter(l=>l.trace_id===args.trace_id)};
      else data={traces:fixture.traces.slice(0,args.limit ?? fixture.traces.length).map(fullTrace)};
      break;
    default: response.statusCode=400; response.setHeader("content-type","application/problem+json"); response.end(JSON.stringify({type:"https://qyl.at/problems/validation-failed",title:"Validation Failed",code:"validation_failed",errors:[],status:400,detail:"Writes require the real collector integration suite."})); return;
  }
  const paged = ["list_traces","get_trace","list_metrics","search_logs","ci_log","fetch_telemetry"].includes(operation);
  const pageContext = Array.isArray(data.traces) ? {...context, coverage:{...context.coverage, returned:data.traces.length, truncated:data.traces.length < fixture.traces.length}} : context;
  response.end(JSON.stringify({...pageContext,...(operation==="list_metrics"||operation==="display_mcp_dashboard"?{}:{mode:"live"}),...(paged?{has_more:false}:{}),...data}));
 })().catch(error=>{response.statusCode=500;response.end(String(error));});
});
await new Promise(resolve=>fixtureCollector.listen(0,"127.0.0.1",resolve));
const fixtureUrl=`http://127.0.0.1:${fixtureCollector.address().port}`;
const temp = await mkdtemp(join(tmpdir(), "qyl-mcp-server-smoke-"));
const nativeStatePath = join(temp, "native-executions.json");
const transport = new StdioClientTransport({
  command: "bun",
  args: ["dist/main.js", "--stdio"],
  env: {
    ...process.env,
    QYL_COLLECTOR_URL: fixtureUrl,
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

// --- 0. stdout hygiene ---------------------------------------------------
// A stdio MCP server owns stdout for JSON-RPC alone; every log line belongs on
// stderr. Proven in LIVE mode against an unreachable collector, so the startup
// warning is actually emitted, by teeing the raw stdout stream and parsing it.
console.log("stdout hygiene");
{
  const rawPath = join(temp, "stdout.raw");
  const hygieneTransport = new StdioClientTransport({
    command: "sh",
    args: ["-c", `exec bun dist/main.js --stdio | tee "${rawPath}"`],
    env: { ...process.env, QYL_COLLECTOR_URL: "http://127.0.0.1:9", QYL_MCP_TELEMETRY: "0", QYL_MCP_NATIVE_STATE_PATH: join(temp, "hygiene-native.json") },
    stderr: "ignore",
  });
  let transportErrors = 0;
  hygieneTransport.onerror = () => transportErrors++;
  const hygieneClient = new Client({ name: "qyl-smoke-hygiene", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await hygieneClient.connect(hygieneTransport);
  await hygieneClient.listTools();
  await hygieneClient.callTool({ name: "list_traces", arguments: { limit: 1 } });
  await hygieneClient.callTool({ name: "get_trace", arguments: { nonsense: 1 } }).catch(() => {});
  await hygieneClient.close();
  await new Promise((r) => setTimeout(r, 200));
  const lines = (await readFile(rawPath, "utf8")).split("\n").filter((l) => l.trim());
  const foreign = lines.filter((l) => { try { return JSON.parse(l).jsonrpc !== "2.0"; } catch { return true; } });
  check("stdout carried only JSON-RPC messages in live mode with a startup warning", lines.length >= 3 && foreign.length === 0, foreign.slice(0, 3).join(" | "));
  check("the client parsed every stdout line", transportErrors === 0, `${transportErrors} transport error(s)`);
}

// --- 1. Direct tools/list ----------------------------------------------------
console.log("tools/list");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "exactly the 32 supported tools",
  names.length === 32 &&
    JSON.stringify(names) ===
      JSON.stringify(
        [
          "triage", "list_failures", "get_failure_context", "compare_groups",
          "compare_traces", "verify_fix", "aggregate_telemetry", "discover_attributes",
          "get_agent_run", "list_releases", "get_service_map", "check_telemetry_health",
          "get_mcp_stats", "update_failure_status",
          "ci_log",
          "create_annotation",
          "create_saved_query",
          "delete",
          "display_mcp_dashboard",
          "display_traces",
          "fetch_telemetry",
          "get_metric_series",
          "get_trace",
          "list_metrics",
          "list_saved_queries",
          "list_sessions",
          "list_traces",
          "query_metric",
          "run_saved_query",
          "search_logs",
          "update_annotation",
          "update_saved_query",
        ].sort(),
      ),
  `got: ${names.join(", ")}`,
);

// Writes change only annotations and saved queries; their hints say so, and
// the collector enforces the verified project and required write roles.
const hints = (name) => JSON.stringify(tools.find((t) => t.name === name)?.annotations);
check(
  "create tools are additive, update and delete destructive and idempotent",
  hints("create_annotation") === JSON.stringify({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }) &&
    hints("create_saved_query") === hints("create_annotation") &&
    hints("update_annotation") === JSON.stringify({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }) &&
    hints("update_saved_query") === hints("update_annotation") &&
    hints("delete") === hints("update_annotation"),
  `${hints("create_annotation")} ${hints("update_annotation")} ${hints("delete")}`,
);
check(
  "every other tool stays read-only",
  tools
    .filter((t) => !["create_annotation", "update_annotation", "create_saved_query", "update_saved_query", "update_failure_status", "delete"].includes(t.name))
    .every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false),
);
const fixtureWrite = await callTool(client, "create_annotation", {
  target: { kind: "trace", trace_id: "0af7651916cd43dd8448eb211c80319c" },
  text: "smoke",
});
check(
  "read-only transport fixture refuses writes with a stable code",
  fixtureWrite.isError === true && fixtureWrite.structuredContent?.error?.code === "collector_rejected" &&
    !/real collector integration suite/u.test(fixtureWrite.content?.[0]?.text ?? ""),
  JSON.stringify(fixtureWrite),
);

const displayTraces = tools.find((t) => t.name === "display_traces");
check(
  "display_traces has _meta.ui.resourceUri",
  displayTraces?._meta?.ui?.resourceUri === "ui://qyl-explorer/mcp-app-v8.html",
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
    "ui://qyl-explorer/mcp-dashboard-v6.html",
  JSON.stringify(displayDashboard?._meta),
);


const ciLog = await callTool(client, "ci_log", {});
check("ci_log returns typed run evidence", !ciLog.isError && Array.isArray(ciLog.structuredContent?.runs));

// --- 2. Direct read tools + handler error contract ---------------------------
console.log("list_traces / get_trace error");
const listed = await callTool(client, "list_traces", {});
check("list_traces: not isError", !listed.isError, listed.content?.[0]?.text);
check(
  "list_traces returns 8 fixture trace summaries without spans",
  listed.structuredContent?.traces?.length === 8 &&
    listed.structuredContent.traces.every((t) => t.spans === undefined),
);
check('mode is live', listed.structuredContent?.mode === "live");

const missingTrace = await callTool(client, "get_trace", {
  trace_id: "0000000000000000000000000000dead",
});
check("handler failure returns isError:true", missingTrace.isError === true);
check(
  "missing-trace error is descriptive",
  missingTrace.structuredContent?.error?.code === "not_found" && /404/u.test(missingTrace.content?.[0]?.text ?? ""),
  missingTrace.content?.[0]?.text,
);

// --- 3. display_traces {} ----------------------------------------------------
console.log("display_traces {}");
const display = await client.callTool({ name: "display_traces", arguments: {} });
const sc = display.structuredContent;
check("not isError", !display.isError, display.content?.[0]?.text);
check("returns a bounded trace page", sc?.traces?.length > 0 && sc.traces.length <= 8, `got ${sc?.traces?.length}`);
check("response stays within24KB", Buffer.byteLength(JSON.stringify(display), "utf8") <= 24_000);
check('mode is live', sc?.mode === "live", `got ${sc?.mode}`);
check(
  "every trace has full spans (spans.length === span_count > 0)",
  sc?.traces?.every((t) => Array.isArray(t.spans) && t.spans.length === t.span_count && t.span_count > 0),
);

// Fixture-data sanity the waterfall depends on: children contained in parents,
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
      typeof l.body === "string" &&
      l.body.includes("   at "),
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
  many.structuredContent?.traces?.length > 0 && many.structuredContent.traces.length <= 8 &&
    many.structuredContent.traces.every((t) => t.spans.length > 0),
);

// --- 7. display_mcp_dashboard (fixture aggregation) -----------------------------
console.log("display_mcp_dashboard {}");
const dash = await client.callTool({
  name: "display_mcp_dashboard",
  arguments: {},
});
const stats = dash.structuredContent?.stats;
check("not isError", !dash.isError, dash.content?.[0]?.text);
check('mode is live', stats?.mode === "live", `got ${stats?.mode}`);
check("fixture reports complete coverage", stats?.truncated === false);
check(
  "totals.requests > 500 in the 24h fixture window",
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
    mcpStatsRes.structuredContent.stats.mode === "live",
);

// --- 9. resources/read of the debugger UIs -----------------------------------
console.log("resources/read ui://qyl-explorer/mcp-dashboard-v6.html");
if (existsSync(new URL("./dist/mcp-dashboard.html", import.meta.url))) {
  const dashRes = await client.readResource({
    uri: "ui://qyl-explorer/mcp-dashboard-v6.html",
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
  nativeState.version === 3 &&
    nativeState.executions.length >= 9 &&
    nativeState.executions.every((execution) =>
      execution.status !== "running" &&
      execution.durationMs >= 0 &&
      typeof execution.toolName === "string" &&
      typeof execution.id === "string"),
);
check(
  "native records contain only operation metadata",
  nativeState.executions.every((execution) =>
    Object.keys(execution).every((key) => [
      "id", "toolName", "status", "createdAt", "startedAt", "completedAt", "durationMs", "errorType",
    ].includes(key))),
);
} finally {
  await client.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}

// A stock SDK v2 client opens with the 2025 handshake. It uses the same
// standalone entry point and tool contract as the modern client above.
console.log("2025-era stdio compatibility");
const legacyTemp = await mkdtemp(join(tmpdir(), "qyl-mcp-legacy-smoke-"));
const legacyClient = new Client({ name: "qyl-smoke-legacy", version: "1.0.0" });
try {
  await legacyClient.connect(new StdioClientTransport({
    command: "bun",
    args: ["dist/main.js", "--stdio"],
    env: {
      ...process.env,
    QYL_COLLECTOR_URL: fixtureUrl, QYL_MCP_TELEMETRY: "0",
      QYL_MCP_NATIVE_STATE_PATH: join(legacyTemp, "native.json"),
    },
  }));
  check("stock client negotiated the legacy era", legacyClient.getProtocolEra() === "legacy");
  check("legacy catalog has all 32 tools", (await legacyClient.listTools()).tools.length === 32);
  const metrics = await legacyClient.callTool({ name: "list_metrics", arguments: {} });
  check("legacy read tool returns typed metric descriptors", !metrics.isError && metrics.structuredContent?.items?.length === 3, JSON.stringify(metrics));
  const invalid = await legacyClient.callTool({ name: "get_trace", arguments: {} });
  check("legacy invalid arguments remain a tool error", invalid.isError === true);
} finally {
  await legacyClient.close().catch(() => undefined);
  await rm(legacyTemp, { recursive: true, force: true });
  await new Promise(resolve=>fixtureCollector.close(resolve));
}


if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
