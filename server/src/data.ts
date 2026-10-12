/** Collector trace polling for opt-in Events; the same analysis read used by tools. */
import { collectorPost, parseCollectorBody, type CollectorRequestOptions } from "./collector.js";
import { ListTracesOutputSchema } from "./contract-validation.js";
import { redactTelemetry } from "./telemetry-redaction.js";
import type { ListTracesInput, ToolTraceSummary } from "@ancplua/qyl-api-schema/types";

export async function fetchTraces(filters: ListTracesInput, options: CollectorRequestOptions = {}): Promise<ToolTraceSummary[]> {
  const path = "/api/v1/analysis/list_traces";
  const output = parseCollectorBody(await collectorPost(path, filters, options), path, ListTracesOutputSchema);
  return redactTelemetry(output.traces);
}
