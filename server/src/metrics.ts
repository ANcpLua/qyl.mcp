/**
 * Metric reading over the contract metrics API, live and demo.
 *
 * Live mode forwards to the collector's three published operations and revalidates
 * the answer against the operation's own 200 body. Demo mode holds stored points
 * and runs the same bucketing and reducer the collector would, so a demo answer
 * honors step_ms, aggregation, group_by, the attribute matchers and the cursor
 * rather than pretending they were applied — the invariant the rest of the demo
 * dataset keeps.
 *
 * The tool inputs are the contract's `Mcp.Tools.*Metric*` models (11.6.0). A
 * matcher is structured, `{ key, op, value }`; the wire keeps the collector's
 * `attr` / `attr_prefix` strings, so the tool layer serializes `eq` and `prefix`
 * to them and nothing else.
 */

import type {
  GetMetricSeriesInput,
  ListMetricsInput,
  MetricAggregation,
  MetricAttributeMatcher,
  MetricDescriptor,
  MetricQueryResult,
  MetricSeries,
  MetricSeriesResult,
  QueryMetricInput,
  Attribute,
} from "@ancplua/qyl-api-schema/types";
import { attributeIdentity, formatAttributeValue } from "@ancplua/qyl-api-schema/runtime";
import {
  CollectorError,
  type CollectorRequestOptions,
  collectorGet,
  parseCollectorMetricDescriptor,
  parseCollectorMetricQueryResult,
  parseCollectorMetricSeries,
  parseCollectorPage,
  resolveMode,
} from "./collector.js";
import {
  MetricsListResponseSchema,
  MetricSeriesListResponseSchema,
} from "./contract-validation.js";
import { getDemoMetrics, type DemoMetricStream } from "./demo.js";
import { demoPage, type Page } from "./paging.js";
import { redactTelemetry } from "./telemetry-redaction.js";
import type { Mode } from "./wire.js";

const METRICS_PATH = "/api/v1/metrics";

/** Tool arguments are the published tool input models. */
export type ListMetricsArgs = ListMetricsInput;
export type MetricSeriesArgs = GetMetricSeriesInput;
export type QueryMetricArgs = QueryMetricInput;

/** A page of metric items with the mode it came from; the cursor is added after redaction. */
export interface MetricPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
  mode: Mode;
}

