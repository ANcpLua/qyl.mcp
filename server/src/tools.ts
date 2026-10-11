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
import { fetchLogs, fetchSessions, fetchTrace, fetchTraces, type TimeRange } from "./data.js";
import {
  filterNote,
  pageNote,
  summarizeLogs,
  summarizeSessions,
  summarizeTrace,
  summarizeTraceTable,
} from "./summaries.js";
import { runTool } from "./request-scope.js";
import { readSessionAnnotations, readTraceAnnotations } from "./collector-resources.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import { QYL_MCP_SCOPE } from "./oauth.js";
import type { QylSpan, QylTrace } from "./wire.js";

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

/** SDK v2.0.0 preserves tool _meta, but has no top-level securitySchemes
 * registration field. OpenAI reads this documented compatibility form;
 * other MCP clients can follow the RFC 9728 challenge.
 */
export const TELEMETRY_TOOL_AUTH_META = {
  securitySchemes: [{ type: "oauth2", scopes: [QYL_MCP_SCOPE] }],
} as const;

/** Re-exported for the callers that learned it here; it lives with `runTool`. */
export { toolError } from "./request-scope.js";

function withoutAttributes<T extends { attributes?: unknown }>(value: T): Omit<T, "attributes"> {
  const rest = { ...value };
  delete rest.attributes;
  return rest;
}

function omitSpanAttributes(span: QylSpan): QylSpan {
  return {
    ...withoutAttributes(span),
    resource: withoutAttributes(span.resource),
    ...(span.events === undefined ? {} : { events: span.events.map(withoutAttributes) }),
    ...(span.links === undefined ? {} : { links: span.links.map(withoutAttributes) }),
    ...(span.instrumentation_scope === undefined ? {} : {
      instrumentation_scope: withoutAttributes(span.instrumentation_scope),
    }),
  };
}

function projectTrace(trace: QylTrace, args: GetTraceInput): {
  trace: QylTrace;
  matchingSpanCount: number;
} {
  const matching = args.errors_only
    ? trace.spans.filter((span) => span.status.code === 2)
    : trace.spans;
  const selected = matching.slice(0, args.max_spans);
  const projectSpan = args.include_attributes === false ? omitSpanAttributes : (span: QylSpan) => span;
  const { root_span: root, ...summary } = trace;
  // A separate root copy must not reintroduce a span excluded by the filter or cap.
  const selectedRoot = !args.errors_only && args.max_spans === undefined
    ? root
    : selected.find((span) => span.span_id === root?.span_id);
  return {
    trace: {
      ...summary,
      spans: selected.map(projectSpan),
      ...(selectedRoot === undefined ? {} : { root_span: projectSpan(selectedRoot) }),
    },
    matchingSpanCount: matching.length,
  };
}

/** `from …`, `until …` for a list header; the window is what the caller asked for. */
function windowNote(range: TimeRange): (string | undefined)[] {
  return [
    range.start_time === undefined ? undefined : `from ${range.start_time}`,
    range.end_time === undefined ? undefined : `until ${range.end_time}`,
  ];
}

