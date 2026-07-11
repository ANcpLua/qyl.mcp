/**
 * The qyl tool catalog — every catalog-eligible telemetry tool as plain data.
 *
 * Tool-slot economy (Sentry MCP's surfaces.ts pattern): only the curated
 * top-level set in surfaces.ts appears in tools/list; the tools here are
 * reached through search_qyl_tools / execute_qyl_tool instead.
 *
 * The registry is exported as data so later layers build on it without
 * re-declaring tools — deliberately NOT built yet, seams only:
 * - `capability` is the seam for skill→capability authorization (everything
 *   is "read" today; filtering at registration is the next step);
 * - the def list is the seam for the eval harness (enumerate, snapshot,
 *   score per tool).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fetchLogs, fetchSessions, fetchTrace, fetchTraces } from "./data.js";
import {
  summarizeLogs,
  summarizeSessions,
  summarizeTrace,
  summarizeTraceTable,
} from "./summaries.js";
import {
  LogRecordSchema,
  ModeSchema,
  SessionSchema,
  TraceSchema,
  TraceSummarySchema,
} from "./wire.js";

/** Uniform failure result: clear text + isError, never a thrown exception. */
export function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface QylToolDef {
  name: string;
  title: string;
  description: string;
  /** Seam for skill→capability authorization; every tool is read-only today. */
  capability: "read";
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe("Number of traces to return (1–100, default 20)");

export const CATALOG_TOOLS: readonly QylToolDef[] = [
  {
    name: "list_traces",
    title: "List Traces",
    description:
      "List recent qyl traces with summary fields (root span, services, duration, " +
      "span count, error flag). Spans are omitted — use get_trace for full span data. " +
      "Use display_traces instead when the user wants to LOOK at traces in the explorer UI.",
    capability: "read",
    inputSchema: { limit: limitSchema },
    outputSchema: { traces: z.array(TraceSummarySchema), mode: ModeSchema },
    handler: async (args) => {
      const { limit } = args as { limit: number };
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
  },
  {
    name: "get_trace",
    title: "Get Trace",
    description:
      "Fetch a single qyl trace by trace id, including every span with timing, " +
      "attributes, events, and status. Use display_traces instead when the user " +
      "wants to SEE the trace waterfall.",
    capability: "read",
    inputSchema: {
      trace_id: z.string().min(1).describe("Trace id (32-char hex from OTLP)"),
    },
    outputSchema: { trace: TraceSchema, mode: ModeSchema },
    handler: async (args) => {
      const { trace_id } = args as { trace_id: string };
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
  },
  {
    name: "list_sessions",
    title: "List Sessions",
    description:
      "List qyl sessions with trace/span/error counts, state, and GenAI token " +
      "usage where present. Pass a session id to display_traces to see a " +
      "session's traces in the explorer UI.",
    capability: "read",
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
    outputSchema: { sessions: z.array(SessionSchema), mode: ModeSchema },
    handler: async (args) => {
      const { limit, active_only } = args as { limit: number; active_only?: boolean };
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
  },
  {
    name: "search_logs",
    title: "Search Logs",
    description:
      "Search qyl log records, filterable by trace id (correlated logs), service " +
      "name, minimum severity (OTel numbers: 9 INFO, 13 WARN, 17 ERROR), and a " +
      "body substring query.",
    capability: "read",
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
    outputSchema: { logs: z.array(LogRecordSchema), mode: ModeSchema },
    handler: async (args) => {
      const { trace_id, service_name, severity_min, query, limit } = args as {
        trace_id?: string;
        service_name?: string;
        severity_min?: number;
        query?: string;
        limit: number;
      };
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
  },
];

export function findCatalogTool(name: string): QylToolDef | undefined {
  return CATALOG_TOOLS.find((tool) => tool.name === name);
}
