import contractJsonSchema from "@ancplua/qyl-api-schema/json-schema" with { type: "json" };
import type * as QylContracts from "@ancplua/qyl-api-schema/types";
import { z } from "zod";

type JsonSchemaObject = Record<string, unknown>;

// z.fromJSONSchema currently translates JSON Schema `date-time` to a Z-only
// validator. JSON Schema uses RFC 3339, which also permits numeric UTC offsets;
// reuse Zod's own offset-aware pattern while retaining the published format.
const rfc3339DateTimePattern = (() => {
  const pattern = z.iso.datetime({ offset: true }).def.pattern;
  if (!(pattern instanceof RegExp)) {
    throw new Error("Zod offset-aware date-time validator did not expose a pattern");
  }
  return pattern.source;
})();

/** Adapt published JSON Schema features that Zod cannot represent directly. */
function adaptPublishedSchemaForZod(schemaNode: unknown): unknown {
  if (typeof schemaNode !== "object" || schemaNode === null || Array.isArray(schemaNode)) {
    throw new Error("Published Qyl JSON Schema root must be an object");
  }

  const root = schemaNode as JsonSchemaObject;
  const sourceDefinitions = asSchemaRecord(root.$defs, "$defs");
  const definitionCache = new Map<string, JsonSchemaObject>();
  const resolvingDefinitions = new Set<string>();

  const definition = (name: string): JsonSchemaObject => {
    const cached = definitionCache.get(name);
    if (cached) return cached;
    if (resolvingDefinitions.has(name)) {
      throw new Error(`Published Qyl JSON Schema has an inheritance cycle at '${name}'`);
    }
    const source = sourceDefinitions[name];
    if (source === undefined) {
      throw new Error(`Published Qyl JSON Schema is missing definition '${name}'`);
    }
    resolvingDefinitions.add(name);
    const adapted = adaptNode(source);
    resolvingDefinitions.delete(name);
    definitionCache.set(name, adapted);
    return adapted;
  };

  const adaptNode = (node: unknown): JsonSchemaObject => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new Error("Expected a JSON Schema object node");
    }
    const source = node as JsonSchemaObject;
    const inheritedDefinitions = inheritedObjectDefinitions(source, definition);
    const adapted: JsonSchemaObject = {};

    if (inheritedDefinitions.length > 0) {
      let inheritedAdditionalProperties: unknown;
      for (const inherited of inheritedDefinitions) {
        const existingProperties = optionalSchemaRecord(adapted.properties);
        const inheritedProperties = optionalSchemaRecord(inherited.properties);
        const existingRequired = stringArray(adapted.required);
        const inheritedRequired = stringArray(inherited.required);
        Object.assign(adapted, inherited);
        adapted.properties = { ...existingProperties, ...inheritedProperties };
        adapted.required = [...new Set([...existingRequired, ...inheritedRequired])];
        inheritedAdditionalProperties = inherited.additionalProperties;
      }
      delete adapted.description;
      delete adapted.additionalProperties;

      for (const [keyword, child] of Object.entries(source)) {
        if (
          keyword === "allOf" ||
          keyword === "properties" ||
          keyword === "required" ||
          keyword === "unevaluatedProperties"
        ) {
          continue;
        }
        adapted[keyword] = adaptValue(child);
      }
      adapted.properties = {
        ...optionalSchemaRecord(adapted.properties),
        ...adaptSchemaRecord(source.properties),
      };
      const required = [
        ...new Set([...stringArray(adapted.required), ...stringArray(source.required)]),
      ];
      if (required.length > 0) adapted.required = required;
      else delete adapted.required;

      if ("unevaluatedProperties" in source) {
        adapted.additionalProperties = adaptUnevaluatedProperties(source.unevaluatedProperties);
      } else if (inheritedAdditionalProperties !== undefined) {
        adapted.additionalProperties = inheritedAdditionalProperties;
      }
    } else {
      for (const [keyword, child] of Object.entries(source)) {
        if (keyword === "unevaluatedProperties") continue;
        adapted[keyword] = adaptValue(child);
      }
      if ("unevaluatedProperties" in source) {
        adapted.additionalProperties = adaptUnevaluatedProperties(source.unevaluatedProperties);
      }
    }

    // JSON Schema integers are not limited to JavaScript's safe-integer range,
    // while Zod's `int64` conversion is. Qyl's JSON DTO intentionally uses
    // numbers for Unix nanoseconds, so retain the integer rule without adding
    // Zod's non-contract safe-range ceiling.
    if (
      source.type === "integer" &&
      (source.format === "int64" || source.format === "uint64")
    ) {
      adapted.type = "number";
      adapted.multipleOf = 1;
      delete adapted.format;
    }
    if (source.type === "string" && source.format === "date-time") {
      adapted.pattern = rfc3339DateTimePattern;
      delete adapted.format;
    }
    return adapted;
  };

  const adaptValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(adaptValue);
    if (typeof value === "object" && value !== null) return adaptNode(value);
    return value;
  };

  const adaptSchemaRecord = (value: unknown): JsonSchemaObject => {
    const record = optionalSchemaRecord(value);
    return Object.fromEntries(
      Object.entries(record).map(([name, child]) => [name, adaptValue(child)]),
    );
  };

  const adaptUnevaluatedProperties = (value: unknown): unknown =>
    isFalseSchema(value) ? false : adaptValue(value);

  const rootWithoutDefinitions = { ...root };
  delete rootWithoutDefinitions.$defs;
  const adaptedRoot = adaptNode(rootWithoutDefinitions);
  adaptedRoot.$defs = Object.fromEntries(
    Object.keys(sourceDefinitions).map((name) => [name, definition(name)]),
  );
  return adaptedRoot;
}

