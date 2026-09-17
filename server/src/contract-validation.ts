import { contractSchema, publishedContractSchema, type ContractInput } from "@ancplua/qyl-api-schema/zod";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

// The JSON-Schema-to-Zod adapter that produced these validators is published by
// the contract package itself, so this module is now only the named bindings.
// Both names are re-exported rather than imported directly by their users:
// workbench/ and dashboard/ reach them through "qyl-mcp-server/contract-validation".
// Every binding below is `contractSchema("<definition>")`, whose result type the contract
// package binds to the name, so a shape cannot be paired with the wrong type.
export { contractSchema, publishedContractSchema, type ContractInput };

const JSON_SCHEMA_TARGET = "draft-2020-12" as const;

const compacted = new WeakMap<object, StandardSchemaWithJSON<never, never>>();

/**
 * Emits a tool's output JSON Schema with repeated subschemas hoisted into
 * `$defs`, when that spelling is actually smaller than the inlined one.
 *
 * The contract's telemetry models nest: a Trace carries Spans, a Span carries
 * attribute values, and the same leaf shapes recur dozens of times inside one
 * response body. The SDK asks a schema for its JSON Schema through
 * `~standard.jsonSchema`, and zod's default there inlines every occurrence, so
 * `tools/list` shipped the Span tree once per mention — 232 KB for the fourteen
 * tools that existed when this was written, most of it the same object repeated. Every byte of that is context an
 * agent pays for on connect.
 *
 * The choice is per schema and measured, not assumed: `reused: "ref"` hoists
 * anything seen twice, which is a loss on a flat shape whose repeats are single
 * keywords ("#/$defs/__schema12" costs more than {"type":"string"}). Taking the
 * smaller of the two keeps the win where the nesting is real and changes
 * nothing where it is not, so no tool pays for the mechanism.
 *
 * Validation is unchanged — `validate` still runs the generated zod schema, so
 * structured content is checked against the contract exactly as before. Only
 * the advertised spelling of the same schema differs, and the conversion is
 * deferred and memoised so importing this module in a browser bundle
 * (dashboard, workbench) costs nothing.
 */
export function compactOutputSchema<T>(schema: z.ZodType<T>): StandardSchemaWithJSON<T, T> {
  // createServer() runs per hosted request, so the wrapper is cached on the
  // generated schema: registering every tool must not re-derive the same
  // JSON Schema on every connection.
  const cachedWrapper = compacted.get(schema);
  if (cachedWrapper !== undefined) return cachedWrapper as StandardSchemaWithJSON<T, T>;

  let emitted: Record<string, unknown> | undefined;
  const jsonSchema = (): Record<string, unknown> => {
    if (emitted === undefined) {
      const inlined = z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io: "output" });
      const hoisted = z.toJSONSchema(schema, {
        target: JSON_SCHEMA_TARGET,
        io: "output",
        reused: "ref",
      });
      emitted = JSON.stringify(hoisted).length < JSON.stringify(inlined).length ? hoisted : inlined;
    }
    return emitted;
  };
  const standard = schema["~standard"];
  const wrapper = {
    "~standard": {
      version: 1,
      vendor: standard.vendor,
      jsonSchema: { input: jsonSchema, output: jsonSchema },
      validate: (value: unknown) => standard.validate(value),
    },
  } as StandardSchemaWithJSON<T, T>;
  compacted.set(schema, wrapper as unknown as StandardSchemaWithJSON<never, never>);
  return wrapper;
}


// Qyl telemetry and installable MCP server contracts.
export const SpanSchema = contractSchema("OTel.Traces.Span");
export const TraceSummarySchema = contractSchema("OTel.Traces.TraceSummary");
export const TraceSchema = contractSchema("OTel.Traces.Trace");
export const LogRecordSchema = contractSchema("OTel.Logs.LogRecord");
export const SessionSchema = contractSchema("Domains.Observe.Session.SessionEntity");

// Exact operation response bodies. These are intentionally not reconstructed
// from the generic CursorPage component: the TypeSpec operation is the public
// HTTP boundary and therefore owns both the envelope and its concrete item.
export const TracesListResponseSchema =
  contractSchema("Operations.TracesApi_list.Response.200");
export const TraceSpansListResponseSchema =
  contractSchema("Operations.TracesApi_getSpans.Response.200");
