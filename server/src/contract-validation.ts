import type * as QylContracts from "@ancplua/qyl-api-schema/types";
import { publishedContractSchema, type ContractInput } from "@ancplua/qyl-api-schema/zod";
import type { z } from "zod";

// The JSON-Schema-to-Zod adapter that produced these validators is published by
// the contract package itself, so this module is now only the named bindings.
// Both names are re-exported rather than imported directly by their users:
// workbench/ and dashboard/ reach them through "qyl-mcp-server/contract-validation",
// and verify-generated-shapes.mjs requires every server/src module that calls
// registerTool to import the generated shapes from contract-validation.js.
export { publishedContractSchema, type ContractInput };

function workbenchContractSchema<TContract>(name: string): z.ZodType<TContract> {
  return publishedContractSchema<TContract>(`Workbench.${name}`);
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
export const CiLogInputSchema = publishedContractSchema<QylContracts.CiLogInput>(
  "Mcp.Tools.CiLogInput",
);
export const CiRunSummarySchema = publishedContractSchema<QylContracts.CiRunSummary>(
  "Mcp.Tools.CiRunSummary",
);
export const CiPhaseSchema = publishedContractSchema<QylContracts.CiPhase>(
  "Mcp.Tools.CiPhase",
);
export const CiLogOutputSchema = publishedContractSchema<QylContracts.CiLogOutput>(
  "Mcp.Tools.CiLogOutput",
);

// Workflow journal, projection, lazy content, and curated debugger tool shapes.
export const WorkflowRunSchema = publishedContractSchema<QylContracts.WorkflowRun>(
  "Workflow.WorkflowRun",
);
export const WorkflowRunPageSchema = publishedContractSchema<QylContracts.WorkflowRunPage>(
  "Operations.WorkflowRunsApi_list.Response.200",
);
export const WorkflowEventPageSchema = publishedContractSchema<QylContracts.WorkflowEventPage>(
  "Operations.WorkflowRunsApi_readEvents.Response.200",
);
export const WorkflowGraphSnapshotSchema =
  publishedContractSchema<QylContracts.WorkflowGraphSnapshot>(
    "Operations.WorkflowRunsApi_getGraph.Response.200",
  );
export const WorkflowContentSchema = publishedContractSchema<QylContracts.WorkflowContent>(
  "Operations.WorkflowRunsApi_getContent.Response.200",
);
export const WorkflowControlCommandSchema =
  publishedContractSchema<QylContracts.WorkflowControlCommand>(
    "Operations.WorkflowRunsApi_submitControl.Response.200",
  );
export const ListWorkflowRunsInputSchema =
  publishedContractSchema<QylContracts.ListWorkflowRunsInput>(
    "Mcp.Tools.ListWorkflowRunsInput",
  );
export const ListWorkflowRunsOutputSchema =
  publishedContractSchema<QylContracts.ListWorkflowRunsOutput>(
    "Mcp.Tools.ListWorkflowRunsOutput",
  );
export const GetWorkflowGraphInputSchema =
  publishedContractSchema<QylContracts.GetWorkflowGraphInput>(
    "Mcp.Tools.GetWorkflowGraphInput",
  );
export const GetWorkflowGraphOutputSchema =
  publishedContractSchema<QylContracts.GetWorkflowGraphOutput>(
    "Mcp.Tools.GetWorkflowGraphOutput",
  );
export const DisplayWorkflowGraphInputSchema =
  publishedContractSchema<QylContracts.DisplayWorkflowGraphInput>(
    "Mcp.Tools.DisplayWorkflowGraphInput",
  );
export const DisplayWorkflowGraphOutputSchema =
  publishedContractSchema<QylContracts.DisplayWorkflowGraphOutput>(
    "Mcp.Tools.DisplayWorkflowGraphOutput",
  );
export const FetchWorkflowGraphUpdatesInputSchema =
  publishedContractSchema<QylContracts.FetchWorkflowGraphUpdatesInput>(
    "Mcp.Tools.FetchWorkflowGraphUpdatesInput",
  );
export const FetchWorkflowGraphUpdatesOutputSchema =
  publishedContractSchema<QylContracts.FetchWorkflowGraphUpdatesOutput>(
    "Mcp.Tools.FetchWorkflowGraphUpdatesOutput",
  );
export const InspectWorkflowEventsInputSchema =
  publishedContractSchema<QylContracts.InspectWorkflowEventsInput>(
    "Mcp.Tools.InspectWorkflowEventsInput",
  );
export const InspectWorkflowEventsOutputSchema =
  publishedContractSchema<QylContracts.InspectWorkflowEventsOutput>(
    "Mcp.Tools.InspectWorkflowEventsOutput",
  );
export const ControlWorkflowRunInputSchema =
  publishedContractSchema<QylContracts.ControlWorkflowRunInput>(
    "Mcp.Tools.ControlWorkflowRunInput",
  );
export const ControlWorkflowRunOutputSchema =
  publishedContractSchema<QylContracts.ControlWorkflowRunOutput>(
    "Mcp.Tools.ControlWorkflowRunOutput",
  );

export const RunnerResourceStateSchema = publishedContractSchema<QylContracts.RunnerResourceState>(
  "Runner.RunnerResourceState",
);
export const RunnerLogLineSchema = publishedContractSchema<QylContracts.RunnerLogLine>(
  "Runner.RunnerLogLine",
);

// Workbench identity, session, and workspace boundaries.
export const WorkbenchSessionIdSchema = workbenchContractSchema<QylContracts.WorkbenchSessionId>(
  "WorkbenchSessionId",
);
export const WorkbenchWorkspaceIdSchema = workbenchContractSchema<QylContracts.WorkbenchWorkspaceId>(
  "WorkbenchWorkspaceId",
);
export const WorkbenchServerIdSchema = workbenchContractSchema<QylContracts.WorkbenchServerId>(
  "WorkbenchServerId",
);
export const WorkbenchExecutionIdSchema = workbenchContractSchema<QylContracts.WorkbenchExecutionId>(
  "WorkbenchExecutionId",
);
export const WorkbenchEvaluationRunIdSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRunId>("WorkbenchEvaluationRunId");
export const WorkbenchTestCaseIdSchema = workbenchContractSchema<QylContracts.WorkbenchTestCaseId>(
  "WorkbenchTestCaseId",
);
export const WorkbenchSuiteIdSchema = workbenchContractSchema<QylContracts.WorkbenchSuiteId>(
  "WorkbenchSuiteId",
);
export const WorkbenchEvaluationExportIdSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportId>(
    "WorkbenchEvaluationExportId",
  );
export const WorkbenchPrincipalIdentitySchema =
  workbenchContractSchema<QylContracts.WorkbenchPrincipalIdentity>("WorkbenchPrincipalIdentity");
export const WorkbenchSessionSchema =
  workbenchContractSchema<QylContracts.WorkbenchSession>("WorkbenchSession");
export const WorkbenchSessionBootstrapResponseSchema =
  workbenchContractSchema<QylContracts.WorkbenchSessionBootstrapResponse>(
    "WorkbenchSessionBootstrapResponse",
  );
export const WorkbenchWorkspaceSchema = workbenchContractSchema<QylContracts.WorkbenchWorkspace>(
  "WorkbenchWorkspace",
);
export const WorkbenchWorkspaceCreateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchWorkspaceCreateRequest>(
    "WorkbenchWorkspaceCreateRequest",
  );
export const WorkbenchWorkspaceUpdateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchWorkspaceUpdateRequest>(
    "WorkbenchWorkspaceUpdateRequest",
  );
export const WorkbenchWorkspaceListResponseSchema =
  workbenchContractSchema<QylContracts.WorkbenchWorkspaceListResponse>(
    "WorkbenchWorkspaceListResponse",
  );
export const WorkbenchToolInputModeSchema =
  workbenchContractSchema<QylContracts.WorkbenchToolInputMode>("WorkbenchToolInputMode");
export const WorkbenchWorkspacePreferencesSchema =
  workbenchContractSchema<QylContracts.WorkbenchWorkspacePreferences>(
    "WorkbenchWorkspacePreferences",
  );
export const WorkbenchWorkspacePreferencesUpdateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchWorkspacePreferencesUpdateRequest>(
    "WorkbenchWorkspacePreferencesUpdateRequest",
  );

// Sanitized transport configuration and connection lifecycle.
export const WorkbenchTransportKindSchema =
  workbenchContractSchema<QylContracts.WorkbenchTransportKind>("WorkbenchTransportKind");
export const WorkbenchHeaderSecretSchemeSchema =
  workbenchContractSchema<QylContracts.WorkbenchHeaderSecretScheme>(
    "WorkbenchHeaderSecretScheme",
  );
export const WorkbenchSecretReferenceSchema =
  workbenchContractSchema<QylContracts.WorkbenchSecretReference>("WorkbenchSecretReference");
export const WorkbenchEnvironmentSecretReferenceSchema =
  workbenchContractSchema<QylContracts.WorkbenchEnvironmentSecretReference>(
    "WorkbenchEnvironmentSecretReference",
  );
export const WorkbenchHeaderSecretReferenceSchema =
  workbenchContractSchema<QylContracts.WorkbenchHeaderSecretReference>(
    "WorkbenchHeaderSecretReference",
  );
export const WorkbenchStdioServerConfigurationSchema =
  workbenchContractSchema<QylContracts.WorkbenchStdioServerConfiguration>(
    "WorkbenchStdioServerConfiguration",
  );
export const WorkbenchStreamableHttpServerConfigurationSchema =
  workbenchContractSchema<QylContracts.WorkbenchStreamableHttpServerConfiguration>(
    "WorkbenchStreamableHttpServerConfiguration",
  );
export const WorkbenchBuiltinServerConfigurationSchema =
  workbenchContractSchema<QylContracts.WorkbenchBuiltinServerConfiguration>(
    "WorkbenchBuiltinServerConfiguration",
  );
export const WorkbenchServerConfigurationSchema =
  workbenchContractSchema<QylContracts.WorkbenchServerConfiguration>(
    "WorkbenchServerConfiguration",
  );
export const WorkbenchErrorCategorySchema =
  workbenchContractSchema<QylContracts.WorkbenchErrorCategory>("WorkbenchErrorCategory");
export const WorkbenchErrorSchema = workbenchContractSchema<QylContracts.WorkbenchError>(
  "WorkbenchError",
);
export const WorkbenchInitializationSnapshotSchema =
  workbenchContractSchema<QylContracts.WorkbenchInitializationSnapshot>(
    "WorkbenchInitializationSnapshot",
  );
export const WorkbenchConnectionStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchConnectionStatus>("WorkbenchConnectionStatus");
export const WorkbenchConnectionSnapshotSchema =
  workbenchContractSchema<QylContracts.WorkbenchConnectionSnapshot>(
    "WorkbenchConnectionSnapshot",
  );
export const WorkbenchServerSchema = workbenchContractSchema<QylContracts.WorkbenchServer>(
  "WorkbenchServer",
);
export const WorkbenchServerCreateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchServerCreateRequest>(
    "WorkbenchServerCreateRequest",
  );
export const WorkbenchServerUpdateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchServerUpdateRequest>(
    "WorkbenchServerUpdateRequest",
  );
export const WorkbenchServerListResponseSchema =
  workbenchContractSchema<QylContracts.WorkbenchServerListResponse>(
    "WorkbenchServerListResponse",
  );
export const WorkbenchServerActionAcceptedSchema =
  workbenchContractSchema<QylContracts.WorkbenchServerActionAccepted>(
    "WorkbenchServerActionAccepted",
  );

// MCP discovery and redacted protocol evidence. SDK payloads remain unknown.
export const WorkbenchDiscoveryCollectionSchema =
  workbenchContractSchema<QylContracts.WorkbenchDiscoveryCollection>(
    "WorkbenchDiscoveryCollection",
  );
export const WorkbenchDiscoverySnapshotSchema =
  workbenchContractSchema<QylContracts.WorkbenchDiscoverySnapshot>("WorkbenchDiscoverySnapshot");
export const WorkbenchProtocolDirectionSchema =
  workbenchContractSchema<QylContracts.WorkbenchProtocolDirection>(
    "WorkbenchProtocolDirection",
  );
export const WorkbenchProtocolEventKindSchema =
  workbenchContractSchema<QylContracts.WorkbenchProtocolEventKind>("WorkbenchProtocolEventKind");
export const WorkbenchProtocolEventSchema =
  workbenchContractSchema<QylContracts.WorkbenchProtocolEvent>("WorkbenchProtocolEvent");
export const WorkbenchProtocolEventPageSchema =
  workbenchContractSchema<QylContracts.WorkbenchProtocolEventPage>("WorkbenchProtocolEventPage");
// SSE event envelopes published alongside the page contracts they stream.
export const WorkbenchProtocolEventsSchema =
  workbenchContractSchema<QylContracts.WorkbenchProtocolEvents>("WorkbenchProtocolEvents");

// Asynchronous execution and correlated Qyl observability evidence.
export const WorkbenchExecutionEffectSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionEffect>("WorkbenchExecutionEffect");
export const WorkbenchExecutionStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionStatus>("WorkbenchExecutionStatus");
export const WorkbenchExecutionConfirmationRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionConfirmationRequest>(
    "WorkbenchExecutionConfirmationRequest",
  );
export const WorkbenchExecutionConfirmationEvidenceSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionConfirmationEvidence>(
    "WorkbenchExecutionConfirmationEvidence",
  );
export const WorkbenchExecutionRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionRequest>("WorkbenchExecutionRequest");
export const WorkbenchExecutionTokenUsageSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionTokenUsage>(
    "WorkbenchExecutionTokenUsage",
  );
export const WorkbenchExecutionCostSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionCost>("WorkbenchExecutionCost");
export const WorkbenchTelemetryCorrelationSchema =
  workbenchContractSchema<QylContracts.WorkbenchTelemetryCorrelation>(
    "WorkbenchTelemetryCorrelation",
  );
export const WorkbenchExecutionUpdateEventsSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionUpdateEvents>(
    "WorkbenchExecutionUpdateEvents",
  );
export const WorkbenchExecutionRecordSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionRecord>("WorkbenchExecutionRecord");
export const WorkbenchExecutionAcceptedSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionAccepted>("WorkbenchExecutionAccepted");
export const WorkbenchExecutionCancelRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionCancelRequest>(
    "WorkbenchExecutionCancelRequest",
  );
export const WorkbenchExecutionPageSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionPage>("WorkbenchExecutionPage");
export const WorkbenchTelemetryAvailabilitySchema =
  workbenchContractSchema<QylContracts.WorkbenchTelemetryAvailability>(
    "WorkbenchTelemetryAvailability",
  );
export const WorkbenchTelemetrySignalAvailabilitySchema =
  workbenchContractSchema<QylContracts.WorkbenchTelemetrySignalAvailability>(
    "WorkbenchTelemetrySignalAvailability",
  );
export const WorkbenchTelemetrySignalSummarySchema =
  workbenchContractSchema<QylContracts.WorkbenchTelemetrySignalSummary>(
    "WorkbenchTelemetrySignalSummary",
  );
export const WorkbenchExecutionTelemetryResponseSchema =
  workbenchContractSchema<QylContracts.WorkbenchExecutionTelemetryResponse>(
    "WorkbenchExecutionTelemetryResponse",
  );

// Reusable test cases, assertions, and suites.
export const WorkbenchAssertionStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchAssertionStatus>("WorkbenchAssertionStatus");
export const WorkbenchStatusAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchStatusAssertion>("WorkbenchStatusAssertion");
export const WorkbenchExactAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchExactAssertion>("WorkbenchExactAssertion");
export const WorkbenchPartialAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchPartialAssertion>("WorkbenchPartialAssertion");
export const WorkbenchSchemaAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchSchemaAssertion>("WorkbenchSchemaAssertion");
export const WorkbenchPatternAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchPatternAssertion>("WorkbenchPatternAssertion");
export const WorkbenchLatencyAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchLatencyAssertion>("WorkbenchLatencyAssertion");
export const WorkbenchTestAssertionSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestAssertion>("WorkbenchTestAssertion");
export const WorkbenchTestCaseSchema = workbenchContractSchema<QylContracts.WorkbenchTestCase>(
  "WorkbenchTestCase",
);
export const WorkbenchTestCaseCreateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestCaseCreateRequest>(
    "WorkbenchTestCaseCreateRequest",
  );
export const WorkbenchTestCaseUpdateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestCaseUpdateRequest>(
    "WorkbenchTestCaseUpdateRequest",
  );
export const WorkbenchTestCasePageSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestCasePage>("WorkbenchTestCasePage");
export const WorkbenchTestSuiteSchema = workbenchContractSchema<QylContracts.WorkbenchTestSuite>(
  "WorkbenchTestSuite",
);
export const WorkbenchTestSuiteCreateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestSuiteCreateRequest>(
    "WorkbenchTestSuiteCreateRequest",
  );
export const WorkbenchTestSuiteUpdateRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestSuiteUpdateRequest>(
    "WorkbenchTestSuiteUpdateRequest",
  );
export const WorkbenchTestSuitePageSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestSuitePage>("WorkbenchTestSuitePage");

// Evaluation runs, comparisons, and export artifacts.
export const WorkbenchEvaluationResultStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationResultStatus>(
    "WorkbenchEvaluationResultStatus",
  );
export const WorkbenchEvaluationRunStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRunStatus>(
    "WorkbenchEvaluationRunStatus",
  );
export const WorkbenchRegressionStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchRegressionStatus>("WorkbenchRegressionStatus");
export const WorkbenchEvaluationRunRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRunRequest>(
    "WorkbenchEvaluationRunRequest",
  );
export const WorkbenchTestCaseRunRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchTestCaseRunRequest>(
    "WorkbenchTestCaseRunRequest",
  );
export const WorkbenchSuiteRunRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchSuiteRunRequest>("WorkbenchSuiteRunRequest");
export const WorkbenchAssertionResultSchema =
  workbenchContractSchema<QylContracts.WorkbenchAssertionResult>("WorkbenchAssertionResult");
export const WorkbenchEvaluationTestCaseSnapshotSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationTestCaseSnapshot>(
    "WorkbenchEvaluationTestCaseSnapshot",
  );
export const WorkbenchEvaluationSuiteSnapshotSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationSuiteSnapshot>(
    "WorkbenchEvaluationSuiteSnapshot",
  );
export const WorkbenchEvaluationTestResultSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationTestResult>(
    "WorkbenchEvaluationTestResult",
  );
export const WorkbenchEvaluationSummarySchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationSummary>("WorkbenchEvaluationSummary");
export const WorkbenchEvaluationRunSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRun>("WorkbenchEvaluationRun");
export const WorkbenchEvaluationRunAcceptedSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRunAccepted>(
    "WorkbenchEvaluationRunAccepted",
  );
export const WorkbenchEvaluationRunPageSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRunPage>(
    "WorkbenchEvaluationRunPage",
  );
export const WorkbenchEvaluationComparisonRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationComparisonRequest>(
    "WorkbenchEvaluationComparisonRequest",
  );
export const WorkbenchEvaluationTestComparisonSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationTestComparison>(
    "WorkbenchEvaluationTestComparison",
  );
export const WorkbenchEvaluationRunComparisonSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationRunComparison>(
    "WorkbenchEvaluationRunComparison",
  );
export const WorkbenchEvaluationExportFormatSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportFormat>(
    "WorkbenchEvaluationExportFormat",
  );
export const WorkbenchEvaluationExportStatusSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportStatus>(
    "WorkbenchEvaluationExportStatus",
  );
export const WorkbenchEvaluationExportRequestSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportRequest>(
    "WorkbenchEvaluationExportRequest",
  );
export const WorkbenchEvaluationExportSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExport>("WorkbenchEvaluationExport");
export const WorkbenchEvaluationJsonExportPayloadSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationJsonExportPayload>(
    "WorkbenchEvaluationJsonExportPayload",
  );
export const WorkbenchEvaluationReportExportPayloadSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationReportExportPayload>(
    "WorkbenchEvaluationReportExportPayload",
  );
export const WorkbenchEvaluationExportPayloadSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportPayload>(
    "WorkbenchEvaluationExportPayload",
  );
export const WorkbenchEvaluationExportArtifactSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportArtifact>(
    "WorkbenchEvaluationExportArtifact",
  );
export const WorkbenchEvaluationExportAcceptedSchema =
  workbenchContractSchema<QylContracts.WorkbenchEvaluationExportAccepted>(
    "WorkbenchEvaluationExportAccepted",
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
