/**
 * qyl Apps Server
 *
 * An MCP Apps server for qyl telemetry with an interactive trace/log
 * explorer UI. Successor to the deleted `services/qyl.mcp` Apps
 * (TraceExplorer/ErrorExplorer), rebuilt on @modelcontextprotocol/ext-apps.
 *
 * Model-facing tools:
 * - list_traces:    GET /api/v1/traces (summaries, spans omitted)
 * - get_trace:      GET /api/v1/traces/{traceId} (full spans)
 * - list_sessions:  GET /api/v1/sessions
 * - search_logs:    GET /api/v1/logs
 * - display_traces: fetches traces and renders the trace explorer UI
 *
 * App-only tool (hidden from the model, called by the viewer iframe):
 * - fetch_telemetry: traces / single trace / log search, used by the
 *   viewer's refresh button, drill-down, and logs tab.
 *
 * Modes:
 * - Live mode: fetches from the qyl collector REST API at
 *   `QYL_COLLECTOR_URL` (default http://127.0.0.1:5100). The read API has
 *   no auth (only OTLP ingest does), so no token handling.
 * - Demo mode: `QYL_DEMO=1`, or the collector startup probe getting a
 *   connection-refused → canned telemetry so every tool is fully
 *   functional offline (filters included).
 */

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// =============================================================================
// Configuration
// =============================================================================

const COLLECTOR_URL = process.env.QYL_COLLECTOR_URL ?? "http://127.0.0.1:5100";

/** URI of the trace explorer UI resource (see INTERFACE.md). */
export const RESOURCE_URI = "ui://qyl-explorer/mcp-app.html";

// Works both from source (server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

// =============================================================================
// Collector wire shapes (single source of truth: INTERFACE.md)
// Response bodies are snake_case with dotted OTel keys; query params are
// camelCase. Demo data uses the exact same shapes so live mode is a drop-in.
// =============================================================================

export interface QylTrace {
  trace_id: string;
  spans: QylSpan[];
  root_span?: QylSpan;
  span_count: number;
  duration_ns: number;
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601
  services: string[];
  has_error: boolean;
}

export interface QylSpan {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  kind: 0 | 1 | 2 | 3 | 4 | 5; // Unspecified/Internal/Server/Client/Producer/Consumer
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  attributes?: Array<{ key: string; value: unknown }>;
  events?: Array<{
    name: string;
    time_unix_nano: number;
    attributes?: unknown[];
  }>;
  status: { code: 0 | 1 | 2; message?: string }; // Unset/Ok/Error
  resource: Record<string, unknown>; // dotted keys; "service.name" always present
}

export interface QylLogRecord {
  time_unix_nano: number;
  severity_number: number;
  severity_text?: string;
  body: string;
  attributes?: Array<{ key: string; value: unknown }>;
  trace_id?: string;
  span_id?: string;
  resource: Record<string, unknown>;
}

export interface QylSession {
  "session.id": string;
  "user.id"?: string;
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  trace_count: number;
  span_count: number;
  error_count: number;
  services: string[];
  state: string;
  genai_usage?: {
    request_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    models_used: string[];
    providers_used: string[];
    estimated_cost_usd?: number;
  };
}

type Mode = "live" | "demo";

// =============================================================================
// Zod schemas (runtime validators mirroring the interfaces above)
// =============================================================================

const AttributeSchema = z.object({ key: z.string(), value: z.unknown() });

const SpanSchema = z.object({
  span_id: z.string(),
  trace_id: z.string(),
  parent_span_id: z.string().optional(),
  name: z.string(),
  kind: z
    .number()
    .int()
    .min(0)
    .max(5)
    .describe("0 Unspecified, 1 Internal, 2 Server, 3 Client, 4 Producer, 5 Consumer"),
  start_time_unix_nano: z.number(),
  end_time_unix_nano: z.number(),
  attributes: z.array(AttributeSchema).optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        time_unix_nano: z.number(),
        attributes: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
  status: z.object({
    code: z.number().int().min(0).max(2).describe("0 Unset, 1 Ok, 2 Error"),
    message: z.string().optional(),
  }),
  resource: z
    .record(z.string(), z.unknown())
    .describe('OTel resource with dotted keys; "service.name" always present'),
});

/** Trace summary — everything except the spans array (list_traces output). */
const TraceSummarySchema = z.object({
  trace_id: z.string(),
  root_span: SpanSchema.optional(),
  span_count: z.number().int(),
  duration_ns: z.number(),
  start_time: z.string().describe("ISO 8601 timestamp"),
  end_time: z.string().describe("ISO 8601 timestamp"),
  services: z.array(z.string()),
  has_error: z.boolean(),
});

