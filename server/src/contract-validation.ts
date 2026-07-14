import contractJsonSchema from "@ancplua/qyl-api-schema/json-schema" with { type: "json" };
import type {
  BadGatewayError,
  ConflictError,
  DisplayMcpDashboardInput,
  DisplayMcpDashboardOutput,
  DisplayTracesInput,
  DisplayTracesOutput,
  FetchTelemetryInput,
  FetchTelemetryOutput,
  ForbiddenError,
  GetTraceInput,
  GetTraceOutput,
  InternalServerError,
  ListSessionsInput,
  ListSessionsOutput,
  ListTracesInput,
  ListTracesOutput,
  LogRecord,
  McpDashboardStats,
  McpDataMode,
  NotFoundError,
  ProblemDetails,
  RunnerLogLine,
  RunnerMcpResourceReadRequest,
  RunnerMcpResourceReadResponse,
  RunnerMcpToolCallRequest,
  RunnerMcpToolCallResponse,
  RunnerMcpToolsResponse,
  RunnerResourceState,
  SearchLogsInput,
  SearchLogsOutput,
  SessionEntity,
  Span,
  Trace,
  TraceSummary,
  ValidationError,
} from "@ancplua/qyl-api-schema/types";
import { z } from "zod";

/** Adapt published JSON Schema features that Zod cannot represent directly. */
function adaptPublishedSchemaForZod(schemaNode: unknown): unknown {
  if (Array.isArray(schemaNode)) return schemaNode.map(adaptPublishedSchemaForZod);
  if (typeof schemaNode !== "object" || schemaNode === null) return schemaNode;

  const sourceObject = schemaNode as Record<string, unknown>;
  const adaptedObject = Object.fromEntries(
    Object.entries(sourceObject).map(([keyword, childNode]) => [
      keyword,
      adaptPublishedSchemaForZod(childNode),
    ]),
  );

  // TypeSpec emits record-only dictionaries with the JSON Schema 2020-12
  // `unevaluatedProperties` keyword. Zod's converter supports the equivalent
  // `additionalProperties` form but otherwise throws while loading the schema.
  // Refuse to rewrite composed objects, where the two keywords differ.
  if ("unevaluatedProperties" in sourceObject) {
    const composedObjectKeywords = [
      "properties",
      "patternProperties",
      "allOf",
      "anyOf",
      "oneOf",
      "not",
      "if",
      "then",
      "else",
    ];
    if (
      "additionalProperties" in sourceObject ||
      composedObjectKeywords.some((keyword) => keyword in sourceObject)
    ) {
      throw new Error("Cannot safely adapt composed unevaluatedProperties schema for Zod");
    }
    adaptedObject.additionalProperties = adaptedObject.unevaluatedProperties;
    delete adaptedObject.unevaluatedProperties;
  }

  // JSON Schema integers are not limited to JavaScript's safe-integer range,
  // while Zod's `int64` conversion is. Qyl's current JSON DTO intentionally
  // uses numbers for Unix nanoseconds, so retain the published integer rule
  // without adding Zod's non-contract safe-range ceiling.
  if (
    sourceObject.type === "integer" &&
    (sourceObject.format === "int64" || sourceObject.format === "uint64")
  ) {
    adaptedObject.type = "number";
    adaptedObject.multipleOf = 1;
    delete adaptedObject.format;
  }
  return adaptedObject;
}

const zodCompatibleContractJsonSchema = adaptPublishedSchemaForZod(
  contractJsonSchema,
) as typeof contractJsonSchema;

