import assert from "node:assert/strict";
import test from "node:test";
import {
  ErrorCode,
  JSONRPCErrorResponseSchema,
  JSONRPC_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpErrorResponse, mcpRequestId } from "./mcp-errors.js";

test("fallback MCP errors are built by the SDK runtime schema", () => {
  const response = mcpErrorResponse(ErrorCode.InternalError, "Internal server error", 41);
  assert.deepEqual(response, {
    jsonrpc: JSONRPC_VERSION,
    error: { code: ErrorCode.InternalError, message: "Internal server error" },
    id: 41,
  });
  assert(JSONRPCErrorResponseSchema.safeParse(response).success);
});

test("request IDs only survive from SDK-valid JSON-RPC requests", () => {
  assert.equal(
    mcpRequestId({ jsonrpc: JSONRPC_VERSION, id: "request-1", method: "tools/list" }),
    "request-1",
  );
  assert.equal(mcpRequestId({ jsonrpc: "1.0", id: "forged", method: "tools/list" }), undefined);
  assert.equal(mcpRequestId({ id: 12 }), undefined);
});