function inheritedObjectDefinitions(
  source: JsonSchemaObject,
  resolve: (name: string) => JsonSchemaObject,
): JsonSchemaObject[] {
  if (source.type !== "object" || !Array.isArray(source.allOf)) return [];
  const names = source.allOf.map((entry) => definitionNameFromRef(entry));
  if (names.some((name) => name === undefined)) return [];
  const inherited = names.map((name) => resolve(name!));
  return inherited.every((definition) => definition.type === "object") ? inherited : [];
}

function definitionNameFromRef(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as JsonSchemaObject;
  if (Object.keys(record).length !== 1 || typeof record.$ref !== "string") return undefined;
  const prefix = "#/$defs/";
  return record.$ref.startsWith(prefix) ? record.$ref.slice(prefix.length) : undefined;
}

function asSchemaRecord(value: unknown, context: string): JsonSchemaObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Published Qyl JSON Schema ${context} must be an object`);
  }
  return value as JsonSchemaObject;
}

function optionalSchemaRecord(value: unknown): JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonSchemaObject
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function isFalseSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as JsonSchemaObject;
  const not = record.not;
  return Object.keys(record).length === 1 &&
    typeof not === "object" &&
    not !== null &&
    !Array.isArray(not) &&
    Object.keys(not).length === 0;
}

const zodCompatibleContractJsonSchema = adaptPublishedSchemaForZod(
  contractJsonSchema,
) as typeof contractJsonSchema;

const publishedContractSchemas = new Map<string, z.ZodType<unknown>>();

/** Build a strict runtime validator from the published TypeSpec-owned JSON Schema. */
export function publishedContractSchema<TContract>(definitionName: string): z.ZodType<TContract> {
  const cached = publishedContractSchemas.get(definitionName);
  if (cached) return cached as z.ZodType<TContract>;
  if (!(definitionName in zodCompatibleContractJsonSchema.$defs)) {
    throw new Error(`Published Qyl JSON Schema has no '${definitionName}' definition`);
  }
  const schema = z.fromJSONSchema({
    $schema: zodCompatibleContractJsonSchema.$schema,
    $defs: zodCompatibleContractJsonSchema.$defs,
    $ref: `#/$defs/${definitionName}`,
  } as unknown as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<TContract>;
  publishedContractSchemas.set(definitionName, schema as z.ZodType<unknown>);
  return schema;
}

