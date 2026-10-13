/** Named analysis tools backed by the collector's generated query contracts. */
import type { McpServer } from "@modelcontextprotocol/server";
import { compactOutputSchema, contractSchema } from "./contract-validation.js";
import { runTool } from "./request-scope.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";
import { queryAnalysis } from "./analysis-client.js";
import { collectorPatch, parseCollectorBody } from "./collector.js";
import { ifMatch, refusals, changeRefusals } from "./collector-resources.js";
import { toolScopeChallenge } from "./tool-scopes.js";
import { WRITE_SCOPES, UPDATE_TOOL_ANNOTATIONS, securityMeta } from "./write-tools.js";
import { CollectorError } from "./collector.js";
import { telemetryToolResult } from "./telemetry-redaction.js";

const TriageInputSchema = contractSchema("Mcp.Tools.TriageInput");
const TriageOutputSchema = contractSchema("Mcp.Tools.TriageOutput");
const ListFailuresInputSchema = contractSchema("Mcp.Tools.ListFailuresInput");
const ListFailuresOutputSchema = contractSchema("Mcp.Tools.ListFailuresOutput");
const GetFailureContextInputSchema = contractSchema("Mcp.Tools.GetFailureContextInput");
const GetFailureContextOutputSchema = contractSchema("Mcp.Tools.GetFailureContextOutput");
const CompareGroupsInputSchema = contractSchema("Mcp.Tools.CompareGroupsInput");
const CompareGroupsOutputSchema = contractSchema("Mcp.Tools.CompareGroupsOutput");
const CompareTracesInputSchema = contractSchema("Mcp.Tools.CompareTracesInput");
const CompareTracesOutputSchema = contractSchema("Mcp.Tools.CompareTracesOutput");
const VerifyFixInputSchema = contractSchema("Mcp.Tools.VerifyFixInput");
const VerifyFixOutputSchema = contractSchema("Mcp.Tools.VerifyFixOutput");
const AggregateTelemetryInputSchema = contractSchema("Mcp.Tools.AggregateTelemetryInput");
const AggregateTelemetryOutputSchema = contractSchema("Mcp.Tools.AggregateTelemetryOutput");
const DiscoverAttributesInputSchema = contractSchema("Mcp.Tools.DiscoverAttributesInput");
const DiscoverAttributesOutputSchema = contractSchema("Mcp.Tools.DiscoverAttributesOutput");
const GetAgentRunInputSchema = contractSchema("Mcp.Tools.GetAgentRunInput");
const GetAgentRunOutputSchema = contractSchema("Mcp.Tools.GetAgentRunOutput");
const ListReleasesInputSchema = contractSchema("Mcp.Tools.ListReleasesInput");
const ListReleasesOutputSchema = contractSchema("Mcp.Tools.ListReleasesOutput");
const GetServiceMapInputSchema = contractSchema("Mcp.Tools.GetServiceMapInput");
const GetServiceMapOutputSchema = contractSchema("Mcp.Tools.GetServiceMapOutput");
const CheckTelemetryHealthInputSchema = contractSchema("Mcp.Tools.CheckTelemetryHealthInput");
const CheckTelemetryHealthOutputSchema = contractSchema("Mcp.Tools.CheckTelemetryHealthOutput");
const GetMcpStatsInputSchema = contractSchema("Mcp.Tools.GetMcpStatsInput");
const GetMcpStatsOutputSchema = contractSchema("Mcp.Tools.GetMcpStatsOutput");

const UpdateFailureStatusInputSchema = contractSchema("Mcp.Tools.UpdateFailureStatusInput");
const UpdateFailureStatusOutputSchema = contractSchema("Mcp.Tools.UpdateFailureStatusOutput");


