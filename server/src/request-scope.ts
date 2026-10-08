/**
 * The request-scoped helpers every tool handler runs inside.
 *
 * The SDK hands each handler a `ServerContext` whose `mcpReq` carries the
 * cancellation signal, the request's `_meta`, and a request-bound `notify`.
 * `runTool` resolves those once and
 * hands the work a plain `ToolScope`: the data layer (`data.ts`, `metrics.ts`)
 * takes `CollectorRequestOptions` with an `AbortSignal`, never the SDK context.
 *
 * Two channels, one frame:
 *   - cancellation: `scope.collector.signal` is `ctx.mcpReq.signal`, aborted on
 *     `notifications/cancelled` for this request and when the connection
 *     closes; `collectorRequest` races it against its own timeout.
 *   - progress: `scope.step(message)` sends `notifications/progress` when the
 *     request carried a `progressToken`, and nothing when it did not. The
 *     reporter counts its own steps, so `progress` increases per token by
 *     construction; `runTool` reports the final step itself once the result is
 *     built, so a handler declares only the steps it reports.
 */
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { CollectorError, type CollectorRequestOptions } from "./collector.js";
import { CollectorAccessError, collectorAccessForSubject } from "./collector-access.js";
import { redactTelemetryText } from "./telemetry-redaction.js";

/** What a tool's work receives: collector options and a progress step. */
export interface ToolScope {
  /** Collector options carrying this request's cancellation signal. */
  collector: CollectorRequestOptions;
  /** Report one more completed step; the message says what just finished. */
  step(message: string): Promise<void>;
}

/** Uniform failure result: clear text + isError, never a thrown exception. */
export function toolError(err: unknown): CallToolResult {
  const message = err instanceof CollectorError || err instanceof CollectorAccessError
    ? err.message
    : "Telemetry request failed.";
  return {
    content: [{ type: "text", text: redactTelemetryText(message) }],
    isError: true,
  };
}

/**
 * Run one tool call inside its request scope.
 *
 * `steps` is how many `scope.step` calls the work makes on its success path;
 * the reported `total` is one more, for the final "Result ready" step that
 * `runTool` sends once the work has returned. A thrown error becomes the
 * uniform `toolError` result. Nothing is sent once the request is cancelled:
 * the SDK discards the result of a cancelled request, and a notification
 * about it would describe work the client already gave up on.
 */
export async function runTool(
  ctx: ServerContext,
  steps: number,
  work: (scope: ToolScope) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const { signal } = ctx.mcpReq;
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const total = steps + 1;
  let progress = 0;

  const step = async (message: string): Promise<void> => {
    if (progressToken === undefined || signal.aborted) return;
    progress += 1;
    await ctx.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    });
  };

  try {
    const access = collectorAccessForSubject(ctx.http?.authInfo?.extra?.["subject"]);
    const result = await work({
      collector: { signal, ...(access === undefined ? {} : { access }) },
      step,
    });
    await step("Result ready");
    return result;
  } catch (err) {
    return toolError(err);
  }
}
