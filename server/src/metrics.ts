/**
 * Metric reading over the contract 8.0.0 metrics API, live and demo.
 *
 * Live mode forwards to the collector's three published operations and revalidates
 * the answer against the operation's own 200 body. Demo mode holds stored points
 * and runs the same bucketing and reducer the collector would, so a demo answer
 * honors step_ms, aggregation, group_by and the attribute matchers rather than
 * pretending they were applied — the invariant the rest of the demo dataset keeps.
 */

import type {
  MetricAggregation,
  MetricDescriptor,
  MetricQueryResult,
  MetricSeries,
  MetricSeriesResult,
  Attribute,
} from "@ancplua/qyl-api-schema/types";
import {
  CollectorError,
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
import { redactTelemetry } from "./telemetry-redaction.js";
import type { Mode } from "./wire.js";

const METRICS_PATH = "/api/v1/metrics";

/** Tool arguments, mirroring the published operation parameters that shape them. */
export interface ListMetricsArgs {
  name_prefix?: string;
  limit?: number;
}

export interface MetricSeriesArgs {
  metric_name: string;
  attr?: readonly string[];
  attr_prefix?: readonly string[];
  limit?: number;
}

export interface QueryMetricArgs {
  metric_name: string;
  start_time: string;
  end_time: string;
  step_ms?: number;
  aggregation?: MetricAggregation;
  group_by?: readonly string[];
  attr?: readonly string[];
  attr_prefix?: readonly string[];
  series_limit?: number;
}

interface Matcher {
  key: string;
  value: string;
}

/**
 * `key=value` and `key=prefix` are the published spellings of both matcher
 * lists. A matcher without `=` is the model's mistake, not the collector's, so
 * it fails here with the offending text rather than reaching the wire as a
 * silently ignored filter.
 */
function parseMatchers(raw: readonly string[] | undefined, parameter: string): Matcher[] {
  return (raw ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new CollectorError(
        `${parameter} entries are written 'key=value'; received ${JSON.stringify(entry)}`,
      );
    }
    return { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
}

function attributeText(attributes: readonly Attribute[], key: string): string | undefined {
  const found = attributes.find((attribute) => attribute.key === key);
  if (found === undefined) return undefined;
  const { value } = found;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (value !== null && typeof value === "object" && "value" in value) {
    return String((value as { value: unknown }).value);
  }
  return value === null ? undefined : String(value);
}

function matchesStream(
  stream: DemoMetricStream,
  exact: readonly Matcher[],
  prefixes: readonly Matcher[],
): boolean {
  const read = (key: string): string | undefined =>
    key === "service.name" ? stream.serviceName : attributeText(stream.attributes, key);
  return (
    exact.every((matcher) => read(matcher.key) === matcher.value) &&
    prefixes.every((matcher) => read(matcher.key)?.startsWith(matcher.value) === true)
  );
}

/** Stable across rebuilds because it is derived from identity, not from order. */
function demoSeriesId(stream: DemoMetricStream): string {
  const identity = [
    stream.name,
    stream.serviceName,
    ...stream.attributes.map((attribute) => `${attribute.key}=${attributeText([attribute], attribute.key) ?? ""}`),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export async function listMetrics(
  args: ListMetricsArgs,
): Promise<{ metrics: MetricDescriptor[]; mode: Mode }> {
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
      .slice(0, limit)
      .map(([name, streams]): MetricDescriptor => {
        const [first] = streams;
        if (first === undefined) throw new CollectorError(`demo metric ${name} has no streams`);
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
    return redactTelemetry({ metrics, mode });
  }

  const body = await collectorGet(METRICS_PATH, {
    name_prefix: args.name_prefix,
    limit,
  });
  return redactTelemetry({
    metrics: parseCollectorPage(
      body,
      METRICS_PATH,
      MetricsListResponseSchema,
      parseCollectorMetricDescriptor,
    ).items,
    mode,
  });
}

export async function listMetricSeries(
  args: MetricSeriesArgs,
): Promise<{ series: MetricSeries[]; mode: Mode }> {
  const mode = await resolveMode();
  const limit = args.limit ?? 200;
  const exact = parseMatchers(args.attr, "attr");
  const prefixes = parseMatchers(args.attr_prefix, "attr_prefix");

  if (mode === "demo") {
    const streams = getDemoMetrics().filter(
      (stream) =>
        stream.name === args.metric_name && matchesStream(stream, exact, prefixes),
    );
    if (streams.length === 0 && !getDemoMetrics().some((s) => s.name === args.metric_name)) {
      throw new CollectorError(`metric not found: ${args.metric_name}`);
    }
    const series = streams.slice(0, limit).map((stream): MetricSeries => ({
      series_id: demoSeriesId(stream),
      name: stream.name,
      kind: stream.kind,
      attributes: stream.attributes,
      service_name: stream.serviceName,
      unit: stream.unit,
      first_seen: new Date(stream.points[0]?.atMs ?? 0).toISOString(),
      last_seen: new Date(stream.points.at(-1)?.atMs ?? 0).toISOString(),
    }));
    return redactTelemetry({ series, mode });
  }

  const path = `${METRICS_PATH}/${encodeURIComponent(args.metric_name)}/series`;
  try {
    const body = await collectorGet(path, {
      attr: args.attr,
      attr_prefix: args.attr_prefix,
      limit,
    });
    return redactTelemetry({
      series: parseCollectorPage(
        body,
        path,
        MetricSeriesListResponseSchema,
        parseCollectorMetricSeries,
      ).items,
      mode,
    });
  } catch (error) {
    if (error instanceof CollectorError && error.status === 404) {
      throw new CollectorError(`metric not found: ${args.metric_name}`);
    }
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
      : attributeText(stream.attributes, key);
    if (value !== undefined) attributes.push({ key, value });
  }
  return { key: attributes.map((a) => `${a.key}=${String(a.value)}`).join("|"), attributes };
}

export async function queryMetric(
  args: QueryMetricArgs,
): Promise<{ result: MetricQueryResult; mode: Mode }> {
  const mode = await resolveMode();
  const stepMs = args.step_ms ?? 60_000;
  const aggregation = args.aggregation ?? "avg";
  const seriesLimit = args.series_limit ?? 50;
  const exact = parseMatchers(args.attr, "attr");
  const prefixes = parseMatchers(args.attr_prefix, "attr_prefix");

  if (mode === "demo") {
    const streams = getDemoMetrics().filter(
      (stream) => stream.name === args.metric_name && matchesStream(stream, exact, prefixes),
    );
    if (!getDemoMetrics().some((stream) => stream.name === args.metric_name)) {
      throw new CollectorError(`metric not found: ${args.metric_name}`);
    }
    const startMs = Date.parse(args.start_time);
    const endMs = Date.parse(args.end_time);
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
    const body = await collectorGet(path, {
      start_time: args.start_time,
      end_time: args.end_time,
      step_ms: stepMs,
      aggregation,
      group_by: args.group_by,
      attr: args.attr,
      attr_prefix: args.attr_prefix,
      series_limit: seriesLimit,
    });
    return redactTelemetry({ result: parseCollectorMetricQueryResult(body, path), mode });
  } catch (error) {
    if (error instanceof CollectorError && error.status === 404) {
      throw new CollectorError(`metric not found: ${args.metric_name}`);
    }
    throw error;
  }
}