const TraceSchema = TraceSummarySchema.extend({
  spans: z.array(SpanSchema),
});

const LogRecordSchema = z.object({
  time_unix_nano: z.number(),
  severity_number: z
    .number()
    .describe("OTel severity: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN, 17-20 ERROR, 21-24 FATAL"),
  severity_text: z.string().optional(),
  body: z.string(),
  attributes: z.array(AttributeSchema).optional(),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
});

const SessionSchema = z.object({
  "session.id": z.string(),
  "user.id": z.string().optional(),
  start_time: z.string(),
  end_time: z.string().optional(),
  duration_ms: z.number().optional(),
  trace_count: z.number().int(),
  span_count: z.number().int(),
  error_count: z.number().int(),
  services: z.array(z.string()),
  state: z.string(),
  genai_usage: z
    .object({
      request_count: z.number().int(),
      total_input_tokens: z.number(),
      total_output_tokens: z.number(),
      models_used: z.array(z.string()),
      providers_used: z.array(z.string()),
      estimated_cost_usd: z.number().optional(),
    })
    .optional(),
});

const ModeSchema = z.enum(["live", "demo"]);

// =============================================================================
// Collector REST client
// =============================================================================

/** Error with a message already suitable for showing to the model/user. */
class CollectorError extends Error {
  constructor(
    message: string,
    readonly connectionError = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CollectorError";
  }
}

/**
 * GET a collector endpoint. Query params are camelCase per the collector
 * API; `undefined` values are omitted. Connection failures map to a clear,
 * actionable message.
 */
async function collectorGet(
  pathname: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<any> {
  const url = new URL(pathname, COLLECTOR_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new CollectorError(
      `collector unreachable at ${COLLECTOR_URL} — start it with ` +
        "`dotnet run --project services/qyl.collector` or set QYL_DEMO=1",
      true,
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body: any = await response.json();
      detail = body?.error || body?.detail || body?.title || "";
    } catch {
      /* non-JSON body — status alone will have to do */
    }
    throw new CollectorError(
      `collector request failed (${response.status} ${response.statusText}) for ${pathname}` +
        (detail ? `: ${detail}` : ""),
      false,
      response.status,
    );
  }

  return response.json();
}

/** Collector list endpoints return CursorPage<T>; tolerate bare arrays too. */
function unwrapItems<T>(body: any): T[] {
  if (Array.isArray(body)) return body as T[];
  return (body?.items ?? []) as T[];
}

// The generated OpenAPI types say span.kind / status.code are numbers, but the live
// collector serializes them as string enums ("client", "ok" — JsonStringEnumConverter).
// Normalize to the numeric contract at the fetch boundary, tolerating both encodings.
const SPAN_KIND_BY_NAME: Record<string, number> = {
  unspecified: 0, internal: 1, server: 2, client: 3, producer: 4, consumer: 5,
};
const STATUS_CODE_BY_NAME: Record<string, number> = { unset: 0, ok: 1, error: 2 };

function toEnumNumber(value: unknown, byName: Record<string, number>): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return byName[value.toLowerCase()] ?? 0;
  return 0;
}

function normalizeSpan(span: any): any {
  if (!span) return span;
  // Project to exactly the contract's QylSpan fields: the live collector also sends
  // trace_state / links / flags / dropped_*_count / instrumentation_scope, which the
  // strict output schema (additionalProperties: false) rejects and the viewer ignores.
  return {
    span_id: span.span_id,
    trace_id: span.trace_id,
    ...(span.parent_span_id ? { parent_span_id: span.parent_span_id } : {}),
    name: span.name,
    kind: toEnumNumber(span.kind, SPAN_KIND_BY_NAME),
    start_time_unix_nano: Number(span.start_time_unix_nano ?? 0),
    end_time_unix_nano: Number(span.end_time_unix_nano ?? 0),
    ...(Array.isArray(span.attributes) ? { attributes: span.attributes } : {}),
    ...(Array.isArray(span.events)
      ? {
          events: span.events.map((e: any) => ({
            name: e?.name ?? "",
            time_unix_nano: Number(e?.time_unix_nano ?? 0),
            ...(Array.isArray(e?.attributes) ? { attributes: e.attributes } : {}),
          })),
        }
      : {}),
    status: span.status
      ? {
          code: toEnumNumber(span.status.code, STATUS_CODE_BY_NAME),
          ...(span.status.message ? { message: span.status.message } : {}),
        }
      : { code: 0 },
    resource: span.resource ?? {},
  };
}

