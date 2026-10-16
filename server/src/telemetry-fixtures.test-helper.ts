/** Small deterministic trace, log and session fixtures for tests; never shipped. */
const collectorUrl = () => "http://127.0.0.1:5343";
import type { QylLogRecord, QylSession, QylSpan, QylTrace } from "./wire.js";
import type {
  Attribute,
  AttributeValue,
  Resource,
  SessionState,
  SeverityNumber,
  UserId,
} from "@ancplua/qyl-api-schema/types";
import { parseSessionId, parseSpanId, parseTraceId } from "@ancplua/qyl-api-schema/types";
import { epochMsToUnixNanos } from "@ancplua/qyl-api-schema/runtime";

/** Deterministic, valid lowercase-hex trace or span id. */
function hexId(seed: number, length: number): string {
  let hex = "";
  let x = (seed ^ 0x5f3759df) >>> 0;
  while (hex.length < length) {
    x = (x * 1664525 + 1013904223) >>> 0;
    hex += x.toString(16).padStart(8, "0");
  }
  return hex.slice(0, length);
}

/** The "now" every fixture timestamp offsets from. */
const fixtureAnchorMs = Date.now();
const minutesAgoMs = (minutes: number) => fixtureAnchorMs - minutes * 60_000;
// Absolute nanosecond timestamps are decimal strings on the wire: an epoch-ns value
const intAttribute = (value: number): AttributeValue => ({
  type: "int",
  value: String(value),
});

/** Per-service OTel resources shared by fixture spans and logs. */
const FIXTURE_RESOURCES: Record<string, Resource> = {
  "qyl-collector": {
    "service_name": "qyl-collector",
    attributes: [
      { key: "service.version", value: "0.4.2" },
      { key: "telemetry.sdk.language", value: "dotnet" },
    ],
  },
  "checkout-api": {
    "service_name": "checkout-api",
    attributes: [
      { key: "service.version", value: "2.11.0" },
      { key: "telemetry.sdk.language", value: "dotnet" },
      { key: "deployment.environment.name", value: "staging" },
    ],
  },
  "agent-worker": {
    "service_name": "agent-worker",
    attributes: [
      { key: "service.version", value: "1.3.7" },
      { key: "telemetry.sdk.language", value: "python" },
    ],
  },
};

/** Span blueprint: offsets are milliseconds relative to the trace start. */
interface FixtureSpanSpec {
  parent?: number; // index into the spec array
  name: string;
  kind: QylSpan["kind"];
  service: keyof typeof FIXTURE_RESOURCES;
  start: number;
  end: number;
  attrs?: Record<string, AttributeValue>;
  status?: QylSpan["status"];
  events?: Array<{ name: string; atMs: number; attributes?: Attribute[] }>;
}

function buildFixtureTrace(
  seq: number,
  startMs: number,
  specs: FixtureSpanSpec[],
): QylTrace {
  const traceId = parseTraceId(hexId(seq * 7919 + 17, 32));

  const spans: QylSpan[] = specs.map((spec, index) => {
    const span: QylSpan = {
      span_id: parseSpanId(hexId(seq * 104_729 + index * 31 + 5, 16)),
      trace_id: traceId,
      name: spec.name,
      kind: spec.kind,
      start_time_unix_nano: epochMsToUnixNanos(startMs + spec.start),
      end_time_unix_nano: epochMsToUnixNanos(startMs + spec.end),
      status: spec.status ?? { code: 0 },
      resource: FIXTURE_RESOURCES[spec.service],
    };
    if (spec.attrs) {
      span.attributes = Object.entries(spec.attrs).map(([key, value]) => ({
        key,
        value,
      }));
    }
    if (spec.events) {
      span.events = spec.events.map((event) => ({
        name: event.name,
        time_unix_nano: epochMsToUnixNanos(startMs + event.atMs),
        ...(event.attributes ? { attributes: event.attributes } : {}),
      }));
    }
    return span;
  });

  // Wire up parent ids after all span ids exist.
  specs.forEach((spec, index) => {
    if (spec.parent !== undefined) {
      spans[index].parent_span_id = spans[spec.parent].span_id;
    }
  });

  const startNano = spans
    .map((s) => BigInt(s.start_time_unix_nano))
    .reduce((min, v) => (v < min ? v : min));
  const endNano = spans
    .map((s) => BigInt(s.end_time_unix_nano))
    .reduce((max, v) => (v > max ? v : max));
  const services = [
    ...new Set(spans.map((s) => String(s.resource.service_name))),
  ];

  return {
    trace_id: traceId,
    spans,
    root_span: spans.find((s) => !s.parent_span_id),
    span_count: spans.length,
    duration_ns: (endNano - startNano).toString(),
    start_time: new Date(Number(startNano / 1_000_000n)).toISOString(),
    end_time: new Date(Number(endNano / 1_000_000n)).toISOString(),
    services,
    has_error: spans.some((s) => s.status.code === 2),
  };
}

