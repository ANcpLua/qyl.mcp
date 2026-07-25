import assert from "node:assert/strict";
import test from "node:test";
import { extractExecutionEvidence } from "./execution-evidence.js";

// The extracted values are the contract's WorkbenchExecutionTokenUsage and
// WorkbenchExecutionCost, so they carry the published snake_case names. The
// *input* stays permissive in both spellings: it is an arbitrary third-party
// MCP tool result, not a qyl contract.
test("extracts only explicit structured usage and cost evidence", () => {
  assert.deepEqual(extractExecutionEvidence({
    structuredContent: {
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, estimated: false },
      cost: { amountUsd: 0.25, estimated: false, source: "provider" },
    },
  }), {
    tokenUsage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, estimated: false },
    cost: { amount_usd: 0.25, estimated: false, source: "provider" },
  });
});

test("does not infer usage or cost from arbitrary result content", () => {
  assert.deepEqual(extractExecutionEvidence({
    content: [{ type: "text", text: "tokens: 12, cost: $0.25" }],
    structuredContent: { answer: 42 },
  }), {});
  assert.deepEqual(extractExecutionEvidence({
    structuredContent: { usage: { inputTokens: 12 } },
  }), {
    tokenUsage: { input_tokens: 12, estimated: false },
  });
});

test("accepts provider metadata in _meta while preserving explicit estimates", () => {
  assert.deepEqual(extractExecutionEvidence({
    _meta: {
      tokenUsage: { total_tokens: 10, estimated: true },
      cost: { amount_usd: 0.1, estimated: true },
    },
  }), {
    tokenUsage: { total_tokens: 10, estimated: true },
    cost: { amount_usd: 0.1, estimated: true },
  });
});
