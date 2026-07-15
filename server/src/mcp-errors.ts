import {
  ErrorCode,
  JSONRPCErrorResponseSchema,
  JSONRPCRequestSchema,
  JSONRPC_VERSION,
  type JSONRPCErrorResponse,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

/** Build a protocol error through the MCP SDK's normative runtime schema. */
export function mcpErrorResponse(
  code: ErrorCode,
  message: string,
  id?: RequestId,
): JSONRPCErrorResponse {
  return JSONRPCErrorResponseSchema.parse({
    jsonrpc: JSONRPC_VERSION,
    error: { code, message },
    ...(id === undefined ? {} : { id }),
  });
}

/** Preserve an ID only when the request itself is a valid SDK-owned envelope. */
export function mcpRequestId(value: unknown): RequestId | undefined {
  const parsed = JSONRPCRequestSchema.safeParse(value);
  return parsed.success ? parsed.data.id : undefined;
}
