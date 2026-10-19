import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/client";
import { connectModernTestClient, type ModernTestClient } from "./modern-test-client.test-helper.js";
import { getTelemetryFixture } from "./telemetry-fixtures.test-helper.js";
import { readContext, toolSummary, toolTrace } from "./analysis-context.test-helper.js";
import { createServer } from "./server.js";

interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

interface LogLine {
  level: string;
  logger?: string;
  data: unknown;
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixtureConnection(): Promise<ModernTestClient> {
  return connectModernTestClient(
    { name: "request-scope-test", version: "1.0.0" },
    () => createServer({ nativeExecution: false }),
  );
}

function collectLogs(connection: ModernTestClient): LogLine[] {
  const lines: LogLine[] = [];
  connection.client.setNotificationHandler("notifications/message", (notification) => {
    const { level, logger, data } = notification.params;
    lines.push({ level, data, ...(logger === undefined ? {} : { logger }) });
  });
  return lines;
}

/** Transport tests use fixed typed responses; query semantics run through real OTLP in verify-answer-key. */
async function collectorConnection(context: TestContext, reply: (operation: string, args: Record<string, unknown>) => Response = responseFor): Promise<ModernTestClient> {
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.method, "POST");
    return reply(new URL(request.url).pathname.split("/").at(-1)!, await request.json() as Record<string, unknown>);
  });
  const connection = await fixtureConnection();
  context.after(() => connection.close());
  return connection;
}
function responseFor(operation: string, args: Record<string, unknown>): Response {
  const context = readContext(1);
  switch (operation) {
    case "list_traces": return Response.json({ ...context, mode: "live", has_more: false, traces: [toolSummary(getTelemetryFixture().traces[0]!)] });
    case "get_trace": return Response.json({ ...context, mode: "live", trace: toolTrace(getTelemetryFixture().traces[0]!) });
    case "list_sessions": return Response.json({ ...context, mode: "live", has_more: false, sessions: [getTelemetryFixture().sessions[0]] });
    case "search_logs": return Response.json({ ...context, mode: "live", has_more: false, logs: [getTelemetryFixture().logs[0]] });
    case "ci_log": return Response.json({ ...context, mode: "live", has_more: false, ...(args.run_id ? { run_id: args.run_id, phases: [] } : { runs: [] }) });
    case "list_metrics": return Response.json({ ...context, has_more: false, items: [] });
    default: throw new Error(`Unexpected operation ${operation}`);
  }
}

test("ci_log reports its collector query and final step to a client that asked", async (context) => {
  const connection = await collectorConnection(context);
  const updates: ProgressUpdate[] = [];
  const result = await connection.client.callTool({ name: "ci_log", arguments: { run_id: "fixture-run" } }, { onprogress: update => void updates.push(update) });
  assert.equal(result.isError, undefined);
  assert.deepEqual(updates, [
    { progress: 1, total: 2, message: "Queried ci_log" },
    { progress: 2, total: 2, message: "Result ready" },
  ]);
});

test("every one-round-trip tool reports the query and final step", async (context) => {
  const connection = await collectorConnection(context);
  for (const name of ["list_traces", "search_logs", "ci_log", "list_metrics"]) {
    const updates: ProgressUpdate[] = [];
    const result = await connection.client.callTool({ name, arguments: {} }, { onprogress: update => void updates.push(update) });
    assert.equal(result.isError, undefined, name);
    assert.deepEqual(updates.map(update => update.progress), [1, 2], name);
    assert.deepEqual(updates.map(update => update.total), [2, 2], name);
    assert.equal(updates[0]!.message, `Queried ${name}`);
    assert.equal(updates[1]!.message, "Result ready");
  }
});

test("get_trace and list_sessions include annotation read-back in the single collector query", async (context) => {
  const connection = await collectorConnection(context);
  for (const name of ["get_trace", "list_sessions"]) {
    const updates: ProgressUpdate[] = [];
    const result = await connection.client.callTool({ name, arguments: name === "get_trace" ? { trace_id: getTelemetryFixture().traces[0]!.trace_id } : {} }, { onprogress: update => void updates.push(update) });
    assert.equal(result.isError, undefined);
    assert.deepEqual(updates.map(update => update.progress), [1, 2]);
    assert.equal(updates[0]!.message, `Queried ${name}`);
  }
});

test("failed calls preserve stable codes, field errors and retryability", async (context) => {
  const connection = await collectorConnection(context, operation => operation === "get_trace"
    ? Response.json({ type: "https://qyl.at/problems/not-found", title: "Not Found", code: "not_found", status: 404, detail: "trace not found" }, { status: 404, headers: { "content-type": "application/problem+json" } })
    : Response.json({ type: "https://qyl.at/problems/validation-failed", title: "Validation Failed", code: "validation_failed", status: 400, detail: "invalid window", errors: [{ field: "end_time", message: "must be after start_time", code: "invalid.window" }] }, { status: 400, headers: { "content-type": "application/problem+json" } }));
  const missing = await connection.client.callTool({ name: "get_trace", arguments: { trace_id: "abcdef0123456789abcdef0123456789" } });
  assert.equal(missing.isError, true);
  assert.equal(((missing.structuredContent as Record<string, unknown>).error as { code: string }).code, "not_found");
  assert.equal(((missing.structuredContent as Record<string, unknown>).error as { retryable: boolean }).retryable, false);
  const invalid = await connection.client.callTool({ name: "query_metric", arguments: { metric_name: "http.server.request.duration", start_time: "2026-10-11T01:00:00Z", end_time: "2026-10-11T00:00:00Z" } });
  assert.equal(invalid.isError, true);
  const error = (invalid.structuredContent as Record<string, unknown> | undefined)?.error as { retryable: boolean; fields: unknown[] };
  assert.equal(error.retryable, false);
  assert.deepEqual(error.fields, [{ field: "end_time", message: "must be after start_time", code: "invalid.window" }]);
});

