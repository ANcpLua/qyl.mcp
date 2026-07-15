/**
 * Telemetry fetching (shared by model tools, display tools, fetch_telemetry —
 * demo mode honors every filter the live endpoints support).
 */

import {
  CollectorError,
  collectorGet,
  parseCollectorLog,
  parseCollectorPage,
  parseCollectorSession,
  parseCollectorTrace,
  resolveMode,
} from "./collector.js";
import { getDemo, getDemoMcpSpans } from "./demo.js";
import { logBodyText } from "./log-body.js";
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

export async function fetchTraces(limit: number): Promise<{ traces: QylTrace[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    return redactTelemetry({ traces: getDemo().traces.slice(0, limit), mode });
  }
  const body = await collectorGet("/api/v1/traces", { limit });
  return redactTelemetry({
    traces: parseCollectorPage(
      body,
      "/api/v1/traces",
      TracesListResponseSchema,
      parseCollectorTrace,
    ).items,
    mode,
  });
}

export async function fetchTrace(traceId: string): Promise<{ trace: QylTrace; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const trace = getDemo().traces.find((t) => t.trace_id === traceId);
    if (!trace) throw new CollectorError(`trace not found: ${traceId}`);
    return redactTelemetry({ trace, mode });
  }
  try {
    const trace = parseCollectorTrace(
      await collectorGet(`/api/v1/traces/${encodeURIComponent(traceId)}`),
      `/api/v1/traces/${traceId}`,
    );
    return redactTelemetry({ trace, mode });
  } catch (err) {
    if (err instanceof CollectorError && err.status === 404) {
      throw new CollectorError(`trace not found: ${traceId}`);
    }
    throw err;
  }
}

export async function fetchSessionTraces(
  sessionId: string,
  limit: number,
): Promise<{ traces: QylTrace[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const traces = getDemo().sessionTraces[sessionId];
    if (!traces) throw new CollectorError(`session not found: ${sessionId}`);
    return redactTelemetry({ traces: traces.slice(0, limit), mode });
  }
  try {
    const body = await collectorGet(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/traces`,
      { limit },
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
      throw new CollectorError(`session not found: ${sessionId}`);
    }
    throw err;
  }
}

export async function fetchSessions(
  limit: number,
  activeOnly?: boolean,
): Promise<{ sessions: QylSession[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    const sessions = (
      activeOnly ? getDemo().sessions.filter((s) => s.state === "active") : getDemo().sessions
    ).slice(0, limit);
    return redactTelemetry({ sessions, mode });
  }
  const body = await collectorGet("/api/v1/sessions", {
    limit,
    isActive: activeOnly ? true : undefined,
  });
  return redactTelemetry({
    sessions: parseCollectorPage(
      body,
      "/api/v1/sessions",
      SessionsListResponseSchema,
      parseCollectorSession,
    ).items,
    mode,
  });
}

interface LogFilters {
  trace_id?: string;
  service_name?: string;
  severity_min?: number;
  query?: string;
  limit: number;
}

export async function fetchLogs(
  filters: LogFilters,
): Promise<{ logs: QylLogRecord[]; mode: Mode }> {
  const mode = await resolveMode();
  if (mode === "demo") {
    let logs = getDemo().logs;
    if (filters.trace_id) logs = logs.filter((l) => l.trace_id === filters.trace_id);
    if (filters.service_name) {
      logs = logs.filter(
        (l) => String(l.resource["service.name"]) === filters.service_name,
      );
    }
    const severityMin = filters.severity_min;
    if (severityMin !== undefined) {
      logs = logs.filter((l) => l.severity_number >= severityMin);
    }
    if (filters.query) {
      const needle = filters.query.toLowerCase();
      logs = logs.filter((l) => logBodyText(l.body).toLowerCase().includes(needle));
    }
    return redactTelemetry({ logs: logs.slice(0, filters.limit), mode });
  }
  const body = await collectorGet("/api/v1/logs", {
    traceId: filters.trace_id,
    serviceName: filters.service_name,
    severityMin: filters.severity_min,
    query: filters.query,
    limit: filters.limit,
  });
  return redactTelemetry({
    logs: parseCollectorPage(
      body,
      "/api/v1/logs",
      LogsListResponseSchema,
      parseCollectorLog,
    ).items,
    mode,
  });
}

/** Shared by display_traces and fetch_telemetry (view "traces"). */
export async function fetchTracesForDisplay(args: {
  trace_id?: TraceId;
  session_id?: SessionId;
  limit: number;
}): Promise<{ traces: QylTrace[]; selected_trace_id?: TraceId; mode: Mode }> {
  if (args.trace_id) {
    const { trace, mode } = await fetchTrace(args.trace_id);
    return { traces: [trace], selected_trace_id: args.trace_id, mode };
  }
  if (args.session_id) {
    return fetchSessionTraces(args.session_id, args.limit);
  }
  return fetchTraces(args.limit);
}

/** Shared by display_mcp_dashboard and fetch_telemetry (view "mcp_stats"). */
export async function fetchMcpStats(hours: number): Promise<McpDashboardStats> {
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

  const body = await collectorGet("/api/v1/traces", { limit: 1000 });
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