function runnerContractSchema<TContract>(name: string): z.ZodType<TContract> {
  return publishedContractSchema<TContract>(`Runner.Mcp.${name}`);
}

// Qyl telemetry and installable MCP server contracts.
export const SpanSchema = publishedContractSchema<QylContracts.Span>("OTel.Traces.Span");
export const TraceSummarySchema = publishedContractSchema<QylContracts.TraceSummary>(
  "OTel.Traces.TraceSummary",
);
export const TraceSchema = publishedContractSchema<QylContracts.Trace>("OTel.Traces.Trace");
export const LogRecordSchema = publishedContractSchema<QylContracts.LogRecord>(
  "OTel.Logs.LogRecord",
);
export const MetricPointSchema = publishedContractSchema<QylContracts.MetricPoint>(
  "OTel.Metrics.MetricPoint",
);
export const SessionSchema = publishedContractSchema<QylContracts.SessionEntity>(
  "Domains.Observe.Session.SessionEntity",
);

// Exact operation response bodies. These are intentionally not reconstructed
// from the generic CursorPage component: the TypeSpec operation is the public
// HTTP boundary and therefore owns both the envelope and its concrete item.
export const TracesListResponseSchema =
  publishedContractSchema<QylContracts.CursorPageTrace>(
    "Operations.TracesApi_list.Response.200",
  );
export const TraceSpansListResponseSchema =
  publishedContractSchema<QylContracts.CursorPageSpan>(
    "Operations.TracesApi_getSpans.Response.200",
  );
export const SessionTracesListResponseSchema =
  publishedContractSchema<QylContracts.CursorPageTrace>(
    "Operations.SessionsApi_getTraces.Response.200",
  );
export const LogsListResponseSchema =
  publishedContractSchema<QylContracts.CursorPageLogRecord>(
    "Operations.LogsApi_list.Response.200",
  );
export const MetricsListResponseSchema =
  publishedContractSchema<QylContracts.CursorPageMetricPoint>(
    "Operations.MetricsApi_list.Response.200",
  );
export const SessionsListResponseSchema =
  publishedContractSchema<QylContracts.CursorPageSessionEntity>(
    "Operations.SessionsApi_list.Response.200",
  );

export const ProblemDetailsSchema = publishedContractSchema<QylContracts.ProblemDetails>(
  "Common.Errors.ProblemDetails",
);
export const ModeSchema = publishedContractSchema<QylContracts.McpDataMode>(
  "Mcp.Tools.McpDataMode",
);
export const McpDashboardStatsSchema = publishedContractSchema<QylContracts.McpDashboardStats>(
  "Mcp.Tools.McpDashboardStats",
);

export const DisplayTracesInputSchema = publishedContractSchema<QylContracts.DisplayTracesInput>(
  "Mcp.Tools.DisplayTracesInput",
);
export const DisplayTracesOutputSchema = publishedContractSchema<QylContracts.DisplayTracesOutput>(
  "Mcp.Tools.DisplayTracesOutput",
);
export const DisplayMcpDashboardInputSchema =
  publishedContractSchema<QylContracts.DisplayMcpDashboardInput>(
    "Mcp.Tools.DisplayMcpDashboardInput",
  );
export const DisplayMcpDashboardOutputSchema =
  publishedContractSchema<QylContracts.DisplayMcpDashboardOutput>(
    "Mcp.Tools.DisplayMcpDashboardOutput",
  );
