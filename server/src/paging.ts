/**
 * Demo-mode paging.
 *
 * Live pages come from the Collector with its own opaque cursor. The demo
 * dataset has no Collector, so it pages itself the same way a caller sees it:
 * an opaque cursor, `has_more` taken from the data, and a cursor that does not
 * decode is the caller's mistake, never a silent first page again — the
 * invariant that demo honors every filter the live endpoints support.
 */

import { CollectorError } from "./collector.js";

/** One page of a list, in the shape every list tool returns. */
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

const DEMO_CURSOR_PREFIX = "demo:";

export function demoPage<T>(items: readonly T[], limit: number, cursor: string | undefined): Page<T> {
  const offset = cursor === undefined ? 0 : decodeDemoCursor(cursor);
  const end = offset + limit;
  const hasMore = end < items.length;
  return {
    items: items.slice(offset, end),
    hasMore,
    ...(hasMore ? { nextCursor: encodeDemoCursor(end) } : {}),
  };
}

function encodeDemoCursor(offset: number): string {
  return Buffer.from(`${DEMO_CURSOR_PREFIX}${offset}`).toString("base64url");
}

function decodeDemoCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString();
  const digits = decoded.startsWith(DEMO_CURSOR_PREFIX) ? decoded.slice(DEMO_CURSOR_PREFIX.length) : "";
  if (!/^\d{1,9}$/u.test(digits)) {
    throw new CollectorError(
      "cursor is not a qyl cursor; pass the previous page's next_cursor unchanged, with the same filters",
      false,
      undefined,
      "invalid_argument",
    );
  }
  return Number(digits);
}
