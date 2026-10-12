/** Shared HTTP transport; every callable analysis operation is registered by name. */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import { CollectorError, collectorPost, parseCollectorBody } from "./collector.js";
import type { ToolScope } from "./request-scope.js";
import { telemetryToolResult } from "./telemetry-redaction.js";

export async function queryAnalysis<Input extends object, Output extends object>(
  operation: string,
  input: Input,
  schema: z.ZodType<Output>,
  scope: ToolScope,
): Promise<CallToolResult> {
  if (process.env.QYL_DEMO === "1") {
    throw new CollectorError("Analysis needs a live qyl Collector; unset QYL_DEMO to query recorded telemetry.");
  }
  const path = `/api/v1/analysis/${operation}`;
  const deadline = Date.now() + 55_000;
  let query: object = input;
  let previousPageSize = Infinity;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CollectorError("The query exceeded its time budget; narrow the time window and matchers.");
    const response = await collectorPost(path, query, { ...scope.collector, timeoutMs: remaining });
    const output = parseCollectorBody(response, path, schema);
    const result = telemetryToolResult(`${operation}: results are in the structured data.`, output);
    // Bytes give a conservative upper bound even for token-dense identifiers.
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes <= 24_000) {
      await scope.step(`Queried ${operation}`);
      return result;
    }
    // Re-query the collector so its cursor, coverage and totals describe the
    // smaller page. Never slice a response and leave its paging metadata stale.
    const args = query as Record<string, unknown>;
    const page = output as Record<string, unknown>;
    const canPage = (operation === "display_traces" && !args.trace_id)
      || (operation === "fetch_telemetry" && args.view === "traces");
    if (canPage && Array.isArray(page.traces) && page.traces.length > 1 && page.traces.length < previousPageSize) {
      previousPageSize = page.traces.length;
      const limit = Math.max(1, Math.floor(page.traces.length * 24_000 / bytes * 0.8));
      const window = page.window as { start_time?: string; end_time?: string } | undefined;
      query = { ...args, ...window, limit };
      continue;
    }
    throw new CollectorError(
      "The result exceeds the response budget; reduce limit or narrow the time window and matchers.",
      false, 413, "collector_rejected",
    );
  }
}
