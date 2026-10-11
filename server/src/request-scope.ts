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
import {
  CollectorError,
  type CollectorRequestOptions,
  type ToolErrorCode,
  isRetryableToolError,
} from "./collector.js";
import { CollectorAccessError, collectorAccessForSubject } from "./collector-access.js";
import { redactTelemetryText } from "./telemetry-redaction.js";
import { InsufficientScopeError, WWW_AUTHENTICATE_META_KEY } from "./tool-scopes.js";

/** What a tool's work receives: collector options and a progress step. */
export interface ToolScope {
  /** Collector options carrying this request's cancellation signal. */
  collector: CollectorRequestOptions;
  /** Report one more completed step; the message says what just finished. */
  step(message: string): Promise<void>;
}

/** The structured half of a failed call: `structuredContent.error`. */
export interface ToolErrorDetail {
  /** Stable across releases; the model branches on this, not on the text. */
  code: ToolErrorCode;
  message: string;
  /** Whether repeating the same call unchanged can succeed. */
  retryable: boolean;
}

/**
 * Anything that is not a known failure stays "Telemetry request failed." with
 * the code `internal`: an unexpected exception's message is not for the model.
 */
export function describeToolError(err: unknown): ToolErrorDetail {
  if (err instanceof CollectorError) {
    return { code: err.code, message: err.message, retryable: isRetryableToolError(err.code) };
  }
  if (err instanceof CollectorAccessError) {
    return { code: "no_project_access", message: err.message, retryable: false };
  }
  if (err instanceof InsufficientScopeError) {
    return { code: "insufficient_scope", message: err.message, retryable: false };
  }
  return { code: "internal", message: "Telemetry request failed.", retryable: false };
}

/**
 * Uniform failure result: clear text + isError, never a thrown exception. The
 * same message travels as `structuredContent.error` with its stable code, so a
 * client can branch on the code and show the text. `isError` results are
 * exempt from the tool's `outputSchema`, so the error shape is not in it.
 */
export function toolError(err: unknown): CallToolResult {
  const detail = describeToolError(err);
  const message = redactTelemetryText(detail.message);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code: detail.code, message, retryable: detail.retryable } },
    isError: true,
    // The challenge a client answers with step-up authorization (tool-scopes.ts).
    ...(err instanceof InsufficientScopeError
      ? { _meta: { [WWW_AUTHENTICATE_META_KEY]: [err.challenge] } }
      : {}),
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
