/**
 * Telemetry fetching (shared by model tools, display tools, fetch_telemetry —
 * demo mode honors every filter and every cursor the live endpoints support).
 *
 * Every list returns the page it was given: the Collector's `has_more` and
 * opaque `next_cursor` live, and a demo page cut from the dataset with the
 * same semantics (`paging.ts`). Filters travel to the Collector under their
 * published query-parameter names; the demo branch applies the same filters
 * itself, so an answer never claims a filter it did not apply.
 */

import {
  CollectorError,
  type CollectorRequestOptions,
  collectorGet,
  parseCollectorLog,
  parseCollectorPage,
  parseCollectorSession,
  parseCollectorTrace,
  resolveMode,
} from "./collector.js";
import { getDemo, getDemoMcpSpans } from "./demo.js";
import {
  compareUnixNanos,
  epochMsToUnixNanos,
  formatAttributeValue,
} from "@ancplua/qyl-api-schema/runtime";
import { demoPage, type Page } from "./paging.js";
import { aggregateMcpStats, pickBucketMs } from "./stats.js";
import { redactTelemetry } from "./telemetry-redaction.js";
import {
  LogsListResponseSchema,
  SessionsListResponseSchema,
  SessionTracesListResponseSchema,
  TracesListResponseSchema,
} from "./contract-validation.js";
import type { SessionId, TraceId } from "@ancplua/qyl-api-schema/types";
import type {
  McpDashboardStats,
  Mode,
  QylLogRecord,
  QylSession,
  QylTrace,
} from "./wire.js";

/** A page plus the mode it came from; `nextCursor` is added after redaction, it is not telemetry. */
type PagedResult<K extends string, T> = { [key in K]: T[] } & {
  hasMore: boolean;
  nextCursor?: string;
  mode: Mode;
};

function paged<K extends string, T>(key: K, page: Page<T>, mode: Mode): PagedResult<K, T> {
  const redacted = redactTelemetry({ [key]: page.items, mode } as { [k in K]: T[] } & { mode: Mode });
  return {
    ...redacted,
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  } as PagedResult<K, T>;
}

/** The published window: `start_time` inclusive, `end_time` exclusive, both RFC 3339. */
export interface TimeRange {
  start_time?: string;
  end_time?: string;
}

function withinRange(iso: string, range: TimeRange): boolean {
  const at = Date.parse(iso);
  if (range.start_time !== undefined && at < Date.parse(range.start_time)) return false;
  if (range.end_time !== undefined && at >= Date.parse(range.end_time)) return false;
  return true;
}

export interface TraceFilters extends TimeRange {
  limit: number;
  service_name?: string;
  errors_only?: boolean;
  cursor?: string;
}

export async function fetchTraces(
  filters: TraceFilters,
  options: CollectorRequestOptions = {},
): Promise<PagedResult<"traces", QylTrace>> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const traces = getDemo().traces.filter((trace) =>
      withinRange(trace.start_time, filters) &&
      (filters.service_name === undefined || trace.services.includes(filters.service_name)) &&
      (!filters.errors_only || trace.has_error));
    return paged("traces", demoPage(traces, filters.limit, filters.cursor), mode);
  }
  const body = await collectorGet(
    "/api/v1/traces",
    {
      start_time: filters.start_time,
      end_time: filters.end_time,
      service_name: filters.service_name,
      errors_only: filters.errors_only ? true : undefined,
      limit: filters.limit,
      cursor: filters.cursor,
    },
    options,
  );
  return paged(
    "traces",
    parseCollectorPage(body, "/api/v1/traces", TracesListResponseSchema, parseCollectorTrace),
    mode,
  );
}

export async function fetchTrace(
  traceId: string,
  options: CollectorRequestOptions = {},
): Promise<{ trace: QylTrace; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const trace = getDemo().traces.find((t) => t.trace_id === traceId);
    if (!trace) throw new CollectorError(`trace not found: ${traceId}`, false, undefined, "not_found");
    return redactTelemetry({ trace, mode });
  }
  try {
    const trace = parseCollectorTrace(
      await collectorGet(`/api/v1/traces/${encodeURIComponent(traceId)}`, {}, options),
      `/api/v1/traces/${traceId}`,
    );
    return redactTelemetry({ trace, mode });
  } catch (err) {
    if (err instanceof CollectorError && err.status === 404) {
      throw new CollectorError(`trace not found: ${traceId}`, false, undefined, "not_found");
    }
    throw err;
  }
}