export const ListTracesInputSchema = publishedContractSchema<QylContracts.ListTracesInput>(
  "Mcp.Tools.ListTracesInput",
);
export const ListTracesOutputSchema = publishedContractSchema<QylContracts.ListTracesOutput>(
  "Mcp.Tools.ListTracesOutput",
);
export const GetTraceInputSchema = publishedContractSchema<QylContracts.GetTraceInput>(
  "Mcp.Tools.GetTraceInput",
);
export const GetTraceOutputSchema = publishedContractSchema<QylContracts.GetTraceOutput>(
  "Mcp.Tools.GetTraceOutput",
);
export const ListSessionsInputSchema = publishedContractSchema<QylContracts.ListSessionsInput>(
  "Mcp.Tools.ListSessionsInput",
);
export const ListSessionsOutputSchema = publishedContractSchema<QylContracts.ListSessionsOutput>(
  "Mcp.Tools.ListSessionsOutput",
);
export const SearchLogsInputSchema = publishedContractSchema<QylContracts.SearchLogsInput>(
  "Mcp.Tools.SearchLogsInput",
);
export const SearchLogsOutputSchema = publishedContractSchema<QylContracts.SearchLogsOutput>(
  "Mcp.Tools.SearchLogsOutput",
);
export const FetchTelemetryInputSchema = publishedContractSchema<QylContracts.FetchTelemetryInput>(
  "Mcp.Tools.FetchTelemetryInput",
);
export const FetchTelemetryOutputSchema = publishedContractSchema<QylContracts.FetchTelemetryOutput>(
  "Mcp.Tools.FetchTelemetryOutput",
);

export const RunnerResourceStateSchema = publishedContractSchema<QylContracts.RunnerResourceState>(
  "Runner.RunnerResourceState",
);
export const RunnerLogLineSchema = publishedContractSchema<QylContracts.RunnerLogLine>(
  "Runner.RunnerLogLine",
);

// Workbench identity, session, and workspace boundaries.
export const RunnerMcpSessionIdSchema = runnerContractSchema<QylContracts.RunnerMcpSessionId>(
  "RunnerMcpSessionId",
);
export const RunnerMcpWorkspaceIdSchema = runnerContractSchema<QylContracts.RunnerMcpWorkspaceId>(
  "RunnerMcpWorkspaceId",
);
export const RunnerMcpServerIdSchema = runnerContractSchema<QylContracts.RunnerMcpServerId>(
  "RunnerMcpServerId",
);
export const RunnerMcpExecutionIdSchema = runnerContractSchema<QylContracts.RunnerMcpExecutionId>(
  "RunnerMcpExecutionId",
);
export const RunnerMcpEvaluationRunIdSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRunId>("RunnerMcpEvaluationRunId");
export const RunnerMcpTestCaseIdSchema = runnerContractSchema<QylContracts.RunnerMcpTestCaseId>(
  "RunnerMcpTestCaseId",
);
export const RunnerMcpSuiteIdSchema = runnerContractSchema<QylContracts.RunnerMcpSuiteId>(
  "RunnerMcpSuiteId",
);
export const RunnerMcpEvaluationExportIdSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportId>(
    "RunnerMcpEvaluationExportId",
  );
export const RunnerMcpPrincipalIdentitySchema =
  runnerContractSchema<QylContracts.RunnerMcpPrincipalIdentity>("RunnerMcpPrincipalIdentity");
export const RunnerMcpWorkbenchSessionSchema =
  runnerContractSchema<QylContracts.RunnerMcpWorkbenchSession>("RunnerMcpWorkbenchSession");
export const RunnerMcpSessionBootstrapResponseSchema =
  runnerContractSchema<QylContracts.RunnerMcpSessionBootstrapResponse>(
    "RunnerMcpSessionBootstrapResponse",
  );
export const RunnerMcpWorkspaceSchema = runnerContractSchema<QylContracts.RunnerMcpWorkspace>(
  "RunnerMcpWorkspace",
);
export const RunnerMcpWorkspaceCreateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpWorkspaceCreateRequest>(
    "RunnerMcpWorkspaceCreateRequest",
  );
export const RunnerMcpWorkspaceUpdateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpWorkspaceUpdateRequest>(
    "RunnerMcpWorkspaceUpdateRequest",
  );
export const RunnerMcpWorkspaceListResponseSchema =
  runnerContractSchema<QylContracts.RunnerMcpWorkspaceListResponse>(
    "RunnerMcpWorkspaceListResponse",
  );
export const RunnerMcpToolInputModeSchema =
  runnerContractSchema<QylContracts.RunnerMcpToolInputMode>("RunnerMcpToolInputMode");
export const RunnerMcpWorkspacePreferencesSchema =
  runnerContractSchema<QylContracts.RunnerMcpWorkspacePreferences>(
    "RunnerMcpWorkspacePreferences",
  );
export const RunnerMcpWorkspacePreferencesUpdateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpWorkspacePreferencesUpdateRequest>(
    "RunnerMcpWorkspacePreferencesUpdateRequest",
  );

// Sanitized transport configuration and connection lifecycle.
export const RunnerMcpTransportKindSchema =
  runnerContractSchema<QylContracts.RunnerMcpTransportKind>("RunnerMcpTransportKind");
export const RunnerMcpHeaderSecretSchemeSchema =
  runnerContractSchema<QylContracts.RunnerMcpHeaderSecretScheme>(
    "RunnerMcpHeaderSecretScheme",
  );
export const RunnerMcpSecretReferenceSchema =
  runnerContractSchema<QylContracts.RunnerMcpSecretReference>("RunnerMcpSecretReference");
export const RunnerMcpEnvironmentSecretReferenceSchema =
  runnerContractSchema<QylContracts.RunnerMcpEnvironmentSecretReference>(
    "RunnerMcpEnvironmentSecretReference",
  );
export const RunnerMcpHeaderSecretReferenceSchema =
  runnerContractSchema<QylContracts.RunnerMcpHeaderSecretReference>(
    "RunnerMcpHeaderSecretReference",
  );
export const RunnerMcpStdioServerConfigurationSchema =
  runnerContractSchema<QylContracts.RunnerMcpStdioServerConfiguration>(
    "RunnerMcpStdioServerConfiguration",
  );
export const RunnerMcpStreamableHttpServerConfigurationSchema =
  runnerContractSchema<QylContracts.RunnerMcpStreamableHttpServerConfiguration>(
    "RunnerMcpStreamableHttpServerConfiguration",
  );
export const RunnerMcpSseServerConfigurationSchema =
  runnerContractSchema<QylContracts.RunnerMcpSseServerConfiguration>(
    "RunnerMcpSseServerConfiguration",
  );
export const RunnerMcpInProcessServerConfigurationSchema =
  runnerContractSchema<QylContracts.RunnerMcpInProcessServerConfiguration>(
    "RunnerMcpInProcessServerConfiguration",
  );
export const RunnerMcpBuiltinServerConfigurationSchema =
  runnerContractSchema<QylContracts.RunnerMcpBuiltinServerConfiguration>(
    "RunnerMcpBuiltinServerConfiguration",
  );
export const RunnerMcpServerConfigurationSchema =
  runnerContractSchema<QylContracts.RunnerMcpServerConfiguration>(
    "RunnerMcpServerConfiguration",
  );
export const RunnerMcpErrorCategorySchema =
  runnerContractSchema<QylContracts.RunnerMcpErrorCategory>("RunnerMcpErrorCategory");
export const RunnerMcpErrorSchema = runnerContractSchema<QylContracts.RunnerMcpError>(
  "RunnerMcpError",
);
export const RunnerMcpInitializationSnapshotSchema =
  runnerContractSchema<QylContracts.RunnerMcpInitializationSnapshot>(
    "RunnerMcpInitializationSnapshot",
  );
