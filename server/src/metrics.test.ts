/**
 * The metrics read surface: the tool inputs the contract publishes, and the
 * demo path that answers them.
 *
 * Demo mode is the one place the bucketing, the reducers, the grouping, the
 * matchers and the paging are ours rather than the collector's, so it is the one
 * place they can be wrong without a collector to blame. Every assertion below is
 * against the published contract's own schemas.
 */

import assert from "node:assert/strict";
import { formatAttributeValue } from "@ancplua/qyl-api-schema/runtime";
import test from "node:test";
import {
  GetMetricSeriesInputSchema,
  GetMetricSeriesOutputSchema,
  ListMetricsInputSchema,
  ListMetricsOutputSchema,
  MetricQueryResultSchema,
  QueryMetricInputSchema,
} from "./contract-validation.js";
import { CollectorError } from "./collector.js";
import { listMetricSeries, listMetrics, queryMetric } from "./metrics.js";
import { summarizeMetricQuery } from "./summaries.js";

async function inDemoMode<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.QYL_DEMO;
  process.env.QYL_DEMO = "1";
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.QYL_DEMO;
    else process.env.QYL_DEMO = previous;
  }
}

const HISTOGRAM = "http.server.request.duration";

test("tool inputs are the published tool models, defaults and bounds included", () => {
  // Bounds, defaults, and the aggregation enum come from the contract, not from
  // anything written here: an unpublished reducer must not reach the collector.
  const accepted = QueryMetricInputSchema.parse({
    metric_name: HISTOGRAM,
    start_time: "2026-09-01T00:00:00Z",
    end_time: "2026-09-01T01:00:00Z",
  });
  assert.deepEqual(accepted, {
    metric_name: HISTOGRAM,
    start_time: "2026-09-01T00:00:00Z",
    end_time: "2026-09-01T01:00:00Z",
    step_ms: 60_000,
    aggregation: "avg",
    series_limit: 50,
  });

  const window = {
    metric_name: HISTOGRAM,
    start_time: "2026-09-01T00:00:00Z",
    end_time: "2026-09-01T01:00:00Z",
  };
  assert.equal(
    QueryMetricInputSchema.safeParse({ ...window, aggregation: "median" }).success,
    false,
    "an aggregation the contract does not publish must be refused before the wire",
  );
  assert.equal(
    QueryMetricInputSchema.safeParse({ metric_name: HISTOGRAM, start_time: window.start_time }).success,
    false,
    "end_time is a required published parameter",
  );
  assert.equal(
    QueryMetricInputSchema.safeParse({ ...window, step_ms: 1.5 }).success,
    false,
    "step_ms is an integer number of milliseconds",
  );
  assert.equal(
    QueryMetricInputSchema.safeParse({ ...window, attr: ["http.route=/checkout"] }).success,
    false,
    "the wire's key=value strings are not a tool input; matchers are structured",
  );
  assert.equal(
    GetMetricSeriesInputSchema.safeParse({
      metric_name: HISTOGRAM,
      matchers: [{ key: "http.route", op: "contains", value: "check" }],
    }).success,
    false,
    "only the published matcher operators exist",
  );
  assert.deepEqual(ListMetricsInputSchema.parse({}), { limit: 200 });

  // The project scope is server-owned; a model must not be able to name it.
  assert.equal(
    QueryMetricInputSchema.safeParse({ ...window, "X-Qyl-Project": "someone-elses" }).success,
    false,
  );
});

test("the demo catalog answers the published list body", async () => {
  await inDemoMode(async () => {
    const page = await listMetrics({});
    assert.equal(page.mode, "demo");
    const output = ListMetricsOutputSchema.parse({ items: page.items, has_more: page.hasMore });
    assert.equal(output.items.length, 3);

    const histogram = output.items.find((metric) => metric.name === HISTOGRAM);
    assert.ok(histogram);
    assert.equal(histogram.kind, "histogram");
    assert.equal(histogram.unit, "s");
    assert.equal(histogram.series_count, 4, "series_count collapses the streams, not the points");

    const filtered = await listMetrics({ name_prefix: "qyl." });
    assert.deepEqual(filtered.items.map((metric) => metric.name), ["qyl.collector.spans.ingested"]);
  });
});