export function registerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "triage",
    {
      title: "Triage",
      description: "Rank new or worsening failures, performance regressions, releases and silent services when investigating what changed.",
      inputSchema: TriageInputSchema,
      outputSchema: compactOutputSchema(TriageOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("triage", args, TriageOutputSchema, scope)),
  );
  server.registerTool(
    "list_failures",
    {
      title: "List Failures",
      description: "List failures grouped by stable fingerprints when investigating recurring errors or their recorded status.",
      inputSchema: ListFailuresInputSchema,
      outputSchema: compactOutputSchema(ListFailuresOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("list_failures", args, ListFailuresOutputSchema, scope)),
  );
  server.registerTool(
    "get_failure_context",
    {
      title: "Get Failure Context",
      description: "Return the recorded failure path, correlated logs and comparison evidence when investigating a failed execution.",
      inputSchema: GetFailureContextInputSchema,
      outputSchema: compactOutputSchema(GetFailureContextOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("get_failure_context", args, GetFailureContextOutputSchema, scope)),
  );
  server.registerTool(
    "compare_groups",
    {
      title: "Compare Groups",
      description: "Compare attribute distributions and durations between two telemetry groups when identifying associations with a failure.",
      inputSchema: CompareGroupsInputSchema,
      outputSchema: compactOutputSchema(CompareGroupsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("compare_groups", args, CompareGroupsOutputSchema, scope)),
  );
  server.registerTool(
    "compare_traces",
    {
      title: "Compare Traces",
      description: "Align two executions and locate their first divergence when comparing a failing path with another execution.",
      inputSchema: CompareTracesInputSchema,
      outputSchema: compactOutputSchema(CompareTracesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("compare_traces", args, CompareTracesOutputSchema, scope)),
  );
  server.registerTool(
    "verify_fix",
    {
      title: "Verify Fix",
      description: "Measure failure recurrence and traffic after a change when checking whether enough evidence supports a fix.",
      inputSchema: VerifyFixInputSchema,
      outputSchema: compactOutputSchema(VerifyFixOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("verify_fix", args, VerifyFixOutputSchema, scope)),
  );
  server.registerTool(
    "aggregate_telemetry",
    {
      title: "Aggregate Telemetry",
      description: "Group spans or logs and calculate counts, error rates and durations when comparing operations or attributes.",
      inputSchema: AggregateTelemetryInputSchema,
      outputSchema: compactOutputSchema(AggregateTelemetryOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("aggregate_telemetry", args, AggregateTelemetryOutputSchema, scope)),
  );
  server.registerTool(
    "discover_attributes",
    {
      title: "Discover Attributes",
      description: "List recorded attribute keys, value distributions and convention descriptions when choosing telemetry filters.",
      inputSchema: DiscoverAttributesInputSchema,
      outputSchema: compactOutputSchema(DiscoverAttributesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("discover_attributes", args, DiscoverAttributesOutputSchema, scope)),
  );
  server.registerTool(
    "get_agent_run",
    {
      title: "Get Agent Run",
      description: "Reconstruct agent and tool execution steps, token usage and repeated calls when investigating an agent run.",
      inputSchema: GetAgentRunInputSchema,
      outputSchema: compactOutputSchema(GetAgentRunOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("get_agent_run", args, GetAgentRunOutputSchema, scope)),
  );
  server.registerTool(
    "list_releases",
    {
      title: "List Releases",
      description: "List observed service versions and their before-and-after impact when investigating a release.",
      inputSchema: ListReleasesInputSchema,
      outputSchema: compactOutputSchema(ListReleasesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("list_releases", args, ListReleasesOutputSchema, scope)),
  );
  server.registerTool(
    "get_service_map",
    {
      title: "Get Service Map",
      description: "Return service dependencies and their traffic, error rates and latency when investigating calls between services.",
      inputSchema: GetServiceMapInputSchema,
      outputSchema: compactOutputSchema(GetServiceMapOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("get_service_map", args, GetServiceMapOutputSchema, scope)),
  );
  server.registerTool(
    "check_telemetry_health",
    {
      title: "Check Telemetry Health",
      description: "Report silent services, orphan spans and missing convention attributes when checking telemetry coverage.",
      inputSchema: CheckTelemetryHealthInputSchema,
      outputSchema: compactOutputSchema(CheckTelemetryHealthOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("check_telemetry_health", args, CheckTelemetryHealthOutputSchema, scope)),
  );
  server.registerTool(
    "get_mcp_stats",
    {
      title: "Get MCP Stats",
      description: "Return MCP request totals, failure classes and latency aggregates when investigating MCP tool health.",
      inputSchema: GetMcpStatsInputSchema,
      outputSchema: compactOutputSchema(GetMcpStatsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("get_mcp_stats", args, GetMcpStatsOutputSchema, scope)),
  );
  server.registerTool(
    "update_failure_status",
    {
      title: "Update Failure Status",
      description: "Set a failure's status or assignee when recording triage decisions, returning the stored failure available through list_failures.",
      inputSchema: UpdateFailureStatusInputSchema,
      outputSchema: compactOutputSchema(UpdateFailureStatusOutputSchema),
      annotations: UPDATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("update_failure_status", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args, ctx) => runTool(ctx, 1, async (scope) => {
      if (args.ignore_until !== undefined && args.status !== "ignored") throw new CollectorError("ignore_until is valid only with status=ignored", false, 400, "invalid_argument");
      const { failure_id, etag, ...changes } = args;
      const path = `/api/v1/failures/${encodeURIComponent(failure_id)}`;
      const response = await refusals(changeRefusals("failure", failure_id, "write"), () => collectorPatch(path, changes, {
        ...scope.collector,
        headers: { ...scope.collector.headers, ...ifMatch(etag) },
      }));
      const output = parseCollectorBody(response, path, UpdateFailureStatusOutputSchema);
      await scope.step("Failure status saved");
      return telemetryToolResult("Failure status saved; list_failures returns the current failure.", output);
    }),
  );

}
