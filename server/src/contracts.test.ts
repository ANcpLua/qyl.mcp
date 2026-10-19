import assert from "node:assert/strict";
import test from "node:test";
import * as ContractSchemas from "./contract-validation.js";
import {
  GetTraceInputSchema,
  GetTraceOutputSchema,
  ListSessionsInputSchema,
  ListSessionsOutputSchema,
  ListTracesInputSchema,
  ListTracesOutputSchema,
  SearchLogsInputSchema,
  SearchLogsOutputSchema,
  SpanSchema,
  ToolErrorSchema,
  TraceSchema,
} from "./contract-validation.js";
import {
  CollectorError,
  parseCollectorBody,
} from "./collector.js";
import { readContext, toolTrace, toolSummary } from "./analysis-context.test-helper.js";
import { getTelemetryFixture } from "./telemetry-fixtures.test-helper.js";
const CiLogInputSchema = ContractSchemas.contractSchema("Mcp.Tools.CiLogInput");
import { toolError } from "./request-scope.js";

test("published telemetry schemas own defaults, bounds, and required tool inputs", () => {
  assert.deepEqual(ListTracesInputSchema.parse({}), { limit: 20 });
  assert(!ListTracesInputSchema.safeParse({ limit: 1.5 }).success);
  assert(ListTracesInputSchema.safeParse({
    start_time: "2026-10-11T00:00:00Z",
    end_time: "2026-10-11T01:00:00Z",
    service_name: "checkout-api",
    errors_only: true,
    cursor: "opaque",
  }).success);
  assert(!ListTracesInputSchema.safeParse({ start_time: "2026-10-11" }).success, "RFC 3339 only");
  assert(!ListTracesInputSchema.safeParse({ errors_only: "true" }).success);

  const traceId = "0".repeat(32);
  assert.deepEqual(GetTraceInputSchema.parse({ trace_id: traceId }), {
    trace_id: traceId, errors_only: false, include_attributes: true,
  });
  assert(!GetTraceInputSchema.safeParse({}).success);
  assert(!GetTraceInputSchema.safeParse({ trace_id: "short" }).success);
  for (const max_spans of [0, 1001, 1.5]) {
    assert(!GetTraceInputSchema.safeParse({ trace_id: traceId, max_spans }).success);
  }
  for (const max_spans of [1, 1000]) {
    assert(GetTraceInputSchema.safeParse({ trace_id: traceId, max_spans }).success);
  }
  assert(!GetTraceInputSchema.safeParse({ trace_id: traceId, errors_only: "true" }).success);
  assert(!GetTraceInputSchema.safeParse({ trace_id: traceId, include_attributes: "false" }).success);
  assert.deepEqual(CiLogInputSchema.parse({}), { service_prefix: "qyl-ci", limit: 10 });
  assert(!CiLogInputSchema.safeParse({ service_prefix: "" }).success);
  assert(!CiLogInputSchema.safeParse({ service_prefix: "x".repeat(257) }).success);
  assert(CiLogInputSchema.safeParse({ service_prefix: "x".repeat(256) }).success);

  assert.deepEqual(ListSessionsInputSchema.parse({}), { limit: 20 });
  assert.deepEqual(ListSessionsInputSchema.parse({ active_only: true }), {
    limit: 20,
    active_only: true,
  });
  assert(!ListSessionsInputSchema.safeParse({ limit: 101 }).success);
  assert(ListSessionsInputSchema.safeParse({ start_time: "2026-10-11T00:00:00Z", cursor: "opaque" }).success);

  assert.deepEqual(SearchLogsInputSchema.parse({}), { limit: 50 });
  assert(!SearchLogsInputSchema.safeParse({ severity_min: 0 }).success);
  assert(!SearchLogsInputSchema.safeParse({ severity_min: 25 }).success);
  assert(!SearchLogsInputSchema.safeParse({ limit: 201 }).success);
  assert(SearchLogsInputSchema.safeParse({
    session_id: "sess-demo-genai-01",
    start_time: "2026-10-11T00:00:00Z",
    end_time: "2026-10-11T01:00:00Z",
    cursor: "opaque",
  }).success);
});

test("the server's error codes are the contract's ToolErrorCode enum", () => {
  for (const error of [
    new CollectorError("bad input"),
    new CollectorError("gone", false, 404),
    new CollectorError("down", true),
    new Error("Authorization: Bearer should-never-escape"),
  ]) {
    const structured = toolError(error).structuredContent as { error: unknown };
    assert(ToolErrorSchema.safeParse(structured.error).success, String(error));
  }
});

