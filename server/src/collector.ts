/**
 * Collector REST client + live/demo mode selection.
 *
 * QYL_DEMO=1 forces demo. Otherwise the first tool call probes the collector
 * (GET /api/v1/traces?limit=1); a connection-refused there pins demo mode for
 * the process lifetime. Any other outcome (including HTTP errors) pins live —
 * the collector is reachable, so real calls should surface real errors.
 */

import { collectorUrl } from "./config.js";
import type { Mode, QylTrace } from "./wire.js";

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

/**
 * GET a collector endpoint. Query params are camelCase per the collector
 * API; `undefined` values are omitted. Connection failures map to a clear,
 * actionable message.
 */
export async function collectorGet(
  pathname: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<any> {
  const url = new URL(pathname, collectorUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new CollectorError(
      `collector unreachable at ${collectorUrl()} — start it with ` +
        "`dotnet run --project services/qyl.collector` or set QYL_DEMO=1",
      true,
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body: any = await response.json();
      detail = body?.error || body?.detail || body?.title || "";
    } catch {
      /* non-JSON body — status alone will have to do */
    }
    throw new CollectorError(
      `collector request failed (${response.status} ${response.statusText}) for ${pathname}` +
        (detail ? `: ${detail}` : ""),
      false,
      response.status,
    );
  }

  return response.json();
}

/** Collector list endpoints return CursorPage<T>; tolerate bare arrays too. */
export function unwrapItems<T>(body: any): T[] {
  if (Array.isArray(body)) return body as T[];
  return (body?.items ?? []) as T[];
}

// The generated OpenAPI types say span.kind / status.code are numbers, but the live
// collector serializes them as string enums ("client", "ok" — JsonStringEnumConverter).
// Normalize to the numeric contract at the fetch boundary, tolerating both encodings.
const SPAN_KIND_BY_NAME: Record<string, number> = {
  unspecified: 0, internal: 1, server: 2, client: 3, producer: 4, consumer: 5,
};
const STATUS_CODE_BY_NAME: Record<string, number> = { unset: 0, ok: 1, error: 2 };

function toEnumNumber(value: unknown, byName: Record<string, number>): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return byName[value.toLowerCase()] ?? 0;
  return 0;
}

export function normalizeSpan(span: any): any {
  if (!span) return span;
  // Project to exactly the contract's QylSpan fields: the live collector also sends
  // trace_state / links / flags / dropped_*_count / instrumentation_scope, which the
  // strict output schema (additionalProperties: false) rejects and the viewer ignores.
  return {
    span_id: span.span_id,
    trace_id: span.trace_id,
    ...(span.parent_span_id ? { parent_span_id: span.parent_span_id } : {}),
    name: span.name,
    kind: toEnumNumber(span.kind, SPAN_KIND_BY_NAME),
    start_time_unix_nano: Number(span.start_time_unix_nano ?? 0),
    end_time_unix_nano: Number(span.end_time_unix_nano ?? 0),
    ...(Array.isArray(span.attributes) ? { attributes: span.attributes } : {}),
    ...(Array.isArray(span.events)
      ? {
          events: span.events.map((e: any) => ({
            name: e?.name ?? "",
            time_unix_nano: Number(e?.time_unix_nano ?? 0),
            ...(Array.isArray(e?.attributes) ? { attributes: e.attributes } : {}),
          })),
        }
      : {}),
    status: span.status
      ? {
          code: toEnumNumber(span.status.code, STATUS_CODE_BY_NAME),
          ...(span.status.message ? { message: span.status.message } : {}),
        }
      : { code: 0 },
    resource: span.resource ?? {},
  };
}

export function normalizeTrace(trace: any): QylTrace {
  return {
    trace_id: trace?.trace_id ?? "",
    spans: Array.isArray(trace?.spans) ? trace.spans.map(normalizeSpan) : [],
    ...(trace?.root_span ? { root_span: normalizeSpan(trace.root_span) } : {}),
    span_count: Number(trace?.span_count ?? 0),
    duration_ns: Number(trace?.duration_ns ?? 0),
    start_time: trace?.start_time ?? "",
    end_time: trace?.end_time ?? "",
    services: Array.isArray(trace?.services) ? trace.services : [],
    has_error: Boolean(trace?.has_error),
  } as QylTrace;
}

let modeProbe: Promise<Mode> | undefined;

export function resolveMode(): Promise<Mode> {
  if (process.env.QYL_DEMO === "1") return Promise.resolve("demo");
  return (modeProbe ??= (async () => {
    try {
      await collectorGet("/api/v1/traces", { limit: 1 });
      return "live";
    } catch (err) {
      if (err instanceof CollectorError && err.connectionError) {
        console.error(
          `qyl-mcp-server: ${err.message}. Serving demo telemetry for the rest of this process.`,
        );
        return "demo";
      }
      return "live";
    }
  })());
}
