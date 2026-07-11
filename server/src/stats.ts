/**
 * MCP dashboard aggregation — shared verbatim by the demo and live paths so
 * the demo dataset exercises exactly the code that renders production stats.
 */

import type { McpDashboardStats, McpToolRow, QylSpan } from "./wire.js";

export function spanAttr(span: QylSpan, key: string): string | undefined {
  const attr = span.attributes?.find((a) => a.key === key);
  return attr === undefined || attr.value === undefined
    ? undefined
    : String(attr.value);
}

/**
 * Pick a clean bucket size that tiles the window into 24–48 buckets.
 * For every integer hours in 1–168 the resulting count lands in range.
 */
export function pickBucketMs(windowMs: number): number {
  const MINUTE = 60_000;
  const candidates = [
    MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    60 * MINUTE, 120 * MINUTE, 180 * MINUTE, 240 * MINUTE, 360 * MINUTE,
  ];
  for (const candidate of candidates) {
    if (Math.ceil(windowMs / candidate) <= 48) return candidate;
  }
  return candidates[candidates.length - 1];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Nearest-rank 95th percentile of an ascending-sorted array. */
function nearestRankP95(sortedAsc: number[]): number {
  return sortedAsc[Math.max(0, Math.ceil(sortedAsc.length * 0.95) - 1)];
}

const MCP_METHOD_NAME_RE =
  /^(initialize|ping|tools\/(?:call|list)|resources\/(?:read|list|templates\/list|subscribe|unsubscribe)|prompts\/(?:get|list)|completion\/complete|logging\/setLevel|notifications\/[\w/]+)(?:\s+(.+))?$/;

/**
 * Classify a span as MCP traffic. Attributes win (full-fidelity emitters); the
 * span-name fallback ("tools/call get_trace", "resources/read ui://…" — the
 * Sentry-style description the qyl.mcp runner emits) recovers method/tool/
 * resource when a collector redacts unknown attributes. qyl's collector
 * allowlist strips mcp.* and app.transport today, keeping only
 * gen_ai.tool.name — so against a live qyl collector this fallback is what
 * lights the dashboard up.
 */
function classifyMcpSpan(
  span: QylSpan,
): { method: string; tool?: string; resourceUri?: string } | null {
  const attrMethod = spanAttr(span, "mcp.method.name");
  const nameMatch = MCP_METHOD_NAME_RE.exec(span.name ?? "");
  const method = attrMethod ?? nameMatch?.[1];
  if (method === undefined) return null;
  const target = nameMatch?.[2];
  const tool =
    spanAttr(span, "mcp.tool.name") ??
    spanAttr(span, "gen_ai.tool.name") ??
    (method === "tools/call" ? target : undefined);
  const resourceUri =
    spanAttr(span, "mcp.resource.uri") ??
    (method === "resources/read" ? target : undefined);
  return { method, tool, resourceUri };
}

/**
 * Aggregate flattened spans into McpDashboardStats (minus mode/truncated,
 * which depend on the data source). Only spans carrying an `mcp.method.name`
 * attribute and starting inside [windowStart, windowEnd] count; durations
 * come from the span nano fields; error = status.code 2.
 */
export function aggregateMcpStats(
  spans: QylSpan[],
  windowStart: number,
  windowEnd: number,
  bucketMs: number,
): Omit<McpDashboardStats, "mode" | "truncated"> {
  const startNano = windowStart * 1e6;
  const endNano = windowEnd * 1e6;
  const mcpSpans: Array<{ span: QylSpan; cls: NonNullable<ReturnType<typeof classifyMcpSpan>> }> = [];
  for (const s of spans) {
    if (s.start_time_unix_nano < startNano || s.start_time_unix_nano > endNano) continue;
    const cls = classifyMcpSpan(s);
    if (cls) mcpSpans.push({ span: s, cls });
  }

  const bucketCount = Math.max(1, Math.ceil((windowEnd - windowStart) / bucketMs));
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: new Date(windowStart + i * bucketMs).toISOString(),
    requests: 0,
    errors: 0,
  }));

  const byServer = new Map<string, number>();
  const byTransport = new Map<string, number>();
  const byMethod = new Map<string, number>();
  interface RowAcc { requests: number; errors: number; durations: number[] }
  const toolAcc = new Map<string, RowAcc>();
  const resourceAcc = new Map<string, RowAcc>();

  const bump = (map: Map<string, number>, name: string) =>
    map.set(name, (map.get(name) ?? 0) + 1);
  const accumulate = (
    map: Map<string, RowAcc>,
    name: string,
    error: boolean,
    ms: number,
  ) => {
    let acc = map.get(name);
    if (!acc) map.set(name, (acc = { requests: 0, errors: 0, durations: [] }));
    acc.requests++;
    if (error) acc.errors++;
    acc.durations.push(ms);
  };

  let totalErrors = 0;
  for (const { span, cls } of mcpSpans) {
    const error = span.status.code === 2;
    if (error) totalErrors++;
    const ms = (span.end_time_unix_nano - span.start_time_unix_nano) / 1e6;

    const startMs = span.start_time_unix_nano / 1e6;
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((startMs - windowStart) / bucketMs)),
    );
    buckets[index].requests++;
    if (error) buckets[index].errors++;

    // service.name is a reasonable last-resort "server" bucket when the
    // emitter-level mcp.server.name attribute was redacted.
    bump(
      byServer,
      spanAttr(span, "mcp.server.name") ??
        (typeof span.resource["service.name"] === "string"
          ? (span.resource["service.name"] as string)
          : "unknown"),
    );
    bump(byTransport, spanAttr(span, "app.transport") ?? "unknown");
    bump(byMethod, cls.method);

    if (cls.tool !== undefined) accumulate(toolAcc, cls.tool, error, ms);
    if (cls.resourceUri !== undefined) accumulate(resourceAcc, cls.resourceUri, error, ms);
  }

  const toNameRequests = (map: Map<string, number>) =>
    [...map]
      .map(([name, requests]) => ({ name, requests }))
      .sort((a, b) => b.requests - a.requests);

  const toRows = (map: Map<string, RowAcc>): McpToolRow[] =>
    [...map]
      .map(([name, acc]) => {
        const sorted = [...acc.durations].sort((a, b) => a - b);
        const sum = sorted.reduce((total, d) => total + d, 0);
        return {
          name,
          requests: acc.requests,
          errors: acc.errors,
          error_rate: round4(acc.errors / acc.requests),
          avg_ms: round2(sum / sorted.length),
          p95_ms: round2(nearestRankP95(sorted)),
        };
      })
      .sort((a, b) => b.requests - a.requests);

  const requests = mcpSpans.length;
  return {
    window: {
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
      bucket_ms: bucketMs,
    },
    buckets,
    totals: {
      requests,
      errors: totalErrors,
      error_rate: requests > 0 ? round4(totalErrors / requests) : 0,
    },
    by_server: toNameRequests(byServer),
    by_transport: toNameRequests(byTransport),
    by_method: toNameRequests(byMethod),
    tools: toRows(toolAcc),
    resources: toRows(resourceAcc),
    span_count_analyzed: requests,
  };
}