/** Register the four model-visible read tools against published contract schemas. */
export function registerTelemetryTools(server: McpServer): void {
  server.registerTool(
    "list_traces",
    {
      title: "List Traces",
      description:
        "List recent qyl traces when the user wants a compact overview of activity " +
        "and failures: root span, services, duration, span count, and error flag. " +
        "Filters: a start_time/end_time window (RFC 3339), service_name (traces with " +
        "a span from that service) and errors_only. Pages: when has_more is true, " +
        "pass next_cursor as cursor with the same filters for the next page. " +
        "Spans are omitted; get_trace returns the full span tree, while display_traces " +
        "provides the interactive explorer.",
      inputSchema: ListTracesInputSchema,
      outputSchema: compactOutputSchema(ListTracesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: ListTracesInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const page = await fetchTraces(
          {
            limit: args.limit ?? 20,
            start_time: args.start_time,
            end_time: args.end_time,
            service_name: args.service_name,
            errors_only: args.errors_only,
            cursor: args.cursor,
          },
          scope.collector,
        );
        await scope.step(`Fetched ${page.traces.length} trace(s)`);
        const output: ListTracesOutput = {
          traces: page.traces.map(({ spans: _spans, ...summary }) => summary),
          mode: page.mode,
          has_more: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
        };
        const filters = filterNote([
          args.errors_only ? "errors only" : undefined,
          args.service_name === undefined ? undefined : `service ${args.service_name}`,
          ...windowNote(args),
        ]);
        return telemetryToolResult(
          summarizeTraceTable(page.traces, page.mode, filters) + pageNote(page),
          output,
        );
      }),
  );

  server.registerTool(
    "get_trace",
    {
      title: "Get Trace",
      description:
        "Fetch a single qyl trace by trace_id when the user wants span timing, " +
        "events, status, and attributes. By default returns all spans; errors_only " +
        "keeps error spans, max_spans caps them after filtering in Collector order, " +
        "and include_attributes=false omits attribute collections. Trace totals " +
        "are preserved and the summary reports returned and matching counts. " +
        "The root span is omitted when excluded by the filter or cap. " +
        "It also returns the annotations on the trace and its spans, with the id and " +
        "etag that update_annotation and delete take. " +
        "display_traces provides the visual waterfall.",
      inputSchema: GetTraceInputSchema,
      outputSchema: compactOutputSchema(GetTraceOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: GetTraceInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 2, async (scope) => {
        const { trace, mode } = await fetchTrace(args.trace_id, scope.collector);
        await scope.step(`Fetched trace ${args.trace_id} (${trace.span_count} spans)`);
        const projected = projectTrace(trace, args);
        const notes = await readTraceAnnotations(args.trace_id, scope);
        const output: GetTraceOutput = {
          trace: projected.trace,
          mode,
          ...(notes.annotations === undefined ? {} : { annotations: notes.annotations }),
        };
        const rootExcluded = trace.root_span !== undefined && projected.trace.root_span === undefined;
        const summary = summarizeTrace(projected.trace, mode, rootExcluded) +
          `\nReturned ${projected.trace.spans.length} of ${projected.matchingSpanCount} matching spans ` +
          `(${trace.span_count} total)${args.errors_only ? "; error status only" : ""}.` +
          (args.include_attributes === false ? " Attribute collections omitted." : "") +
          notes.text;
        return telemetryToolResult(summary, output);
      }),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List qyl sessions when the user wants to find active or failing sessions, " +
        "with trace/span/error counts, state, and GenAI token usage where present. " +
        "Filters: active_only and a start_time/end_time window (RFC 3339) on the " +
        "session start. Pages: when has_more is true, pass next_cursor as cursor with " +
        "the same filters for the next page. It also returns the annotations on the " +
        "listed sessions. " +
        "display_traces accepts a session_id to show that session's traces in the explorer.",
      inputSchema: ListSessionsInputSchema,
      outputSchema: compactOutputSchema(ListSessionsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: ListSessionsInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 2, async (scope) => {
        const page = await fetchSessions(
          {
            limit: args.limit ?? 20,
            active_only: args.active_only,
            start_time: args.start_time,
            end_time: args.end_time,
            cursor: args.cursor,
          },
          scope.collector,
        );
        await scope.step(`Fetched ${page.sessions.length} session(s)`);
        const notes = await readSessionAnnotations(page.sessions.map((session) => session.session_id), scope);
        const output: ListSessionsOutput = {
          sessions: page.sessions,
          mode: page.mode,
          has_more: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
          ...(notes.annotations === undefined ? {} : { annotations: notes.annotations }),
        };
        const filters = filterNote([args.active_only ? "active only" : undefined, ...windowNote(args)]);
        return telemetryToolResult(
          summarizeSessions(page.sessions, page.mode, filters) + pageNote(page) + notes.text,
          output,
        );
      }),
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search Logs",
      description:
        "Search qyl log records when the user wants error details or logs correlated " +
        "with a trace or a session. Filters include trace_id, session_id, service_name, " +
        "minimum severity (OTel numbers: 9 INFO, 13 WARN, 17 ERROR), a body substring " +
        "query, and a start_time/end_time window (RFC 3339). Pages: when has_more is " +
        "true, pass next_cursor as cursor with the same filters for the next page.",
      inputSchema: SearchLogsInputSchema,
      outputSchema: compactOutputSchema(SearchLogsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: SearchLogsInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const page = await fetchLogs(
          {
            trace_id: args.trace_id,
            session_id: args.session_id,
            service_name: args.service_name,
            severity_min: args.severity_min,
            query: args.query,
            start_time: args.start_time,
            end_time: args.end_time,
            limit: args.limit ?? 50,
            cursor: args.cursor,
          },
          scope.collector,
        );
        await scope.step(`Fetched ${page.logs.length} log record(s)`);
        const output: SearchLogsOutput = {
          logs: page.logs,
          mode: page.mode,
          has_more: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
        };
        return telemetryToolResult(summarizeLogs(page.logs, page.mode) + pageNote(page), output);
      }),
  );
}