export const RunnerMcpConnectionStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpConnectionStatus>("RunnerMcpConnectionStatus");
export const RunnerMcpConnectionSnapshotSchema =
  runnerContractSchema<QylContracts.RunnerMcpConnectionSnapshot>(
    "RunnerMcpConnectionSnapshot",
  );
export const RunnerMcpServerSchema = runnerContractSchema<QylContracts.RunnerMcpServer>(
  "RunnerMcpServer",
);
export const RunnerMcpServerCreateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpServerCreateRequest>(
    "RunnerMcpServerCreateRequest",
  );
export const RunnerMcpServerUpdateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpServerUpdateRequest>(
    "RunnerMcpServerUpdateRequest",
  );
export const RunnerMcpServerListResponseSchema =
  runnerContractSchema<QylContracts.RunnerMcpServerListResponse>(
    "RunnerMcpServerListResponse",
  );
export const RunnerMcpServerActionAcceptedSchema =
  runnerContractSchema<QylContracts.RunnerMcpServerActionAccepted>(
    "RunnerMcpServerActionAccepted",
  );

// MCP discovery and redacted protocol evidence. SDK payloads remain unknown.
export const RunnerMcpDiscoveryCollectionSchema =
  runnerContractSchema<QylContracts.RunnerMcpDiscoveryCollection>(
    "RunnerMcpDiscoveryCollection",
  );
export const RunnerMcpDiscoverySnapshotSchema =
  runnerContractSchema<QylContracts.RunnerMcpDiscoverySnapshot>("RunnerMcpDiscoverySnapshot");
export const RunnerMcpProtocolDirectionSchema =
  runnerContractSchema<QylContracts.RunnerMcpProtocolDirection>(
    "RunnerMcpProtocolDirection",
  );
export const RunnerMcpProtocolEventKindSchema =
  runnerContractSchema<QylContracts.RunnerMcpProtocolEventKind>("RunnerMcpProtocolEventKind");
export const RunnerMcpProtocolEventSchema =
  runnerContractSchema<QylContracts.RunnerMcpProtocolEvent>("RunnerMcpProtocolEvent");
export const RunnerMcpProtocolEventPageSchema =
  runnerContractSchema<QylContracts.RunnerMcpProtocolEventPage>("RunnerMcpProtocolEventPage");

// Asynchronous execution and correlated Qyl observability evidence.
export const RunnerMcpExecutionEffectSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionEffect>("RunnerMcpExecutionEffect");
export const RunnerMcpExecutionStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionStatus>("RunnerMcpExecutionStatus");
export const RunnerMcpExecutionConfirmationRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionConfirmationRequest>(
    "RunnerMcpExecutionConfirmationRequest",
  );
export const RunnerMcpExecutionConfirmationEvidenceSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionConfirmationEvidence>(
    "RunnerMcpExecutionConfirmationEvidence",
  );
export const RunnerMcpExecutionRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionRequest>("RunnerMcpExecutionRequest");
export const RunnerMcpExecutionTokenUsageSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionTokenUsage>(
    "RunnerMcpExecutionTokenUsage",
  );
export const RunnerMcpExecutionCostSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionCost>("RunnerMcpExecutionCost");
export const RunnerMcpTelemetryCorrelationSchema =
  runnerContractSchema<QylContracts.RunnerMcpTelemetryCorrelation>(
    "RunnerMcpTelemetryCorrelation",
  );
export const RunnerMcpExecutionRecordSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionRecord>("RunnerMcpExecutionRecord");
export const RunnerMcpExecutionAcceptedSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionAccepted>("RunnerMcpExecutionAccepted");
export const RunnerMcpExecutionCancelRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionCancelRequest>(
    "RunnerMcpExecutionCancelRequest",
  );
export const RunnerMcpExecutionPageSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionPage>("RunnerMcpExecutionPage");
export const RunnerMcpTelemetryAvailabilitySchema =
  runnerContractSchema<QylContracts.RunnerMcpTelemetryAvailability>(
    "RunnerMcpTelemetryAvailability",
  );
export const RunnerMcpTelemetrySignalAvailabilitySchema =
  runnerContractSchema<QylContracts.RunnerMcpTelemetrySignalAvailability>(
    "RunnerMcpTelemetrySignalAvailability",
  );
export const RunnerMcpTelemetrySignalSummarySchema =
  runnerContractSchema<QylContracts.RunnerMcpTelemetrySignalSummary>(
    "RunnerMcpTelemetrySignalSummary",
  );
export const RunnerMcpExecutionTelemetryResponseSchema =
  runnerContractSchema<QylContracts.RunnerMcpExecutionTelemetryResponse>(
    "RunnerMcpExecutionTelemetryResponse",
  );

// Reusable test cases, assertions, and suites.
export const RunnerMcpAssertionStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpAssertionStatus>("RunnerMcpAssertionStatus");
export const RunnerMcpStatusAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpStatusAssertion>("RunnerMcpStatusAssertion");
export const RunnerMcpExactAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpExactAssertion>("RunnerMcpExactAssertion");
export const RunnerMcpPartialAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpPartialAssertion>("RunnerMcpPartialAssertion");
export const RunnerMcpSchemaAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpSchemaAssertion>("RunnerMcpSchemaAssertion");
export const RunnerMcpPatternAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpPatternAssertion>("RunnerMcpPatternAssertion");
export const RunnerMcpLatencyAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpLatencyAssertion>("RunnerMcpLatencyAssertion");
export const RunnerMcpTestAssertionSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestAssertion>("RunnerMcpTestAssertion");
export const RunnerMcpTestCaseSchema = runnerContractSchema<QylContracts.RunnerMcpTestCase>(
  "RunnerMcpTestCase",
);
export const RunnerMcpTestCaseCreateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestCaseCreateRequest>(
    "RunnerMcpTestCaseCreateRequest",
  );
export const RunnerMcpTestCaseUpdateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestCaseUpdateRequest>(
    "RunnerMcpTestCaseUpdateRequest",
  );
export const RunnerMcpTestCasePageSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestCasePage>("RunnerMcpTestCasePage");
export const RunnerMcpTestSuiteSchema = runnerContractSchema<QylContracts.RunnerMcpTestSuite>(
  "RunnerMcpTestSuite",
);
export const RunnerMcpTestSuiteCreateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestSuiteCreateRequest>(
    "RunnerMcpTestSuiteCreateRequest",
  );
export const RunnerMcpTestSuiteUpdateRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestSuiteUpdateRequest>(
    "RunnerMcpTestSuiteUpdateRequest",
  );
export const RunnerMcpTestSuitePageSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestSuitePage>("RunnerMcpTestSuitePage");

// Evaluation runs, comparisons, and export artifacts.
export const RunnerMcpEvaluationResultStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationResultStatus>(
    "RunnerMcpEvaluationResultStatus",
  );
export const RunnerMcpEvaluationRunStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRunStatus>(
    "RunnerMcpEvaluationRunStatus",
  );
export const RunnerMcpRegressionStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpRegressionStatus>("RunnerMcpRegressionStatus");
export const RunnerMcpEvaluationRunRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRunRequest>(
    "RunnerMcpEvaluationRunRequest",
  );
export const RunnerMcpTestCaseRunRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpTestCaseRunRequest>(
    "RunnerMcpTestCaseRunRequest",
  );
export const RunnerMcpSuiteRunRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpSuiteRunRequest>("RunnerMcpSuiteRunRequest");
export const RunnerMcpAssertionResultSchema =
  runnerContractSchema<QylContracts.RunnerMcpAssertionResult>("RunnerMcpAssertionResult");
