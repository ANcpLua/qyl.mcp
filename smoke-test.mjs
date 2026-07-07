/**
 * Smoke test for qyl-apps-server (demo mode, stdio).
 *
 * Spawns `node dist/index.js --stdio` with QYL_DEMO=1 and asserts the
 * INTERFACE.md contract: tool list + _meta, display_traces, get_trace,
 * search_logs severity filtering, fetch_telemetry correlated logs, and
 * demo-data parent/child span time containment.
 *
 * Run: node smoke-test.mjs   (after `npm run build`)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--stdio"],
  env: { ...process.env, QYL_DEMO: "1" },
});
const client = new Client({ name: "qyl-smoke", version: "1.0.0" });
await client.connect(transport);

// --- 1. Tool list + _meta ---------------------------------------------------
console.log("tools/list");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "6 tools registered",
  names.length === 6 &&
    JSON.stringify(names) ===
      JSON.stringify(
        [
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

// --- 2. display_traces {} ----------------------------------------------------
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

// --- 3. get_trace ------------------------------------------------------------
console.log("get_trace");
const someId = sc.traces[0].trace_id;
const got = await client.callTool({
  name: "get_trace",
  arguments: { trace_id: someId },
});
check("not isError", !got.isError, got.content?.[0]?.text);
check(
  "returns the trace with spans",
  got.structuredContent?.trace?.trace_id === someId &&
    got.structuredContent.trace.spans.length > 0,
);

// --- 4. search_logs severity_min:17 -------------------------------------------
console.log("search_logs { severity_min: 17 }");
const logsRes = await client.callTool({
  name: "search_logs",
  arguments: { severity_min: 17 },
});
const logs = logsRes.structuredContent?.logs;
check("not isError", !logsRes.isError, logsRes.content?.[0]?.text);
check("returns at least one log", Array.isArray(logs) && logs.length > 0);
check(
  "only ERROR+ logs (severity_number >= 17)",
  logs?.every((l) => l.severity_number >= 17),
  JSON.stringify(logs?.map((l) => l.severity_number)),
);

// --- 5. fetch_telemetry view:"logs" for the error trace -----------------------
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

await client.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