export async function fetchSessionTraces(
  sessionId: string,
  limit: number,
  options: CollectorRequestOptions = {},
): Promise<{ traces: QylTrace[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const traces = getDemo().sessionTraces[sessionId];
    if (!traces) throw new CollectorError(`session not found: ${sessionId}`, false, undefined, "not_found");
    return redactTelemetry({ traces: traces.slice(0, limit), mode });
  }
  try {
    const body = await collectorGet(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/traces`,
      { limit },
      options,
    );
    return redactTelemetry({
      traces: parseCollectorPage(
        body,
        `/api/v1/sessions/${sessionId}/traces`,
        SessionTracesListResponseSchema,
        parseCollectorTrace,
      ).items,
      mode,
    });
  } catch (err) {
    if (err instanceof CollectorError && err.status === 404) {
      throw new CollectorError(`session not found: ${sessionId}`, false, undefined, "not_found");
    }
    throw err;
  }
}

export interface SessionFilters extends TimeRange {
  limit: number;
  active_only?: boolean;
  cursor?: string;
}

export async function fetchSessions(
  filters: SessionFilters,
  options: CollectorRequestOptions = {},
): Promise<PagedResult<"sessions", QylSession>> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const sessions = getDemo().sessions.filter((session) =>
      (!filters.active_only || session.state === "active") &&
      withinRange(session.start_time, filters));
    return paged("sessions", demoPage(sessions, filters.limit, filters.cursor), mode);
  }
  const body = await collectorGet(
    "/api/v1/sessions",
    {
      is_active: filters.active_only ? true : undefined,
      start_time: filters.start_time,
      end_time: filters.end_time,
      limit: filters.limit,
      cursor: filters.cursor,
    },
    options,
  );
  return paged(
    "sessions",
    parseCollectorPage(body, "/api/v1/sessions", SessionsListResponseSchema, parseCollectorSession),
    mode,
  );
}

export interface LogFilters extends TimeRange {
  trace_id?: string;
  session_id?: string;
  service_name?: string;
  severity_min?: number;
  query?: string;
  limit: number;
  cursor?: string;
}

export async function fetchLogs(
  filters: LogFilters,
  options: CollectorRequestOptions = {},
): Promise<PagedResult<"logs", QylLogRecord>> {
  const mode = await resolveMode();
  if (mode === "demo") {
    let logs = getDemo().logs;
    if (filters.trace_id) logs = logs.filter((l) => l.trace_id === filters.trace_id);
    if (filters.session_id !== undefined) {
      // Demo log records carry no session id; the session owns its traces, so
      // its logs are the logs of those traces. An unknown session is an empty
      // page, as the Collector answers a log filter that matches nothing.
      const traceIds = new Set(
        (getDemo().sessionTraces[filters.session_id] ?? []).map((trace) => trace.trace_id),
      );
      logs = logs.filter((l) => l.trace_id !== undefined && traceIds.has(l.trace_id));
    }
    if (filters.service_name) {
      logs = logs.filter(
        (l) => String(l.resource.service_name) === filters.service_name,
      );
    }
    const severityMin = filters.severity_min;
    if (severityMin !== undefined) {
      logs = logs.filter((l) => l.severity_number >= severityMin);
    }
    if (filters.query) {
      const needle = filters.query.toLowerCase();
      logs = logs.filter((l) => formatAttributeValue(l.body).toLowerCase().includes(needle));
    }
    if (filters.start_time !== undefined) {
      const start = epochMsToUnixNanos(Date.parse(filters.start_time));
      logs = logs.filter((l) => compareUnixNanos(l.time_unix_nano, start) >= 0);
    }
    if (filters.end_time !== undefined) {
      const end = epochMsToUnixNanos(Date.parse(filters.end_time));
      logs = logs.filter((l) => compareUnixNanos(l.time_unix_nano, end) < 0);
    }
    return paged("logs", demoPage(logs, filters.limit, filters.cursor), mode);
  }
  const body = await collectorGet(
    "/api/v1/logs",
    {
      session_id: filters.session_id,
      trace_id: filters.trace_id,
      service_name: filters.service_name,
      severity_min: filters.severity_min,
      query: filters.query,
      start_time: filters.start_time,
      end_time: filters.end_time,
      limit: filters.limit,
      cursor: filters.cursor,
    },
    options,
  );
  return paged(
    "logs",
    parseCollectorPage(body, "/api/v1/logs", LogsListResponseSchema, parseCollectorLog),
    mode,
  );
}

/** Shared by display_traces and fetch_telemetry (view "traces"). */
export async function fetchTracesForDisplay(
  args: {
    trace_id?: TraceId;
    session_id?: SessionId;
    limit: number;
  },
  options: CollectorRequestOptions = {},
): Promise<{ traces: QylTrace[]; selected_trace_id?: TraceId; mode: Mode }> {
  if (args.trace_id) {
    const { trace, mode } = await fetchTrace(args.trace_id, options);
    return { traces: [trace], selected_trace_id: args.trace_id, mode };
  }
  if (args.session_id) {
    return fetchSessionTraces(args.session_id, args.limit, options);
  }
  const { traces, mode } = await fetchTraces({ limit: args.limit }, options);
  return { traces, mode };
}

/** Shared by display_mcp_dashboard and fetch_telemetry (view "mcp_stats"). */
export async function fetchMcpStats(
  hours: number,
  options: CollectorRequestOptions = {},
): Promise<McpDashboardStats> {
  const mode = await resolveMode();
  const windowEnd = Date.now();
  const windowStart = windowEnd - hours * 3_600_000;
  const bucketMs = pickBucketMs(windowEnd - windowStart);

  if (mode === "demo") {
    const stats = aggregateMcpStats(
      redactTelemetry(getDemoMcpSpans()),
      windowStart,
      windowEnd,
      bucketMs,
    );
    return redactTelemetry({ ...stats, truncated: false, mode });
  }

  const body = await collectorGet("/api/v1/traces", { limit: 1000 }, options);
  const page = parseCollectorPage(
    body,
    "/api/v1/traces",
    TracesListResponseSchema,
    parseCollectorTrace,
  );
  const traces = redactTelemetry(page.items);
  const spans = traces.flatMap((t) => t.spans);
  const stats = aggregateMcpStats(spans, windowStart, windowEnd, bucketMs);
  const truncated = traces.length >= 1000 || page.hasMore;
  return redactTelemetry({ ...stats, truncated, mode });
}
