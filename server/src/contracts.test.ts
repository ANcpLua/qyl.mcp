import assert from "node:assert/strict";
import test from "node:test";
import {
  DisplayMcpDashboardInputSchema,
  DisplayMcpDashboardOutputSchema,
  DisplayTracesInputSchema,
  DisplayTracesOutputSchema,
  FetchTelemetryInputSchema,
  FetchTelemetryOutputSchema,
  GetTraceInputSchema,
  GetTraceOutputSchema,
  ListSessionsInputSchema,
  ListSessionsOutputSchema,
  ListTracesInputSchema,
  ListTracesOutputSchema,
  SearchLogsInputSchema,
  SearchLogsOutputSchema,
  SpanSchema,
} from "./contract-validation.js";
import {
  parseCollectorLog,
  parseCollectorPage,
  parseCollectorSession,
  parseCollectorTrace,
} from "./collector.js";
import { getDemo } from "./demo.js";
import { fetchMcpStats } from "./data.js";

test("published schemas own defaults, bounds, and required inputs for all seven tools", () => {
  assert.deepEqual(DisplayTracesInputSchema.parse({}), { limit: 20 });
  assert(!DisplayTracesInputSchema.safeParse({ limit: 0 }).success);
  assert(!DisplayTracesInputSchema.safeParse({ limit: 101 }).success);

  assert.deepEqual(DisplayMcpDashboardInputSchema.parse({}), { hours: 24 });
  assert(!DisplayMcpDashboardInputSchema.safeParse({ hours: 0 }).success);
  assert(!DisplayMcpDashboardInputSchema.safeParse({ hours: 169 }).success);

  assert.deepEqual(ListTracesInputSchema.parse({}), { limit: 20 });
  assert(!ListTracesInputSchema.safeParse({ limit: 1.5 }).success);

  const traceId = "0".repeat(32);
  assert.deepEqual(GetTraceInputSchema.parse({ trace_id: traceId }), { trace_id: traceId });
  assert(!GetTraceInputSchema.safeParse({}).success);
  assert(!GetTraceInputSchema.safeParse({ trace_id: "short" }).success);

  assert.deepEqual(ListSessionsInputSchema.parse({}), { limit: 20 });
  assert.deepEqual(ListSessionsInputSchema.parse({ active_only: true }), {
    limit: 20,
    active_only: true,
  });
  assert(!ListSessionsInputSchema.safeParse({ limit: 101 }).success);

  assert.deepEqual(SearchLogsInputSchema.parse({}), { limit: 50 });
  assert(!SearchLogsInputSchema.safeParse({ severity_min: 0 }).success);
  assert(!SearchLogsInputSchema.safeParse({ severity_min: 25 }).success);
  assert(!SearchLogsInputSchema.safeParse({ limit: 201 }).success);

  assert.deepEqual(FetchTelemetryInputSchema.parse({ view: "traces" }), { view: "traces" });
  assert(!FetchTelemetryInputSchema.safeParse({}).success);
  assert(!FetchTelemetryInputSchema.safeParse({ view: "logs", severity_min: 25 }).success);
  assert(!FetchTelemetryInputSchema.safeParse({ view: "mcp_stats", hours: 169 }).success);
});

test("published output schemas accept the programmatically generated demo dataset", async () => {
  const demo = getDemo();
  const [trace] = demo.traces;
  const summaries = demo.traces.map(({ spans: _spans, ...summary }) => summary);

  assert(DisplayTracesOutputSchema.safeParse({ traces: demo.traces, mode: "demo" }).success);
  assert(ListTracesOutputSchema.safeParse({ traces: summaries, mode: "demo" }).success);
  assert(GetTraceOutputSchema.safeParse({ trace, mode: "demo" }).success);
  assert(ListSessionsOutputSchema.safeParse({ sessions: demo.sessions, mode: "demo" }).success);
  assert(SearchLogsOutputSchema.safeParse({ logs: demo.logs, mode: "demo" }).success);
  assert(FetchTelemetryOutputSchema.safeParse({ traces: demo.traces, mode: "demo" }).success);

  const previousDemo = process.env.QYL_DEMO;
  process.env.QYL_DEMO = "1";
  try {
    const stats = await fetchMcpStats(24);
    assert(DisplayMcpDashboardOutputSchema.safeParse({ stats }).success);
    assert(FetchTelemetryOutputSchema.safeParse({ stats, mode: stats.mode }).success);
  } finally {
    if (previousDemo === undefined) delete process.env.QYL_DEMO;
    else process.env.QYL_DEMO = previousDemo;
  }
});

test("64-bit JSON integers keep the published integer rule without a safe-integer ceiling", () => {
  const span = getDemo().traces[0].spans[0];
  const unixNanos = 1_742_000_000_123_456_789;
  assert(SpanSchema.safeParse({ ...span, start_time_unix_nano: unixNanos }).success);
  assert(!SpanSchema.safeParse({ ...span, start_time_unix_nano: 1.5 }).success);
});

test("TypeSpec record dictionaries retain their value contract at runtime", () => {
  const span = structuredClone(getDemo().traces[0].spans[0]);
  span.attributes = [
    {
      key: "nested",
      value: {
        message: "Grüße",
        retryable: true,
        attempts: 2,
      },
    },
  ];

  assert(SpanSchema.safeParse(span).success);
  span.attributes[0].value = { unsupported: null } as never;
  assert(!SpanSchema.safeParse(span).success);
});

test("collector boundary normalizes RFC 3339 offsets and rejects alternate wire encodings", () => {
  const demo = getDemo();
  const sourceTrace = structuredClone(demo.traces[0]);
  sourceTrace.start_time = sourceTrace.start_time.replace("Z", "+00:00");
  sourceTrace.end_time = sourceTrace.end_time.replace("Z", "+00:00");
  const page = parseCollectorPage(
    { items: [sourceTrace], has_more: false },
    "/api/v1/traces",
    parseCollectorTrace,
  );
  assert.equal(page.items[0].start_time.endsWith("Z"), true);
  assert.equal(typeof page.items[0].spans[0].kind, "number");
  assert.equal(page.hasMore, false);

  assert.throws(
    () => parseCollectorPage([sourceTrace], "/api/v1/traces", parseCollectorTrace),
    /expected an object/,
  );
  assert.throws(
    () => parseCollectorPage({ items: [] }, "/api/v1/traces", parseCollectorTrace),
    /has_more:boolean/,
  );

  const session = structuredClone(demo.sessions[0]);
  session.start_time = session.start_time.replace("Z", "+00:00");
  assert.equal(parseCollectorSession(session).state, demo.sessions[0].state);

  const log = structuredClone(demo.logs[0]);
  const normalizedLog = parseCollectorLog(log);
  assert.equal(normalizedLog.severity_number, log.severity_number);
  assert.equal(normalizedLog.severity_text, log.severity_text);

  const malformedTrace = structuredClone(sourceTrace);
  malformedTrace.spans[0].kind = "Client" as never;
  assert.throws(() => parseCollectorTrace(malformedTrace), /collector contract mismatch/);

  const malformedLog = structuredClone(log);
  malformedLog.severity_number = "Info" as never;
  assert.throws(() => parseCollectorLog(malformedLog), /collector contract mismatch/);
});
