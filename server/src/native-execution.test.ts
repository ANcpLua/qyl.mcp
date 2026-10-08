import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  assertNativeExecutionRecordingArmed,
  FileNativeExecutionRepository,
  hasNativeExecutionTelemetry,
  installNativeExecutionRecording,
  NativeExecutionRuntime,
  type NativeExecutionRecord,
  type NativeExecutionRepository,
  type NativeExecutionTelemetry,
} from "./native-execution.js";
import { SecretRedactor } from "./secret-redactor.js";
import { connectModernTestClient } from "./modern-test-client.test-helper.js";
import { createServer } from "./server.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";

class MemoryRepository implements NativeExecutionRepository {
  readonly writes: NativeExecutionRecord[] = [];

  save(record: NativeExecutionRecord): Promise<void> {
    this.writes.push(structuredClone(record));
    return Promise.resolve();
  }

  final(): NativeExecutionRecord {
    const record = this.writes.at(-1);
    assert(record);
    return record;
  }
}

function capturingTelemetry(
  starts: unknown[],
  completions: unknown[],
): NativeExecutionTelemetry {
  return {
    startOperation(input) {
      starts.push(structuredClone(input));
      return {
        correlation: { traceId: TRACE_ID, spanId: SPAN_ID },
        run: (operation) => operation(),
        end: (completion) => {
          completions.push(structuredClone(completion));
          return { traceId: TRACE_ID, spanId: SPAN_ID };
        },
      };
    },
  };
}

test("native tools/call records operation metadata and keeps payloads out of telemetry", async () => {
  const repository = new MemoryRepository();
  const starts: unknown[] = [];
  const completions: unknown[] = [];
  const secret = "NATIVE_EXECUTION_SECRET";
  let now = Date.parse("2026-07-17T12:00:00.000Z");
  const runtime = new NativeExecutionRuntime(repository, {
    telemetry: capturingTelemetry(starts, completions),
    redactor: new SecretRedactor({
      environment: { API_KEY: secret },
    }),
    now: () => now,
    id: () => "native-execution-1",
  });
  const connection = await connectModernTestClient(
    { name: "native-evidence-test", version: "1.0.0" },
    () => {
      const server = createServer({ nativeExecution: runtime, transport: "stdio" });
      assert.equal(hasNativeExecutionTelemetry(server), true);
      server.registerTool(
        "fixture.evidence",
        { inputSchema: z.object({ authorization: z.string() }) },
        async (): Promise<CallToolResult> => {
          now += 37;
          return {
            content: [{ type: "text", text: `result token=${secret}` }],
            structuredContent: {
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 14,
              },
              cost_usd: {
                amount_usd: 0.025,
                source: secret,
              },
            },
          };
        },
      );
      return server;
    },
  );

  try {
    const result = await connection.client.callTool({
      name: "fixture.evidence",
      arguments: { authorization: `Bearer ${secret}` },
      _meta: {
        traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
        conversation: "ordinary private conversation",
        baggage: "private=ordinary-private-value",
      },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), new RegExp(secret, "u"));

    assert.equal(repository.writes.length, 2);
    assert.equal(repository.writes[0]!.status, "running");
    const persisted = repository.final();
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.durationMs, 37);
    assert.deepEqual(persisted, {
      id: "native-execution-1",
      toolName: "fixture.evidence",
      status: "succeeded",
      createdAt: "2026-07-17T12:00:00.000Z",
      startedAt: "2026-07-17T12:00:00.000Z",
      completedAt: "2026-07-17T12:00:00.037Z",
      durationMs: 37,
    });
    const durableJson = JSON.stringify(persisted);
    assert.doesNotMatch(durableJson, new RegExp(secret, "u"));
    assert.doesNotMatch(durableJson, /arguments|_meta|ordinary private|ordinary-private/u);

    assert.equal(starts.length, 1);
    const started = starts[0] as Record<string, unknown>;
    assert.equal(started.role, "server");
    assert.equal(started.method, "tools/call");
    assert.equal(started.serverId, "qyl.mcp/native");
    assert.equal(started.toolName, "fixture.evidence");
    assert.equal(started.transport, "stdio");
    assert.equal(started.jsonRpcProtocolVersion, "2.0");
    assert.equal(started.executionId, "native-execution-1");
    assert.deepEqual(started.remotePropagation, {
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    });
    assert.equal(started.startTimeMs, Date.parse("2026-07-17T12:00:00.000Z"));
    assert.doesNotMatch(JSON.stringify(started), /NATIVE_EXECUTION_SECRET/u);
    assert.equal(started.requestBody, undefined);
    assert.doesNotMatch(JSON.stringify(started), /ordinary private|ordinary-private/u);
    assert.equal(completions.length, 1);
    const completion = completions[0] as Record<string, unknown>;
    assert.equal(completion.endTimeMs, Date.parse("2026-07-17T12:00:00.037Z"));
    assert.equal(completion.jsonRpcRequestId, undefined);
    assert.doesNotMatch(JSON.stringify(completion), /NATIVE_EXECUTION_SECRET/u);
    assert.equal(completion.responseBody, undefined);
  } finally {
    await connection.close();
  }
});

