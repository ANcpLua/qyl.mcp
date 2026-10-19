/** Compact evidence for hosts that show text without expanding structuredContent. */
export function analysisSummary(operation: string, output: object): string {
  const data = output as Record<string, unknown>;
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const short = (value: unknown): string => (value == null ? "unknown" : typeof value === "string" ? value : JSON.stringify(value) ?? "unknown").replace(/\s+/gu, " ").slice(0, 180);
  const lines = [operation.replaceAll("_", " ")];
  const coverage = record(data.coverage);
  if (Object.keys(coverage).length) lines.push(`Matched ${short(coverage.matched)}; returned ${short(coverage.returned)}. ${coverage.scan_complete === true ? "Scan complete." : "Scan incomplete; totals may be unknown."}`);
  const points = record(data.points);
  if (Array.isArray(points.items)) {
    const unknown = points.items.filter(point => record(point).data === null).length;
    lines.push(`original points: ${points.items.length} on this page${unknown ? `; ${unknown} original representation unknown` : ""}.`);
    if (points.has_more === true && typeof points.next_cursor === "string") {
      lines.push("More original points: repeat with points.next_cursor as points_cursor, the same series_id and filters.");
    }
  }
  for (const key of ["verdict", "reason", "settled", "method", "unit", "approximate"]) {
    if (data[key] !== undefined) lines.push(`${key}: ${short(data[key])}`);
  }
  const totals = record(data.totals);
  if (totals.requests !== undefined) lines.push(`${short(totals.errors)} errors / ${short(totals.requests)} requests; p95 ${short(totals.p95_ms)} ms.`);
  const trace = record(data.trace);
  if (trace.trace_id) lines.push(`Trace ${short(trace.trace_id)}: ${short(trace.span_count)} spans${trace.has_error ? ", contains errors" : ""}.`);
  const cause = record(record(data.observed).root_cause_span);
  if (cause.name) lines.push(`Recorded failure: ${short(cause.service)} / ${short(cause.name)} — ${short(record(cause.exception).message ?? cause.status)}`);
  const collections = ["failures", "regressions", "groups", "steps", "traces", "sessions", "logs", "items", "attributes", "releases", "nodes", "runs", "phases", "saved_queries"];
  let evidence = 0;
  for (const field of collections) {
    const rows = data[field];
    if (!Array.isArray(rows)) continue;
    lines.push(`${field.replaceAll("_", " ")}: ${rows.length} on this page.`);
    for (const value of rows) {
      if (evidence >= 3) break;
      const row = record(value);
      const title = row.normalized_message ?? row.name ?? row.operation ?? row.key ?? row.root_span_name ?? row.body ?? row.service ?? row.session_id;
      if (title === undefined) continue;
      const label = typeof title === "object" ? JSON.stringify(title) : title;
      const stats = row.count ?? row.requests ?? row.status ?? row.change;
      const id = row.failure_id ?? row.trace_id;
      lines.push(`- ${short(label)}${stats === undefined ? "" : ` (${short(stats)})`}${id === undefined ? "" : ` · ${short(id)}`}`);
      evidence++;
    }
  }
  if (data.has_more === true && typeof data.next_cursor === "string") lines.push("More results: repeat with next_cursor and the same filters.");
  else if (data.has_more === true && typeof data.next_phase_cursor === "string") lines.push("More phases: repeat with next_phase_cursor as phase_cursor and the same filters.");
  else if (data.has_more === true) lines.push("More evidence exists; narrow the filters to retrieve it.");
  else if (coverage.truncated === true) lines.push("Evidence is truncated; narrow the query for more detail.");
  return lines.slice(0, 14).join("\n");
}