export const SessionTracesListResponseSchema =
  contractSchema("Operations.SessionsApi_getTraces.Response.200");
export const LogsListResponseSchema =
  contractSchema("Operations.LogsApi_list.Response.200");
export const SessionsListResponseSchema =
  contractSchema("Operations.SessionsApi_list.Response.200");

// Metrics read surface (contract 8.0.0). The list and series endpoints page
// like every other reader; the query endpoint answers with the result model
// directly, so its 200 body IS MetricQueryResult.
export const MetricDescriptorSchema = contractSchema("OTel.Metrics.MetricDescriptor");
export const MetricSeriesSchema = contractSchema("OTel.Metrics.MetricSeries");
export const MetricQueryResultSchema = contractSchema("Operations.MetricsApi_query.Response.200");
export const MetricsListResponseSchema =
  contractSchema("Operations.MetricsApi_list.Response.200");
export const MetricSeriesListResponseSchema =
  contractSchema("Operations.MetricsApi_listSeries.Response.200");

export const ProblemDetailsSchema = contractSchema("Common.Errors.ProblemDetails");
export const ModeSchema = contractSchema("Mcp.Tools.McpDataMode");
export const McpDashboardStatsSchema = contractSchema("Mcp.Tools.McpDashboardStats");

export const DisplayTracesInputSchema = contractSchema("Mcp.Tools.DisplayTracesInput");
export const DisplayTracesOutputSchema = contractSchema("Mcp.Tools.DisplayTracesOutput");
export const DisplayMcpDashboardInputSchema =
  contractSchema("Mcp.Tools.DisplayMcpDashboardInput");
export const DisplayMcpDashboardOutputSchema =
  contractSchema("Mcp.Tools.DisplayMcpDashboardOutput");
export const ListTracesInputSchema = contractSchema("Mcp.Tools.ListTracesInput");
export const ListTracesOutputSchema = contractSchema("Mcp.Tools.ListTracesOutput");
export const GetTraceInputSchema = contractSchema("Mcp.Tools.GetTraceInput");
export const GetTraceOutputSchema = contractSchema("Mcp.Tools.GetTraceOutput");
export const ListSessionsInputSchema = contractSchema("Mcp.Tools.ListSessionsInput");
export const ListSessionsOutputSchema = contractSchema("Mcp.Tools.ListSessionsOutput");
export const SearchLogsInputSchema = contractSchema("Mcp.Tools.SearchLogsInput");
export const SearchLogsOutputSchema = contractSchema("Mcp.Tools.SearchLogsOutput");
export const FetchTelemetryInputSchema = contractSchema("Mcp.Tools.FetchTelemetryInput");
export const FetchTelemetryOutputSchema = contractSchema("Mcp.Tools.FetchTelemetryOutput");
export const CiLogInputSchema = contractSchema("Mcp.Tools.CiLogInput");
export const CiRunSummarySchema = contractSchema("Mcp.Tools.CiRunSummary");
export const CiPhaseSchema = contractSchema("Mcp.Tools.CiPhase");
export const CiLogOutputSchema = contractSchema("Mcp.Tools.CiLogOutput");

export const RunnerResourceStateSchema = contractSchema("Runner.RunnerResourceState");
export const RunnerLogLineSchema = contractSchema("Runner.RunnerLogLine");

// Workbench identity, session, and workspace boundaries.
export const WorkbenchSessionIdSchema = contractSchema("Workbench.WorkbenchSessionId");
export const WorkbenchWorkspaceIdSchema = contractSchema("Workbench.WorkbenchWorkspaceId");
export const WorkbenchServerIdSchema = contractSchema("Workbench.WorkbenchServerId");
export const WorkbenchExecutionIdSchema = contractSchema("Workbench.WorkbenchExecutionId");
export const WorkbenchEvaluationRunIdSchema =
  contractSchema("Workbench.WorkbenchEvaluationRunId");
export const WorkbenchTestCaseIdSchema = contractSchema("Workbench.WorkbenchTestCaseId");
export const WorkbenchSuiteIdSchema = contractSchema("Workbench.WorkbenchSuiteId");
export const WorkbenchEvaluationExportIdSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportId");
export const WorkbenchPrincipalIdentitySchema =
  contractSchema("Workbench.WorkbenchPrincipalIdentity");