interface TelemetryFixture {
  traces: QylTrace[]; // newest first
  logs: QylLogRecord[]; // oldest first
  sessions: QylSession[];
  sessionTraces: Record<string, QylTrace[]>;
}

function buildTelemetryFixture(): TelemetryFixture {
  const NPGSQL_STACKTRACE = [
    "Npgsql.NpgsqlException (0x80004005): Exception while writing to stream",
    " ---> System.IO.IOException: Unable to write data to the transport connection: Connection reset by peer.",
    " ---> System.Net.Sockets.SocketException (104): Connection reset by peer",
    "   at System.Net.Sockets.NetworkStream.Write(ReadOnlySpan`1 buffer)",
    "   --- End of inner exception stack trace ---",
    "   at Npgsql.Internal.NpgsqlConnector.Flush(Boolean async)",
    "   at Npgsql.NpgsqlCommand.ExecuteReader(CommandBehavior behavior)",
    "   at CheckoutApi.Orders.OrderRepository.InsertAsync(Order order) in /src/Orders/OrderRepository.cs:line 88",
    "   at CheckoutApi.Checkout.CheckoutHandler.Handle(CheckoutCommand cmd) in /src/Checkout/CheckoutHandler.cs:line 54",
  ].join("\n");

  // --- Trace 1 (2 min ago): agentic GenAI run — plan, two model calls, a tool
  // with a DuckDB lookup. agent-worker.
  const agentRun = buildFixtureTrace(1, minutesAgoMs(2), [
    {
      name: "POST /v1/agent/run",
      kind: 2,
      service: "agent-worker",
      start: 0,
      end: 4200,
      status: { code: 1 },
      attrs: {
        "http.request.method": "POST",
        "url.path": "/v1/agent/run",
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 0,
      name: "agent.plan",
      kind: 1,
      service: "agent-worker",
      start: 15,
      end: 70,
      attrs: { "gen_ai.operation.name": "invoke_agent" },
    },
    {
      parent: 0,
      name: "chat claude-sonnet-5",
      kind: 3,
      service: "agent-worker",
      start: 90,
      end: 2350,
      attrs: {
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5",
        "gen_ai.response.model": "claude-sonnet-5",
        "gen_ai.usage.input_tokens": intAttribute(1874),
        "gen_ai.usage.output_tokens": intAttribute(412),
      },
    },
    {
      parent: 0,
      name: "tool.execute search_docs",
      kind: 1,
      service: "agent-worker",
      start: 2400,
      end: 2900,
      attrs: { "gen_ai.tool.name": "search_docs" },
    },
    {
      parent: 3,
      name: "SELECT docs",
      kind: 3,
      service: "agent-worker",
      start: 2410,
      end: 2600,
      attrs: {
        "db.system": "duckdb",
        "db.statement":
          "SELECT id, title, snippet FROM docs WHERE match_bm25(content, ?) LIMIT 10",
      },
    },
    {
      parent: 0,
      name: "chat claude-sonnet-5",
      kind: 3,
      service: "agent-worker",
      start: 2950,
      end: 4150,
      attrs: {
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5",
        "gen_ai.response.model": "claude-sonnet-5",
        "gen_ai.usage.input_tokens": intAttribute(2412),
        "gen_ai.usage.output_tokens": intAttribute(655),
      },
    },
  ]);

  // --- Trace 2 (5 min ago): GenAI summarize that calls the collector's own
  // API cross-service (agent-worker → qyl-collector → DuckDB).
  const agentSummarize = buildFixtureTrace(2, minutesAgoMs(5), [
    {
      name: "POST /v1/agent/summarize",
      kind: 2,
      service: "agent-worker",
      start: 0,
      end: 2800,
      status: { code: 1 },
      attrs: {
        "http.request.method": "POST",
        "url.path": "/v1/agent/summarize",
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 0,
      name: "chat claude-haiku-4-5",
      kind: 3,
      service: "agent-worker",
      start: 40,
      end: 1900,
      attrs: {
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.response.model": "claude-haiku-4-5-20251001",
        "gen_ai.usage.input_tokens": intAttribute(932),
        "gen_ai.usage.output_tokens": intAttribute(208),
      },
    },
    {
      parent: 0,
      name: "GET /api/v1/traces",
      kind: 3,
      service: "agent-worker",
      start: 1950,
      end: 2100,
      attrs: {
        "http.request.method": "GET",
        "url.full": `${collectorUrl()}/api/v1/traces?limit=20`,
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 2,
      name: "GET /api/v1/traces",
      kind: 2,
      service: "qyl-collector",
      start: 1960,
      end: 2085,
      attrs: {
        "http.request.method": "GET",
        "url.path": "/api/v1/traces",
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 3,
      name: "SELECT traces",
      kind: 3,
      service: "qyl-collector",
      start: 1970,
      end: 2075,
      attrs: {
        "db.system": "duckdb",
        "db.statement":
          "SELECT trace_id, min(start_time_unix_nano) FROM spans GROUP BY trace_id ORDER BY 2 DESC LIMIT 20",
      },
    },
  ]);

  // --- Trace 3 (8 min ago): failed checkout — Postgres insert dies with an
  // exception event; root span carries the error status too.
  const checkoutError = buildFixtureTrace(3, minutesAgoMs(8), [
    {
      name: "POST /checkout",
      kind: 2,
      service: "checkout-api",
      start: 0,
      end: 430,
      status: { code: 2, message: "checkout failed: order persistence error" },
      attrs: {
        "http.request.method": "POST",
        "url.path": "/checkout",
        "http.response.status_code": intAttribute(500),
      },
    },
    {
      parent: 0,
      name: "validate cart",
      kind: 1,
      service: "checkout-api",
      start: 5,
      end: 35,
      attrs: { "db.operation.name": "SELECT" },
    },
    {
      parent: 0,
      name: "reserve inventory",
      kind: 1,
      service: "checkout-api",
      start: 40,
      end: 160,
    },
    {
      parent: 2,
      name: "UPDATE inventory",
      kind: 3,
      service: "checkout-api",
      start: 45,
      end: 150,
      attrs: {
        "db.system": "postgresql",
        "db.statement":
          "UPDATE inventory SET reserved = reserved + $1 WHERE sku = $2 AND available >= $1",
      },
    },
    {
      parent: 0,
      name: "INSERT INTO orders",
      kind: 3,
      service: "checkout-api",
      start: 170,
      end: 410,
      status: { code: 2, message: "connection reset by peer" },
      attrs: {
        "db.system": "postgresql",
        "db.statement":
          "INSERT INTO orders (id, user_id, total_cents, status) VALUES ($1, $2, $3, 'pending')",
      },
      events: [
        {
          name: "exception",
          atMs: 405,
          attributes: [
            { key: "exception.type", value: "Npgsql.NpgsqlException" },
            {
              key: "exception.message",
              value:
                "Exception while writing to stream: connection reset by peer",
            },
            { key: "exception.stacktrace", value: NPGSQL_STACKTRACE },
          ],
        },
      ],
    },
  ]);

  // --- Trace 4 (11 min ago): read-path order lookup, two Postgres queries.
  const orderLookup = buildFixtureTrace(4, minutesAgoMs(11), [
    {
      name: "GET /orders/{orderId}",
      kind: 2,
      service: "checkout-api",
      start: 0,
      end: 96,
      status: { code: 1 },
      attrs: {
        "http.request.method": "GET",
        "http.route": "/orders/{orderId}",
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 0,
      name: "SELECT orders",
      kind: 3,
      service: "checkout-api",
      start: 8,
      end: 34,
      attrs: {
        "db.system": "postgresql",
        "db.statement": "SELECT * FROM orders WHERE id = $1",
      },
    },
    {
      parent: 0,
      name: "SELECT order_items",
      kind: 3,
      service: "checkout-api",
      start: 38,
      end: 71,
      attrs: {
        "db.system": "postgresql",
        "db.statement":
          "SELECT sku, quantity, price_cents FROM order_items WHERE order_id = $1",
      },
    },
    {
      parent: 0,
      name: "render response",
      kind: 1,
      service: "checkout-api",
      start: 74,
      end: 92,
    },
  ]);

  // --- Trace 5 (13 min ago): messaging — checkout publishes order.shipped,
  // agent-worker consumes it and notifies the customer.
  const orderShipped = buildFixtureTrace(5, minutesAgoMs(13), [
    {
      name: "POST /orders/{orderId}/ship",
      kind: 2,
      service: "checkout-api",
      start: 0,
      end: 115,
      status: { code: 1 },
      attrs: {
        "http.request.method": "POST",
        "http.route": "/orders/{orderId}/ship",
        "http.response.status_code": intAttribute(202),
      },
    },
    {
      parent: 0,
      name: "publish order.shipped",
      kind: 4,
      service: "checkout-api",
      start: 20,
      end: 112,
      attrs: {
        "messaging.system": "kafka",
        "messaging.destination.name": "order.events",
        "messaging.operation.type": "publish",
      },
    },
    {
      parent: 1,
      name: "process order.shipped",
      kind: 5,
      service: "agent-worker",
      start: 60,
      end: 108,
      attrs: {
        "messaging.system": "kafka",
        "messaging.destination.name": "order.events",
        "messaging.operation.type": "process",
      },
    },
    {
      parent: 2,
      name: "notify customer",
      kind: 1,
      service: "agent-worker",
      start: 65,
      end: 100,
      attrs: { "messaging.destination.name": "email" },
    },
  ]);

  // --- Trace 6 (3 min ago): deep async pipeline — 13 spans, 4 levels, with a
  // slow shard that needed a retry.
  const pipeline = buildFixtureTrace(6, minutesAgoMs(3), [
    {
      name: "pipeline.run nightly-eval",
      kind: 1,
      service: "agent-worker",
      start: 0,
      end: 8600,
      status: { code: 1 },
      attrs: { "gen_ai.operation.name": "invoke_agent" },
    },
    { parent: 0, name: "stage.collect", kind: 1, service: "agent-worker", start: 20, end: 2100 },
    {
      parent: 1,
      name: "fetch dataset shard-1",
      kind: 3,
      service: "agent-worker",
      start: 40,
      end: 900,
      attrs: { "url.path": "/datasets/eval/shard-1" },
    },
    {
      parent: 1,
      name: "fetch dataset shard-2",
      kind: 3,
      service: "agent-worker",
      start: 60,
      end: 1400,
      attrs: { "url.path": "/datasets/eval/shard-2" },
    },
    {
      parent: 1,
      name: "fetch dataset shard-3",
      kind: 3,
      service: "agent-worker",
      start: 80,
      end: 2050,
      attrs: {
        "url.path": "/datasets/eval/shard-3",
        "http.request.resend_count": intAttribute(1),
      },
    },
    {
      parent: 4,
      name: "GET shard-3 (retry)",
      kind: 3,
      service: "agent-worker",
      start: 1100,
      end: 2000,
      attrs: { "url.path": "/datasets/eval/shard-3" },
    },
    { parent: 0, name: "stage.transform", kind: 1, service: "agent-worker", start: 2150, end: 5100 },
    { parent: 6, name: "normalize records", kind: 1, service: "agent-worker", start: 2160, end: 3600 },
    { parent: 6, name: "dedupe records", kind: 1, service: "agent-worker", start: 3620, end: 5050 },
    { parent: 8, name: "hash partition 0", kind: 1, service: "agent-worker", start: 3630, end: 4300 },
    { parent: 8, name: "hash partition 1", kind: 1, service: "agent-worker", start: 3640, end: 5000 },
    { parent: 0, name: "stage.load", kind: 1, service: "agent-worker", start: 5150, end: 8550 },
    {
      parent: 11,
      name: "INSERT eval_results",
      kind: 3,
      service: "agent-worker",
      start: 5200,
      end: 8500,
      attrs: {
        "db.system": "duckdb",
        "db.statement": "INSERT INTO eval_results SELECT * FROM staging_eval",
      },
    },
  ]);

  // --- Trace 7 (15 min ago): the collector ingesting an OTLP batch.
  const otlpIngest = buildFixtureTrace(7, minutesAgoMs(15), [
    {
      name: "POST /v1/traces",
      kind: 2,
      service: "qyl-collector",
      start: 0,
      end: 38,
      status: { code: 1 },
      attrs: {
        "http.request.method": "POST",
        "url.path": "/v1/traces",
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 0,
      name: "parse otlp payload",
      kind: 1,
      service: "qyl-collector",
      start: 2,
      end: 9,
      attrs: { "rpc.method": "Export" },
    },
    {
      parent: 0,
      name: "INSERT INTO spans",
      kind: 3,
      service: "qyl-collector",
      start: 12,
      end: 33,
      attrs: {
        "db.system": "duckdb",
        "db.statement": "INSERT INTO spans FROM read_otlp_batch(?)",
      },
    },
  ]);

  // --- Trace 8 (1 min ago): quick single-turn chat.
  const quickChat = buildFixtureTrace(8, minutesAgoMs(1), [
    {
      name: "POST /v1/agent/chat",
      kind: 2,
      service: "agent-worker",
      start: 0,
      end: 1350,
      status: { code: 1 },
      attrs: {
        "http.request.method": "POST",
        "url.path": "/v1/agent/chat",
        "http.response.status_code": intAttribute(200),
      },
    },
    {
      parent: 0,
      name: "chat claude-sonnet-5",
      kind: 3,
      service: "agent-worker",
      start: 25,
      end: 1320,
      attrs: {
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5",
        "gen_ai.response.model": "claude-sonnet-5",
        "gen_ai.usage.input_tokens": intAttribute(154),
        "gen_ai.usage.output_tokens": intAttribute(89),
      },
    },
  ]);

  const traces = [
    quickChat, // 1 min ago
    agentRun, // 2 min
    pipeline, // 3 min
    agentSummarize, // 5 min
    checkoutError, // 8 min
    orderLookup, // 11 min
    orderShipped, // 13 min
    otlpIngest, // 15 min
  ];

  // --- ~30 logs correlated to the traces above. Severity numbers follow
  // OTel: TRACE=1, DEBUG=5, INFO=9, WARN=13, ERROR=17.
  const log = (
    trace: QylTrace,
    spanIndex: number,
    offsetMs: number,
    severity: SeverityNumber,
    severityText: string,
    body: string,
    attrs?: Record<string, AttributeValue>,
  ) => {
    const span = trace.spans[spanIndex];
    const timeUnixNano = (
      BigInt(span.start_time_unix_nano) + BigInt(Math.round(offsetMs)) * 1_000_000n
    ).toString();
    return {
      time_unix_nano: timeUnixNano,
      observed_time_unix_nano: timeUnixNano,
      severity_number: severity,
      severity_text: severityText,
      body,
      trace_id: trace.trace_id,
      span_id: span.span_id,
      resource: span.resource,
      ...(attrs
        ? {
            attributes: Object.entries(attrs).map(([key, value]) => ({
              key,
              value,
            })),
          }
        : {}),
    } satisfies QylLogRecord;
  };

  const logs: QylLogRecord[] = [
    // otlpIngest (15 min ago)
    log(otlpIngest, 1, 1, 5, "DEBUG", "parsed OTLP batch: 142 spans, 3 resources"),
    log(otlpIngest, 2, 2, 1, "TRACE", "duckdb appender flushed 142 rows into spans"),
    // orderShipped (13 min)
    log(orderShipped, 1, 2, 9, "INFO", "published order.shipped for order ord_8842 to order.events", { "messaging.kafka.offset": intAttribute(91204) }),
    log(orderShipped, 2, 3, 9, "INFO", "consumed order.shipped for order ord_8842"),
    log(orderShipped, 3, 5, 5, "DEBUG", "notification email queued for user user-77"),
    // orderLookup (11 min)
    log(orderLookup, 1, 3, 5, "DEBUG", "order ord_8842 loaded in 26ms (2 queries)"),
    log(orderLookup, 0, 90, 9, "INFO", "GET /orders/ord_8842 -> 200 in 96ms"),
    // checkoutError (8 min)
    log(checkoutError, 0, 1, 9, "INFO", "checkout started for cart crt_5521 (3 items, total $84.97)"),
    log(checkoutError, 1, 5, 5, "DEBUG", "cart crt_5521 validated: all SKUs in catalog"),
    log(checkoutError, 3, 80, 13, "WARN", "inventory for sku KB-0042 low after reservation: 2 left"),
    log(
      checkoutError,
      4,
      236,
      17,
      "ERROR",
      "order insert failed: Npgsql.NpgsqlException: Exception while writing to stream: connection reset by peer\n" +
        NPGSQL_STACKTRACE,
      { "db.system": "postgresql", "error.type": "Npgsql.NpgsqlException" },
    ),
    log(checkoutError, 0, 425, 17, "ERROR", "POST /checkout -> 500 (order persistence error, order not created)"),
    log(checkoutError, 0, 428, 13, "WARN", "checkout for cart crt_5521 will be retried by the client"),
    // agentSummarize (5 min)
    log(agentSummarize, 0, 2, 9, "INFO", "summarize request received (target: last 20 traces)"),
    log(agentSummarize, 1, 1855, 9, "INFO", "claude-haiku-4-5 responded: 932 in / 208 out tokens"),
    log(agentSummarize, 3, 120, 5, "DEBUG", "served 20 trace summaries from duckdb in 105ms"),
    // pipeline (3 min)
    log(pipeline, 0, 5, 9, "INFO", "pipeline nightly-eval started (3 shards)"),
    log(pipeline, 2, 855, 5, "DEBUG", "shard-1 fetched: 10,240 records"),
    log(pipeline, 3, 1335, 5, "DEBUG", "shard-2 fetched: 10,240 records"),
    log(pipeline, 4, 1015, 13, "WARN", "shard-3 fetch timed out after 1s, retrying (attempt 2)"),
    log(pipeline, 5, 895, 5, "DEBUG", "shard-3 fetched on retry: 10,239 records"),
    log(pipeline, 8, 10, 1, "TRACE", "dedupe: hashing 30,719 records into 2 partitions"),
    log(pipeline, 12, 3295, 9, "INFO", "loaded 30,584 eval results into duckdb"),
    log(pipeline, 0, 8590, 9, "INFO", "pipeline nightly-eval finished in 8.6s (135 duplicates dropped)"),
    // agentRun (2 min)
    log(agentRun, 0, 3, 9, "INFO", "agent run started for user user-42 (goal: summarize failing checkouts)"),
    log(agentRun, 1, 50, 5, "DEBUG", "plan: [search_docs, analyze, respond]"),
    log(agentRun, 2, 2255, 9, "INFO", "claude-sonnet-5 responded: 1874 in / 412 out tokens"),
    log(agentRun, 4, 185, 1, "TRACE", "search_docs matched 10 documents (bm25)"),
    log(agentRun, 5, 1195, 9, "INFO", "claude-sonnet-5 responded: 2412 in / 655 out tokens"),
    log(agentRun, 0, 4195, 9, "INFO", "agent run completed in 4.2s"),
    // quickChat (1 min)
    log(quickChat, 0, 2, 9, "INFO", "chat request received (1 message)"),
    log(quickChat, 1, 1290, 5, "DEBUG", "claude-sonnet-5 responded: 154 in / 89 out tokens"),
  ].sort((a, b) =>
    Number(BigInt(a.time_unix_nano) - BigInt(b.time_unix_nano)),
  );

  // --- 3 sessions grouping the traces.
  const makeSession = (
    id: string,
    userId: string | undefined,
    sessionTraceList: QylTrace[],
    state: SessionState,
    genaiUsage?: QylSession["genai_usage"],
  ): QylSession => {
    const startMs = Math.min(
      ...sessionTraceList.map((t) => Date.parse(t.start_time)),
    );
    const endMs = Math.max(
      ...sessionTraceList.map((t) => Date.parse(t.end_time)),
    );
    const active = state === "active";
    return {
      "session_id": parseSessionId(id),
      ...(userId ? { user_id: userId as UserId } : {}),
      start_time: new Date(startMs).toISOString(),
      ...(active ? {} : { end_time: new Date(endMs).toISOString(), duration_ms: endMs - startMs }),
      trace_count: sessionTraceList.length,
      span_count: sessionTraceList.reduce((sum, t) => sum + t.span_count, 0),
      error_count: sessionTraceList.reduce(
        (sum, t) => sum + t.spans.filter((s) => s.status.code === 2).length,
        0,
      ),
      services: [...new Set(sessionTraceList.flatMap((t) => t.services))],
      state,
      ...(genaiUsage ? { genai_usage: genaiUsage } : {}),
    };
  };

  const sessionTraces: Record<string, QylTrace[]> = {
    "sess-demo-genai-01": [quickChat, agentRun, agentSummarize],
    "sess-demo-pipeline-02": [pipeline, otlpIngest],
    "sess-demo-checkout-03": [checkoutError, orderLookup, orderShipped],
  };

  const sessions: QylSession[] = [
    makeSession(
      "sess-demo-genai-01",
      "user-42",
      sessionTraces["sess-demo-genai-01"],
      "ended",
      {
        request_count: 4,
        total_input_tokens: 5372,
        total_output_tokens: 1364,
        models_used: ["claude-sonnet-5", "claude-haiku-4-5"],
        providers_used: ["anthropic"],
      },
    ),
    makeSession(
      "sess-demo-pipeline-02",
      undefined,
      sessionTraces["sess-demo-pipeline-02"],
      "active",
    ),
    makeSession(
      "sess-demo-checkout-03",
      "user-77",
      sessionTraces["sess-demo-checkout-03"],
      "ended",
    ),
  ];

  return { traces, logs, sessions, sessionTraces };
}

let fixture: TelemetryFixture | undefined;

export function getTelemetryFixture(): TelemetryFixture {
  return fixture ??= buildTelemetryFixture();
}