function normalizeTrace(trace: any): QylTrace {
  return {
    trace_id: trace?.trace_id ?? "",
    spans: Array.isArray(trace?.spans) ? trace.spans.map(normalizeSpan) : [],
    ...(trace?.root_span ? { root_span: normalizeSpan(trace.root_span) } : {}),
    span_count: Number(trace?.span_count ?? 0),
    duration_ns: Number(trace?.duration_ns ?? 0),
    start_time: trace?.start_time ?? "",
    end_time: trace?.end_time ?? "",
    services: Array.isArray(trace?.services) ? trace.services : [],
    has_error: Boolean(trace?.has_error),
  } as QylTrace;
}

// =============================================================================
// Mode selection
// QYL_DEMO=1 forces demo. Otherwise the first tool call probes the collector
// (GET /api/v1/traces?limit=1); a connection-refused there pins demo mode for
// the process lifetime. Any other outcome (including HTTP errors) pins live —
// the collector is reachable, so real calls should surface real errors.
// =============================================================================

let modeProbe: Promise<Mode> | undefined;

function resolveMode(): Promise<Mode> {
  if (process.env.QYL_DEMO === "1") return Promise.resolve("demo");
  return (modeProbe ??= (async () => {
    try {
      await collectorGet("/api/v1/traces", { limit: 1 });
      return "live";
    } catch (err) {
      if (err instanceof CollectorError && err.connectionError) {
        console.error(
          `qyl-apps-server: ${err.message}. Serving demo telemetry for the rest of this process.`,
        );
        return "demo";
      }
      return "live";
    }
  })());
}

// =============================================================================
// Demo dataset (exact collector wire shapes; timestamps relative to process
// start so the data always looks recent)
// =============================================================================

/** Deterministic hex id — stable within a process, looks like real OTel ids. */
function hexId(seed: number, length: number): string {
  let hex = "";
  let x = (seed ^ 0x5f3759df) >>> 0;
  while (hex.length < length) {
    x = (x * 1664525 + 1013904223) >>> 0;
    hex += x.toString(16).padStart(8, "0");
  }
  return hex.slice(0, length);
}

const PROCESS_START_MS = Date.now();
const minutesAgoMs = (minutes: number) => PROCESS_START_MS - minutes * 60_000;
const toNano = (absoluteMs: number) => Math.round(absoluteMs * 1e6);

/** Per-service OTel resources shared by demo spans and logs. */
const DEMO_RESOURCES: Record<string, Record<string, unknown>> = {
  "qyl-collector": {
    "service.name": "qyl-collector",
    "service.version": "0.4.2",
    "telemetry.sdk.language": "dotnet",
  },
  "checkout-api": {
    "service.name": "checkout-api",
    "service.version": "2.11.0",
    "telemetry.sdk.language": "dotnet",
    "deployment.environment.name": "staging",
  },
  "agent-worker": {
    "service.name": "agent-worker",
    "service.version": "1.3.7",
    "telemetry.sdk.language": "python",
  },
};

/** Span blueprint: offsets are milliseconds relative to the trace start. */
interface DemoSpanSpec {
  parent?: number; // index into the spec array
  name: string;
  kind: QylSpan["kind"];
  service: keyof typeof DEMO_RESOURCES;
  start: number;
  end: number;
  attrs?: Record<string, unknown>;
  status?: QylSpan["status"];
  events?: Array<{ name: string; atMs: number; attributes?: unknown[] }>;
}