export const WorkbenchSessionSchema =
  contractSchema("Workbench.WorkbenchSession");
export const WorkbenchSessionBootstrapResponseSchema =
  contractSchema("Workbench.WorkbenchSessionBootstrapResponse");
export const WorkbenchWorkspaceSchema = contractSchema("Workbench.WorkbenchWorkspace");
export const WorkbenchWorkspaceCreateRequestSchema =
  contractSchema("Workbench.WorkbenchWorkspaceCreateRequest");
export const WorkbenchWorkspaceUpdateRequestSchema =
  contractSchema("Workbench.WorkbenchWorkspaceUpdateRequest");
export const WorkbenchWorkspaceListResponseSchema =
  contractSchema("Workbench.WorkbenchWorkspaceListResponse");
export const WorkbenchToolInputModeSchema =
  contractSchema("Workbench.WorkbenchToolInputMode");
export const WorkbenchWorkspacePreferencesSchema =
  contractSchema("Workbench.WorkbenchWorkspacePreferences");
export const WorkbenchWorkspacePreferencesUpdateRequestSchema =
  contractSchema("Workbench.WorkbenchWorkspacePreferencesUpdateRequest");

// Sanitized transport configuration and connection lifecycle.
export const WorkbenchTransportKindSchema =
  contractSchema("Workbench.WorkbenchTransportKind");
export const WorkbenchHeaderSecretSchemeSchema =
  contractSchema("Workbench.WorkbenchHeaderSecretScheme");
export const WorkbenchSecretReferenceSchema =
  contractSchema("Workbench.WorkbenchSecretReference");
export const WorkbenchEnvironmentSecretReferenceSchema =
  contractSchema("Workbench.WorkbenchEnvironmentSecretReference");
export const WorkbenchHeaderSecretReferenceSchema =
  contractSchema("Workbench.WorkbenchHeaderSecretReference");
export const WorkbenchStdioServerConfigurationSchema =
  contractSchema("Workbench.WorkbenchStdioServerConfiguration");
export const WorkbenchStreamableHttpServerConfigurationSchema =
  contractSchema("Workbench.WorkbenchStreamableHttpServerConfiguration");
export const WorkbenchBuiltinServerConfigurationSchema =
  contractSchema("Workbench.WorkbenchBuiltinServerConfiguration");
export const WorkbenchServerConfigurationSchema =
  contractSchema("Workbench.WorkbenchServerConfiguration");
export const WorkbenchErrorCategorySchema =
  contractSchema("Workbench.WorkbenchErrorCategory");
export const WorkbenchErrorSchema = contractSchema("Workbench.WorkbenchError");
export const WorkbenchInitializationSnapshotSchema =
  contractSchema("Workbench.WorkbenchInitializationSnapshot");
export const WorkbenchConnectionStatusSchema =
  contractSchema("Workbench.WorkbenchConnectionStatus");
export const WorkbenchConnectionSnapshotSchema =
  contractSchema("Workbench.WorkbenchConnectionSnapshot");
export const WorkbenchServerSchema = contractSchema("Workbench.WorkbenchServer");
export const WorkbenchServerCreateRequestSchema =
  contractSchema("Workbench.WorkbenchServerCreateRequest");
export const WorkbenchServerUpdateRequestSchema =
  contractSchema("Workbench.WorkbenchServerUpdateRequest");
export const WorkbenchServerListResponseSchema =
  contractSchema("Workbench.WorkbenchServerListResponse");
export const WorkbenchServerActionAcceptedSchema =
  contractSchema("Workbench.WorkbenchServerActionAccepted");

// MCP discovery and redacted protocol evidence. SDK payloads remain unknown.
export const WorkbenchDiscoveryCollectionSchema =
  contractSchema("Workbench.WorkbenchDiscoveryCollection");
export const WorkbenchDiscoverySnapshotSchema =
  contractSchema("Workbench.WorkbenchDiscoverySnapshot");
export const WorkbenchProtocolDirectionSchema =
  contractSchema("Workbench.WorkbenchProtocolDirection");
export const WorkbenchProtocolEventKindSchema =
  contractSchema("Workbench.WorkbenchProtocolEventKind");
export const WorkbenchProtocolEventSchema =
  contractSchema("Workbench.WorkbenchProtocolEvent");
