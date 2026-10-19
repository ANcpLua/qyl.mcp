/**
 * Smoke test for the child-process MCP transport with fixed telemetry fixtures.
 *
 * Spawns `bun dist/main.js --stdio` with a local typed fixture collector and asserts the direct
 * tool surface, trace/log behavior, explicit mode selection and the native execution records.
 *
 * Run: node smoke-test.mjs   (after `bun run build`)
 */
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { getTelemetryFixture } from "./src/telemetry-fixtures.test-helper.ts";

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

// Presence and absence of named tools; the committed manifest pins the whole catalog.
const READ_TOOLS = [
  "triage", "list_failures", "get_failure_context", "compare_groups", "compare_traces", "verify_fix",
  "aggregate_telemetry", "discover_attributes", "get_agent_run", "list_releases", "get_service_map",
  "check_telemetry_health", "get_mcp_stats", "ci_log", "get_metric_series", "get_trace", "list_metrics",
  "list_saved_queries", "list_sessions", "list_traces", "query_metric", "run_saved_query", "search_logs",
];
const WRITE_TOOLS = [
  "create_annotation", "update_annotation", "create_saved_query", "update_saved_query",
  "update_failure_status", "delete_record",
];
const RETIRED_TOOLS = ["display_traces", "display_mcp_dashboard", "fetch_telemetry", "delete"];

// This fixture verifies the child-process transport only.
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
    case "search_logs": data={logs:fixture.logs.filter(l=>(args.severity_min===undefined || l.severity_number>=args.severity_min) && (args.trace_id===undefined || l.trace_id===args.trace_id))}; break;
    case "ci_log": data={runs:[]}; break;
    case "list_metrics": data={items:[0,1,2].map(i=>({instrument_id:`fixture-instrument-${i}`,has_conflict:false,name:`fixture.metric.${i}`,kind:"gauge",unit:"1",series_count:1,temporality:"unspecified",monotonic:false,last_seen:new Date().toISOString()}))}; break;
    default: response.statusCode=400; response.setHeader("content-type","application/problem+json"); response.end(JSON.stringify({type:"https://qyl.at/problems/validation-failed",title:"Validation Failed",code:"validation_failed",errors:[],status:400,detail:"Writes require the real collector integration suite."})); return;
  }
  const paged = ["list_traces","get_trace","list_metrics","search_logs","ci_log"].includes(operation);
  const pageContext = Array.isArray(data.traces) ? {...context, coverage:{...context.coverage, returned:data.traces.length, truncated:data.traces.length < fixture.traces.length}} : context;
  response.end(JSON.stringify({...pageContext,...(operation==="list_metrics"?{}:{mode:"live"}),...(paged?{has_more:false}:{}),...data}));
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
const names = new Set(tools.map((t) => t.name));
const missing = [...READ_TOOLS, ...WRITE_TOOLS].filter((name) => !names.has(name));
check("every read and write tool is published", missing.length === 0, `missing: ${missing.join(", ")}`);
const retired = RETIRED_TOOLS.filter((name) => names.has(name));
check("no viewer, app-only or pre-rename tool is published", retired.length === 0, `published: ${retired.join(", ")}`);
check("no tool names a UI resource", tools.every((t) => t._meta?.ui === undefined));

// Writes change only annotations and saved queries; their hints say so, and
// the collector enforces the verified project and required write roles.
const hints = (name) => JSON.stringify(tools.find((t) => t.name === name)?.annotations);
check(
  "create tools are additive, update and delete destructive and idempotent",
  hints("create_annotation") === JSON.stringify({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }) &&
    hints("create_saved_query") === hints("create_annotation") &&
    hints("update_annotation") === JSON.stringify({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }) &&
    hints("update_saved_query") === hints("update_annotation") &&
    hints("delete_record") === hints("update_annotation"),
  `${hints("create_annotation")} ${hints("update_annotation")} ${hints("delete_record")}`,
);
check(
  "every other tool stays read-only",
  tools
    .filter((t) => !WRITE_TOOLS.includes(t.name))
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

// --- 3. fixture traces -------------------------------------------------------
// The response budget may place a special case outside this bounded page.
// Fetch each known case explicitly so its transport assertions always run.
async function requiredFixtureTrace(predicate, label) {
  const expected = fixture.traces.find(predicate);
  assert(expected, `fixture must contain ${label}`);
  const result = await callTool(client, "get_trace", { trace_id: expected.trace_id });
  check(`${label}: not isError`, !result.isError, result.content?.[0]?.text);
  assert(result.structuredContent?.trace, `${label}: get_trace must return its typed trace`);
  return result.structuredContent.trace;
}
const errorTrace = await requiredFixtureTrace(t => t.has_error, "error trace");
check("the error trace has has_error", errorTrace.has_error === true);
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
const deepTrace = await requiredFixtureTrace(t => t.span_count >= 10, "deep trace");
check(
  "a deep trace with 10+ spans exists",
  deepTrace.span_count >= 10 && deepTrace.spans.length === deepTrace.span_count,
);
const genAiTrace = await requiredFixtureTrace(t => t.spans.some(s => s.attributes?.some(a => a.key === "gen_ai.system")), "gen_ai trace");
check(
  "gen_ai spans present",
  genAiTrace.spans.some((s) => s.attributes?.some((a) => a.key === "gen_ai.system")),
);

// --- 4. get_trace ------------------------------------------------------------
console.log("get_trace");
const someId = listed.structuredContent.traces[0].trace_id;
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

// --- 6. search_logs for the error trace -------------------------------------
console.log("search_logs { trace_id: <error trace> }");
const corr = await callTool(client, "search_logs", { trace_id: errorTrace.trace_id });
const corrLogs = corr.structuredContent?.logs;
check("not isError", !corr.isError, corr.content?.[0]?.text);
check("returns logs", Array.isArray(corrLogs) && corrLogs.length > 0);
check("every log belongs to the error trace", corrLogs?.every((l) => l.trace_id === errorTrace.trace_id));
check(
  "includes an ERROR log with a stacktrace body",
  corrLogs?.some(
    (l) =>
      l.severity_number >= 17 &&
      typeof l.body === "string" &&
      l.body.includes("   at "),
  ),
);

const nativeState = JSON.parse(await readFile(nativeStatePath, "utf8"));
check(
  "native tool execution evidence is automatic and terminal",
  nativeState.version === 3 &&
    nativeState.executions.length >= 8 &&
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
  const legacyNames = new Set((await legacyClient.listTools()).tools.map((t) => t.name));
  check(
    "legacy catalog publishes the same tools",
    [...READ_TOOLS, ...WRITE_TOOLS].every((name) => legacyNames.has(name)) &&
      RETIRED_TOOLS.every((name) => !legacyNames.has(name)),
  );
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
