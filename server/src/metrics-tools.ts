import type { McpServer } from "@modelcontextprotocol/server";
import { compactOutputSchema, contractSchema } from "./contract-validation.js";
import { runTool } from "./request-scope.js";
import { queryAnalysis } from "./analysis-client.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";
export function registerMetricsTools(server: McpServer): void {
  server.registerTool(
    "list_metrics",
    {
      title: "List Metrics",
      description: "List instruments and their units, kinds and aggregation support when choosing a metric.",
      inputSchema: contractSchema("Mcp.Tools.ListMetricsInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.ListMetricsOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("list_metrics", args, contractSchema("Mcp.Tools.ListMetricsOutput"), scope)),
  );
  server.registerTool(
    "get_metric_series",
    {
      title: "Get Metric Series",
      description: "Discover metric streams and attribute cardinality when choosing filters, or select series_id to page complete original points with points_cursor. Oversized individual points remain available through the HTTP points API.",
      inputSchema: contractSchema("Mcp.Tools.GetMetricSeriesInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.GetMetricSeriesOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("get_metric_series", args, contractSchema("Mcp.Tools.GetMetricSeriesOutput"), scope)),
  );
  server.registerTool(
    "query_metric",
    {
      title: "Query Metric",
      description: "Query float64 metric projections, counter changes or ratios when measuring trends across a time window. Use get_metric_series with series_id for original numeric values, buckets and exemplars.",
      inputSchema: contractSchema("Mcp.Tools.QueryMetricInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.QueryMetricOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("query_metric", args, contractSchema("Mcp.Tools.QueryMetricOutput"), scope)),
  );
}
