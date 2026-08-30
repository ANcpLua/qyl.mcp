/**
 * Collector REST client + live/demo mode selection.
 *
 * QYL_DEMO=1 selects explicit demo mode. Every other invocation is live;
 * connection, HTTP, JSON, and contract failures surface to the caller rather
 * than silently substituting generated telemetry or invented defaults.
 */

import type {
  LogRecord,
  ProblemDetails,
  SessionEntity,
  Trace,
} from "@ancplua/qyl-api-schema/types";
import { z } from "zod";
import { collectorHeaders, collectorUrl } from "./config.js";
import {
  LogRecordSchema,
  ProblemDetailsSchema,
  SessionSchema,
  TraceSchema,
} from "./contract-validation.js";
import type { Mode } from "./wire.js";

/** Error with a message already suitable for showing to the model/user. */
export class CollectorError extends Error {
  constructor(
    message: string,
    readonly connectionError = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CollectorError";
  }
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollectorError(`collector contract mismatch for ${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function contractMismatch(context: string, error: z.ZodError): CollectorError {
  return new CollectorError(
    `collector contract mismatch for ${context}: ${z.prettifyError(error)}`,
  );
}

/**
 * Not a validation workaround: the generated contract validator accepts every
 * RFC 3339 spelling, offsets included. This normalizes so that live timestamps
 * read exactly like demo ones, which demo.ts builds with `Date#toISOString`,
 * because consumers use the string as the value -- summaries.ts renders it and
 * ci.ts reports it, where a `+02:00` trace must not print unlike a `Z` trace.
 * Validating before converting keeps a malformed timestamp a contract mismatch
 * instead of a `RangeError`; the canonical form costs sub-millisecond digits.
 */
const rfc3339 = z.iso.datetime({ offset: true });

function canonicalDateTime(value: unknown, context: string): string {
  const parsed = rfc3339.safeParse(value);
  if (!parsed.success) throw contractMismatch(context, parsed.error);
  return new Date(parsed.data).toISOString();
}

/** Normalize RFC 3339 spelling, then enforce the public Trace schema exactly. */
export function parseCollectorTrace(value: unknown, context = "trace"): Trace {
  const trace = asRecord(value, context);
  const normalized: Record<string, unknown> = {
    ...trace,
    start_time: canonicalDateTime(trace.start_time, `${context}.start_time`),
    end_time: canonicalDateTime(trace.end_time, `${context}.end_time`),
  };
  const parsed = TraceSchema.safeParse(normalized);
  if (!parsed.success) throw contractMismatch(context, parsed.error);
  return parsed.data;
}

/** Normalize RFC 3339 spelling, then enforce the public Session schema exactly. */
export function parseCollectorSession(value: unknown, context = "session"): SessionEntity {
  const session = asRecord(value, context);
  const normalized: Record<string, unknown> = {
    ...session,
    start_time: canonicalDateTime(session.start_time, `${context}.start_time`),
  };
  if (session.end_time !== undefined) {
    normalized.end_time = canonicalDateTime(session.end_time, `${context}.end_time`);
  }

  const parsed = SessionSchema.safeParse(normalized);
  if (!parsed.success) throw contractMismatch(context, parsed.error);
  return parsed.data;
}

/** Enforce the public LogRecord schema without alternate wire encodings. */
export function parseCollectorLog(value: unknown, context = "log"): LogRecord {
  const parsed = LogRecordSchema.safeParse(asRecord(value, context));
  if (!parsed.success) throw contractMismatch(context, parsed.error);
  return parsed.data;
}

interface ParsedCollectorPage<T> {
  items: T[];
  hasMore: boolean;
}

export interface CollectorRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Normalize endpoint items, then validate the complete operation-specific
 * response body. The supplied schema must be an Operations.*.Response.200
 * definition from the generated contract.
 */
export function parseCollectorPage<T, TPage extends { items: T[]; has_more: boolean }>(
  value: unknown,
  context: string,
  pageSchema: z.ZodType<TPage>,
  parseItem: (item: unknown, context: string) => T,
): ParsedCollectorPage<T> {
  try {
    const source = asRecord(value, context);
    const sourceItems = z.array(z.unknown()).safeParse(source.items);
    if (!sourceItems.success) throw contractMismatch(`${context}.items`, sourceItems.error);
    const page = pageSchema.parse({
      ...source,
      items: sourceItems.data.map((item, index) =>
        parseItem(item, `${context}.items[${index}]`)),
    });
    return { items: page.items, hasMore: page.has_more };
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    if (error instanceof z.ZodError) throw contractMismatch(context, error);
    throw error;
  }
}

function normalizeProblemDetails(value: unknown): unknown {
  const problem = asRecord(value, "error response");
  if (problem.timestamp === undefined) return problem;
  return {
    ...problem,
    timestamp: canonicalDateTime(problem.timestamp, "error response.timestamp"),
  };
}

function parseProblemDetails(value: unknown): ProblemDetails | undefined {
  try {
    const parsed = ProblemDetailsSchema.safeParse(normalizeProblemDetails(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Call a collector endpoint. Query params use their generated wire names;
 * `undefined` values are omitted. All response data remains unknown until the
 * endpoint-specific generated contract parser accepts it.
 */
async function collectorRequest(
  pathname: string,
  method: "GET" | "POST",
  params: Record<string, string | number | boolean | undefined>,
  body: unknown,
  options: CollectorRequestOptions,
): Promise<unknown> {
  const url = new URL(pathname, collectorUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const headers = {
    accept: "application/json",
    ...collectorHeaders(),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    if (options.signal?.aborted) {
      throw new CollectorError(`collector request cancelled for ${pathname}`, true);
    }
    if (timeout.aborted) {
      throw new CollectorError(`collector timed out for ${pathname}`, true);
    }
    throw new CollectorError(
      `collector unreachable at ${collectorUrl()} — start it with ` +
        "`dotnet run --project services/qyl.collector` or set QYL_DEMO=1",
      true,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new CollectorError(
      `collector returned invalid JSON (${response.status} ${response.statusText}) for ${pathname}`,
      false,
      response.status,
    );
  }

  if (!response.ok) {
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/problem+json") {
      throw new CollectorError(
        `collector contract mismatch for ${pathname}: expected application/problem+json, got ${mediaType ?? "no content type"}`,
        false,
        response.status,
      );
    }
    const problem = parseProblemDetails(responseBody);
    if (!problem) {
      throw new CollectorError(
        `collector contract mismatch for ${pathname}: invalid Problem Details body`,
        false,
        response.status,
      );
    }
    throw new CollectorError(
      `collector request failed (${response.status} ${response.statusText}) for ${pathname}`,
      false,
      response.status,
    );
  }

  return responseBody;
}

export function collectorGet(
  pathname: string,
  params: Record<string, string | number | boolean | undefined> = {},
  options: CollectorRequestOptions = {},
): Promise<unknown> {
  return collectorRequest(pathname, "GET", params, undefined, options);
}

export function collectorPost(
  pathname: string,
  body: unknown,
  options: CollectorRequestOptions = {},
): Promise<unknown> {
  return collectorRequest(pathname, "POST", {}, body, options);
}

export function resolveMode(): Promise<Mode> {
  return Promise.resolve(process.env.QYL_DEMO === "1" ? "demo" : "live");
}
