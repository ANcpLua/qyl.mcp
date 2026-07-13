/**
 * Text summaries (compact and model-friendly) for tool results.
 */

import type {
  McpDashboardStats,
  Mode,
  QylLogRecord,
  QylSession,
  QylSpan,
  QylTrace,
} from "./wire.js";
import { logBodyText } from "./log-body.js";

/** Humanize a nanosecond duration: "1.24 s" / "87 ms" / "640 µs". */
export function humanizeNs(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${Math.round(ns / 1e6)} ms`;
  return `${Math.round(ns / 1e3)} µs`;
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Root span name, or the earliest span when no root is identified. */
export function rootSpanName(trace: QylTrace): string {
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

export function summarizeTraceTable(traces: QylTrace[], mode: Mode): string {
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

export function summarizeTrace(trace: QylTrace, mode: Mode): string {
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

export function summarizeSessions(sessions: QylSession[], mode: Mode): string {
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

export function summarizeLogs(logs: QylLogRecord[], mode: Mode): string {
  if (logs.length === 0) return `No logs matched${modeNote(mode)}.`;
  const lines = logs.map((record) => {
    const time = new Date(record.time_unix_nano / 1e6)
      .toISOString()
      .slice(11, 23);
    const severity = record.severity_text ?? String(record.severity_number);
    const renderedBody = logBodyText(record.body).replace(/\s+/g, " ");
    const body =
      renderedBody.length > 140
        ? `${renderedBody.slice(0, 140)}…`
        : renderedBody;
    const correlation = record.trace_id
      ? ` (trace ${shortId(record.trace_id)})`
      : "";
    return `- ${time} ${severity} [${String(record.resource["service.name"] ?? "unknown")}] ${body}${correlation}`;
  });
  return `Logs (${logs.length})${modeNote(mode)}\n${lines.join("\n")}`;
}

export function summarizeMcpStats(stats: McpDashboardStats, hours: number): string {
  const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
  const nameList = (rows: Array<{ name: string; requests: number }>) =>
    rows.map((r) => `${r.name} ×${r.requests}`).join(", ") || "—";

  const lines = [
    `MCP traffic — last ${hours}h${modeNote(stats.mode)}` +
      (stats.truncated ? " (truncated at the 1000-trace fetch cap)" : ""),
    `Requests: ${stats.totals.requests}, errors: ${stats.totals.errors} ` +
      `(${pct(stats.totals.error_rate)})`,
    `Servers: ${nameList(stats.by_server)}`,
    `Transports: ${nameList(stats.by_transport)}`,
    `Methods: ${nameList(stats.by_method)}`,
  ];

  if (stats.tools.length > 0) {
    lines.push(
      "",
      "| Tool | Requests | Error rate | p95 |",
      "|------|----------|------------|-----|",
    );
    for (const tool of stats.tools.slice(0, 5)) {
      lines.push(
        `| ${tool.name} | ${tool.requests} | ${pct(tool.error_rate)} | ${tool.p95_ms} ms |`,
      );
    }
  }
  return lines.join("\n");
}
