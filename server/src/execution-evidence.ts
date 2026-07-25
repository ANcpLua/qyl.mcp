import type {
  WorkbenchExecutionCost,
  WorkbenchExecutionTokenUsage,
} from "@ancplua/qyl-api-schema/types";

export interface ExecutionEvidenceMetadata {
  tokenUsage?: WorkbenchExecutionTokenUsage;
  cost?: WorkbenchExecutionCost;
}

/**
 * Read only explicitly named usage/cost evidence from an MCP tool result.
 *
 * MCP does not define a universal billing envelope for tool results. qyl.mcp
 * therefore accepts metadata only from structured result fields (or _meta),
 * never from prose, latency, payload size, or a locally maintained estimate.
 */
export function extractExecutionEvidence(result: unknown): ExecutionEvidenceMetadata {
  if (!isRecord(result)) return {};

  const roots = [result.structuredContent, result._meta]
    .filter(isRecord);
  let tokenUsage: WorkbenchExecutionTokenUsage | undefined;
  let cost: WorkbenchExecutionCost | undefined;
  for (const root of roots) {
    tokenUsage ??= parseTokenUsage(
      root.tokenUsage
      ?? root.token_usage
      ?? root.usage,
    );
    cost ??= parseCost(root.cost ?? root.costUsd ?? root.cost_usd);
  }
  return {
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function parseTokenUsage(value: unknown): WorkbenchExecutionTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeInteger(value.inputTokens ?? value.input_tokens);
  const outputTokens = nonNegativeInteger(value.outputTokens ?? value.output_tokens);
  const totalTokens = nonNegativeInteger(value.totalTokens ?? value.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
    // A producer that reports token counts has supplied observed evidence.
    // It can opt into the explicit estimated=true state when appropriate.
    estimated: value.estimated === true,
  };
}

function parseCost(value: unknown): WorkbenchExecutionCost | undefined {
  if (typeof value === "number") {
    return nonNegativeNumber(value) === undefined
      ? undefined
      : { amount_usd: value, estimated: false };
  }
  if (!isRecord(value)) return undefined;
  const amountUsd = nonNegativeNumber(value.amountUsd ?? value.amount_usd);
  if (amountUsd === undefined) return undefined;
  const source = typeof value.source === "string" && value.source.trim().length > 0
    ? value.source.trim().slice(0, 256)
    : undefined;
  return {
    amount_usd: amountUsd,
    estimated: value.estimated === true,
    ...(source === undefined ? {} : { source }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    ? value
    : undefined;
}
