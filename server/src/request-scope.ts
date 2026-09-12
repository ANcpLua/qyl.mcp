/**
 * The request-scoped helpers every tool handler runs inside.
 *
 * The SDK hands each handler a `ServerContext` whose `mcpReq` carries the
 * cancellation signal, the request's `_meta`, a `notify` bound to this request
 * and `log` for `notifications/message`. `runTool` resolves all of that once and
 * hands the work a plain `ToolScope`: the data layer (`data.ts`, `metrics.ts`)
 * takes `CollectorRequestOptions` with an `AbortSignal`, never the SDK context.
 *
 * Three channels, one frame:
 *   - cancellation: `scope.collector.signal` is `ctx.mcpReq.signal`, aborted on
 *     `notifications/cancelled` for this request and when the connection
 *     closes; `collectorRequest` races it against its own timeout.
 *   - progress: `scope.step(message)` sends `notifications/progress` when the
 *     request carried a `progressToken`, and nothing when it did not. The
 *     reporter counts its own steps, so `progress` increases per token by
 *     construction; `runTool` reports the final step itself once the result is
 *     built, so a handler declares only the steps it reports.
 *   - logging: one `info` per finished call and one `warning` per failed one,
 *     through `ctx.mcpReq.log`, which honours the client's `logging/setLevel`
 *     (per request on revision 2026-07-28). MCP logging is deprecated as of
 *     that revision (SEP-2577) and stays functional through the deprecation
 *     window; qyl.mcp keeps it beside stderr and OpenTelemetry at the owner's
 *     call — see the workspace DECISIONS.md entry of 2026-09-12.
 */
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { CollectorError, type CollectorRequestOptions } from "./collector.js";
import { redactTelemetryText } from "./telemetry-redaction.js";

/** The logger name every `notifications/message` from this server carries. */
export const LOGGER = "qyl.mcp";

/** Longest summary line a log notification carries; results can be tables. */
const LOG_SUMMARY_CHARS = 200;

/** What a tool's work receives: collector options and a progress step. */
export interface ToolScope {
  /** Collector options carrying this request's cancellation signal. */
  collector: CollectorRequestOptions;
  /** Report one more completed step; the message says what just finished. */
  step(message: string): Promise<void>;
}

/** Uniform failure result: clear text + isError, never a thrown exception. */
export function toolError(err: unknown): CallToolResult {
  const message = err instanceof CollectorError
    ? err.message
    : "Telemetry request failed.";
  return {
    content: [{ type: "text", text: redactTelemetryText(message) }],
    isError: true,
  };
}

/** The first line of a result's first text block, bounded; already redacted. */
function summaryOf(result: CallToolResult): string {
  const first = result.content.find((block) => block.type === "text");
  const line = first?.type === "text" ? first.text.split("\n", 1)[0] ?? "" : "";
  return line.length > LOG_SUMMARY_CHARS ? `${line.slice(0, LOG_SUMMARY_CHARS - 1)}…` : line;
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
  tool: string,
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
  const log = async (level: "info" | "warning", data: Record<string, unknown>): Promise<void> => {
    if (signal.aborted) return;
    await ctx.mcpReq.log(level, { tool, ...data }, LOGGER);
  };

  try {
    const result = await work({ collector: { signal }, step });
    await step("Result ready");
    await log(result.isError ? "warning" : "info", { summary: summaryOf(result) });
    return result;
  } catch (err) {
    const result = toolError(err);
    await log("warning", { summary: summaryOf(result) });
    return result;
  }
}
