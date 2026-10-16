import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { MetricPoint } from "@ancplua/qyl-api-schema/types";
import { queryAnalysis } from "./analysis-client.js";
import { ANALYSIS_RESPONSE_BYTES, responseBytes } from "./analysis-budget.js";
import { analysisSummary } from "./analysis-summary.js";
import { CollectorError } from "./collector.js";
import { contractSchema } from "./contract-validation.js";
import { readContext } from "./analysis-context.test-helper.js";

const metricName = "worker.queue.depth";
const seriesId = "exact-meter-series";
const window = readContext().window;
const schema = contractSchema("Mcp.Tools.GetMetricSeriesOutput");

function environment(context: TestContext): void {
  const keys = ["MCP_COLLECTOR_PROJECTS", "QYL_API_KEY", "QYL_PROJECT", "QYL_COLLECTOR_URL"];
  const prior = keys.map(key => [key, process.env[key]] as const);
  keys.forEach(key => delete process.env[key]);
  process.env.QYL_COLLECTOR_URL = "http://collector.test";
  context.after(() => prior.forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }));
}

function point(index: number): MetricPoint {
  return {
    observation_id: `observation-${index}`,
    series_id: seriesId,
    has_conflict: false,
    time_unix_nano: (1_760_264_000_000_000_000n + BigInt(index)).toString(),
    attributes: [{ key: "worker.queue", value: "primary" }],
    flags: 0,
    data: { type: "number", value: { type: "int", value: "9007199254740993" } },
    exemplars: [],
  };
}

function output(points: MetricPoint[], hasMore = false) {
  return {
    ...readContext(1),
    items: [{
      series_id: seriesId, name: metricName,
      kind: points[0]?.data?.type === "exponential_histogram" ? "exponential_histogram" : "gauge",
      attributes: [],
      first_seen: window.start_time, last_seen: window.end_time,
    }],
    points: {
      items: points, has_more: hasMore,
      ...(hasMore ? { next_cursor: `signed-points-after-${points.length}` } : {}),
    },
  };
}

test("original-point budget re-queries points_limit and preserves the signed point continuation", async context => {
  environment(context);
  const queries: Array<Record<string, unknown>> = [];
  const points = Array.from({ length: 100 }, (_, index) => point(index));
  const before = structuredClone(points);
  context.mock.method(globalThis, "fetch", async (_: unknown, init?: RequestInit) => {
    assert.equal(typeof init?.body, "string");
    const input = JSON.parse(init?.body as string) as Record<string, unknown>;
    queries.push(input);
    return Response.json(output(points.slice(0, Number(input.points_limit)), true));
  });
  const result = await queryAnalysis("get_metric_series", {
    metric_name: metricName, series_id: seriesId, points_limit: 100,
    points_cursor: "signed-current-page", lookback_minutes: 60,
    matchers: [{ key: "worker.queue", op: "eq", value: "primary" }],
  }, schema, { collector: {}, step: async () => {} });
  assert.equal(queries.length, 2);
  const next = queries[1]!;
  assert(Number(next.points_limit) < 100);
  assert.equal(next.limit, undefined, "metadata limit cannot page original points");
  assert.equal(next.metric_name, metricName);
  assert.equal(next.series_id, seriesId);
  assert.equal(next.points_cursor, "signed-current-page");
  assert.equal(next.start_time, window.start_time);
  assert.equal(next.end_time, window.end_time);
  assert.deepEqual(next.matchers, queries[0]?.matchers);
  assert.deepEqual(result.structuredContent, output(points.slice(0, Number(next.points_limit)), true));
  assert(responseBytes(result) <= ANALYSIS_RESPONSE_BYTES);
  assert.match(JSON.stringify(result.content), /points_cursor/u);
  assert.deepEqual(points, before);
});

test("one original point over the MCP budget fails explicitly without trimming its native buckets", async context => {
  environment(context);
  const original = point(0);
  original.data = {
    type: "exponential_histogram", scale: 20, count: "18446744073709551615",
    zero_count: "0", zero_threshold: 0,
    positive: { offset: -4000, bucket_counts: Array.from({ length: 8000 }, () => "18446744073709551615") },
  };
  const page = output([original]);
  const before = structuredClone(page);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json(page);
  });
  await assert.rejects(queryAnalysis("get_metric_series", {
    metric_name: metricName, series_id: seriesId, points_limit: 1,
  }, schema, { collector: {}, step: async () => {} }), error => {
    assert(error instanceof CollectorError);
    assert.equal(error.code, "response_too_large");
    assert.equal(error.connectionError, false);
    assert.match(error.message, /\/api\/v1\/metrics\/worker.queue.depth\/series\/exact-meter-series\/points/u);
    return true;
  });
  assert.equal(requests, 1);
  assert.deepEqual(page, before);
});

test("point summaries identify historically unknown originals and the independent point continuation", () => {
  const old = point(0);
  old.data = null;
  old.projection = { value: 9007199254740992 };
  const text = analysisSummary("get_metric_series", output([point(1), old], true));
  assert.match(text, /original points: 2/u);
  assert.match(text, /1 original representation unknown/u);
  assert.match(text, /points_cursor/u);
  assert.doesNotMatch(text, /repeat with next_cursor/u);
});
