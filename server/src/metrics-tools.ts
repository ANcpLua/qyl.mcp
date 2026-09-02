/**
 * The metrics read tools: catalog, series discovery, range query.
 *
 * Three tools rather than one because they answer three different questions an
 * agent asks in order — "what is recorded here", "which streams exist under
 * this name", "what did this one do over that window" — and folding them into a
 * single tool with a mode argument would make every call carry the arguments of
 * the other two.
 *
 * Output shapes are the operations' own 200 bodies from contract-validation.ts.
 * Input shapes are derived from the same operations' published parameters (see
 * contract-operations.ts): the metrics API landed in @ancplua/qyl-api-schema
 * 8.0.0 with responses but without `Mcp.Tools.*Metric*` input models, and
 * generating them from the OpenAPI document keeps gate G10a honest instead of
 * exempting three hand-written objects from it.
 */

import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { operationInputSchema } from "./contract-operations.js";
import {
  MetricQueryResultSchema,
  MetricsListResponseSchema,
  MetricSeriesListResponseSchema,
  compactOutputSchema,
} from "./contract-validation.js";
import {
  listMetricSeries,
  listMetrics,
  queryMetric,
  type ListMetricsArgs,
  type MetricSeriesArgs,
  type QueryMetricArgs,
} from "./metrics.js";
import {
  summarizeMetricCatalog,
  summarizeMetricQuery,
  summarizeMetricSeries,
} from "./summaries.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, toolError } from "./tools.js";

const METRICS_PATH = "/api/v1/metrics";
const SERIES_PATH = "/api/v1/metrics/{metric_name}/series";
const QUERY_PATH = "/api/v1/metrics/{metric_name}/query";

/**
 * The list operations page, and their pages are the tool's output. `has_more`
 * travels with the items so a reader can tell a complete catalog from a first
 * page; the cursor does not, because these tools take no cursor.
 */
export function registerMetricsTools(server: McpServer): void {
  server.registerTool(
    "list_metrics",
    {
      title: "List Metrics",
      description:
        "List the metric instruments recorded for this project: name, kind " +
        "(gauge/sum/histogram), unit, how many attribute streams exist under each " +
        "name, and when it was last written. Start here — query_metric needs an " +
        "exact instrument name, and this is where the names come from.",
      inputSchema: operationInputSchema<ListMetricsArgs>(METRICS_PATH),
      outputSchema: compactOutputSchema(MetricsListResponseSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (args: ListMetricsArgs): Promise<CallToolResult> => {
      try {
        const { metrics, mode } = await listMetrics(args);
        return telemetryToolResult(summarizeMetricCatalog(metrics, mode), {
          items: metrics,
          has_more: false,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_metric_series",
    {
      title: "Get Metric Series",
      description:
        "List the distinct attribute streams recorded under one metric name, with " +
        "each stream's attributes, service, and first/last seen. Use it to discover " +
        "which attribute keys are worth passing to query_metric as group_by or attr " +
        "filters, before running a range query that would otherwise collapse or " +
        "explode the result.",
      inputSchema: operationInputSchema<MetricSeriesArgs>(SERIES_PATH),
      outputSchema: compactOutputSchema(MetricSeriesListResponseSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (args: MetricSeriesArgs): Promise<CallToolResult> => {
      try {
        const { series, mode } = await listMetricSeries(args);
        return telemetryToolResult(summarizeMetricSeries(series, mode), {
          items: series,
          has_more: false,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "query_metric",
    {
      title: "Query Metric",
      description:
        "Run a time-bucketed range query over one metric: a window (start_time, " +
        "end_time), a bucket width (step_ms), a reducer (aggregation: avg, min, max, " +
        "sum, count, last, p50, p90, p95, p99), optional group_by attribute keys, and " +
        "optional attr/attr_prefix matchers written 'key=value'. Returns one stream " +
        "per grouping with its buckets. One bucket spanning the whole window collapses " +
        "the answer to a single number.",
      inputSchema: operationInputSchema<QueryMetricArgs>(QUERY_PATH),
      outputSchema: compactOutputSchema(MetricQueryResultSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (args: QueryMetricArgs): Promise<CallToolResult> => {
      try {
        const { result, mode } = await queryMetric(args);
        return telemetryToolResult(summarizeMetricQuery(result, mode), result);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
