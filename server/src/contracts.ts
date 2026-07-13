import contractJsonSchema from "@ancplua/qyl-api-schema/json-schema" with { type: "json" };
import type {
  DisplayMcpDashboardInput,
  DisplayMcpDashboardOutput,
  DisplayTracesInput,
  DisplayTracesOutput,
  FetchTelemetryInput,
  FetchTelemetryOutput,
  GetTraceInput,
  GetTraceOutput,
  ListSessionsInput,
  ListSessionsOutput,
  ListTracesInput,
  ListTracesOutput,
  LogRecord,
  McpDashboardStats,
  McpDataMode,
  ProblemDetails,
  SearchLogsInput,
  SearchLogsOutput,
  SessionEntity,
  Span,
  Trace,
  TraceSummary,
} from "@ancplua/qyl-api-schema/types";
import { z } from "zod";

/**
 * JSON Schema integers are not limited to JavaScript's safe-integer range,
 * while Zod's `int64` conversion is. Qyl's current JSON DTO intentionally uses
 * numbers for Unix nanoseconds, so preserve the published integer constraint
 * with `multipleOf: 1` without adding Zod's non-contract safe-range ceiling.
 */
function adaptInt64ForJavaScript(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adaptInt64ForJavaScript);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const adapted = Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [key, adaptInt64ForJavaScript(entry)]),
  );
  if (
    source.type === "integer" &&
    (source.format === "int64" || source.format === "uint64")
  ) {
    adapted.type = "number";
    adapted.multipleOf = 1;
    delete adapted.format;
  }
  return adapted;
}

const runtimeJsonSchema = adaptInt64ForJavaScript(contractJsonSchema) as typeof contractJsonSchema;

/** Build a Zod validator from the published TypeSpec-owned JSON Schema. */
function contractSchema<T>(definition: string): z.ZodType<T> {
  return z.fromJSONSchema({
    $schema: runtimeJsonSchema.$schema,
    $defs: runtimeJsonSchema.$defs,
    $ref: `#/$defs/${definition}`,
  } as unknown as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<T>;
}

export const SpanSchema = contractSchema<Span>("OTel.Traces.Span");
export const TraceSummarySchema = contractSchema<TraceSummary>("OTel.Traces.TraceSummary");
export const TraceSchema = contractSchema<Trace>("OTel.Traces.Trace");
export const LogRecordSchema = contractSchema<LogRecord>("OTel.Logs.LogRecord");
export const SessionSchema = contractSchema<SessionEntity>("Domains.Observe.Session.SessionEntity");
export const ProblemDetailsSchema = contractSchema<ProblemDetails>("Common.Errors.ProblemDetails");
export const ModeSchema = contractSchema<McpDataMode>("Mcp.Tools.McpDataMode");
export const McpDashboardStatsSchema = contractSchema<McpDashboardStats>(
  "Mcp.Tools.McpDashboardStats",
);

export const DisplayTracesInputSchema = contractSchema<DisplayTracesInput>(
  "Mcp.Tools.DisplayTracesInput",
);
export const DisplayTracesOutputSchema = contractSchema<DisplayTracesOutput>(
  "Mcp.Tools.DisplayTracesOutput",
);
export const DisplayMcpDashboardInputSchema = contractSchema<DisplayMcpDashboardInput>(
  "Mcp.Tools.DisplayMcpDashboardInput",
);
export const DisplayMcpDashboardOutputSchema = contractSchema<DisplayMcpDashboardOutput>(
  "Mcp.Tools.DisplayMcpDashboardOutput",
);
export const ListTracesInputSchema = contractSchema<ListTracesInput>(
  "Mcp.Tools.ListTracesInput",
);
export const ListTracesOutputSchema = contractSchema<ListTracesOutput>(
  "Mcp.Tools.ListTracesOutput",
);
export const GetTraceInputSchema = contractSchema<GetTraceInput>("Mcp.Tools.GetTraceInput");
export const GetTraceOutputSchema = contractSchema<GetTraceOutput>("Mcp.Tools.GetTraceOutput");
export const ListSessionsInputSchema = contractSchema<ListSessionsInput>(
  "Mcp.Tools.ListSessionsInput",
);
export const ListSessionsOutputSchema = contractSchema<ListSessionsOutput>(
  "Mcp.Tools.ListSessionsOutput",
);
export const SearchLogsInputSchema = contractSchema<SearchLogsInput>("Mcp.Tools.SearchLogsInput");
export const SearchLogsOutputSchema = contractSchema<SearchLogsOutput>(
  "Mcp.Tools.SearchLogsOutput",
);
export const FetchTelemetryInputSchema = contractSchema<FetchTelemetryInput>(
  "Mcp.Tools.FetchTelemetryInput",
);
export const FetchTelemetryOutputSchema = contractSchema<FetchTelemetryOutput>(
  "Mcp.Tools.FetchTelemetryOutput",
);