test("published output schemas accept the test telemetry fixture", async () => {
  const fixture = getTelemetryFixture();
  const [trace] = fixture.traces;
  const summaries = fixture.traces.map(toolSummary);
  const context = readContext(fixture.traces.length);

  assert(ListTracesOutputSchema.safeParse({ ...context, traces: summaries, mode: "live", has_more: false }).success);
  assert(
    !ListTracesOutputSchema.safeParse({ ...readContext(fixture.traces.length, false), traces: summaries, mode: "live" }).success,
    "has_more is required: a page must say whether it is the whole result",
  );
  assert(ListTracesOutputSchema.safeParse({ ...context, traces: summaries, mode: "live", has_more: true, next_cursor: "c" }).success);
  assert(GetTraceOutputSchema.safeParse({ ...context, trace: toolTrace(trace!), mode: "live" }).success);
  assert(ListSessionsOutputSchema.safeParse({ ...context, sessions: fixture.sessions, mode: "live", has_more: false }).success);
  assert(SearchLogsOutputSchema.safeParse({ ...context, logs: fixture.logs, mode: "live", has_more: false }).success);
});

test("64-bit nanosecond timestamps survive the wire exactly, above the safe-integer ceiling", () => {
  const span = getTelemetryFixture().traces[0].spans[0];
  // Past Number.MAX_SAFE_INTEGER: as a JS number literal this value silently becomes
  // ...456_800, which is the precision loss the decimal-string encoding exists to remove.
  const unixNanos = "1742000000123456789";
  const parsed = SpanSchema.safeParse({ ...span, start_time_unix_nano: unixNanos });
  assert(parsed.success);
  assert.equal(parsed.data.start_time_unix_nano, unixNanos);
  assert.equal(BigInt(parsed.data.start_time_unix_nano), 1742000000123456789n);

  assert(!SpanSchema.safeParse({ ...span, start_time_unix_nano: "1.5" }).success);
  assert(!SpanSchema.safeParse({ ...span, start_time_unix_nano: 1.5 }).success);
});

test("TypeSpec record dictionaries retain their value contract at runtime", () => {
  const span = structuredClone(getTelemetryFixture().traces[0].spans[0]);
  span.attributes = [
    {
      key: "nested",
      value: {
        type: "kvlist",
        values: {
          message: "Grüße",
          retryable: true,
          attempts: { type: "int", value: "2" },
        },
      },
    },
  ];

  assert(SpanSchema.safeParse(span).success);
  span.attributes![0]!.value = { unsupported: null } as never;
  assert(!SpanSchema.safeParse(span).success);
});

test("analysis boundary preserves RFC 3339 precision and rejects alternate wire encodings", () => {
  const trace = toolSummary(structuredClone(getTelemetryFixture().traces[0]!));
  trace.start_time = "2026-07-28T12:00:00.123456789+02:00";
  const body = { ...readContext(1), traces: [trace], mode: "live" };
  const parse = (value: unknown) => parseCollectorBody(value, "/api/v1/analysis/list_traces", ListTracesOutputSchema);
  assert.equal(parse(body).traces[0]?.start_time, trace.start_time);
  assert.throws(() => parse([trace]), /collector contract mismatch/u);
  assert.throws(() => parse({ ...body, has_more: undefined }), /has_more/u);
  assert.throws(() => parse({ ...body, invented: true }), /Unrecognized key/u);
  trace.root_span!.kind = "Client" as never;
  assert.throws(() => parse(body), /collector contract mismatch/u);
});

test("contract date-time fields accept RFC 3339 and reject its near-misses", () => {
  const trace = structuredClone(getTelemetryFixture().traces[0]);
  // Seconds are mandatory in RFC 3339 `partial-time`, an offset is `HH:MM`, and
  // one of `Z` or an offset is mandatory -- the three rejections below. A Zod
  // pattern change that loosens or tightens any of them fails here by value.
  const cases = [
    ["2026-07-28T12:00:00Z", true],
    ["2026-07-28T12:00:00+02:00", true],
    ["2026-07-28T12:00:00.123456789Z", true],
    ["2026-07-28T12:00Z", false],
    ["2026-07-28T12:00:00+0200", false],
    ["2026-07-28T12:00:00", false],
  ] as const;

  for (const [value, accepted] of cases) {
    assert.equal(
      TraceSchema.safeParse({ ...trace, start_time: value }).success,
      accepted,
      `start_time ${value} should be ${accepted ? "accepted" : "rejected"}`,
    );
  }
});

test("an inherited Object.prototype key is not a contract definition", () => {
  // `$defs` comes from `Object.fromEntries`, so `in` answers true for every
  // `Object.prototype` key. Before the `Object.hasOwn` guard these resolved
  // through `#/$defs/<key>` to `z.any()`: a validator that accepts anything,
  // installed silently where the missing-definition throw belongs.
  for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(
      () => ContractSchemas.publishedContractSchema(inherited),
      new RegExp(`has no '${inherited}' definition`),
      `${inherited} must not resolve to a contract definition`,
    );
  }
});
