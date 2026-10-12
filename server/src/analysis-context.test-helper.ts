import type { ToolCoverage, ToolTrace, ToolTraceSummary } from "@ancplua/qyl-api-schema/types";
import type { QylTrace } from "./wire.js";

/** Fixed metadata for transport/schema tests; query semantics use the OTLP answer-key suite. */
export function readContext(count = 0) {
  const coverage: ToolCoverage = {
    examined: count, matched: count, returned: count,
    truncated: false, scan_complete: true, as_of: "2026-10-12T10:00:00Z",
  };
  return { window: { start_time: "2026-10-12T09:00:00Z", end_time: "2026-10-12T10:00:00Z" }, coverage };
}
export function toolTrace(trace: QylTrace): ToolTrace {
  return { ...trace, spans: trace.spans.map((span) => ({ ...span, role: "matched" })) };
}
export function toolSummary(trace: QylTrace): ToolTraceSummary {
  const { spans, ...summary } = trace;
  void spans;
  return { ...summary, root_error: trace.root_span?.status.code === 2,
    contained_error: trace.has_error, failure_ids: [], annotation_labels: [] };
}