export const WorkbenchProtocolEventPageSchema =
  contractSchema("Workbench.WorkbenchProtocolEventPage");
// SSE event envelopes published alongside the page contracts they stream.
export const WorkbenchProtocolEventsSchema =
  contractSchema("Workbench.WorkbenchProtocolEvents");

// Asynchronous execution and correlated Qyl observability evidence.
export const WorkbenchExecutionEffectSchema =
  contractSchema("Workbench.WorkbenchExecutionEffect");
export const WorkbenchExecutionStatusSchema =
  contractSchema("Workbench.WorkbenchExecutionStatus");
export const WorkbenchExecutionConfirmationRequestSchema =
  contractSchema("Workbench.WorkbenchExecutionConfirmationRequest");
export const WorkbenchExecutionConfirmationEvidenceSchema =
  contractSchema("Workbench.WorkbenchExecutionConfirmationEvidence");
export const WorkbenchExecutionRequestSchema =
  contractSchema("Workbench.WorkbenchExecutionRequest");
export const WorkbenchExecutionTokenUsageSchema =
  contractSchema("Workbench.WorkbenchExecutionTokenUsage");
export const WorkbenchExecutionCostSchema =
  contractSchema("Workbench.WorkbenchExecutionCost");
export const WorkbenchTelemetryCorrelationSchema =
  contractSchema("Workbench.WorkbenchTelemetryCorrelation");
export const WorkbenchExecutionUpdateEventsSchema =
  contractSchema("Workbench.WorkbenchExecutionUpdateEvents");
export const WorkbenchExecutionRecordSchema =
  contractSchema("Workbench.WorkbenchExecutionRecord");
export const WorkbenchExecutionAcceptedSchema =
  contractSchema("Workbench.WorkbenchExecutionAccepted");
export const WorkbenchExecutionCancelRequestSchema =
  contractSchema("Workbench.WorkbenchExecutionCancelRequest");
export const WorkbenchExecutionPageSchema =
  contractSchema("Workbench.WorkbenchExecutionPage");
export const WorkbenchTelemetryAvailabilitySchema =
  contractSchema("Workbench.WorkbenchTelemetryAvailability");
export const WorkbenchTelemetrySignalAvailabilitySchema =
  contractSchema("Workbench.WorkbenchTelemetrySignalAvailability");
export const WorkbenchTelemetrySignalSummarySchema =
  contractSchema("Workbench.WorkbenchTelemetrySignalSummary");
export const WorkbenchExecutionTelemetryResponseSchema =
  contractSchema("Workbench.WorkbenchExecutionTelemetryResponse");

// Reusable test cases, assertions, and suites.
export const WorkbenchAssertionStatusSchema =
  contractSchema("Workbench.WorkbenchAssertionStatus");
export const WorkbenchStatusAssertionSchema =
  contractSchema("Workbench.WorkbenchStatusAssertion");
export const WorkbenchExactAssertionSchema =
  contractSchema("Workbench.WorkbenchExactAssertion");
export const WorkbenchPartialAssertionSchema =
  contractSchema("Workbench.WorkbenchPartialAssertion");
export const WorkbenchSchemaAssertionSchema =
  contractSchema("Workbench.WorkbenchSchemaAssertion");
export const WorkbenchPatternAssertionSchema =
  contractSchema("Workbench.WorkbenchPatternAssertion");
export const WorkbenchLatencyAssertionSchema =
  contractSchema("Workbench.WorkbenchLatencyAssertion");
export const WorkbenchTestAssertionSchema =
  contractSchema("Workbench.WorkbenchTestAssertion");
export const WorkbenchTestCaseSchema = contractSchema("Workbench.WorkbenchTestCase");
export const WorkbenchTestCaseCreateRequestSchema =
  contractSchema("Workbench.WorkbenchTestCaseCreateRequest");
export const WorkbenchTestCaseUpdateRequestSchema =
  contractSchema("Workbench.WorkbenchTestCaseUpdateRequest");
export const WorkbenchTestCasePageSchema =
  contractSchema("Workbench.WorkbenchTestCasePage");
export const WorkbenchTestSuiteSchema = contractSchema("Workbench.WorkbenchTestSuite");
export const WorkbenchTestSuiteCreateRequestSchema =
  contractSchema("Workbench.WorkbenchTestSuiteCreateRequest");
