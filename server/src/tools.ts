/** Qyl's directly registered, read-only telemetry tools. */

import type {
  GetTraceInput,
  GetTraceOutput,
  ListSessionsInput,
  ListSessionsOutput,
  ListTracesInput,
  ListTracesOutput,
  SearchLogsInput,
  SearchLogsOutput,
} from "@ancplua/qyl-api-schema/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GetTraceInputSchema,
  GetTraceOutputSchema,
  ListSessionsInputSchema,
  ListSessionsOutputSchema,
  ListTracesInputSchema,
  ListTracesOutputSchema,
  SearchLogsInputSchema,
  SearchLogsOutputSchema,
} from "./contracts.js";
import { fetchLogs, fetchSessions, fetchTrace, fetchTraces } from "./data.js";
import {
  summarizeLogs,
  summarizeSessions,
  summarizeTrace,
  summarizeTraceTable,
} from "./summaries.js";

/** Uniform failure result: clear text + isError, never a thrown exception. */
export function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The MCP envelope uses a string-keyed record; generated DTOs remain the value owner. */
function asStructuredContent<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/** Register the four model-visible read tools against published contract schemas. */
export function registerTelemetryTools(server: McpServer): void {
  server.registerTool(
    "list_traces",
    {
      title: "List Traces",
      description:
        "List recent qyl traces with summary fields (root span, services, duration, " +
        "span count, error flag). Spans are omitted — use get_trace for full span data. " +
        "Use display_traces instead when the user wants to LOOK at traces in the explorer UI.",
      inputSchema: ListTracesInputSchema,
      outputSchema: ListTracesOutputSchema,
    },
    async (args: ListTracesInput): Promise<CallToolResult> => {
      try {
        const { traces, mode } = await fetchTraces(args.limit ?? 20);
        const output: ListTracesOutput = {
          traces: traces.map(({ spans: _spans, ...summary }) => summary),
          mode,
        };
        return {
          content: [{ type: "text", text: summarizeTraceTable(traces, mode) }],
          structuredContent: asStructuredContent(output),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_trace",
    {
      title: "Get Trace",
      description:
        "Fetch a single qyl trace by trace id, including every span with timing, " +
        "attributes, events, and status. Use display_traces instead when the user " +
        "wants to SEE the trace waterfall.",
      inputSchema: GetTraceInputSchema,
      outputSchema: GetTraceOutputSchema,
    },
    async (args: GetTraceInput): Promise<CallToolResult> => {
      try {
        const { trace, mode } = await fetchTrace(args.trace_id);
        const output: GetTraceOutput = { trace, mode };
        return {
          content: [{ type: "text", text: summarizeTrace(trace, mode) }],
          structuredContent: asStructuredContent(output),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List qyl sessions with trace/span/error counts, state, and GenAI token " +
        "usage where present. Pass a session id to display_traces to see a " +
        "session's traces in the explorer UI.",
      inputSchema: ListSessionsInputSchema,
      outputSchema: ListSessionsOutputSchema,
    },
    async (args: ListSessionsInput): Promise<CallToolResult> => {
      try {
        const { sessions, mode } = await fetchSessions(args.limit ?? 20, args.active_only);
        const output: ListSessionsOutput = { sessions, mode };
        return {
          content: [{ type: "text", text: summarizeSessions(sessions, mode) }],
          structuredContent: asStructuredContent(output),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search Logs",
      description:
        "Search qyl log records, filterable by trace id (correlated logs), service " +
        "name, minimum severity (OTel numbers: 9 INFO, 13 WARN, 17 ERROR), and a " +
        "body substring query.",
      inputSchema: SearchLogsInputSchema,
      outputSchema: SearchLogsOutputSchema,
    },
    async (args: SearchLogsInput): Promise<CallToolResult> => {
      try {
        const { logs, mode } = await fetchLogs({
          trace_id: args.trace_id,
          service_name: args.service_name,
          severity_min: args.severity_min,
          query: args.query,
          limit: args.limit ?? 50,
        });
        const output: SearchLogsOutput = { logs, mode };
        return {
          content: [{ type: "text", text: summarizeLogs(logs, mode) }],
          structuredContent: asStructuredContent(output),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
