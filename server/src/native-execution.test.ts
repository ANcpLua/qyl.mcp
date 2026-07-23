import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  FileNativeExecutionRepository,
  hasNativeExecutionTelemetry,
  NativeExecutionRuntime,
  type NativeExecutionRecord,
  type NativeExecutionRepository,
  type NativeExecutionTelemetry,
} from "./native-execution.js";
import { SecretRedactor } from "./secret-redactor.js";
import { MAX_PERSISTED_RESULT_CHARACTERS } from "./execution-result.js";
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

test("native tools/call automatically persists validated, redacted, correlated evidence", async () => {
  const repository = new MemoryRepository();
  const starts: unknown[] = [];
  const completions: unknown[] = [];
  const secret = "NATIVE_EXECUTION_SECRET";
  let now = Date.parse("2026-07-17T12:00:00.000Z");
  const runtime = new NativeExecutionRuntime(repository, {
    telemetry: capturingTelemetry(starts, completions),
    redactor: new SecretRedactor({
      environment: { API_KEY: secret },
      maxStringLength: MAX_PERSISTED_RESULT_CHARACTERS + 1,
    }),
    now: () => now,
    id: () => "native-execution-1",
  });
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
  const client = new Client({ name: "native-evidence-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "fixture.evidence",
      arguments: { authorization: `Bearer ${secret}` },
      _meta: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), new RegExp(secret, "u"));

    assert.equal(repository.writes.length, 2);
    assert.equal(repository.writes[0]!.status, "running");
    const persisted = repository.final();
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.durationMs, 37);
    assert.equal(persisted.protocolEvents.length, 2);
    assert.equal(persisted.protocolEvents[0]!.messageKind, "request");
    assert.equal(persisted.protocolEvents[1]!.messageKind, "result");
    assert.deepEqual(persisted.telemetryCorrelation, {
      executionId: "native-execution-1",
      traceIds: [TRACE_ID],
      spanIds: [SPAN_ID],
    });
    assert.deepEqual(persisted.tokenUsage, {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      estimated: false,
    });
    assert.deepEqual(persisted.cost, {
      amountUsd: 0.025,
      estimated: false,
      source: "[REDACTED]",
    });
    const durableJson = JSON.stringify(persisted);
    assert.doesNotMatch(durableJson, new RegExp(secret, "u"));
    assert.match(durableJson, /\[REDACTED\]/u);

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
    assert.match(JSON.stringify(started.requestBody), /\[REDACTED\]/u);
    assert.equal(completions.length, 1);
    const completion = completions[0] as Record<string, unknown>;
    assert.equal(completion.endTimeMs, Date.parse("2026-07-17T12:00:00.037Z"));
    assert.equal(completion.jsonRpcRequestId, persisted.request.requestId);
    assert.doesNotMatch(JSON.stringify(completion), /NATIVE_EXECUTION_SECRET/u);
    assert.match(JSON.stringify(completion.responseBody), /\[REDACTED\]/u);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("native evidence records validation failure and bounds only the durable large result", async () => {
  const repository = new MemoryRepository();
  let sequence = 0;
  const runtime = new NativeExecutionRuntime(repository, {
    now: () => Date.parse("2026-07-17T13:00:00.000Z") + sequence++,
    id: () => `native-execution-${sequence}`,
  });
  const server = createServer({ nativeExecution: runtime, transport: "inproc" });
  assert.equal(hasNativeExecutionTelemetry(server), false);
  const completeText = "c".repeat(100_000);
  const largeText = "x".repeat(2_000_100);
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
  const client = new Client({ name: "native-validation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "fixture.complete", arguments: {} });
    const completeRecord = repository.final();
    assert.equal(completeRecord.status, "succeeded");
    const completeResult = CallToolResultSchema.parse(completeRecord.result);
    assert.equal(
      completeResult.content[0]?.type === "text"
        ? completeResult.content[0].text.length
        : 0,
      completeText.length,
    );
    assert.equal(
      (completeRecord.protocolEvents[1]?.payload as { truncated?: boolean }).truncated,
      true,
    );
    assert.equal(completeRecord.tokenUsage, undefined);
    assert.equal(completeRecord.cost, undefined);

    const large = CallToolResultSchema.parse(
      await client.callTool({ name: "fixture.large", arguments: {} }),
    );
    assert.equal(large.content[0]?.type, "text");
    assert.equal(large.content[0]?.type === "text" ? large.content[0].text.length : 0, largeText.length);
    const largeRecord = repository.final();
    assert.equal(largeRecord.status, "succeeded");
    assert.match(JSON.stringify(largeRecord.result), /qylOutputTruncated/u);
    assert.doesNotMatch(JSON.stringify(largeRecord.result), /x{1000}/u);

    await assert.rejects(
      client.callTool({ name: "fixture.invalid", arguments: {} }),
      /expected array|invalid_type/u,
    );
    const invalidRecord = repository.final();
    assert.equal(invalidRecord.status, "failed");
    assert.equal(invalidRecord.protocolEvents[1]?.messageKind, "error");
    assert.equal(invalidRecord.result, undefined);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
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
  const server = createServer({ nativeExecution: runtime, transport: "inproc" });
  server.registerTool(
    "fixture.persistence-failure",
    {},
    async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: "valid" }] }),
  );
  const client = new Client({ name: "native-persistence-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await assert.rejects(
      client.callTool({ name: "fixture.persistence-failure", arguments: {} }),
    );
    assert.equal(writes, 2);
    assert.equal(starts.length, 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.errorType, "evidence_persistence_failed");
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("file native repository uses atomic private persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qyl-native-evidence-"));
  const filePath = join(directory, "native.json");
  const repository = new FileNativeExecutionRepository({ filePath });
  const runtime = new NativeExecutionRuntime(repository, {
    now: () => Date.parse("2026-07-17T14:00:00.000Z"),
    id: () => "native-file-execution",
  });
  const server = createServer({ nativeExecution: runtime, transport: "streamable_http" });
  server.registerTool(
    "fixture.persist",
    {},
    async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: "persisted" }] }),
  );
  const client = new Client({ name: "native-file-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "fixture.persist", arguments: {} });
    const state = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      executions: NativeExecutionRecord[];
    };
    assert.equal(state.version, 1);
    assert.equal(state.executions.length, 1);
    assert.equal(state.executions[0]?.status, "succeeded");
    assert.equal(state.executions[0]?.request.transport, "streamable_http");
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