export const WorkbenchTestSuiteUpdateRequestSchema =
  contractSchema("Workbench.WorkbenchTestSuiteUpdateRequest");
export const WorkbenchTestSuitePageSchema =
  contractSchema("Workbench.WorkbenchTestSuitePage");

// Evaluation runs, comparisons, and export artifacts.
export const WorkbenchEvaluationResultStatusSchema =
  contractSchema("Workbench.WorkbenchEvaluationResultStatus");
export const WorkbenchEvaluationRunStatusSchema =
  contractSchema("Workbench.WorkbenchEvaluationRunStatus");
export const WorkbenchRegressionStatusSchema =
  contractSchema("Workbench.WorkbenchRegressionStatus");
export const WorkbenchEvaluationRunRequestSchema =
  contractSchema("Workbench.WorkbenchEvaluationRunRequest");
export const WorkbenchTestCaseRunRequestSchema =
  contractSchema("Workbench.WorkbenchTestCaseRunRequest");
export const WorkbenchSuiteRunRequestSchema =
  contractSchema("Workbench.WorkbenchSuiteRunRequest");
export const WorkbenchAssertionResultSchema =
  contractSchema("Workbench.WorkbenchAssertionResult");
export const WorkbenchEvaluationTestCaseSnapshotSchema =
  contractSchema("Workbench.WorkbenchEvaluationTestCaseSnapshot");
export const WorkbenchEvaluationSuiteSnapshotSchema =
  contractSchema("Workbench.WorkbenchEvaluationSuiteSnapshot");
export const WorkbenchEvaluationTestResultSchema =
  contractSchema("Workbench.WorkbenchEvaluationTestResult");
export const WorkbenchEvaluationSummarySchema =
  contractSchema("Workbench.WorkbenchEvaluationSummary");
export const WorkbenchEvaluationRunSchema =
  contractSchema("Workbench.WorkbenchEvaluationRun");
export const WorkbenchEvaluationRunAcceptedSchema =
  contractSchema("Workbench.WorkbenchEvaluationRunAccepted");
export const WorkbenchEvaluationRunPageSchema =
  contractSchema("Workbench.WorkbenchEvaluationRunPage");
export const WorkbenchEvaluationComparisonRequestSchema =
  contractSchema("Workbench.WorkbenchEvaluationComparisonRequest");
export const WorkbenchEvaluationTestComparisonSchema =
  contractSchema("Workbench.WorkbenchEvaluationTestComparison");
export const WorkbenchEvaluationRunComparisonSchema =
  contractSchema("Workbench.WorkbenchEvaluationRunComparison");
export const WorkbenchEvaluationExportFormatSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportFormat");
export const WorkbenchEvaluationExportStatusSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportStatus");
export const WorkbenchEvaluationExportRequestSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportRequest");
export const WorkbenchEvaluationExportSchema =
  contractSchema("Workbench.WorkbenchEvaluationExport");
export const WorkbenchEvaluationJsonExportPayloadSchema =
  contractSchema("Workbench.WorkbenchEvaluationJsonExportPayload");
export const WorkbenchEvaluationReportExportPayloadSchema =
  contractSchema("Workbench.WorkbenchEvaluationReportExportPayload");
export const WorkbenchEvaluationExportPayloadSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportPayload");
export const WorkbenchEvaluationExportArtifactSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportArtifact");
export const WorkbenchEvaluationExportAcceptedSchema =
  contractSchema("Workbench.WorkbenchEvaluationExportAccepted");

// Generated Problem Details variants used by both workbench and Qyl tools.
export const UnauthorizedErrorSchema = contractSchema("Common.Errors.UnauthorizedError");
export const ForbiddenErrorSchema = contractSchema("Common.Errors.ForbiddenError");
export const NotFoundErrorSchema = contractSchema("Common.Errors.NotFoundError");
export const ValidationErrorSchema = contractSchema("Common.Errors.ValidationError");
export const ConflictErrorSchema = contractSchema("Common.Errors.ConflictError");
export const BadGatewayErrorSchema = contractSchema("Common.Errors.BadGatewayError");
export const ServiceUnavailableErrorSchema =
  contractSchema("Common.Errors.ServiceUnavailableError");
export const InternalServerErrorSchema =
  contractSchema("Common.Errors.InternalServerError");
