/**
 * Live smoke for every tool the server publishes, against a real collector.
 *
 * Starts the installed `qyl` tool (`qyl up`) with a hard timeout, sends OTLP/JSON
 * traces, logs and metrics to its receiver, then drives `dist/main.js --stdio`
 * in live mode through the MCP client and calls every tool — the write tools
 * through one annotation and one saved query it creates, changes and deletes
 * again — then repeats tools/list and one call over Streamable HTTP against a
 * second process. The Collector must serve the same contract revision as this package. Prints one
 * line per tool with isError, the structured-content keys and the first
 * numbers that matter, so a reader can judge "useful" as well as "works".
 *
 * Run: node live-tools-smoke.mjs   (after `bun run build`; needs `qyl` on PATH)
 * Env: QYL_BIN (default `qyl`), QYL_UP_TIMEOUT_MS (default 240000)
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const COLLECTOR = "http://127.0.0.1:5100";
const OTLP = "http://127.0.0.1:4318";
const QYL_BIN = process.env.QYL_BIN ?? "qyl";
const UP_TIMEOUT = Number(process.env.QYL_UP_TIMEOUT_MS ?? 240_000);

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---------------------------------------------------------------- collector
for (const port of [5100, 5200, 4318, 4317, 18889]) {
  try { execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: "ignore" }); throw new Error(`port ${port} is busy; this smoke starts its own collector`); }
  catch (e) { if (e.message?.startsWith("port")) throw e; }
}
const home = await mkdtemp(join(tmpdir(), "qyl-live-smoke-home-"));
const up = spawn(QYL_BIN, ["up"], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
let upLog = "";
up.stdout.on("data", (d) => (upLog += d));
up.stderr.on("data", (d) => (upLog += d));
const killUp = () => { if (!up.killed) up.kill("SIGTERM"); };
const deadline = setTimeout(() => { console.error("qyl up exceeded timeout"); killUp(); process.exit(2); }, UP_TIMEOUT);
process.on("exit", killUp);

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${COLLECTOR}/health`); if (r.ok) return await r.json(); } catch {}
    if (up.exitCode !== null) throw new Error(`qyl up exited ${up.exitCode}\n${upLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`collector never became healthy\n${upLog.slice(-2000)}`);
}
const health = await waitHealthy();
console.log(`collector healthy, contract ${health.contract_revision}`);

// ---------------------------------------------------------------- telemetry
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const attr = (k, v) => ({ key: k, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: String(v) } });
const traceId = hex(16), rootSpan = hex(8), childSpan = hex(8), sessionId = `live-smoke-${hex(4)}`;
const t0 = nowNs() - 2_000_000_000n;

const resource = (service) => ({ attributes: [attr("service.name", service), attr("service.version", "0.0.0-smoke")] });
const spans = {
  resourceSpans: [{
    resource: resource("live-smoke-api"),
    scopeSpans: [{ scope: { name: "live-smoke" }, spans: [
      { traceId, spanId: rootSpan, name: "GET /orders", kind: 2, startTimeUnixNano: String(t0), endTimeUnixNano: String(t0 + 120_000_000n),
        attributes: [attr("http.request.method", "GET"), attr("http.route", "/orders"), attr("http.response.status_code", 200), attr("session.id", sessionId)], status: { code: 1 } },
      { traceId, spanId: childSpan, parentSpanId: rootSpan, name: "tools/call", kind: 1, startTimeUnixNano: String(t0 + 10_000_000n), endTimeUnixNano: String(t0 + 90_000_000n),
        attributes: [attr("mcp.method.name", "tools/call"), attr("mcp.tool.name", "list_traces"), attr("session.id", sessionId)], status: { code: 2, message: "smoke error" } },
    ] }],
  }, {
    resource: resource("qyl-ci-live-smoke"),
    scopeSpans: [{ scope: { name: "ci" }, spans: [
      { traceId: hex(16), spanId: hex(8), name: "ci run", kind: 1, startTimeUnixNano: String(t0), endTimeUnixNano: String(t0 + 500_000_000n), attributes: [attr("session.id", `ci-${sessionId}`)], status: { code: 1 } },
    ] }],
  }],
};
const logs = { resourceLogs: [{ resource: resource("live-smoke-api"), scopeLogs: [{ scope: { name: "live-smoke" }, logRecords: [
  { timeUnixNano: String(t0 + 20_000_000n), severityNumber: 9, severityText: "INFO", body: { stringValue: "order listed for smoke" }, traceId, spanId: rootSpan, attributes: [attr("session.id", sessionId)] },
  { timeUnixNano: String(t0 + 30_000_000n), severityNumber: 17, severityText: "ERROR", body: { stringValue: "smoke error: upstream timeout" }, traceId, spanId: childSpan, attributes: [attr("session.id", sessionId)] },
] }] }] };
const metrics = { resourceMetrics: [{ resource: resource("live-smoke-api"), scopeMetrics: [{ scope: { name: "live-smoke" }, metrics: [
  { name: "http.server.request.duration", unit: "s", histogram: { aggregationTemporality: 2, dataPoints: [0, 1, 2].map((i) => ({
      startTimeUnixNano: String(t0), timeUnixNano: String(t0 + BigInt(i + 1) * 300_000_000n), count: "4", sum: 0.8, bucketCounts: ["1", "2", "1", "0"], explicitBounds: [0.1, 0.25, 0.5],
      attributes: [attr("http.request.method", "GET"), attr("http.route", "/orders")] })) } },
  { name: "live_smoke.requests", unit: "{request}", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [0, 1, 2].map((i) => ({
      startTimeUnixNano: String(t0), timeUnixNano: String(t0 + BigInt(i + 1) * 300_000_000n), asInt: String(10 * (i + 1)), attributes: [attr("http.route", "/orders")] })) } },
] }] }] };
/** @type {ReadonlyArray<readonly [string, unknown]>} */
const exports_ = [["traces", spans], ["logs", logs], ["metrics", metrics]];
for (const [path, body] of exports_) {
  const r = await fetch(`${OTLP}/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  ok(`OTLP /v1/${path} accepted`, r.ok, `${r.status} ${text.slice(0, 200)}`);
  if (path === "metrics") ok("metrics export has no partial_success rejection", !text.includes("rejected"), text.slice(0, 200));
}
await new Promise((r) => setTimeout(r, 2500)); // ingest settle

// ---------------------------------------------------------------- MCP client
const temp = await mkdtemp(join(tmpdir(), "qyl-live-smoke-"));
const transport = new StdioClientTransport({
  command: "node", args: ["dist/main.js", "--stdio"],
  env: { ...process.env, QYL_COLLECTOR_URL: COLLECTOR, QYL_MCP_TELEMETRY: "0", QYL_MCP_NATIVE_STATE_PATH: join(temp, "native.json") },
});
const client = new Client({ name: "qyl-live-smoke", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
const summary = (r) => {
  const sc = r.structuredContent ?? {};
  const keys = Object.keys(sc).slice(0, 6).join(",");
  const first = (r.content ?? []).find((c) => c.type === "text")?.text?.replace(/\s+/g, " ").slice(0, 110) ?? "";
  return `isError=${!!r.isError} keys=[${keys}] ${first}`;
};
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); console.log(`  ${name.padEnd(22)} ${summary(r)}`); return r; };
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  ok("32 tools listed", tools.length === 32, tools.map((t) => t.name).join(","));
  const windowArgs = { start_time: new Date(Date.now() - 3_600_000).toISOString(), end_time: new Date(Date.now() + 60_000).toISOString() };

  let r = await call("list_traces", { limit: 20 });
  ok("list_traces finds the smoke trace", JSON.stringify(r.structuredContent ?? r).includes(traceId), "trace id absent");
  r = await call("get_trace", { trace_id: traceId });
  ok("get_trace returns both spans", (JSON.stringify(r.structuredContent ?? r).match(/spanId|span_id/g) ?? []).length >= 2);
  r = await call("list_sessions", { limit: 20 });
  ok("list_sessions lists the smoke session", JSON.stringify(r.structuredContent ?? r).includes(sessionId));
  r = await call("search_logs", { query: "smoke", limit: 20 });
  ok("search_logs finds the two records", (JSON.stringify(r.structuredContent ?? r).match(/smoke/g) ?? []).length >= 2);
  r = await call("ci_log", { limit: 10 });
  ok("ci_log sees the qyl-ci service session", !r.isError && JSON.stringify(r.structuredContent ?? r).includes("ci-"));
  r = await call("list_metrics", {});
  ok("list_metrics lists both instruments", ["http.server.request.duration", "live_smoke.requests"].every((n) => JSON.stringify(r.structuredContent ?? r).includes(n)));
  r = await call("get_metric_series", { metric_name: "http.server.request.duration" });
  ok("get_metric_series shows http.route", JSON.stringify(r.structuredContent ?? r).includes("http.route"));
  r = await call("query_metric", { metric_name: "http.server.request.duration", ...windowArgs, step_ms: 3_660_000, aggregation: "p95" });
  ok("query_metric p95 over one bucket returns a number", !r.isError && /\d/.test(JSON.stringify(r.structuredContent ?? r)));
  r = await call("query_metric", { metric_name: "live_smoke.requests", ...windowArgs, step_ms: 3_660_000, aggregation: "sum", group_by: ["http.route"] });
  ok("query_metric sum grouped by route", !r.isError && JSON.stringify(r.structuredContent ?? r).includes("/orders"));
  r = await call("display_traces", {});
  const uiUri = (tool) => JSON.stringify(tools.find((t) => t.name === tool)?._meta ?? {}).match(/ui:\/\/[^"]+/)?.[0];
  ok("display_traces declares a UI resource in its _meta", !!uiUri("display_traces"), "no ui:// in _meta");
  const app = await client.readResource({ uri: uiUri("display_traces") });
  const html = app.contents?.[0]?.text ?? "";
  ok("the trace explorer resource is a single-file HTML app", html.includes("<html") && html.length > 10_000, `${html.length} chars`);
  const dash = await client.readResource({ uri: uiUri("display_mcp_dashboard") });
  ok("the MCP dashboard resource is a single-file HTML app", (dash.contents?.[0]?.text ?? "").includes("<html"));
  r = await call("display_mcp_dashboard", { hours: 1 });
  ok("display_mcp_dashboard aggregates the mcp.method.name span", !r.isError && JSON.stringify(r.structuredContent ?? r).includes("tools/call"));
  r = await call("fetch_telemetry", { view: "traces", limit: 5 });
  ok("fetch_telemetry (app plumbing) answers", !r.isError);

  // Every added read has a concrete call; results are validated by the client.
  /** @type {Array<[string, Record<string, unknown>]>} */
  const addedReads = [
    ["triage", windowArgs], ["list_failures", windowArgs],
    ["get_failure_context", { ...windowArgs, trace_id: traceId }],
    ["compare_groups", { ...windowArgs, signal: "spans", group_a: { matchers: [{ key: "error.type", op: "exists" }] }, group_b: "rest" }],
    ["compare_traces", { ...windowArgs, a: { trace_id: traceId }, b: { trace_id: traceId } }],
    ["aggregate_telemetry", { ...windowArgs, signal: "spans", measures: ["count", "error_rate"] }],
    ["discover_attributes", { ...windowArgs, signal: "resources" }],
    ["get_agent_run", { ...windowArgs, trace_id: traceId }],
    ["list_releases", windowArgs], ["get_service_map", windowArgs],
    ["check_telemetry_health", windowArgs], ["get_mcp_stats", windowArgs],
  ];
  for (const [name, args] of addedReads) { const result = await call(name, args); ok(name + " validates", !result.isError, summary(result)); }
  const failureList = await call("list_failures", windowArgs);
  const failure = failureList.structuredContent?.failures?.[0];
  ok("failure available for lifecycle checks", !!failure);
  if (failure) {
    r = await call("verify_fix", { ...windowArgs, failure_id: failure.failure_id, since: windowArgs.start_time });
    ok("verify_fix validates", !r.isError, summary(r));
    r = await call("update_failure_status", { failure_id: failure.failure_id, etag: failure.etag, status: "open" });
    ok("update_failure_status validates", !r.isError && !!r.structuredContent?.failure?.etag, summary(r));
  }

  // ------------------------------------------------------------ write tools
  // Local stdio has no OAuth: the Collector key decides what may change. Each
  // object the smoke creates is deleted again; the telemetry stays as sent.
  r = await call("create_annotation", { target: { kind: "trace", trace_id: traceId }, text: "live smoke note" });
  const note = r.structuredContent?.annotation;
  ok("create_annotation attaches a note to the smoke trace", !r.isError && note?.target?.trace_id === traceId, summary(r));
  r = await call("get_trace", { trace_id: traceId });
  ok("get_trace reads the note back", JSON.stringify(r.structuredContent?.annotations ?? []).includes("live smoke note"));
  r = await call("update_annotation", { id: note?.id, etag: note?.etag, text: "live smoke note, edited" });
  const edited = r.structuredContent?.annotation;
  ok("update_annotation replaces the text and moves the etag", !r.isError && edited?.etag !== note?.etag, summary(r));
  r = await call("update_annotation", { id: note?.id, etag: note?.etag, text: "stale" });
  ok("a stale etag is refused as precondition_failed", r.structuredContent?.error?.code === "precondition_failed", summary(r));
  const queryName = `${sessionId}-query`;
  r = await call("create_saved_query", { name: queryName, filter: { signal: "traces", lookback_minutes: 60 } });
  const saved = r.structuredContent?.saved_query;
  ok("create_saved_query stores a trace filter", !r.isError && saved?.name === queryName, summary(r));
  r = await call("create_saved_query", { name: queryName, filter: { signal: "traces" } });
  ok("a duplicate name is refused as conflict", r.structuredContent?.error?.code === "conflict", summary(r));
  r = await call("list_saved_queries", { signal: "traces" });
  ok("list_saved_queries lists it", JSON.stringify(r.structuredContent ?? r).includes(saved?.id ?? "missing"));
  r = await call("run_saved_query", { id: saved?.id });
  ok("run_saved_query finds the smoke trace", !r.isError && JSON.stringify(r.structuredContent ?? r).includes(traceId), summary(r));
  r = await call("update_saved_query", { id: saved?.id, etag: saved?.etag, name: queryName + "-updated" });
  const updatedQuery = r.structuredContent?.saved_query;
  ok("update_saved_query changes the saved object", !r.isError && updatedQuery?.etag !== saved?.etag, summary(r));
  r = await call("delete", { kind: "saved_query", id: updatedQuery?.id, etag: updatedQuery?.etag });
  ok("delete removes the saved query", r.structuredContent?.deleted === true, summary(r));
  r = await call("delete", { kind: "annotation", id: edited?.id, etag: edited?.etag });
  ok("delete removes the annotation", r.structuredContent?.deleted === true, summary(r));
  r = await call("get_trace", { trace_id: traceId });
  ok(
    "the trace is unchanged by every write and its annotations are gone",
    !r.isError && (r.structuredContent?.trace?.spans?.length ?? 0) >= 2 && (r.structuredContent?.annotations ?? []).length === 0,
    summary(r),
  );

  // ------------------------------------------------------------ HTTP transport
  const port = 3000 + Math.floor(Math.random() * 3000);
  const http = spawn("bun", ["dist/main.js"], { env: { ...process.env, QYL_COLLECTOR_URL: COLLECTOR, QYL_MCP_TELEMETRY: "0", PORT: String(port), QYL_MCP_NATIVE_STATE_PATH: join(temp, "native-http.json") }, stdio: ["ignore", "pipe", "pipe"] });
  let httpLog = ""; http.stdout.on("data", (d) => (httpLog += d)); http.stderr.on("data", (d) => (httpLog += d));
  try {
    for (let i = 0; i < 40 && !httpLog.includes("serving"); i++) await new Promise((r) => setTimeout(r, 250));
    ok("HTTP server announces its /mcp endpoint", httpLog.includes(`http://127.0.0.1:${port}/mcp`), httpLog.slice(-300));
    const httpClient = new Client({ name: "qyl-live-smoke-http", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const httpTools = await httpClient.listTools();
    ok("HTTP tools/list matches stdio", httpTools.tools.length === tools.length);
    const hr = await httpClient.callTool({ name: "get_trace", arguments: { trace_id: traceId } });
    ok("HTTP get_trace reaches the same live collector", !hr.isError && JSON.stringify(hr.structuredContent ?? hr).includes(traceId));
    const page = await fetch(`http://127.0.0.1:${port}/`);
    ok("HTTP serves the product page at /", page.ok && (await page.text()).includes("<html"));
    const unauth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    ok("HTTP rejects a bodiless POST without crashing", unauth.status >= 400 && unauth.status < 500, String(unauth.status));
    await httpClient.close().catch(() => {});
  } finally {
    http.kill("SIGTERM");
  }
} finally {
  await client.close().catch(() => {});
  clearTimeout(deadline); killUp();
  await rm(temp, { recursive: true, force: true }).catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : "all live checks passed");
process.exit(failures ? 1 : 0);
