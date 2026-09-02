/**
 * The metrics read surface: the tool inputs the contract generates, and the
 * demo path that answers them.
 *
 * Demo mode is the one place the bucketing, the reducers, the grouping, and the
 * matchers are ours rather than the collector's, so it is the one place they can
 * be wrong without a collector to blame. Every assertion below is against the
 * published contract's own schemas.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { operationInputSchema } from "./contract-operations.js";
import {
  MetricQueryResultSchema,
  MetricsListResponseSchema,
  MetricSeriesListResponseSchema,
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

test("tool inputs are generated from the published operation parameters", () => {
  const query = operationInputSchema("/api/v1/metrics/{metric_name}/query");

  // Bounds, defaults, and the aggregation enum come from the contract, not from
  // anything written here: an unpublished reducer must not reach the collector.
  const accepted = query.parse({
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

  assert.equal(
    query.safeParse({
      metric_name: HISTOGRAM,
      start_time: "2026-09-01T00:00:00Z",
      end_time: "2026-09-01T01:00:00Z",
      aggregation: "median",
    }).success,
    false,
    "an aggregation the contract does not publish must be refused before the wire",
  );

  assert.equal(
    query.safeParse({ metric_name: HISTOGRAM, start_time: "2026-09-01T00:00:00Z" }).success,
    false,
    "end_time is a required published parameter",
  );

  // The project scope is server-owned; a model must not be able to name it.
  assert.equal(
    query.safeParse({
      metric_name: HISTOGRAM,
      start_time: "2026-09-01T00:00:00Z",
      end_time: "2026-09-01T01:00:00Z",
      "X-Qyl-Project": "someone-elses",
    }).success,
    false,
  );
});

test("an operation the contract does not publish is a startup failure, not an empty tool", () => {
  assert.throws(() => operationInputSchema("/api/v1/metrics/nope"), /publishes no GET/u);
});

test("the demo catalog answers the published list body", async () => {
  await inDemoMode(async () => {
    const { metrics, mode } = await listMetrics({});
    assert.equal(mode, "demo");
    const page = MetricsListResponseSchema.parse({ items: metrics, has_more: false });
    assert.equal(page.items.length, 3);

    const histogram = page.items.find((metric) => metric.name === HISTOGRAM);
    assert.ok(histogram);
    assert.equal(histogram.kind, "histogram");
    assert.equal(histogram.unit, "s");
    assert.equal(histogram.series_count, 4, "series_count collapses the streams, not the points");

    const { metrics: filtered } = await listMetrics({ name_prefix: "qyl." });
    assert.deepEqual(filtered.map((metric) => metric.name), ["qyl.collector.spans.ingested"]);
  });
});

test("series discovery filters by exact and prefix attribute matchers", async () => {
  await inDemoMode(async () => {
    const { series } = await listMetricSeries({ metric_name: HISTOGRAM });
    MetricSeriesListResponseSchema.parse({ items: series, has_more: false });
    assert.equal(series.length, 4);
    assert.equal(new Set(series.map((stream) => stream.series_id)).size, 4);

    const exact = await listMetricSeries({
      metric_name: HISTOGRAM,
      attr: ["http.response.status_code=500"],
    });
    assert.equal(exact.series.length, 1);

    const prefixed = await listMetricSeries({
      metric_name: HISTOGRAM,
      attr_prefix: ["http.route=/check"],
    });
    assert.equal(prefixed.series.length, 2);

    const byService = await listMetricSeries({
      metric_name: HISTOGRAM,
      attr: ["service.name=agent-worker"],
    });
    assert.equal(byService.series.length, 1);
  });
});

test("an unknown metric name is reported as not found, not as an empty answer", async () => {
  await inDemoMode(async () => {
    await assert.rejects(
      () => listMetricSeries({ metric_name: "not.a.metric" }),
      (error: unknown) =>
        error instanceof CollectorError && /metric not found/u.test(error.message),
    );
  });
});

test("a matcher without '=' fails on the argument rather than silently not filtering", async () => {
  await inDemoMode(async () => {
    await assert.rejects(
      () => listMetricSeries({ metric_name: HISTOGRAM, attr: ["http.route"] }),
      /attr entries are written 'key=value'/u,
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
      grouped.result.series.map((stream) => stream.attributes[0]?.value).sort(),
      ["/checkout", "/health", "/v1/agent/run"],
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
