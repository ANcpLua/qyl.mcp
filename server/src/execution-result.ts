import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SecretRedactor } from "./secret-redactor.js";

export const MAX_PERSISTED_RESULT_CHARACTERS = 2_000_000;

/** Redact a validated MCP result and bound only its durable representation. */
export function sanitizePersistedToolResult(
  result: CallToolResult,
  redactor: SecretRedactor,
): CallToolResult {
  const sanitized = redactor.redact(result) as CallToolResult;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_PERSISTED_RESULT_CHARACTERS) return sanitized;
  return {
    content: [{
      type: "text",
      text:
        `[Tool output omitted: sanitized result exceeded ${MAX_PERSISTED_RESULT_CHARACTERS} characters.]`,
    }],
    isError: true,
    _meta: { qylOutputTruncated: true },
  };
}
