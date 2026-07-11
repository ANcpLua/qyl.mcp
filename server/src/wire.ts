/**
 * Collector wire shapes (single source of truth: INTERFACE.md).
 * Response bodies are snake_case with dotted OTel keys; query params are
 * camelCase. Demo data uses the exact same shapes so live mode is a drop-in.
 */

import { z } from "zod";

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

export type Mode = "live" | "demo";

// --- MCP dashboard aggregate (INTERFACE.md addendum) -------------------------

export interface McpToolRow {
  name: string;
  requests: number;
  errors: number;
  error_rate: number;
  avg_ms: number;
  p95_ms: number;
}

export interface McpDashboardStats {
  window: { start: string; end: string; bucket_ms: number }; // bucket count 24-48
  buckets: Array<{ start: string; requests: number; errors: number }>;
  totals: { requests: number; errors: number; error_rate: number };
  by_server: Array<{ name: string; requests: number }>; // mcp.server.name
  by_transport: Array<{ name: string; requests: number }>; // app.transport
  by_method: Array<{ name: string; requests: number }>; // mcp.method.name
  tools: McpToolRow[]; // by mcp.tool.name, desc requests
  resources: Array<McpToolRow & { name: string }>; // name = mcp.resource.uri
  span_count_analyzed: number;
  truncated: boolean; // hit the 1000-trace fetch cap
  mode: Mode;
}

// =============================================================================
// Zod schemas (runtime validators mirroring the interfaces above)
// =============================================================================

const AttributeSchema = z.object({ key: z.string(), value: z.unknown() });

export const SpanSchema = z.object({
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
export const TraceSummarySchema = z.object({
  trace_id: z.string(),
  root_span: SpanSchema.optional(),
  span_count: z.number().int(),
  duration_ns: z.number(),
  start_time: z.string().describe("ISO 8601 timestamp"),
  end_time: z.string().describe("ISO 8601 timestamp"),
  services: z.array(z.string()),
  has_error: z.boolean(),
});

export const TraceSchema = TraceSummarySchema.extend({
  spans: z.array(SpanSchema),
});

export const LogRecordSchema = z.object({
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

export const SessionSchema = z.object({
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

export const ModeSchema = z.enum(["live", "demo"]);

const McpToolRowSchema = z.object({
  name: z.string(),
  requests: z.number().int(),
  errors: z.number().int(),
  error_rate: z.number().describe("errors / requests, 0–1"),
  avg_ms: z.number(),
  p95_ms: z.number().describe("nearest-rank 95th percentile duration"),
});

const NameRequestsSchema = z.object({
  name: z.string(),
  requests: z.number().int(),
});

export const McpDashboardStatsSchema = z.object({
  window: z.object({
    start: z.string().describe("ISO 8601"),
    end: z.string().describe("ISO 8601"),
    bucket_ms: z.number(),
  }),
  buckets: z.array(
    z.object({
      start: z.string().describe("ISO 8601 bucket start"),
      requests: z.number().int(),
      errors: z.number().int(),
    }),
  ),
  totals: z.object({
    requests: z.number().int(),
    errors: z.number().int(),
    error_rate: z.number(),
  }),
  by_server: z.array(NameRequestsSchema).describe('by "mcp.server.name"'),
  by_transport: z.array(NameRequestsSchema).describe('by "app.transport"'),
  by_method: z.array(NameRequestsSchema).describe('by "mcp.method.name"'),
  tools: z.array(McpToolRowSchema).describe('by "mcp.tool.name", requests desc'),
  resources: z
    .array(McpToolRowSchema)
    .describe('by "mcp.resource.uri" (name = uri), requests desc'),
  span_count_analyzed: z.number().int(),
  truncated: z.boolean().describe("true when the 1000-trace fetch cap was hit"),
  mode: ModeSchema,
});