function metricPage<T>(page: Page<T>, mode: Mode): MetricPage<T> {
  return {
    ...redactTelemetry({ items: page.items, mode }),
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

/**
 * The collector's published spellings of the two matcher lists: `eq` becomes
 * `attr=key=value`, `prefix` becomes `attr_prefix=key=value`. The collector
 * splits on the first `=`, so a value containing `=` survives.
 */
function wireMatchers(
  matchers: readonly MetricAttributeMatcher[] | undefined,
): { attr: string[] | undefined; attr_prefix: string[] | undefined } {
  const attr: string[] = [];
  const attr_prefix: string[] = [];
  for (const matcher of matchers ?? []) {
    (matcher.op === "eq" ? attr : attr_prefix).push(`${matcher.key}=${matcher.value}`);
  }
  return {
    attr: attr.length === 0 ? undefined : attr,
    attr_prefix: attr_prefix.length === 0 ? undefined : attr_prefix,
  };
}

function attributeFormatted(attributes: readonly Attribute[], key: string): string | undefined {
  const found = attributes.find((attribute) => attribute.key === key);
  return found === undefined ? undefined : formatAttributeValue(found.value);
}

function matchesStream(
  stream: DemoMetricStream,
  matchers: readonly MetricAttributeMatcher[] | undefined,
): boolean {
  const read = (key: string): string | undefined =>
    key === "service.name" ? stream.serviceName : attributeFormatted(stream.attributes, key);
  return (matchers ?? []).every((matcher) => {
    const value = read(matcher.key);
    switch (matcher.op) {
      case "exists": return value !== undefined;
      case "eq": return value === String(matcher.value);
      case "neq": return value !== String(matcher.value);
      case "in": return matcher.values?.some((candidate) => value === String(candidate)) === true;
      case "prefix": return value?.startsWith(String(matcher.value)) === true;
      case "contains": return value?.includes(String(matcher.value)) === true;
      case "gt": return value !== undefined && Number(value) > Number(matcher.value);
      case "gte": return value !== undefined && Number(value) >= Number(matcher.value);
      case "lt": return value !== undefined && Number(value) < Number(matcher.value);
      case "lte": return value !== undefined && Number(value) <= Number(matcher.value);
    }
  });
}

/** Stable across rebuilds because it is derived from identity, not from order. */
function demoSeriesId(stream: DemoMetricStream): string {
  const identity = [
    stream.name,
    stream.serviceName,
    // The contract's own identity, the same string the collector computes in C#.
    ...stream.attributes.map((attribute) => `${attribute.key}=${attributeIdentity(attribute.value)}`),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function demoNotFound(metricName: string): CollectorError {
  return new CollectorError(`metric not found: ${metricName}`, false, undefined, "not_found");
}

export async function listMetrics(
  args: ListMetricsArgs,
  options: CollectorRequestOptions = {},
): Promise<MetricPage<MetricDescriptor>> {
  const mode = await resolveMode();
  const limit = args.limit ?? 200;

  if (mode === "demo") {
    const byName = new Map<string, DemoMetricStream[]>();
    for (const stream of getDemoMetrics()) {
      if (args.name_prefix !== undefined && !stream.name.startsWith(args.name_prefix)) continue;
      const bucket = byName.get(stream.name);
      if (bucket) bucket.push(stream);
      else byName.set(stream.name, [stream]);
    }
    const metrics = [...byName.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, streams]): MetricDescriptor => {
        const [first] = streams;
        if (first === undefined) {
          throw new CollectorError(`demo metric ${name} has no streams`, false, undefined, "internal");
        }
        const lastSeen = Math.max(
          ...streams.map((stream) => stream.points.at(-1)?.atMs ?? 0),
        );
        return {
          name,
          kind: first.kind,
          temporality: first.temporality,
          monotonic: first.monotonic,
          unit: first.unit,
          description: first.description,
          series_count: streams.length,
          last_seen: new Date(lastSeen).toISOString(),
        };
      });
    return metricPage(demoPage(metrics, limit, args.cursor), mode);
  }

  const body = await collectorGet(
    METRICS_PATH,
    { name_prefix: args.name_prefix, limit, cursor: args.cursor },
    options,
  );
  return metricPage(
    parseCollectorPage(body, METRICS_PATH, MetricsListResponseSchema, parseCollectorMetricDescriptor),
    mode,
  );
}

export async function listMetricSeries(
  args: MetricSeriesArgs,
  options: CollectorRequestOptions = {},
): Promise<MetricPage<MetricSeries>> {
  const mode = await resolveMode();
  const limit = args.limit ?? 200;

  if (mode === "demo") {
    const streams = getDemoMetrics().filter(
      (stream) => stream.name === args.metric_name && matchesStream(stream, args.matchers),
    );
    if (streams.length === 0 && !getDemoMetrics().some((s) => s.name === args.metric_name)) {
      throw demoNotFound(args.metric_name);
    }
    const series = streams.map((stream): MetricSeries => ({
      series_id: demoSeriesId(stream),
      name: stream.name,
      kind: stream.kind,
      attributes: stream.attributes,
      service_name: stream.serviceName,
      unit: stream.unit,
      first_seen: new Date(stream.points[0]?.atMs ?? 0).toISOString(),
      last_seen: new Date(stream.points.at(-1)?.atMs ?? 0).toISOString(),
    }));
    return metricPage(demoPage(series, limit, args.cursor), mode);
  }

  const path = `${METRICS_PATH}/${encodeURIComponent(args.metric_name)}/series`;
  try {
    const body = await collectorGet(
      path,
      { ...wireMatchers(args.matchers), limit, cursor: args.cursor },
      options,
    );
    return metricPage(
      parseCollectorPage(body, path, MetricSeriesListResponseSchema, parseCollectorMetricSeries),
      mode,
    );
  } catch (error) {
    if (error instanceof CollectorError && error.status === 404) throw demoNotFound(args.metric_name);
    throw error;
  }
}

/** The published reducers, over the points that landed in one bucket. */
function reduce(values: number[], aggregation: MetricAggregation): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[index] as number;
  };
  switch (aggregation) {
    case "avg":
      return values.reduce((total, value) => total + value, 0) / values.length;
    case "min":
      return sorted[0] as number;
    case "max":
      return sorted[sorted.length - 1] as number;
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "count":
      return values.length;
    case "last":
      return values[values.length - 1] as number;
    case "p50":
      return quantile(0.5);
    case "p90":
      return quantile(0.9);
    case "p95":
      return quantile(0.95);
    case "p99":
      return quantile(0.99);
  }
}

