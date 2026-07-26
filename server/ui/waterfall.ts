/**
 * @file Waterfall geometry for the qyl trace explorer.
 *
 * Pure functions only (no DOM) so the math is unit-testable outside the app.
 */

/**
 * Minimal span shape the waterfall needs (subset of the wire QylSpan).
 *
 * Absolute nanosecond timestamps are decimal strings: an epoch-ns value is ~1.79e18,
 * past Number.MAX_SAFE_INTEGER, so they are parsed to BigInt and only narrowed to a
 * number once reduced to an offset or duration relative to the trace start.
 */
export interface WaterfallSpan {
  span_id: string;
  parent_span_id?: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
}

export interface WaterfallRow<S extends WaterfallSpan> {
  span: S;
  depth: number;
  /** Percent offset of the bar from the left edge (0–100). */
  leftPct: number;
  /** Percent width of the bar (CSS min-width keeps it ≥ 2px). */
  widthPct: number;
}

export interface Waterfall<S extends WaterfallSpan> {
  rows: Array<WaterfallRow<S>>;
  /** Absolute trace start, kept exact as a decimal string. */
  traceStartNs: string;
  /** Trace wall-clock span. A duration, so exact in a number until ~104 days. */
  totalNs: number;
}

/**
 * Depth-first flatten of the span tree, siblings ordered by start time.
 * Spans whose parent_span_id is missing from the trace (orphans) are treated
 * as roots at depth 0; cycles are broken by a visited set, with any spans
 * left unreachable appended at depth 0. Zero-duration traces render every
 * bar full-width instead of dividing by zero.
 */
export function computeWaterfall<S extends WaterfallSpan>(spans: S[]): Waterfall<S> {
  if (spans.length === 0) return { rows: [], traceStartNs: "0", totalNs: 0 };

  const byId = new Map<string, S>();
  for (const span of spans) byId.set(span.span_id, span);

  const children = new Map<string, S[]>();
  const roots: S[] = [];
  for (const span of spans) {
    const parent = span.parent_span_id;
    if (parent && parent !== span.span_id && byId.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(span);
      else children.set(parent, [span]);
    } else {
      roots.push(span);
    }
  }

  const byStart = (a: S, b: S) => {
    const left = BigInt(a.start_time_unix_nano);
    const right = BigInt(b.start_time_unix_nano);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);

  let traceStart = BigInt(spans[0].start_time_unix_nano);
  let traceEnd = BigInt(spans[0].end_time_unix_nano);
  for (const span of spans) {
    const start = BigInt(span.start_time_unix_nano);
    const end = BigInt(span.end_time_unix_nano);
    if (start < traceStart) traceStart = start;
    if (end > traceEnd) traceEnd = end;
  }
  // Reduced to a duration before narrowing, so the number is exact.
  const totalNs = Math.max(0, Number(traceEnd - traceStart));

  const rows: Array<WaterfallRow<S>> = [];
  const visited = new Set<string>();
  const pushRow = (span: S, depth: number) => {
    const startOffset = Number(BigInt(span.start_time_unix_nano) - traceStart);
    const durationNs = Math.max(
      0,
      Number(BigInt(span.end_time_unix_nano) - BigInt(span.start_time_unix_nano)),
    );
    const leftPct = totalNs > 0 ? Math.min(100, Math.max(0, (startOffset / totalNs) * 100)) : 0;
    const widthPct = totalNs > 0 ? Math.min(100 - leftPct, (durationNs / totalNs) * 100) : 100;
    rows.push({ span, depth, leftPct, widthPct });
  };
  const walk = (span: S, depth: number) => {
    if (visited.has(span.span_id)) return;
    visited.add(span.span_id);
    pushRow(span, depth);
    for (const child of children.get(span.span_id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  // Cycle leftovers (a↔b parent loops have no root): surface them anyway.
  const leftovers = spans.filter((s) => !visited.has(s.span_id)).sort(byStart);
  for (const span of leftovers) walk(span, 0);

  return { rows, traceStartNs: traceStart.toString(), totalNs };
}
