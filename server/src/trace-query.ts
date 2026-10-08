import type { DisplayTracesInput } from "@ancplua/qyl-api-schema/types";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { DisplayTracesInputSchema } from "./contract-validation.js";

export const TRACE_QUERY_META_KEY = "qyl/traceQuery";

/** Restore the query with its result when a host opens or recreates the viewer. */
export function traceQueryForResult(
  result: Pick<CallToolResult, "_meta">,
  fallback: DisplayTracesInput,
): DisplayTracesInput {
  const parsed = DisplayTracesInputSchema.safeParse(result._meta?.[TRACE_QUERY_META_KEY]);
  return parsed.success ? parsed.data : fallback;
}