function groupingKey(
  stream: DemoMetricStream,
  groupBy: readonly string[],
): { key: string; attributes: Attribute[] } {
  const attributes: Attribute[] = [];
  for (const key of groupBy) {
    const value = key === "service.name"
      ? stream.serviceName
      : attributeFormatted(stream.attributes, key);
    if (value !== undefined) attributes.push({ key, value });
  }
  return { key: attributes.map((a) => `${a.key}=${formatAttributeValue(a.value)}`).join("|"), attributes };
}

export async function queryMetric(
  args: QueryMetricArgs,
  options: CollectorRequestOptions = {},
): Promise<{ result: MetricQueryResult; mode: Mode }> {
  const mode = await resolveMode();
  const stepMs = args.step_ms ?? 60_000;
  const aggregation = args.aggregation ?? "avg";
  const seriesLimit = args.series_limit ?? 50;

  if (mode === "demo") {
    const streams = getDemoMetrics().filter(
      (stream) => stream.name === args.metric_name && matchesStream(stream, args.matchers),
    );
    if (!getDemoMetrics().some((stream) => stream.name === args.metric_name)) {
      throw demoNotFound(args.metric_name);
    }
    const endMs = args.end_time === undefined ? Date.now() : Date.parse(args.end_time);
    const startMs = args.start_time === undefined
      ? endMs - (args.lookback_minutes ?? 60) * 60_000
      : Date.parse(args.start_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new CollectorError("end_time must be a valid timestamp after start_time");
    }

    const groups = new Map<string, { attributes: Attribute[]; streams: DemoMetricStream[] }>();
    for (const stream of streams) {
      const { key, attributes } = groupingKey(stream, args.group_by ?? []);
      const existing = groups.get(key);
      if (existing) existing.streams.push(stream);
      else groups.set(key, { attributes, streams: [stream] });
    }

    const ordered = [...groups.values()];
    const truncated = ordered.length > seriesLimit;
    const bucketCount = Math.max(1, Math.ceil((endMs - startMs) / stepMs));
    const series: MetricSeriesResult[] = ordered.slice(0, seriesLimit).map((group) => {
      const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
      for (const stream of group.streams) {
        for (const point of stream.points) {
          if (point.atMs < startMs || point.atMs >= endMs) continue;
          const index = Math.min(bucketCount - 1, Math.floor((point.atMs - startMs) / stepMs));
          (buckets[index] as number[]).push(point.value);
        }
      }
      return {
        attributes: group.attributes,
        buckets: buckets.map((values, index) => ({
          bucket_start: new Date(startMs + index * stepMs).toISOString(),
          value: reduce(values, aggregation),
          point_count: values.length,
        })),
      };
    });

    const first = streams[0];
    const result: MetricQueryResult = {
      name: args.metric_name,
      kind: first?.kind ?? "gauge",
      unit: first?.unit,
      aggregation,
      step_ms: stepMs,
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      series,
      truncated,
    };
    return redactTelemetry({ result, mode });
  }

  const path = `${METRICS_PATH}/${encodeURIComponent(args.metric_name)}/query`;
  try {
    const body = await collectorGet(
      path,
      {
        start_time: args.start_time,
        end_time: args.end_time,
        step_ms: stepMs,
        aggregation,
        group_by: args.group_by,
        ...wireMatchers(args.matchers),
        series_limit: seriesLimit,
      },
      options,
    );
    return redactTelemetry({ result: parseCollectorMetricQueryResult(body, path), mode });
  } catch (error) {
    if (error instanceof CollectorError && error.status === 404) throw demoNotFound(args.metric_name);
    throw error;
  }
}