test("list tools forward opaque cursors unchanged across the MCP boundary", async (context) => {
  const calls: Record<string, unknown>[] = [];
  const connection = await collectorConnection(context, (operation, args) => {
    assert.equal(operation, "list_traces"); calls.push(args);
    const second = args.cursor !== undefined;
    return Response.json({ ...readContext(1), mode: "live", traces: [toolSummary(getTelemetryFixture().traces[second ? 1 : 0]!)], has_more: !second, ...(second ? {} : { next_cursor: "opaque.signed.cursor" }) });
  });
  const first = await connection.client.callTool({ name: "list_traces", arguments: { limit: 1, errors_only: true } });
  assert.equal(first.isError, undefined);
  assert.equal((first.structuredContent as Record<string, unknown> | undefined)?.has_more, true);
  const second = await connection.client.callTool({ name: "list_traces", arguments: { limit: 1, errors_only: true, cursor: (first.structuredContent as Record<string, unknown> | undefined)?.next_cursor } });
  assert.equal(second.isError, undefined);
  assert.equal((second.structuredContent as Record<string, unknown> | undefined)?.has_more, false);
  assert.deepEqual(calls[1], { limit: 1, errors_only: true, cursor: "opaque.signed.cursor" });
  assert.notDeepEqual((first.structuredContent as Record<string, unknown> | undefined)?.traces, (second.structuredContent as Record<string, unknown> | undefined)?.traces);
});

test("a client that did not ask receives no progress notification", async (context) => {
  const connection = await collectorConnection(context);
  let stray = 0; connection.client.setNotificationHandler("notifications/progress", () => { stray += 1; });
  const result = await connection.client.callTool({ name: "ci_log", arguments: {} });
  assert.equal(result.isError, undefined); assert.equal(stray, 0);
});

test("modern tool calls emit no logging notifications even when a log level is requested", async (context) => {
  const connection = await collectorConnection(context, (operation, args) => operation === "get_trace"
    ? Response.json({ title: "Not Found", code: "not_found", status: 404, detail: "trace not found" }, { status: 404, headers: { "content-type": "application/problem+json" } }) : responseFor(operation, args));
  assert.equal(connection.client.getServerCapabilities()?.logging, undefined);
  const lines = collectLogs(connection);
  for (const level of ["info", "warning", undefined]) {
    const meta = level === undefined ? {} : { [LOG_LEVEL_META_KEY]: level };
    assert.equal((await connection.client.callTool({ name: "list_traces", arguments: { limit: 2 }, _meta: meta })).isError, undefined);
    assert.equal((await connection.client.callTool({ name: "get_trace", arguments: { trace_id: "0123456789abcdef0123456789abcdef" }, _meta: meta })).isError, true);
    assert.deepEqual(lines, []);
  }
});

test("cancelling a tool call aborts the in-flight collector fetch", async () => {
  await withEnv({ QYL_COLLECTOR_URL: "http://qyl-collector.invalid" }, async () => {
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    // A collector that never answers: the only way this fetch settles is
    // through the signal the server passed in.
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, "collector fetch carries no AbortSignal");
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;

    const connection = await fixtureConnection();
    try {
      const controller = new AbortController();
      const call = connection.client.callTool(
        { name: "list_traces", arguments: {} },
        { signal: controller.signal },
      );
      await until(() => signals.length === 1, "the collector fetch to start");
      assert.equal(signals[0]!.aborted, false);

      controller.abort("the end user clicked Stop");
      await assert.rejects(call);
      await until(() => signals[0]!.aborted, "the collector fetch to be aborted");
    } finally {
      globalThis.fetch = originalFetch;
      await connection.close();
    }
  });
});


test("oversized pages requery with a smaller limit and retain collector coverage", async (context) => {
  const requests: Record<string, unknown>[] = [];
  const log = { ...getTelemetryFixture().logs[0]!, body: "x".repeat(6_000) };
  const logs = Array.from({ length: 8 }, () => log);
  const connection = await collectorConnection(context, (_operation, args) => {
    requests.push(args);
    const page = logs.slice(0, Number(args.limit ?? logs.length));
    const metadata = readContext(8);
    return Response.json({ ...metadata, mode: "live", logs: page,
      coverage: { ...metadata.coverage, returned: page.length, truncated: page.length < 8 } });
  });
  const result = await connection.client.callTool({ name: "search_logs", arguments: {} });
  assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 500));
  assert.equal(requests.length, 2);
  assert(Number(requests[1]!.limit) < 8);
  assert.equal(requests[1]!.start_time, readContext().window.start_time);
  assert.equal(requests[1]!.end_time, readContext().window.end_time);
  const output = result.structuredContent as { coverage: { examined: number; returned: number; truncated: boolean }; logs: unknown[] };
  assert.equal(output.coverage.examined, 8);
  assert.equal(output.coverage.returned, output.logs.length);
  assert.equal(output.coverage.truncated, true);
  assert(Buffer.byteLength(JSON.stringify(result), "utf8") <= 24_000);
});