test("native evidence records validation failure without persisting results of any size", async () => {
  const repository = new MemoryRepository();
  let sequence = 0;
  const runtime = new NativeExecutionRuntime(repository, {
    now: () => Date.parse("2026-07-17T13:00:00.000Z") + sequence++,
    id: () => `native-execution-${sequence}`,
  });
  const completeText = "c".repeat(100_000);
  const largeText = "x".repeat(2_000_100);
  const connection = await connectModernTestClient(
    { name: "native-validation-test", version: "1.0.0" },
    () => {
      const server = createServer({ nativeExecution: runtime, transport: "inproc" });
      assert.equal(hasNativeExecutionTelemetry(server), false);
      server.registerTool(
        "fixture.complete",
        {},
        async (): Promise<CallToolResult> => ({
          content: [{ type: "text", text: completeText }],
        }),
      );
      server.registerTool(
        "fixture.large",
        {},
        async (): Promise<CallToolResult> => ({
          content: [{ type: "text", text: largeText }],
        }),
      );
      server.registerTool(
        "fixture.invalid",
        {},
        async () => ({ content: "not-an-array" }) as unknown as CallToolResult,
      );
      return server;
    },
  );

  try {
    const completeResult = CallToolResultSchema.parse(
      await connection.client.callTool({ name: "fixture.complete", arguments: {} }),
    );
    const completeRecord = repository.final();
    assert.equal(completeRecord.status, "succeeded");
    assert.equal(
      completeResult.content[0]?.type === "text"
        ? completeResult.content[0].text.length
        : 0,
      completeText.length,
    );
    assert.equal("result" in completeRecord, false);
    assert.equal("protocolEvents" in completeRecord, false);

    const large = CallToolResultSchema.parse(
      await connection.client.callTool({ name: "fixture.large", arguments: {} }),
    );
    assert.equal(large.content[0]?.type, "text");
    assert.equal(large.content[0]?.type === "text" ? large.content[0].text.length : 0, largeText.length);
    const largeRecord = repository.final();
    assert.equal(largeRecord.status, "succeeded");
    assert.equal("result" in largeRecord, false);
    assert.doesNotMatch(JSON.stringify(largeRecord), /x{1000}/u);

    await assert.rejects(
      connection.client.callTool({ name: "fixture.invalid", arguments: {} }),
      /expected array|invalid_type/u,
    );
    const invalidRecord = repository.final();
    assert.equal(invalidRecord.status, "failed");
    assert.equal(invalidRecord.errorType, "ZodError");
    assert.equal("result" in invalidRecord, false);
  } finally {
    await connection.close();
  }
});

