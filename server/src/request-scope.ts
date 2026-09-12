/**
 * The request-scoped helpers a tool handler forwards into its work.
 *
 * The SDK hands every handler a `ServerContext` whose `mcpReq` carries the
 * cancellation signal, the request's `_meta`, and a `notify` bound to this
 * request. A handler resolves what it needs from the context once, at the top,
 * and passes plain values down: the data layer takes an `AbortSignal`, never
 * the SDK context.
 *
 * MCP logging (`ctx.mcpReq.log`, the `logging` capability) is deliberately not
 * wired. It is deprecated as of revision 2026-07-28 (SEP-2577); this server
 * logs to stderr (`stderr-log.ts`) and OpenTelemetry (`telemetry.ts`) instead.
 * See the workspace DECISIONS.md entry of 2026-09-12.
 */
import type { ServerContext } from "@modelcontextprotocol/server";
import type { CollectorRequestOptions } from "./collector.js";

/**
 * The collector options this request contributes: its cancellation signal.
 * The SDK aborts the signal when the client sends `notifications/cancelled`
 * for the request and when the connection closes. `collectorRequest` races it
 * against its own timeout, so a cancelled call unwinds the in-flight collector
 * fetch at once instead of waiting the timeout out.
 */
export function requestScope(ctx: ServerContext): CollectorRequestOptions {
  return { signal: ctx.mcpReq.signal };
}

/** Reports completed units of work to a client that asked for progress. */
export interface ProgressReporter {
  /** Report one more completed step; the message says what just finished. */
  step(message: string): Promise<void>;
}

const SILENT: ProgressReporter = { step: () => Promise.resolve() };

/**
 * A `notifications/progress` sender for this request, or a silent one when the
 * request carried no `progressToken` in `_meta` (a client that did not ask gets
 * nothing). `progress` is the number of `step` calls so far, so it increases on
 * every notification by construction, which is what the protocol requires of a
 * token. `total` is how many steps the handler reports over its whole run.
 */
export function progressReporter(ctx: ServerContext, total: number): ProgressReporter {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return SILENT;
  let progress = 0;
  return {
    async step(message: string): Promise<void> {
      // A cancelled request gets no response; a progress update after the
      // cancellation would be a message about work the client already gave up.
      if (ctx.mcpReq.signal.aborted) return;
      progress += 1;
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    },
  };
}
