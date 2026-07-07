/**
 * @file Waterfall geometry for the qyl trace explorer.
 *
 * Pure functions only (no DOM) so the math is unit-testable outside the app.
 */

/** Minimal span shape the waterfall needs (subset of the wire QylSpan). */
export interface WaterfallSpan {
  span_id: string;
  parent_span_id?: string;
  start_time_unix_nano: number;
  end_time_unix_nano: number;
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
  traceStartNs: number;
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
  if (spans.length === 0) return { rows: [], traceStartNs: 0, totalNs: 0 };

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

  const byStart = (a: S, b: S) => a.start_time_unix_nano - b.start_time_unix_nano;
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);

  let traceStartNs = Infinity;
  let traceEndNs = -Infinity;
  for (const span of spans) {
    traceStartNs = Math.min(traceStartNs, span.start_time_unix_nano);
    traceEndNs = Math.max(traceEndNs, span.end_time_unix_nano);
  }
  const totalNs = Math.max(0, traceEndNs - traceStartNs);

  const rows: Array<WaterfallRow<S>> = [];
  const visited = new Set<string>();
  const pushRow = (span: S, depth: number) => {
    const startOffset = span.start_time_unix_nano - traceStartNs;
    const durationNs = Math.max(0, span.end_time_unix_nano - span.start_time_unix_nano);
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

  return { rows, traceStartNs, totalNs };
}
