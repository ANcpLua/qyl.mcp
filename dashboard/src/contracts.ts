import contractJsonSchema from "@ancplua/qyl-api-schema/json-schema" with { type: "json" };
import type {
  ProblemDetails,
  RunnerLogLine,
  RunnerMcpResourceReadRequest,
  RunnerMcpResourceReadResponse,
  RunnerMcpToolCallRequest,
  RunnerMcpToolCallResponse,
  RunnerMcpToolsResponse,
  RunnerResourceState,
} from "@ancplua/qyl-api-schema/types";
import { z } from "zod";
export { McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps/app-bridge";

/** Translate the published record keyword to Zod's supported equivalent. */
function adaptForZod(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adaptForZod);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const adapted = Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [key, adaptForZod(entry)]),
  );
  if ("unevaluatedProperties" in source && !("additionalProperties" in source)) {
    adapted.additionalProperties = adaptForZod(source.unevaluatedProperties);
    delete adapted.unevaluatedProperties;
  }
  return adapted;
}

const runtimeJsonSchema = adaptForZod(contractJsonSchema) as typeof contractJsonSchema;

function contractSchema<T>(definition: string): z.ZodType<T> {
  return z.fromJSONSchema({
    $schema: runtimeJsonSchema.$schema,
    $defs: runtimeJsonSchema.$defs,
    $ref: `#/$defs/${definition}`,
  } as unknown as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<T>;
}

export const RunnerResourceStateSchema = contractSchema<RunnerResourceState>(
  "Runner.RunnerResourceState",
);
export const RunnerLogLineSchema = contractSchema<RunnerLogLine>("Runner.RunnerLogLine");
export const RunnerMcpToolsResponseSchema = contractSchema<RunnerMcpToolsResponse>(
  "Runner.Mcp.RunnerMcpToolsResponse",
);
export const RunnerMcpToolCallRequestSchema = contractSchema<RunnerMcpToolCallRequest>(
  "Runner.Mcp.RunnerMcpToolCallRequest",
);
export const RunnerMcpToolCallResponseSchema = contractSchema<RunnerMcpToolCallResponse>(
  "Runner.Mcp.RunnerMcpToolCallResponse",
);
export const RunnerMcpResourceReadRequestSchema = contractSchema<RunnerMcpResourceReadRequest>(
  "Runner.Mcp.RunnerMcpResourceReadRequest",
);
export const RunnerMcpResourceReadResponseSchema = contractSchema<RunnerMcpResourceReadResponse>(
  "Runner.Mcp.RunnerMcpResourceReadResponse",
);
export const ProblemDetailsSchema = contractSchema<ProblemDetails>("Common.Errors.ProblemDetails");
