/**
 * Telemetry fetching (shared by model tools, display tools, fetch_telemetry —
 * demo mode honors every filter the live endpoints support).
 */

import {
  CollectorError,
  collectorGet,
  normalizeTrace,
  resolveMode,
  unwrapItems,
} from "./collector.js";
import { DEMO, getDemoMcpSpans } from "./demo.js";
import { aggregateMcpStats, pickBucketMs } from "./stats.js";
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
    return { traces: DEMO.traces.slice(0, limit), mode };
  }
  const body = await collectorGet("/api/v1/traces", { limit });
  return { traces: unwrapItems<any>(body).map(normalizeTrace), mode };
}

export async function fetchTrace(traceId: string): Promise<{ trace: QylTrace; mode: Mode }> {
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

export async function fetchSessionTraces(
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

export async function fetchSessions(
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

export interface LogFilters {
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
export async function fetchTracesForDisplay(args: {
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

/** Shared by display_mcp_dashboard and fetch_telemetry (view "mcp_stats"). */
export async function fetchMcpStats(hours: number): Promise<McpDashboardStats> {
  const mode = await resolveMode();
  const windowEnd = Date.now();
  const windowStart = windowEnd - hours * 3_600_000;
  const bucketMs = pickBucketMs(windowEnd - windowStart);

  if (mode === "demo") {
    const stats = aggregateMcpStats(getDemoMcpSpans(), windowStart, windowEnd, bucketMs);
    return { ...stats, truncated: false, mode };
  }

  const body = await collectorGet("/api/v1/traces", { limit: 1000 });
  const traces = unwrapItems<any>(body).map(normalizeTrace);
  const spans = traces.flatMap((t) => t.spans);
  const stats = aggregateMcpStats(spans, windowStart, windowEnd, bucketMs);
  const truncated = traces.length >= 1000 || Boolean((body as any)?.has_more);
  return { ...stats, truncated, mode };
}
