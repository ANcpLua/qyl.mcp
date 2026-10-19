/** Shared HTTP transport; every callable analysis operation is registered by name. */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import { CollectorError, collectorPost, parseCollectorBody } from "./collector.js";
import { ANALYSIS_RESPONSE_BYTES, compactAnalysisResult, responseBytes } from "./analysis-budget.js";
import { analysisSummary } from "./analysis-summary.js";
import type { ToolScope } from "./request-scope.js";
import { telemetryToolResult } from "./telemetry-redaction.js";

export async function queryAnalysis<Input extends object, Output extends object>(
  operation: string,
  input: Input,
  schema: z.ZodType<Output>,
  scope: ToolScope,
): Promise<CallToolResult> {
  const path = `/api/v1/analysis/${operation}`;
  const deadline = Date.now() + 55_000;
  let query: object = input;
  let previousPageSize = Infinity;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CollectorError("The query exceeded its time budget; narrow the time window and matchers.");
    const response = await collectorPost(path, query, { ...scope.collector, timeoutMs: remaining });
    const output = parseCollectorBody(response, path, schema);
    const result = telemetryToolResult(analysisSummary(operation, output), output);
    // Bytes give a conservative upper bound even for token-dense identifiers.
    const bytes = responseBytes(result);
    if (bytes <= ANALYSIS_RESPONSE_BYTES) {
      await scope.step(`Queried ${operation}`);
      return result;
    }
    // Re-query the collector so its cursor, coverage and totals describe the
    // smaller page. Never slice a response and leave its paging metadata stale.
    const args = query as Record<string, unknown>;
    const page = output as Record<string, unknown>;
    const originalPoints = operation === "get_metric_series" && typeof args.series_id === "string";
    const points = page.points as { items: unknown[] } | undefined;
    const sizeKey = originalPoints ? "points_limit" : operation === "get_trace" ? "max_spans" : operation === "query_metric" ? "series_limit" : operation === "get_agent_run" ? "max_steps" : "limit";
    const trace = page.trace as { spans?: unknown[] } | undefined;
    const observed = page.observed as { error_spans?: unknown[]; logs?: unknown[] } | undefined;
    const sizes = [trace?.spans?.length, observed?.error_spans?.length, observed?.logs?.length,
      ...Object.values(page).filter(Array.isArray).map((items) => items.length)].filter((size): size is number => size !== undefined);
    const pageSize = originalPoints ? points?.items.length ?? 0 : Math.max(0, ...sizes);
    if (pageSize > 1 && pageSize < previousPageSize) {
      previousPageSize = pageSize;
      const limit = Math.max(1, Math.floor(pageSize * ANALYSIS_RESPONSE_BYTES / bytes * 0.8));
      // The collector creates the smaller page and its continuation together.
      query = { ...args, ...(page.window as object), [sizeKey]: limit,
        ...(operation === "get_failure_context" ? { max_spans: limit, max_logs: limit } : {}) };
      continue;
    }
    // Original numeric oneofs, buckets and exemplars must remain complete.
    // A smaller page must come from the Collector with its signed continuation.
    if (originalPoints) {
      const route = `/api/v1/metrics/${encodeURIComponent(String(args.metric_name))}/series/${encodeURIComponent(String(args.series_id))}/points`;
      throw new CollectorError(
        `The complete original metric point page exceeds the MCP response budget. Read it through GET ${route} using the same time window and point cursor.`,
        false, undefined, "response_too_large",
      );
    }
    await scope.step(`Queried ${operation}; large evidence compacted`);
    return compactAnalysisResult(operation, output);
  }
}
