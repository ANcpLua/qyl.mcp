/**
 * Text summaries (compact and model-friendly) for tool results.
 */

import type {
  MetricDescriptor,
  MetricQueryResult,
  MetricSeries,
} from "@ancplua/qyl-api-schema/types";
import type {
  McpDashboardStats,
  Mode,
  QylLogRecord,
  QylSession,
  QylSpan,
  QylTrace,
} from "./wire.js";
import { logBodyText } from "./log-body.js";

/**
 * Humanize a nanosecond duration: "1.24 s" / "87 ms" / "640 µs".
 *
 * Durations arrive as decimal strings but are safe to narrow: a duration only
 * reaches Number.MAX_SAFE_INTEGER at ~104 days. Absolute timestamps are not —
 * those go through nsToBigInt and are subtracted before ever becoming a Number.
 */
export function humanizeNs(ns: string): string {
  const value = Number(ns);
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} s`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} ms`;
  return `${Math.round(value / 1e3)} µs`;
}

/** Absolute nanosecond timestamps exceed Number.MAX_SAFE_INTEGER; never parse one with Number. */
export function nsToBigInt(ns: string): bigint {
  return BigInt(ns);
}

/** Comparator for sorting by an absolute nanosecond timestamp, exact at ns resolution. */
export function compareNs(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** ISO-8601 for an absolute nanosecond timestamp, via BigInt so the ms floor is exact. */
export function nsToIso(ns: string): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Root span name, or the earliest span when no root is identified. */
export function rootSpanName(trace: QylTrace): string {
  if (trace.root_span?.name) return trace.root_span.name;
  const earliest = [...(trace.spans ?? [])].sort((a, b) =>
    compareNs(a.start_time_unix_nano, b.start_time_unix_nano),
  )[0];
  return earliest?.name ?? "unknown";
}

function serviceOf(span: QylSpan): string {
  return String(span.resource?.service_name ?? "unknown");
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
        ? humanizeNs(String(Math.round(session.duration_ms * 1e6)))
        : "—";
    const genai = session.genai_usage
      ? `${session.genai_usage.request_count} req, ` +
        `${session.genai_usage.total_input_tokens}/${session.genai_usage.total_output_tokens} tok`
      : "—";
    lines.push(
      `| ${session["session_id"]} | ${session.state} | ${session.trace_count} | ` +
        `${session.span_count} | ${session.error_count} | ${duration} | ${genai} |`,
    );
  }
  return lines.join("\n");
}

export function summarizeLogs(logs: QylLogRecord[], mode: Mode): string {
  if (logs.length === 0) return `No logs matched${modeNote(mode)}.`;
  const lines = logs.map((record) => {
    const time = nsToIso(record.time_unix_nano).slice(11, 23);
    const severity = record.severity_text ?? String(record.severity_number);
    const renderedBody = logBodyText(record.body).replace(/\s+/g, " ");
    const body =
      renderedBody.length > 140
        ? `${renderedBody.slice(0, 140)}…`
        : renderedBody;
    const correlation = record.trace_id
      ? ` (trace ${shortId(record.trace_id)})`
      : "";
    return `- ${time} ${severity} [${String(record.resource.service_name ?? "unknown")}] ${body}${correlation}`;
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

/** One catalog line per instrument: what it is, and how much of it there is. */
export function summarizeMetricCatalog(metrics: readonly MetricDescriptor[], mode: Mode): string {
  if (metrics.length === 0) return `No metrics recorded (${mode} mode).`;
  const rows = metrics.map((metric) => {
    const unit = metric.unit ? ` [${metric.unit}]` : "";
    return `${metric.name}${unit} — ${metric.kind}, ${metric.series_count} series, last ${metric.last_seen}`;
  });
  return `${metrics.length} metrics (${mode} mode):\n${rows.join("\n")}`;
}

/** One line per stream, naming the attributes that distinguish it. */
export function summarizeMetricSeries(series: readonly MetricSeries[], mode: Mode): string {
  if (series.length === 0) return `No series match those attributes (${mode} mode).`;
  const rows = series.map((stream) => {
    const attributes = stream.attributes
      .map((attribute) => `${attribute.key}=${String(attribute.value)}`)
      .join(" ");
    const service = stream.service_name ? `${stream.service_name} ` : "";
    return `${stream.series_id} ${service}${attributes || "(no attributes)"}`;
  });
  return `${series.length} series of ${series[0]?.name} (${mode} mode):\n${rows.join("\n")}`;
}

/**
 * A range query answered as text: the shape of each stream, not every bucket.
 * The buckets are in structured content for anything that wants to plot them;
 * repeating them here would be the largest and least readable half of the
 * answer, so the text carries what a reader asks next — which stream, how far
 * it moved, and whether the answer is complete.
 */
export function summarizeMetricQuery(result: MetricQueryResult, mode: Mode): string {
  const unit = result.unit ? ` ${result.unit}` : "";
  const header =
    `${result.name} ${result.aggregation} over ${result.start_time}..${result.end_time} ` +
    `at ${result.step_ms} ms buckets (${mode} mode)`;
  if (result.series.length === 0) return `${header}\nNo matching series.`;

  const rows = result.series.map((stream) => {
    const values = stream.buckets
      .map((bucket) => bucket.value)
      .filter((value): value is number => value !== null);
    const label = stream.attributes.length === 0
      ? "all series"
      : stream.attributes.map((a) => `${a.key}=${String(a.value)}`).join(" ");
    if (values.length === 0) return `${label}: no recorded values`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((total, value) => total + value, 0) / values.length;
    const last = values[values.length - 1] as number;
    const points = stream.buckets.reduce((total, bucket) => total + bucket.point_count, 0);
    return (
      `${label}: last ${format(last)}${unit}, min ${format(min)}, avg ${format(avg)}, ` +
      `max ${format(max)} over ${values.length}/${stream.buckets.length} buckets, ${points} points`
    );
  });

  const truncated = result.truncated
    ? "\nTruncated: more streams matched than series_limit allowed."
    : "";
  return `${header}\n${rows.join("\n")}${truncated}`;
}

/** Metric values span bytes to seconds; four significant digits reads well for both. */
function format(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1000 || magnitude < 0.001) return value.toPrecision(4);
  return String(Number(value.toPrecision(4)));
}