test("native telemetry reports terminal evidence persistence failures", async () => {
  let writes = 0;
  const repository: NativeExecutionRepository = {
    save() {
      writes += 1;
      return writes === 2
        ? Promise.reject(new Error("injected native persistence failure"))
        : Promise.resolve();
    },
  };
  const starts: unknown[] = [];
  const completions: Array<{ errorType?: string }> = [];
  const runtime = new NativeExecutionRuntime(repository, {
    telemetry: capturingTelemetry(starts, completions),
    now: () => Date.parse("2026-07-17T13:30:00.000Z"),
    id: () => "native-persistence-failure",
  });
  const connection = await connectModernTestClient(
    { name: "native-persistence-test", version: "1.0.0" },
    () => {
      const server = createServer({ nativeExecution: runtime, transport: "inproc" });
      server.registerTool(
        "fixture.persistence-failure",
        {},
        async (): Promise<CallToolResult> => ({
          content: [{ type: "text", text: "valid" }],
        }),
      );
      return server;
    },
  );

  try {
    // The subject here is the telemetry below. The call itself comes back as an
    // isError result rather than rejecting: tools/call has no protocol-error
    // channel (errors.md), so a persistence fault has to be reported in-band.
    const result = await connection.client.callTool({
      name: "fixture.persistence-failure",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(writes, 2);
    assert.equal(starts.length, 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.errorType, "evidence_persistence_failed");
  } finally {
    await connection.close();
  }
});

test("file native repository persists only operation metadata for successful and failed calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qyl-native-evidence-"));
  const filePath = join(directory, "native.json");
  const repository = new FileNativeExecutionRepository({ filePath });
  let sequence = 0;
  const runtime = new NativeExecutionRuntime(repository, {
    now: () => Date.parse("2026-07-17T14:00:00.000Z"),
    id: () => `native-file-execution-${sequence++}`,
  });
  const connection = await connectModernTestClient(
    { name: "native-file-test", version: "1.0.0" },
    () => {
      const server = createServer({
        nativeExecution: runtime,
        transport: "streamable_http",
      });
      server.registerTool(
        "fixture.persist",
        { inputSchema: z.object({ text: z.string(), fail: z.boolean() }) },
        async ({ text, fail }): Promise<CallToolResult> => ({
          content: [{ type: "text", text }],
          structuredContent: { echo: text },
          _meta: { conversation: text },
          isError: fail,
        }),
      );
      return server;
    },
  );

  try {
    for (const fail of [false, true]) {
      const text = "private ordinary text that no secret redactor recognizes";
      const result = await connection.client.callTool({
        name: "fixture.persist",
        arguments: { text, fail },
        _meta: { conversation: text },
      });
      assert.equal(result.isError, fail);
      assert.equal((result.structuredContent as { echo: string }).echo, text);
    }
    const source = await readFile(filePath, "utf8");
    const state = JSON.parse(source) as {
      version: number;
      executions: NativeExecutionRecord[];
    };
    assert.equal(state.version, 3);
    assert.equal(state.executions.length, 2);
    assert.equal(state.executions[0]?.status, "succeeded");
    assert.equal(state.executions[0]?.toolName, "fixture.persist");
    assert.equal(state.executions[1]?.errorType, "tool_result_error");
    assert.doesNotMatch(source, /private ordinary|arguments|_meta|conversation|structuredContent|protocolEvents/u);
    assert.deepEqual(await new FileNativeExecutionRepository({ filePath }).list(), state.executions);
    await assert.rejects(repository.save({
      ...state.executions[0]!,
      arguments: { text: "must not write" },
      _meta: { conversation: "must not write" },
    } as NativeExecutionRecord), /unrecognized_keys/u);
    assert.equal(await readFile(filePath, "utf8"), source);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recording that never wrapped a tools/call dispatcher fails loudly", () => {
  // McpServer registers the tools/call dispatcher in its constructor as soon as
  // capabilities.tools is declared there, which is before recording can wrap it.
  // Without the guard the tools answer normally and record nothing at all.
  const server = new McpServer(
    { name: "guard-fixture", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  installNativeExecutionRecording(
    server,
    new NativeExecutionRuntime(new MemoryRepository(), { redactor: new SecretRedactor() }),
    "builtin",
  );
  server.registerTool(
    "fixture.unrecorded",
    {},
    async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: "unrecorded" }] }),
  );

  assert.throws(
    () => assertNativeExecutionRecordingArmed(server),
    /never wrapped a tools\/call dispatcher/u,
  );
});

