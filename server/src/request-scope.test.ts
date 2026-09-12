import assert from "node:assert/strict";
import test from "node:test";
import { connectModernTestClient } from "./modern-test-client.test-helper.js";
import { createServer } from "./server.js";

interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
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

test("ci_log with a run_id reports two increasing progress steps to a client that asked", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await connectModernTestClient(
      { name: "request-scope-test", version: "1.0.0" },
      () => createServer({ nativeExecution: false }),
    );
    try {
      const updates: ProgressUpdate[] = [];
      const result = await connection.client.callTool(
        { name: "ci_log", arguments: { run_id: "sess-demo-pipeline-02" } },
        { onprogress: (update) => void updates.push(update) },
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(updates.map((update) => update.progress), [1, 2]);
      assert.deepEqual(updates.map((update) => update.total), [2, 2]);
      assert.match(updates[0]!.message ?? "", /^Fetched \d+ trace\(s\) of CI run sess-demo-pipeline-02$/u);
      assert.match(updates[1]!.message ?? "", /^Collected \d+ phase\(s\) across \d+ leg\(s\)$/u);
    } finally {
      await connection.close();
    }
  });
});

test("display_traces for a session reports progress; a single trace or the recent list does not", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await connectModernTestClient(
      { name: "request-scope-test", version: "1.0.0" },
      () => createServer({ nativeExecution: false }),
    );
    try {
      const forSession: ProgressUpdate[] = [];
      const session = await connection.client.callTool(
        { name: "display_traces", arguments: { session_id: "sess-demo-checkout-03" } },
        { onprogress: (update) => void forSession.push(update) },
      );
      assert.equal(session.isError, undefined);
      assert.deepEqual(forSession.map((update) => update.progress), [1, 2]);
      assert.match(forSession[0]!.message ?? "", /of session sess-demo-checkout-03$/u);
      assert.equal(forSession[1]!.message, "Explorer payload ready");

      const forRecent: ProgressUpdate[] = [];
      const recent = await connection.client.callTool(
        { name: "display_traces", arguments: { limit: 3 } },
        { onprogress: (update) => void forRecent.push(update) },
      );
      assert.equal(recent.isError, undefined);
      assert.deepEqual(forRecent, []);
    } finally {
      await connection.close();
    }
  });
});

test("a client that did not ask for progress receives no progress notification", async () => {
  await withEnv({ QYL_DEMO: "1" }, async () => {
    const connection = await connectModernTestClient(
      { name: "request-scope-test", version: "1.0.0" },
      () => createServer({ nativeExecution: false }),
    );
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

    const connection = await connectModernTestClient(
      { name: "request-scope-test", version: "1.0.0" },
      () => createServer({ nativeExecution: false }),
    );
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