/** Build a runtime validator from the published TypeSpec-owned JSON Schema. */
function publishedContractSchema<TContract>(definitionName: string): z.ZodType<TContract> {
  return z.fromJSONSchema({
    $schema: zodCompatibleContractJsonSchema.$schema,
    $defs: zodCompatibleContractJsonSchema.$defs,
    $ref: `#/$defs/${definitionName}`,
  } as unknown as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<TContract>;
}

export const SpanSchema = publishedContractSchema<Span>("OTel.Traces.Span");
export const TraceSummarySchema = publishedContractSchema<TraceSummary>(
  "OTel.Traces.TraceSummary",
);
export const TraceSchema = publishedContractSchema<Trace>("OTel.Traces.Trace");
export const LogRecordSchema = publishedContractSchema<LogRecord>("OTel.Logs.LogRecord");
export const SessionSchema = publishedContractSchema<SessionEntity>(
  "Domains.Observe.Session.SessionEntity",
);
export const ProblemDetailsSchema = publishedContractSchema<ProblemDetails>(
  "Common.Errors.ProblemDetails",
);
export const ModeSchema = publishedContractSchema<McpDataMode>("Mcp.Tools.McpDataMode");
export const McpDashboardStatsSchema = publishedContractSchema<McpDashboardStats>(
  "Mcp.Tools.McpDashboardStats",
);

export const DisplayTracesInputSchema = publishedContractSchema<DisplayTracesInput>(
  "Mcp.Tools.DisplayTracesInput",
);
export const DisplayTracesOutputSchema = publishedContractSchema<DisplayTracesOutput>(
  "Mcp.Tools.DisplayTracesOutput",
);
export const DisplayMcpDashboardInputSchema = publishedContractSchema<DisplayMcpDashboardInput>(
  "Mcp.Tools.DisplayMcpDashboardInput",
);
export const DisplayMcpDashboardOutputSchema = publishedContractSchema<DisplayMcpDashboardOutput>(
  "Mcp.Tools.DisplayMcpDashboardOutput",
);
export const ListTracesInputSchema = publishedContractSchema<ListTracesInput>(
  "Mcp.Tools.ListTracesInput",
);
export const ListTracesOutputSchema = publishedContractSchema<ListTracesOutput>(
  "Mcp.Tools.ListTracesOutput",
);
export const GetTraceInputSchema = publishedContractSchema<GetTraceInput>(
  "Mcp.Tools.GetTraceInput",
);
export const GetTraceOutputSchema = publishedContractSchema<GetTraceOutput>(
  "Mcp.Tools.GetTraceOutput",
);
export const ListSessionsInputSchema = publishedContractSchema<ListSessionsInput>(
  "Mcp.Tools.ListSessionsInput",
);
export const ListSessionsOutputSchema = publishedContractSchema<ListSessionsOutput>(
  "Mcp.Tools.ListSessionsOutput",
);
export const SearchLogsInputSchema = publishedContractSchema<SearchLogsInput>(
  "Mcp.Tools.SearchLogsInput",
);
export const SearchLogsOutputSchema = publishedContractSchema<SearchLogsOutput>(
  "Mcp.Tools.SearchLogsOutput",
);
export const FetchTelemetryInputSchema = publishedContractSchema<FetchTelemetryInput>(
  "Mcp.Tools.FetchTelemetryInput",
);
export const FetchTelemetryOutputSchema = publishedContractSchema<FetchTelemetryOutput>(
  "Mcp.Tools.FetchTelemetryOutput",
);

export const RunnerResourceStateSchema = publishedContractSchema<RunnerResourceState>(
  "Runner.RunnerResourceState",
);
export const RunnerLogLineSchema = publishedContractSchema<RunnerLogLine>(
  "Runner.RunnerLogLine",
);
export const RunnerMcpToolsResponseSchema = publishedContractSchema<RunnerMcpToolsResponse>(
  "Runner.Mcp.RunnerMcpToolsResponse",
);
export const RunnerMcpToolCallRequestSchema = publishedContractSchema<RunnerMcpToolCallRequest>(
  "Runner.Mcp.RunnerMcpToolCallRequest",
);
export const RunnerMcpToolCallResponseSchema = publishedContractSchema<RunnerMcpToolCallResponse>(
  "Runner.Mcp.RunnerMcpToolCallResponse",
);
export const RunnerMcpResourceReadRequestSchema =
  publishedContractSchema<RunnerMcpResourceReadRequest>(
    "Runner.Mcp.RunnerMcpResourceReadRequest",
  );
export const RunnerMcpResourceReadResponseSchema =
  publishedContractSchema<RunnerMcpResourceReadResponse>(
    "Runner.Mcp.RunnerMcpResourceReadResponse",
  );

export const ForbiddenErrorSchema = publishedContractSchema<ForbiddenError>(
  "Common.Errors.ForbiddenError",
);
export const NotFoundErrorSchema = publishedContractSchema<NotFoundError>(
  "Common.Errors.NotFoundError",
);
export const ValidationErrorSchema = publishedContractSchema<ValidationError>(
  "Common.Errors.ValidationError",
);
export const ConflictErrorSchema = publishedContractSchema<ConflictError>(
  "Common.Errors.ConflictError",
);
export const BadGatewayErrorSchema = publishedContractSchema<BadGatewayError>(
  "Common.Errors.BadGatewayError",
);
export const InternalServerErrorSchema = publishedContractSchema<InternalServerError>(
  "Common.Errors.InternalServerError",
);
