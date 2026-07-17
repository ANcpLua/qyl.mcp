import type {
  RunnerMcpExecutionCost,
  RunnerMcpExecutionTokenUsage,
} from "@ancplua/qyl-api-schema/types";

export interface ExecutionEvidenceMetadata {
  tokenUsage?: RunnerMcpExecutionTokenUsage;
  cost?: RunnerMcpExecutionCost;
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
  let tokenUsage: RunnerMcpExecutionTokenUsage | undefined;
  let cost: RunnerMcpExecutionCost | undefined;
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

function parseTokenUsage(value: unknown): RunnerMcpExecutionTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeInteger(value.inputTokens ?? value.input_tokens);
  const outputTokens = nonNegativeInteger(value.outputTokens ?? value.output_tokens);
  const totalTokens = nonNegativeInteger(value.totalTokens ?? value.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    // A producer that reports token counts has supplied observed evidence.
    // It can opt into the explicit estimated=true state when appropriate.
    estimated: value.estimated === true,
  };
}

function parseCost(value: unknown): RunnerMcpExecutionCost | undefined {
  if (typeof value === "number") {
    return nonNegativeNumber(value) === undefined
      ? undefined
      : { amountUsd: value, estimated: false };
  }
  if (!isRecord(value)) return undefined;
  const amountUsd = nonNegativeNumber(value.amountUsd ?? value.amount_usd);
  if (amountUsd === undefined) return undefined;
  const source = typeof value.source === "string" && value.source.trim().length > 0
    ? value.source.trim().slice(0, 256)
    : undefined;
  return {
    amountUsd,
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