function buildDemoTrace(
  seq: number,
  startMs: number,
  specs: DemoSpanSpec[],
): QylTrace {
  const traceId = hexId(seq * 7919 + 17, 32);

  const spans: QylSpan[] = specs.map((spec, index) => {
    const span: QylSpan = {
      span_id: hexId(seq * 104_729 + index * 31 + 5, 16),
      trace_id: traceId,
      name: spec.name,
      kind: spec.kind,
      start_time_unix_nano: toNano(startMs + spec.start),
      end_time_unix_nano: toNano(startMs + spec.end),
      status: spec.status ?? { code: 0 },
      resource: DEMO_RESOURCES[spec.service],
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
        time_unix_nano: toNano(startMs + event.atMs),
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

  const startNano = Math.min(...spans.map((s) => s.start_time_unix_nano));
  const endNano = Math.max(...spans.map((s) => s.end_time_unix_nano));
  const services = [
    ...new Set(spans.map((s) => String(s.resource["service.name"]))),
  ];

  return {
    trace_id: traceId,
    spans,
    root_span: spans.find((s) => !s.parent_span_id),
    span_count: spans.length,
    duration_ns: endNano - startNano,
    start_time: new Date(startNano / 1e6).toISOString(),
    end_time: new Date(endNano / 1e6).toISOString(),
    services,
    has_error: spans.some((s) => s.status.code === 2),
  };
}

interface DemoData {
  traces: QylTrace[]; // newest first
  logs: QylLogRecord[]; // oldest first
  sessions: QylSession[];
  sessionTraces: Record<string, QylTrace[]>;
}

function buildDemoData(): DemoData {
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
  const agentRun = buildDemoTrace(1, minutesAgoMs(2), [
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
        "http.response.status_code": 200,
      },
    },
    {
      parent: 0,
      name: "agent.plan",
      kind: 1,
      service: "agent-worker",
      start: 15,
      end: 70,
      attrs: { "qyl.agent.step": "plan" },
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
        "gen_ai.usage.input_tokens": 1874,
        "gen_ai.usage.output_tokens": 412,
      },
    },
    {
      parent: 0,
      name: "tool.execute search_docs",
      kind: 1,
      service: "agent-worker",
      start: 2400,
      end: 2900,
      attrs: { "qyl.tool.name": "search_docs" },
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
        "gen_ai.usage.input_tokens": 2412,
        "gen_ai.usage.output_tokens": 655,
      },
    },
  ]);

  // --- Trace 2 (5 min ago): GenAI summarize that calls the collector's own
  // API cross-service (agent-worker → qyl-collector → DuckDB).
  const agentSummarize = buildDemoTrace(2, minutesAgoMs(5), [
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
        "http.response.status_code": 200,
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
        "gen_ai.usage.input_tokens": 932,
        "gen_ai.usage.output_tokens": 208,
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
        "url.full": `${COLLECTOR_URL}/api/v1/traces?limit=20`,
        "http.response.status_code": 200,
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
        "http.response.status_code": 200,
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
  const checkoutError = buildDemoTrace(3, minutesAgoMs(8), [
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
        "http.response.status_code": 500,
      },
    },
    {
      parent: 0,
      name: "validate cart",
      kind: 1,
      service: "checkout-api",
      start: 5,
      end: 35,
      attrs: { "qyl.cart.items": 3 },
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
  const orderLookup = buildDemoTrace(4, minutesAgoMs(11), [
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
        "http.response.status_code": 200,
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
  const orderShipped = buildDemoTrace(5, minutesAgoMs(13), [
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
        "http.response.status_code": 202,
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
      attrs: { "qyl.notification.channel": "email" },
    },
  ]);

  // --- Trace 6 (3 min ago): deep async pipeline — 13 spans, 4 levels, with a
  // slow shard that needed a retry.
  const pipeline = buildDemoTrace(6, minutesAgoMs(3), [
    {
      name: "pipeline.run nightly-eval",
      kind: 1,
      service: "agent-worker",
      start: 0,
      end: 8600,
      status: { code: 1 },
      attrs: { "qyl.pipeline.name": "nightly-eval" },
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
      attrs: { "url.path": "/datasets/eval/shard-3", "http.request.resend_count": 1 },
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
  const otlpIngest = buildDemoTrace(7, minutesAgoMs(15), [
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
        "http.response.status_code": 200,
      },
    },
    {
      parent: 0,
      name: "parse otlp payload",
      kind: 1,
      service: "qyl-collector",
      start: 2,
      end: 9,
      attrs: { "qyl.otlp.spans": 142 },
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
  const quickChat = buildDemoTrace(8, minutesAgoMs(1), [
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
        "http.response.status_code": 200,
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
        "gen_ai.usage.input_tokens": 154,
        "gen_ai.usage.output_tokens": 89,
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
    severity: number,
    severityText: string,
    body: string,
    attrs?: Record<string, unknown>,
  ): QylLogRecord => {
    const span = trace.spans[spanIndex];
    return {
      time_unix_nano: span.start_time_unix_nano + Math.round(offsetMs * 1e6),
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
    };
  };

  const logs: QylLogRecord[] = [
    // otlpIngest (15 min ago)
    log(otlpIngest, 1, 1, 5, "DEBUG", "parsed OTLP batch: 142 spans, 3 resources"),
    log(otlpIngest, 2, 2, 1, "TRACE", "duckdb appender flushed 142 rows into spans"),
    // orderShipped (13 min)
    log(orderShipped, 1, 2, 9, "INFO", "published order.shipped for order ord_8842 to order.events", { "messaging.kafka.offset": 91204 }),
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
  ].sort((a, b) => a.time_unix_nano - b.time_unix_nano);

  // --- 3 sessions grouping the traces.
  const makeSession = (
    id: string,
    userId: string | undefined,
    sessionTraceList: QylTrace[],
    state: string,
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
      "session.id": id,
      ...(userId ? { "user.id": userId } : {}),
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
      "completed",
      {
        request_count: 4,
        total_input_tokens: 5372,
        total_output_tokens: 1364,
        models_used: ["claude-sonnet-5", "claude-haiku-4-5"],
        providers_used: ["anthropic"],
        estimated_cost_usd: 0.0421,
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
      "errored",
    ),
  ];

  return { traces, logs, sessions, sessionTraces };
}

const DEMO = buildDemoData();

// =============================================================================
// Telemetry fetching (shared by model tools, display_traces, fetch_telemetry —
// demo mode honors every filter the live endpoints support)
// =============================================================================

async function fetchTraces(limit: number): Promise<{ traces: QylTrace[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    return { traces: DEMO.traces.slice(0, limit), mode };
  }
  const body = await collectorGet("/api/v1/traces", { limit });
  return { traces: unwrapItems<any>(body).map(normalizeTrace), mode };
}

async function fetchTrace(traceId: string): Promise<{ trace: QylTrace; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const trace = DEMO.traces.find((t) => t.trace_id === traceId);
    if (!trace) throw new CollectorError(`trace not found: ${traceId}`);
    return { trace, mode };
  }
  try {
    const trace = normalizeTrace(
      await collectorGet(`/api/v1/traces/${encodeURIComponent(traceId)}`),
    );
    return { trace, mode };
  } catch (err) {
    if (err instanceof CollectorError && err.status === 404) {
      throw new CollectorError(`trace not found: ${traceId}`);
    }
    throw err;
  }
}

async function fetchSessionTraces(
  sessionId: string,
  limit: number,
): Promise<{ traces: QylTrace[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const traces = DEMO.sessionTraces[sessionId];
    if (!traces) throw new CollectorError(`session not found: ${sessionId}`);
    return { traces: traces.slice(0, limit), mode };
  }
  try {
    const body = await collectorGet(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/traces`,
      { limit },
    );
    return { traces: unwrapItems<any>(body).map(normalizeTrace), mode };
  } catch (err) {
    if (err instanceof CollectorError && err.status === 404) {
      throw new CollectorError(`session not found: ${sessionId}`);
    }
    throw err;
  }
}

async function fetchSessions(
  limit: number,
  activeOnly?: boolean,
): Promise<{ sessions: QylSession[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const sessions = (
      activeOnly ? DEMO.sessions.filter((s) => s.state === "active") : DEMO.sessions
    ).slice(0, limit);
    return { sessions, mode };
  }
  const body = await collectorGet("/api/v1/sessions", {
    limit,
    isActive: activeOnly ? true : undefined,
  });
  return { sessions: unwrapItems<QylSession>(body), mode };
}

interface LogFilters {
  trace_id?: string;
  service_name?: string;
  severity_min?: number;
  query?: string;
  limit: number;
}

async function fetchLogs(
  filters: LogFilters,
): Promise<{ logs: QylLogRecord[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    let logs = DEMO.logs;
    if (filters.trace_id) logs = logs.filter((l) => l.trace_id === filters.trace_id);
    if (filters.service_name) {
      logs = logs.filter(
        (l) => String(l.resource["service.name"]) === filters.service_name,
      );
    }
    if (filters.severity_min !== undefined) {
      logs = logs.filter((l) => l.severity_number >= filters.severity_min!);
    }
    if (filters.query) {
      const needle = filters.query.toLowerCase();
      logs = logs.filter((l) => l.body.toLowerCase().includes(needle));
    }
    return { logs: logs.slice(0, filters.limit), mode };
  }
  const body = await collectorGet("/api/v1/logs", {
    traceId: filters.trace_id,
    serviceName: filters.service_name,
    severityMin: filters.severity_min,
    query: filters.query,
    limit: filters.limit,
  });
  return { logs: unwrapItems<QylLogRecord>(body), mode };
}

/** Shared by display_traces and fetch_telemetry (view "traces"). */
async function fetchTracesForDisplay(args: {
  trace_id?: string;
  session_id?: string;
  limit: number;
}): Promise<{ traces: QylTrace[]; selected_trace_id?: string; mode: Mode }> {
  if (args.trace_id) {
    const { trace, mode } = await fetchTrace(args.trace_id);
    return { traces: [trace], selected_trace_id: args.trace_id, mode };
  }
  if (args.session_id) {
    return fetchSessionTraces(args.session_id, args.limit);
  }
  return fetchTraces(args.limit);
}

// =============================================================================
// Text summaries (compact and model-friendly)
// =============================================================================

/** Humanize a nanosecond duration: "1.24 s" / "87 ms" / "640 µs". */
function humanizeNs(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${Math.round(ns / 1e6)} ms`;
  return `${Math.round(ns / 1e3)} µs`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Root span name with fallback to the earliest span (per INTERFACE.md). */
function rootSpanName(trace: QylTrace): string {
  if (trace.root_span?.name) return trace.root_span.name;
  const earliest = [...(trace.spans ?? [])].sort(
    (a, b) => a.start_time_unix_nano - b.start_time_unix_nano,
  )[0];
  return earliest?.name ?? "unknown";
}

function serviceOf(span: QylSpan): string {
  return String(span.resource?.["service.name"] ?? "unknown");
}

function modeNote(mode: Mode): string {
  return mode === "demo" ? " [demo data]" : "";
}

function summarizeTraceTable(traces: QylTrace[], mode: Mode): string {
  const lines = [
    `Traces (${traces.length})${modeNote(mode)}`,
    "",
    "| Trace | Root span | Spans | Duration | Status | Services |",
    "|-------|-----------|-------|----------|--------|----------|",
  ];
  for (const trace of traces) {
    const services =
      trace.services.slice(0, 3).join(", ") +
      (trace.services.length > 3 ? ` +${trace.services.length - 3}` : "");
    lines.push(
      `| ${shortId(trace.trace_id)} | ${rootSpanName(trace)} | ${trace.span_count} | ` +
        `${humanizeNs(trace.duration_ns)} | ${trace.has_error ? "ERROR" : "OK"} | ${services} |`,
    );
  }
  return lines.join("\n");
}

function summarizeTrace(trace: QylTrace, mode: Mode): string {
  const spansByService = new Map<string, number>();
  for (const span of trace.spans) {
    const service = serviceOf(span);
    spansByService.set(service, (spansByService.get(service) ?? 0) + 1);
  }
  const perService = [...spansByService]
    .map(([service, count]) => `${service} ×${count}`)
    .join(", ");

  const lines = [
    `Trace ${trace.trace_id}${modeNote(mode)}`,
    `Root: ${rootSpanName(trace)} — ${humanizeNs(trace.duration_ns)}, ` +
      `${trace.span_count} spans, started ${trace.start_time}`,
    `Spans by service: ${perService}`,
  ];

  const errorSpans = trace.spans.filter((s) => s.status.code === 2);
  if (errorSpans.length > 0) {
    lines.push(`Error spans (${errorSpans.length}):`);
    for (const span of errorSpans) {
      lines.push(
        `- ${span.name} (${serviceOf(span)})` +
          (span.status.message ? ` — ${span.status.message}` : ""),
      );
    }
  }
  return lines.join("\n");
}

function summarizeSessions(sessions: QylSession[], mode: Mode): string {
  const lines = [
    `Sessions (${sessions.length})${modeNote(mode)}`,
    "",
    "| Session | State | Traces | Spans | Errors | Duration | GenAI |",
    "|---------|-------|--------|-------|--------|----------|-------|",
  ];
  for (const session of sessions) {
    const duration =
      session.duration_ms !== undefined
        ? humanizeNs(session.duration_ms * 1e6)
        : "—";
    const genai = session.genai_usage
      ? `${session.genai_usage.request_count} req, ` +
        `${session.genai_usage.total_input_tokens}/${session.genai_usage.total_output_tokens} tok` +
        (session.genai_usage.estimated_cost_usd !== undefined
          ? `, ~$${session.genai_usage.estimated_cost_usd.toFixed(4)}`
          : "")
      : "—";
    lines.push(
      `| ${session["session.id"]} | ${session.state} | ${session.trace_count} | ` +
        `${session.span_count} | ${session.error_count} | ${duration} | ${genai} |`,
    );
  }
  return lines.join("\n");
}

function summarizeLogs(logs: QylLogRecord[], mode: Mode): string {
  if (logs.length === 0) return `No logs matched${modeNote(mode)}.`;
  const lines = logs.map((record) => {
    const time = new Date(record.time_unix_nano / 1e6)
      .toISOString()
      .slice(11, 23);
    const severity = record.severity_text ?? String(record.severity_number);
    const body =
      record.body.length > 140
        ? `${record.body.slice(0, 140).replace(/\s+/g, " ")}…`
        : record.body.replace(/\s+/g, " ");
    const correlation = record.trace_id
      ? ` (trace ${shortId(record.trace_id)})`
      : "";
    return `- ${time} ${severity} [${String(record.resource["service.name"] ?? "unknown")}] ${body}${correlation}`;
  });
  return `Logs (${logs.length})${modeNote(mode)}\n${lines.join("\n")}`;
}

// =============================================================================
// Result helpers
// =============================================================================

/** Uniform failure result: clear text + isError, never a thrown exception. */
function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

// =============================================================================
// MCP Server Factory
// =============================================================================

// Cached across createServer() calls — in stateless HTTP deployments a fresh
// server is created per request and per-instance caches would be useless.
let cachedAppHtml: string | undefined;

/**
 * Creates a new MCP server instance with all qyl telemetry tools and the
 * trace explorer UI resource registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "qyl Apps Server",
    version: "1.0.0",
  });

  const limitSchema = z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of traces to return (1–100, default 20)");

  // ---------------------------------------------------------------------------
  // Tool 1: list_traces — recent trace summaries
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_traces",
    {
      title: "List Traces",
      description:
        "List recent qyl traces with summary fields (root span, services, duration, " +
        "span count, error flag). Spans are omitted — use get_trace for full span data. " +
        "Use display_traces instead when the user wants to LOOK at traces in the explorer UI.",
      inputSchema: {
        limit: limitSchema,
      },
      outputSchema: {
        traces: z.array(TraceSummarySchema),
        mode: ModeSchema,
      },
    },
    async ({ limit }): Promise<CallToolResult> => {
      try {
        const { traces, mode } = await fetchTraces(limit);
        const summaries = traces.map(({ spans: _spans, ...summary }) => summary);
        return {
          content: [{ type: "text", text: summarizeTraceTable(traces, mode) }],
          structuredContent: { traces: summaries, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 2: get_trace — one trace with full spans
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_trace",
    {
      title: "Get Trace",
      description:
        "Fetch a single qyl trace by trace id, including every span with timing, " +
        "attributes, events, and status. Use display_traces instead when the user " +
        "wants to SEE the trace waterfall.",
      inputSchema: {
        trace_id: z.string().min(1).describe("Trace id (32-char hex from OTLP)"),
      },
      outputSchema: {
        trace: TraceSchema,
        mode: ModeSchema,
      },
    },
    async ({ trace_id }): Promise<CallToolResult> => {
      try {
        const { trace, mode } = await fetchTrace(trace_id);
        return {
          content: [{ type: "text", text: summarizeTrace(trace, mode) }],
          structuredContent: { trace, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 3: list_sessions — qyl sessions (agentic runs / user sessions)
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List qyl sessions with trace/span/error counts, state, and GenAI token " +
        "usage where present. Pass a session id to display_traces to see a " +
        "session's traces in the explorer UI.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Number of sessions to return (1–100, default 20)"),
        active_only: z
          .boolean()
          .optional()
          .describe("Only sessions that are still active"),
      },
      outputSchema: {
        sessions: z.array(SessionSchema),
        mode: ModeSchema,
      },
    },
    async ({ limit, active_only }): Promise<CallToolResult> => {
      try {
        const { sessions, mode } = await fetchSessions(limit, active_only);
        return {
          content: [{ type: "text", text: summarizeSessions(sessions, mode) }],
          structuredContent: { sessions, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 4: search_logs — log search with correlation filters
  // ---------------------------------------------------------------------------
  server.registerTool(
    "search_logs",
    {
      title: "Search Logs",
      description:
        "Search qyl log records, filterable by trace id (correlated logs), service " +
        "name, minimum severity (OTel numbers: 9 INFO, 13 WARN, 17 ERROR), and a " +
        "body substring query.",
      inputSchema: {
        trace_id: z
          .string()
          .optional()
          .describe("Only logs correlated to this trace"),
        service_name: z
          .string()
          .optional()
          .describe('Only logs from this service (resource "service.name")'),
        severity_min: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe("Minimum OTel severity number (e.g. 13 for WARN and above)"),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the log body"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Number of logs to return (1–200, default 50)"),
      },
      outputSchema: {
        logs: z.array(LogRecordSchema),
        mode: ModeSchema,
      },
    },
    async ({ trace_id, service_name, severity_min, query, limit }): Promise<CallToolResult> => {
      try {
        const { logs, mode } = await fetchLogs({
          trace_id,
          service_name,
          severity_min,
          query,
          limit,
        });
        return {
          content: [{ type: "text", text: summarizeLogs(logs, mode) }],
          structuredContent: { logs, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 5: display_traces — THE app tool (renders the trace explorer UI)
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "display_traces",
    {
      title: "Display Traces",
      description:
        "Show qyl traces in the interactive trace explorer with a span waterfall, " +
        "detail panel, and correlated logs. Pass a trace_id to open one trace, a " +
        "session_id for that session's traces, or neither for recent traces. Prefer " +
        "this over list_traces/get_trace whenever the user wants to look at traces.",
      inputSchema: {
        trace_id: z
          .string()
          .optional()
          .describe("Open this single trace in the explorer"),
        session_id: z
          .string()
          .optional()
          .describe("Show this session's traces"),
        limit: limitSchema.optional(),
      },
      outputSchema: z.object({
        traces: z.array(TraceSchema),
        selected_trace_id: z.string().optional(),
        mode: ModeSchema,
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ trace_id, session_id, limit }): Promise<CallToolResult> => {
      try {
        const result = await fetchTracesForDisplay({
          trace_id,
          session_id,
          limit: limit ?? 20,
        });

        let text: string;
        if (result.selected_trace_id) {
          const trace = result.traces[0];
          text =
            `Showing trace ${shortId(trace.trace_id)} (${rootSpanName(trace)}, ` +
            `${trace.span_count} spans, ${humanizeNs(trace.duration_ns)}) in the qyl explorer` +
            `${result.mode === "demo" ? " (demo data)" : ""}.`;
        } else {
          const errorCount = result.traces.filter((t) => t.has_error).length;
          const scope = session_id ? `session ${session_id}` : "recent";
          text =
            `Showing ${result.traces.length} ${scope} traces in the qyl explorer` +
            `${errorCount > 0 ? ` (${errorCount} with errors)` : ""}` +
            `${result.mode === "demo" ? " (demo data)" : ""}.`;
        }

        const structuredContent = {
          traces: result.traces,
          ...(result.selected_trace_id
            ? { selected_trace_id: result.selected_trace_id }
            : {}),
          mode: result.mode,
        };

        return {
          content: [{ type: "text", text }],
          structuredContent: structuredContent as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 6: fetch_telemetry — app-only (hidden from the model)
  // Used by the viewer iframe for refresh, drill-down, and the logs tab.
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "fetch_telemetry",
    {
      title: "Fetch Telemetry",
      description:
        "Fetch traces, a single trace, or logs for the trace explorer UI. " +
        "The model should NOT call this tool directly.",
      inputSchema: {
        view: z
          .enum(["traces", "trace", "logs"])
          .describe(
            '"traces" for the recent trace list, "trace" for one trace, "logs" for a log search',
          ),
        trace_id: z
          .string()
          .optional()
          .describe('Trace id (required for view "trace"; filters view "logs")'),
        service_name: z
          .string()
          .optional()
          .describe('Service filter for view "logs"'),
        severity_min: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe('Minimum OTel severity for view "logs"'),
        query: z
          .string()
          .optional()
          .describe('Body substring filter for view "logs"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max items (default: 20 traces / 50 logs)"),
      },
      outputSchema: z.object({
        traces: z.array(TraceSchema).optional(),
        trace: TraceSchema.optional(),
        logs: z.array(LogRecordSchema).optional(),
        mode: ModeSchema,
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ view, trace_id, service_name, severity_min, query, limit }): Promise<CallToolResult> => {
      try {
        if (view === "trace") {
          if (!trace_id) {
            throw new CollectorError('view "trace" requires a `trace_id`.');
          }
          const { trace, mode } = await fetchTrace(trace_id);
          return {
            content: [
              {
                type: "text",
                text: `Fetched trace ${shortId(trace.trace_id)} (${trace.span_count} spans, ${mode} mode).`,
              },
            ],
            structuredContent: { trace, mode } as any,
          };
        }

        if (view === "logs") {
          const { logs, mode } = await fetchLogs({
            trace_id,
            service_name,
            severity_min,
            query,
            limit: limit ?? 50,
          });
          return {
            content: [
              {
                type: "text",
                text: `Fetched ${logs.length} logs (${mode} mode).`,
              },
            ],
            structuredContent: { logs, mode } as any,
          };
        }

        const { traces, mode } = await fetchTraces(limit ?? 20);
        return {
          content: [
            {
              type: "text",
              text: `Fetched ${traces.length} traces (${mode} mode).`,
            },
          ],
          structuredContent: { traces, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // UI resource: the bundled trace explorer HTML
  // ---------------------------------------------------------------------------
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = (cachedAppHtml ??= await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      ));
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  // Fully self-contained viewer: system font stack, no CDN,
                  // all data via fetch_telemetry — no external origins.
                  connectDomains: [],
                  resourceDomains: [],
                },
              },
            },
          },
        ],
      };
    },
  );

  return server;
}