test("the catalog and the series list page with an opaque cursor, never a guess", async () => {
  await inDemoMode(async () => {
    const whole = await listMetrics({});
    assert.equal(whole.hasMore, false, "every demo instrument fits the default limit");
    assert.equal(whole.nextCursor, undefined, "a complete result hands out no cursor");

    const first = await listMetrics({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true, "a third instrument exists beyond the page");
    assert.equal(typeof first.nextCursor, "string");

    const second = await listMetrics({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(
      [...first.items, ...second.items].map((metric) => metric.name),
      whole.items.map((metric) => metric.name),
      "the pages are the whole catalog, in order, without overlap",
    );

    const allSeries = await listMetricSeries({ metric_name: HISTOGRAM });
    assert.equal(allSeries.hasMore, false);
    const oneSeries = await listMetricSeries({ metric_name: HISTOGRAM, limit: 1 });
    assert.equal(oneSeries.items.length, 1);
    assert.equal(oneSeries.hasMore, true, "three more streams exist under the histogram");
    const rest = await listMetricSeries({ metric_name: HISTOGRAM, limit: 10, cursor: oneSeries.nextCursor });
    assert.equal(rest.items.length, 3);
    assert.equal(rest.hasMore, false);

    await assert.rejects(
      () => listMetrics({ cursor: "not-a-cursor" }),
      (error: unknown) => error instanceof CollectorError && error.code === "invalid_argument",
      "a cursor that is not ours is the caller's mistake, not a silent first page",
    );
  });
});

test("series discovery filters by structured exact and prefix matchers", async () => {
  await inDemoMode(async () => {
    const { items: series, hasMore } = await listMetricSeries({ metric_name: HISTOGRAM });
    GetMetricSeriesOutputSchema.parse({ items: series, has_more: hasMore });
    assert.equal(series.length, 4);
    assert.equal(new Set(series.map((stream) => stream.series_id)).size, 4);

    const exact = await listMetricSeries({
      metric_name: HISTOGRAM,
      matchers: [{ key: "http.response.status_code", op: "eq", value: "500" }],
    });
    assert.equal(exact.items.length, 1);

    const prefixed = await listMetricSeries({
      metric_name: HISTOGRAM,
      matchers: [{ key: "http.route", op: "prefix", value: "/check" }],
    });
    assert.equal(prefixed.items.length, 2);

    const byService = await listMetricSeries({
      metric_name: HISTOGRAM,
      matchers: [{ key: "service.name", op: "eq", value: "agent-worker" }],
    });
    assert.equal(byService.items.length, 1);

    const both = await listMetricSeries({
      metric_name: HISTOGRAM,
      matchers: [
        { key: "http.route", op: "prefix", value: "/check" },
        { key: "http.response.status_code", op: "eq", value: "500" },
      ],
    });
    assert.equal(both.items.length, 1, "every matcher must hold");
  });
});

test("an unknown metric name is reported as not found, not as an empty answer", async () => {
  await inDemoMode(async () => {
    await assert.rejects(
      () => listMetricSeries({ metric_name: "not.a.metric" }),
      (error: unknown) =>
        error instanceof CollectorError && error.code === "not_found" && /metric not found/u.test(error.message),
    );
  });
});

test("a range query buckets, reduces, and groups the way it says it does", async () => {
  await inDemoMode(async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3_600_000);
    const window = {
      metric_name: HISTOGRAM,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      step_ms: 600_000,
    } as const;

    const { result } = await queryMetric(window);
    MetricQueryResultSchema.parse(result);
    assert.equal(result.step_ms, 600_000);
    assert.equal(result.aggregation, "avg");
    assert.equal(result.series.length, 1, "no group_by collapses every stream into one");
    assert.deepEqual(result.series[0]?.attributes, []);
    assert.equal(result.series[0]?.buckets.length, 6, "one hour at ten-minute steps");
    assert.ok(
      result.series[0]?.buckets.every((bucket) => bucket.point_count > 0),
      "the demo dataset covers the last six hours, so no bucket in the last hour is empty",
    );

    // Grouping by one key folds the four streams into one per distinct route:
    // the two /checkout streams differ only by status code, which is not grouped.
    const grouped = await queryMetric({ ...window, group_by: ["http.route"] });
    assert.deepEqual(
      grouped.result.series.map((stream) => formatAttributeValue(stream.attributes[0]?.value ?? null)).sort((a, b) => a.localeCompare(b)),
      ["/checkout", "/health", "/v1/agent/run"],
    );

    // A matcher narrows the streams before grouping.
    const matched = await queryMetric({
      ...window,
      group_by: ["http.route"],
      matchers: [{ key: "http.route", op: "prefix", value: "/check" }],
    });
    assert.deepEqual(
      matched.result.series.map((stream) => formatAttributeValue(stream.attributes[0]?.value ?? null)),
      ["/checkout"],
    );

    // Same window, different reducer: max must dominate avg, which must dominate min.
    const [min, avg, max] = await Promise.all(
      (["min", "avg", "max"] as const).map(async (aggregation) => {
        const answer = await queryMetric({ ...window, aggregation });
        return answer.result.series[0]?.buckets[0]?.value ?? 0;
      }),
    );
    assert.ok(min <= avg && avg <= max, `expected min<=avg<=max, got ${min}/${avg}/${max}`);

    const counted = await queryMetric({ ...window, aggregation: "count" });
    assert.equal(
      counted.result.series[0]?.buckets[0]?.value,
      counted.result.series[0]?.buckets[0]?.point_count,
      "count is the number of points folded into the bucket",
    );
  });
});

test("a grouping wider than series_limit is truncated and says so", async () => {
  await inDemoMode(async () => {
    const end = new Date();
    const { result } = await queryMetric({
      metric_name: HISTOGRAM,
      start_time: new Date(end.getTime() - 3_600_000).toISOString(),
      end_time: end.toISOString(),
      group_by: ["http.route", "http.response.status_code"],
      series_limit: 1,
    });
    assert.equal(result.series.length, 1);
    assert.equal(result.truncated, true);
    assert.match(summarizeMetricQuery(result, "demo"), /Truncated/u);
  });
});

test("a window with no points answers with empty buckets rather than a fabricated value", async () => {
  await inDemoMode(async () => {
    const end = new Date(Date.now() - 30 * 24 * 3_600_000);
    const { result } = await queryMetric({
      metric_name: HISTOGRAM,
      start_time: new Date(end.getTime() - 3_600_000).toISOString(),
      end_time: end.toISOString(),
      step_ms: 3_600_000,
    });
    MetricQueryResultSchema.parse(result);
    assert.deepEqual(
      result.series[0]?.buckets.map((bucket) => [bucket.value, bucket.point_count]),
      [[null, 0]],
    );
    assert.match(summarizeMetricQuery(result, "demo"), /no recorded values/u);
  });
});

test("an inverted window is refused instead of producing zero buckets", async () => {
  await inDemoMode(async () => {
    const now = new Date();
    await assert.rejects(
      () => queryMetric({
        metric_name: HISTOGRAM,
        start_time: now.toISOString(),
        end_time: new Date(now.getTime() - 60_000).toISOString(),
      }),
      /after start_time/u,
    );
  });
});
