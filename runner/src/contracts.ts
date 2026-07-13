import contractJsonSchema from "@ancplua/qyl-api-schema/json-schema" with { type: "json" };
import type {
    BadGatewayError,
    ConflictError,
    ForbiddenError,
    InternalServerError,
    NotFoundError,
    RunnerLogLine,
    RunnerMcpResourceReadRequest,
    RunnerMcpResourceReadResponse,
    RunnerMcpToolCallRequest,
    RunnerMcpToolCallResponse,
    RunnerMcpToolsResponse,
    RunnerResourceState,
    ValidationError,
} from "@ancplua/qyl-api-schema/types";
import { z } from "zod";

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

export const ForbiddenErrorSchema = contractSchema<ForbiddenError>("Common.Errors.ForbiddenError");
export const NotFoundErrorSchema = contractSchema<NotFoundError>("Common.Errors.NotFoundError");
export const ValidationErrorSchema = contractSchema<ValidationError>("Common.Errors.ValidationError");
export const ConflictErrorSchema = contractSchema<ConflictError>("Common.Errors.ConflictError");
export const BadGatewayErrorSchema = contractSchema<BadGatewayError>("Common.Errors.BadGatewayError");
export const InternalServerErrorSchema = contractSchema<InternalServerError>(
    "Common.Errors.InternalServerError",
);
