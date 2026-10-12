import type { CallToolResult } from "@modelcontextprotocol/server";
import { analysisSummary } from "./analysis-summary.js";
import { telemetryToolResult } from "./telemetry-redaction.js";

export const ANALYSIS_RESPONSE_BYTES = 24_000;
export const responseBytes = (result: object): number => Buffer.byteLength(JSON.stringify(result), "utf8");

/** Final compaction for a single large record, after the Collector has paged it.
 * Stable identities, counts and signed continuations are preserved. Bulk text and
 * nested evidence can be omitted; totals and the text response explain the loss.
 */
export function compactAnalysisResult(operation: string, original: object): CallToolResult {
  const output = structuredClone(original) as Record<string, unknown>;
  const totals = { ...(output.page_totals as Record<string, number> | undefined) };
  let omitted = 0;
  let shortened = 0;
  const coverage = { ...(output.coverage as Record<string, unknown>), truncated: true, returned: null };
  output.coverage = coverage;
  output.page_totals = totals;
  const result = (): CallToolResult => telemetryToolResult(
    `${analysisSummary(operation, output)}\nResponse budget: ${omitted} other evidence item(s) omitted; ${shortened} text field(s) shortened. Narrow the filters or use the continuation for more evidence.`, output);
  // These fields are descriptions/content, never identifiers, credentials or cursors.
  const textFields = new Set(["body", "text", "message", "status_message", "description", "brief", "summary", "pattern", "value", "name"]);
  function trimText(value: unknown, cap: number): void {
    if (Array.isArray(value)) { for (const item of value) trimText(item, cap); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && item.length > cap && textFields.has(key)) {
        (value as Record<string, unknown>)[key] = `${Array.from(item).slice(0, cap).join("")}…`;
        shortened++;
      } else trimText(item, cap);
    }
  }
  trimText(output, 512);
  for (let iteration = 0; responseBytes(result()) > ANALYSIS_RESPONSE_BYTES && iteration < 128; iteration++) {
    const arrays: Array<{ values: unknown[]; path: string; bytes: number }> = [];
    function collect(value: unknown, path: string): void {
      if (Array.isArray(value)) {
        if (value.length > 0) arrays.push({ values: value, path, bytes: responseBytes(value) });
        value.forEach((item, index) => collect(item, `${path}.${index}`));
      } else if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (key !== "page_totals" && key !== "coverage") collect(item, path ? `${path}.${key}` : key);
        }
      }
    }
    collect(output, "");
    // Prefer removing bulk inside a trace over removing the trace itself.
    arrays.sort((a, b) => (b.path.split(".").length > 1 ? b.bytes : b.bytes / 4) - (a.path.split(".").length > 1 ? a.bytes : a.bytes / 4));
    const candidate = arrays[0];
    if (!candidate) { trimText(output, 64); break; }
    const removed = candidate.values.splice(Math.floor(candidate.values.length / 2)).length;
    omitted += removed;
    totals[`other.${candidate.path}`] = (totals[`other.${candidate.path}`] ?? 0) + removed;
  }
  // A cursor can encode large filters. Keeping it must not defeat the response cap.
  if (responseBytes(result()) > ANALYSIS_RESPONSE_BYTES) {
    delete output.next_cursor;
    delete output.next_phase_cursor;
    trimText(output, 64);
  }
  return result();
}
