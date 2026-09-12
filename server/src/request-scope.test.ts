import assert from "node:assert/strict";
import test from "node:test";
import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/client";
import { connectModernTestClient, type ModernTestClient } from "./modern-test-client.test-helper.js";
import { LOGGER } from "./request-scope.js";
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

function demoConnection(): Promise<ModernTestClient> {
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

test("ci_log with a run_id reports its two steps and the final one to a client that asked", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await demoConnection();
    try {
      const updates: ProgressUpdate[] = [];
      const result = await connection.client.callTool(
        { name: "ci_log", arguments: { run_id: "sess-demo-pipeline-02" } },
        { onprogress: (update) => void updates.push(update) },
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(updates.map((update) => update.progress), [1, 2, 3]);
      assert.deepEqual(updates.map((update) => update.total), [3, 3, 3]);
      assert.match(updates[0]!.message ?? "", /^Fetched \d+ trace\(s\) of CI run sess-demo-pipeline-02$/u);
      assert.match(updates[1]!.message ?? "", /^Collected \d+ phase\(s\) across \d+ leg\(s\)$/u);
      assert.equal(updates[2]!.message, "Result ready");
    } finally {
      await connection.close();
    }
  });
});

test("every one-round-trip tool reports the round trip and the final step", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await demoConnection();
    try {
      const calls: Array<{ name: string; arguments: Record<string, unknown>; first: RegExp }> = [
        { name: "list_traces", arguments: { limit: 3 }, first: /^Fetched \d+ trace\(s\)$/u },
        { name: "list_sessions", arguments: {}, first: /^Fetched \d+ session\(s\)$/u },
        { name: "search_logs", arguments: { limit: 5 }, first: /^Fetched \d+ log record\(s\)$/u },
        { name: "ci_log", arguments: {}, first: /^Found \d+ CI run\(s\) among \d+ session\(s\)$/u },
        { name: "list_metrics", arguments: {}, first: /^Fetched \d+ metric instrument\(s\)$/u },
        { name: "display_mcp_dashboard", arguments: { hours: 1 }, first: /^Aggregated \d+ MCP request\(s\) over 1h$/u },
        {
          name: "display_traces",
          arguments: { session_id: "sess-demo-checkout-03" },
          first: /^Fetched \d+ trace\(s\) for session sess-demo-checkout-03$/u,
        },
        { name: "display_traces", arguments: { limit: 2 }, first: /^Fetched 2 trace\(s\) for recent traces$/u },
        { name: "fetch_telemetry", arguments: { view: "traces", limit: 2 }, first: /^Fetched 2 trace\(s\)$/u },
      ];
      for (const call of calls) {
        const updates: ProgressUpdate[] = [];
        const result = await connection.client.callTool(
          { name: call.name, arguments: call.arguments },
          { onprogress: (update) => void updates.push(update) },
        );
        assert.equal(result.isError, undefined, call.name);
        assert.deepEqual(updates.map((update) => update.progress), [1, 2], call.name);
        assert.deepEqual(updates.map((update) => update.total), [2, 2], call.name);
        assert.match(updates[0]!.message ?? "", call.first, call.name);
        assert.equal(updates[1]!.message, "Result ready", call.name);
      }
    } finally {
      await connection.close();
    }
  });
});

test("a client that did not ask for progress receives no progress notification", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await demoConnection();
    try {
      let stray = 0;
      connection.client.setNotificationHandler("notifications/progress", () => {
        stray += 1;
      });
      const result = await connection.client.callTool({
        name: "ci_log",
        arguments: { run_id: "sess-demo-pipeline-02" },
      });
      assert.equal(result.isError, undefined);
      assert.equal(stray, 0);
    } finally {
      await connection.close();
    }
  });
});

test("a request that carries a log level gets one line per call: info on success, warning on failure", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await demoConnection();
    try {
      const lines = collectLogs(connection);
      // On revision 2026-07-28 the client's level travels per request in the
      // `_meta` envelope; there is no `logging/setLevel` session state.
      const info = { [LOG_LEVEL_META_KEY]: "info" };

      const ok = await connection.client.callTool({
        name: "list_traces",
        arguments: { limit: 2 },
        _meta: info,
      });
      assert.equal(ok.isError, undefined);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.level, "info");
      assert.equal(lines[0]!.logger, LOGGER);
      assert.deepEqual(Object.keys(lines[0]!.data as object).sort(), ["summary", "tool"]);
      assert.equal((lines[0]!.data as { tool: string }).tool, "list_traces");

      const failed = await connection.client.callTool({
        name: "get_trace",
        arguments: { trace_id: "0123456789abcdef0123456789abcdef" },
        _meta: info,
      });
      assert.equal(failed.isError, true);
      assert.equal(lines.length, 2);
      assert.equal(lines[1]!.level, "warning");
      assert.deepEqual(lines[1]!.data, {
        tool: "get_trace",
        summary: "trace not found: 0123456789abcdef0123456789abcdef",
      });
    } finally {
      await connection.close();
    }
  });
});

test("the request's log level is the threshold; a request without one gets no log line", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await demoConnection();
    try {
      const lines = collectLogs(connection);
      const warning = { [LOG_LEVEL_META_KEY]: "warning" };

      const ok = await connection.client.callTool({
        name: "list_sessions",
        arguments: {},
        _meta: warning,
      });
      assert.equal(ok.isError, undefined);
      assert.equal(lines.length, 0);

      const failed = await connection.client.callTool({
        name: "display_traces",
        arguments: { session_id: "no-such-session" },
        _meta: warning,
      });
      assert.equal(failed.isError, true);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.level, "warning");

      const silent = await connection.client.callTool({
        name: "display_traces",
        arguments: { session_id: "no-such-session" },
      });
      assert.equal(silent.isError, true);
      assert.equal(lines.length, 1);
    } finally {
      await connection.close();
    }
  });
});

test("cancelling a tool call aborts the in-flight collector fetch", async () => {
  await withEnv({ QYL_DEMO: undefined, QYL_COLLECTOR_URL: "http://qyl-collector.invalid" }, async () => {
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

    const connection = await demoConnection();
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
