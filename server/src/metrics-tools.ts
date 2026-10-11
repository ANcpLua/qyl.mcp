/**
 * The metrics read tools: catalog, series discovery, range query.
 *
 * Three tools rather than one because they answer three different questions an
 * agent asks in order — "what is recorded here", "which streams exist under
 * this name", "what did this one do over that window" — and folding them into a
 * single tool with a mode argument would make every call carry the arguments of
 * the other two.
 *
 * Input and output shapes are the contract's `Mcp.Tools.*Metric*` models from
 * contract-validation.ts, like every other tool. The two list tools page: the
 * page's own `has_more` and `next_cursor` travel with the items, and the same
 * `cursor` input continues the list.
 */

import type {
  GetMetricSeriesOutput,
  ListMetricsOutput,
  QueryMetricOutput,
} from "@ancplua/qyl-api-schema/types";
import type { McpServer, CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import {
  GetMetricSeriesInputSchema,
  GetMetricSeriesOutputSchema,
  ListMetricsInputSchema,
  ListMetricsOutputSchema,
  QueryMetricInputSchema,
  QueryMetricOutputSchema,
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
  pageNote,
  summarizeMetricCatalog,
  summarizeMetricQuery,
  summarizeMetricSeries,
} from "./summaries.js";
import { runTool } from "./request-scope.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";

export function registerMetricsTools(server: McpServer): void {
  server.registerTool(
    "list_metrics",
    {
      title: "List Metrics",
      description:
        "List the metric instruments recorded for this project: name, kind " +
        "(gauge/sum/histogram), unit, how many attribute streams exist under each " +
        "name, and when it was last written. Useful when the user wants to discover " +
        "instrument names before querying a metric by its exact name. name_prefix " +
        "narrows the catalog; when has_more is true, pass next_cursor as cursor with " +
        "the same prefix for the next page.",
      inputSchema: ListMetricsInputSchema,
      outputSchema: compactOutputSchema(ListMetricsOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: ListMetricsArgs, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const page = await listMetrics(args, scope.collector);
        await scope.step(`Fetched ${page.items.length} metric instrument(s)`);
        const output: ListMetricsOutput = {
          items: page.items,
          has_more: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
        };
        return telemetryToolResult(
          summarizeMetricCatalog(page.items, page.mode) + pageNote(page),
          output,
        );
      }),
  );

  server.registerTool(
    "get_metric_series",
    {
      title: "Get Metric Series",
      description:
        "List the distinct attribute streams recorded under one metric name, with " +
        "each stream's attributes, service, and first/last seen. Useful when the user " +
        "wants to discover group_by keys or matchers for query_metric before " +
        "choosing the groups in a range query. matchers narrow the streams: each is " +
        "{key, op, value} with op eq (exact) or prefix. When has_more is true, pass " +
        "next_cursor as cursor with the same matchers for the next page.",
      inputSchema: GetMetricSeriesInputSchema,
      outputSchema: compactOutputSchema(GetMetricSeriesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: MetricSeriesArgs, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const page = await listMetricSeries(args, scope.collector);
        await scope.step(`Fetched ${page.items.length} series of ${args.metric_name}`);
        const output: GetMetricSeriesOutput = {
          items: page.items,
          has_more: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
        };
        return telemetryToolResult(
          summarizeMetricSeries(page.items, page.mode) + pageNote(page),
          output,
        );
      }),
  );

  server.registerTool(
    "query_metric",
    {
      title: "Query Metric",
      description:
        "Run a time-bucketed range query when the user wants to compare a metric " +
        "over time or across groups: a window (start_time, " +
        "end_time), a bucket width in whole milliseconds (step_ms), a reducer " +
        "(aggregation: avg, min, max, sum, count, last, p50, p90, p95, p99), optional " +
        "group_by attribute keys, and optional matchers, each {key, op, value} with op " +
        "eq (exact) or prefix. Returns one stream per grouping with its buckets. With " +
        "step_ms equal to the window duration, each grouping yields one bucket: one " +
        "number per series.",
      inputSchema: QueryMetricInputSchema,
      outputSchema: compactOutputSchema(QueryMetricOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: QueryMetricArgs, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const { result, mode } = await queryMetric(args, scope.collector);
        await scope.step(
          `Queried ${args.metric_name}: ${result.series.length} series, ` +
            `${result.series[0]?.buckets.length ?? 0} bucket(s) each`,
        );
        const output: QueryMetricOutput = result;
        return telemetryToolResult(summarizeMetricQuery(result, mode), output);
      }),
  );
}
