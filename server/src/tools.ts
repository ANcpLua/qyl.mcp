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
import type {
  McpServer,
  CallToolResult,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  GetTraceInputSchema,
  GetTraceOutputSchema,
  ListSessionsInputSchema,
  ListSessionsOutputSchema,
  ListTracesInputSchema,
  ListTracesOutputSchema,
  SearchLogsInputSchema,
  SearchLogsOutputSchema,
  compactOutputSchema,
} from "./contract-validation.js";
import { fetchLogs, fetchSessions, fetchTrace, fetchTraces } from "./data.js";
import {
  summarizeLogs,
  summarizeSessions,
  summarizeTrace,
  summarizeTraceTable,
} from "./summaries.js";
import { runTool } from "./request-scope.js";
import { telemetryToolResult } from "./telemetry-redaction.js";

/**
 * The qyl telemetry tools only query the configured collector. They neither
 * mutate it nor reach an unbounded set of external entities.
 */
export const READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/** Re-exported for the callers that learned it here; it lives with `runTool`. */
export { toolError } from "./request-scope.js";

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
      outputSchema: compactOutputSchema(ListTracesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    (args: ListTracesInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, "list_traces", 1, async (scope) => {
        const { traces, mode } = await fetchTraces(args.limit ?? 20, scope.collector);
        await scope.step(`Fetched ${traces.length} trace(s)`);
        const output: ListTracesOutput = {
          traces: traces.map(({ spans: _spans, ...summary }) => summary),
          mode,
        };
        return telemetryToolResult(summarizeTraceTable(traces, mode), output);
      }),
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
      outputSchema: compactOutputSchema(GetTraceOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    (args: GetTraceInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, "get_trace", 1, async (scope) => {
        const { trace, mode } = await fetchTrace(args.trace_id, scope.collector);
        await scope.step(`Fetched trace ${args.trace_id} (${trace.span_count} spans)`);
        const output: GetTraceOutput = { trace, mode };
        return telemetryToolResult(summarizeTrace(trace, mode), output);
      }),
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
      outputSchema: compactOutputSchema(ListSessionsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    (args: ListSessionsInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, "list_sessions", 1, async (scope) => {
        const { sessions, mode } = await fetchSessions(
          args.limit ?? 20,
          args.active_only,
          scope.collector,
        );
        await scope.step(`Fetched ${sessions.length} session(s)`);
        const output: ListSessionsOutput = { sessions, mode };
        return telemetryToolResult(summarizeSessions(sessions, mode), output);
      }),
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
      outputSchema: compactOutputSchema(SearchLogsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    (args: SearchLogsInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, "search_logs", 1, async (scope) => {
        const { logs, mode } = await fetchLogs(
          {
            trace_id: args.trace_id,
            service_name: args.service_name,
            severity_min: args.severity_min,
            query: args.query,
            limit: args.limit ?? 50,
          },
          scope.collector,
        );
        await scope.step(`Fetched ${logs.length} log record(s)`);
        const output: SearchLogsOutput = { logs, mode };
        return telemetryToolResult(summarizeLogs(logs, mode), output);
      }),
  );
}