export const RunnerMcpEvaluationTestCaseSnapshotSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationTestCaseSnapshot>(
    "RunnerMcpEvaluationTestCaseSnapshot",
  );
export const RunnerMcpEvaluationSuiteSnapshotSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationSuiteSnapshot>(
    "RunnerMcpEvaluationSuiteSnapshot",
  );
export const RunnerMcpEvaluationTestResultSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationTestResult>(
    "RunnerMcpEvaluationTestResult",
  );
export const RunnerMcpEvaluationSummarySchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationSummary>("RunnerMcpEvaluationSummary");
export const RunnerMcpEvaluationRunSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRun>("RunnerMcpEvaluationRun");
export const RunnerMcpEvaluationRunAcceptedSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRunAccepted>(
    "RunnerMcpEvaluationRunAccepted",
  );
export const RunnerMcpEvaluationRunPageSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRunPage>(
    "RunnerMcpEvaluationRunPage",
  );
export const RunnerMcpEvaluationComparisonRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationComparisonRequest>(
    "RunnerMcpEvaluationComparisonRequest",
  );
export const RunnerMcpEvaluationTestComparisonSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationTestComparison>(
    "RunnerMcpEvaluationTestComparison",
  );
export const RunnerMcpEvaluationRunComparisonSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationRunComparison>(
    "RunnerMcpEvaluationRunComparison",
  );
export const RunnerMcpEvaluationExportFormatSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportFormat>(
    "RunnerMcpEvaluationExportFormat",
  );
export const RunnerMcpEvaluationExportStatusSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportStatus>(
    "RunnerMcpEvaluationExportStatus",
  );
export const RunnerMcpEvaluationExportRequestSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportRequest>(
    "RunnerMcpEvaluationExportRequest",
  );
export const RunnerMcpEvaluationExportSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExport>("RunnerMcpEvaluationExport");
export const RunnerMcpEvaluationJsonExportPayloadSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationJsonExportPayload>(
    "RunnerMcpEvaluationJsonExportPayload",
  );
export const RunnerMcpEvaluationReportExportPayloadSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationReportExportPayload>(
    "RunnerMcpEvaluationReportExportPayload",
  );
export const RunnerMcpEvaluationExportPayloadSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportPayload>(
    "RunnerMcpEvaluationExportPayload",
  );
export const RunnerMcpEvaluationExportArtifactSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportArtifact>(
    "RunnerMcpEvaluationExportArtifact",
  );
export const RunnerMcpEvaluationExportAcceptedSchema =
  runnerContractSchema<QylContracts.RunnerMcpEvaluationExportAccepted>(
    "RunnerMcpEvaluationExportAccepted",
  );

// Generated Problem Details variants used by both workbench and Qyl tools.
export const UnauthorizedErrorSchema = publishedContractSchema<QylContracts.UnauthorizedError>(
  "Common.Errors.UnauthorizedError",
);
export const ForbiddenErrorSchema = publishedContractSchema<QylContracts.ForbiddenError>(
  "Common.Errors.ForbiddenError",
);
export const NotFoundErrorSchema = publishedContractSchema<QylContracts.NotFoundError>(
  "Common.Errors.NotFoundError",
);
export const ValidationErrorSchema = publishedContractSchema<QylContracts.ValidationError>(
  "Common.Errors.ValidationError",
);
export const ConflictErrorSchema = publishedContractSchema<QylContracts.ConflictError>(
  "Common.Errors.ConflictError",
);
export const BadGatewayErrorSchema = publishedContractSchema<QylContracts.BadGatewayError>(
  "Common.Errors.BadGatewayError",
);
export const ServiceUnavailableErrorSchema =
  publishedContractSchema<QylContracts.ServiceUnavailableError>(
    "Common.Errors.ServiceUnavailableError",
  );
export const InternalServerErrorSchema =
  publishedContractSchema<QylContracts.InternalServerError>(
    "Common.Errors.InternalServerError",
  );
