import { compareUnixNanos } from "@ancplua/qyl-api-schema/runtime";
import type { QylTrace } from "./wire.js";

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Root span name, or the earliest span when no root is identified. */
export function rootSpanName(trace: Pick<QylTrace, "root_span"> & Partial<Pick<QylTrace, "spans">>): string {
  if (trace.root_span?.name) return trace.root_span.name;
  const earliest = [...(trace.spans ?? [])].sort((a, b) =>
    compareUnixNanos(a.start_time_unix_nano, b.start_time_unix_nano),
  )[0];
  return earliest?.name ?? "unknown";
}