test("the shipped server arms recording", () => {
  assert.doesNotThrow(() => createServer({ transport: "builtin" }));
});

test("a recording fault answers tools/call through its only failure channel", async () => {
  // errors.md: a tools/call handler produces tool errors, never protocol errors.
  // The recording wrapper is a raw tools/call handler, so a fault inside it has
  // nothing below to convert it — before this it left as -32603.
  const failing: NativeExecutionRepository = {
    save() {
      return Promise.reject(new Error("evidence store is unavailable"));
    },
  };
  const connection = await connectModernTestClient(
    { name: "recording-fault-test", version: "1.0.0" },
    () =>
      createServer({
        transport: "streamable_http",
        nativeExecution: new NativeExecutionRuntime(failing, { redactor: new SecretRedactor() }),
      }),
  );

  try {
    const result = await connection.client.callTool({ name: "list_traces", arguments: {} });
    assert.equal(result.isError, true);
    const text = String((result.content as { text?: string }[])[0]?.text);
    assert.match(text, /could not record its execution evidence/u);
    assert.doesNotMatch(text, /evidence store is unavailable/u, "the detail belongs on stderr, not on the wire");
  } finally {
    await connection.close();
  }
});

for (const version of [1, 2]) {
  test(`version-${version} state loses payloads before it is read or written again`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-native-migrate-"));
    const filePath = join(directory, "state.json");
    const createdAt = "2026-10-08T00:00:00.000Z";
    const sensitive = "ordinary conversation that must not survive migration";
    const legacy = {
      id: "old-execution", serverId: "qyl.mcp/native", status: "succeeded",
      createdAt, startedAt: createdAt, completedAt: createdAt, durationMs: 0,
      attemptCount: 1,
      request: { requestId: sensitive, toolName: "list_traces", transport: "stdio",
        arguments: { query: sensitive }, meta: { conversation: sensitive } },
      result: { content: [{ type: "text", text: sensitive }], _meta: { conversation: sensitive } },
      error: { code: "tool_result_error", message: sensitive },
      tokenUsage: { input_tokens: 1 }, cost: { source: sensitive },
      protocolEvents: [{ payload: { arguments: sensitive, _meta: sensitive } }],
    };
    await writeFile(filePath, JSON.stringify({ version, executions: [
      legacy,
      { ...legacy, id: "interrupted-execution", status: "running" },
    ] }));
    try {
      const repository = new FileNativeExecutionRepository({
        filePath, now: () => Date.parse(createdAt) + 1_000,
      });
      const records = await repository.list();
      assert.equal(records.length, 2);
      assert.equal(records[0]?.toolName, "list_traces");
      assert.equal(records[0]?.errorType, "tool_result_error");
      assert.equal(records[1]?.errorType, "process_interrupted");
      assert.equal(records[1]?.durationMs, 1_000);
      const source = await readFile(filePath, "utf8");
      assert.doesNotMatch(source, /ordinary conversation|arguments|_meta|protocolEvents|requestId/u);
      assert.deepEqual(JSON.parse(source), { version: 3, executions: records });
      assert.deepEqual(await readdir(directory), ["state.json"], "no payload-bearing migration backup");
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a state file this build cannot read is archived, not fatal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qyl-native-archive-"));
  const filePath = join(directory, "state.json");
  await writeFile(filePath, JSON.stringify({ version: 999, executions: [] }), "utf8");

  try {
    const repository = new FileNativeExecutionRepository({
      filePath,
      now: () => Date.parse("2026-08-20T00:00:00.000Z"),
    });
    assert.deepEqual(await repository.list(), [], "the repository serves a fresh log");

    const archived = (await readdir(directory)).filter((entry) => entry.includes("unreadable"));
    assert.equal(archived.length, 1, `expected one archived file, got ${archived.join(", ")}`);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, archived[0]!), "utf8")),
      { version: 999, executions: [] },
      "the old records are preserved byte for byte",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
