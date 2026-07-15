import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionSnapshot } from "./connection-manager.js";
import {
    ExecutionConflictError,
    ExecutionService,
    ExecutionValidationError,
    type ExecutionConnectionPort,
    type ExecutionRecord,
} from "./execution-service.js";
import { ProtocolJournal } from "./protocol-journal.js";
import { SecretRedactor } from "./secret-redactor.js";
import {
    currentMcpTraceparent,
    McpTelemetry,
    type ActiveMcpOperation,
    type McpOperationInput,
    type McpOperationStartInput,
} from "./telemetry.js";
import type { PersistedExecution } from "./workbench-repository.js";

const safeTool: Tool = {
    name: "echo",
    description: "Echo structured input.",
    inputSchema: {
        type: "object",
        properties: { message: { type: "string", minLength: 1 } },
        required: ["message"],
        additionalProperties: false,
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
    },
};

const consequentialTool: Tool = {
    name: "delete-record",
    inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
    },
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
    },
};

class FakeConnections implements ExecutionConnectionPort {
    constructor(
        private readonly tools: readonly Tool[],
        private readonly invoke: (
            params: {
                name: string;
                arguments?: Record<string, unknown>;
                _meta?: Record<string, unknown>;
            },
            options?: { signal?: AbortSignal; timeout?: number },
        ) => Promise<unknown>,
        private readonly journal?: ProtocolJournal,
    ) {}

    get(connectionId: string): ConnectionSnapshot {
        return {
            id: connectionId,
            kind: "builtin",
            lifecycle: "connected",
            journalEntries: 0,
            initialization: {
                connectedAt: "2026-07-15T10:00:00.000Z",
                capabilities: { tools: {} },
                discovery: { tools: this.tools, resources: [], resourceTemplates: [], prompts: [] },
            },
        };
    }

    getClient(): Pick<Client, "callTool"> {
        return {
            callTool: ((params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }, _schema: unknown, options?: { signal?: AbortSignal; timeout?: number }) =>
                this.invoke(params, options)) as Client["callTool"],
        };
    }

    getJournal(): ProtocolJournal | undefined {
        return this.journal;
    }
}

test("execution validates discovered schemas before calling a tool", async () => {
    let calls = 0;
    const service = new ExecutionService(new FakeConnections([safeTool], async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
    }));

    await assert.rejects(
        service.start({
            workspaceId: "workspace",
            serverId: "server",
            toolName: "echo",
            arguments: { message: 42 },
            timeoutMs: 1_000,
            idempotencyKey: "schema-failure",
        }),
        ExecutionValidationError,
    );
    assert.equal(calls, 0);
});

test("execution isolates hostile schema patterns from the runner event loop", { timeout: 2_000 }, async () => {
    let calls = 0;
    let heartbeatObserved = false;
    const heartbeat = setTimeout(() => {
        heartbeatObserved = true;
    }, 10);
    const hostileTool: Tool = {
        ...safeTool,
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", pattern: "(a+)+$" },
            },
            required: ["message"],
        },
    };
    const service = new ExecutionService(new FakeConnections([hostileTool], async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
    }));

    await assert.rejects(
        service.start({
            workspaceId: "workspace",
            serverId: "server",
            toolName: "echo",
            arguments: { message: `${"a".repeat(50_000)}!` },
            timeoutMs: 1_000,
            idempotencyKey: "schema-redos-isolated",
        }),
        /safety deadline/u,
    );
    clearTimeout(heartbeat);
    assert.equal(heartbeatObserved, true);
    assert.equal(calls, 0);
});

test("execution requires explicit confirmation for consequential tools", async () => {
    let calls = 0;
    const service = new ExecutionService(new FakeConnections([consequentialTool], async () => {
        calls += 1;
        return { content: [{ type: "text", text: "deleted" }] };
    }));

    await assert.rejects(
        service.start({
            workspaceId: "workspace",
            serverId: "server",
            toolName: "delete-record",
            arguments: { id: "123" },
            timeoutMs: 1_000,
            idempotencyKey: "delete-without-confirmation",
        }),
        ExecutionConflictError,
    );
    assert.equal(calls, 0);

    const accepted = await service.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "delete-record",
        arguments: { id: "123" },
        timeoutMs: 1_000,
        idempotencyKey: "delete-with-confirmation",
        confirmation: { acknowledged: true, acknowledgement: "Delete record 123" },
    });
    const finished = await waitForTerminal(service, accepted.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.effect, "consequential");
    assert.equal(finished.confirmation?.acknowledgement, "Delete record 123");
    assert.equal(calls, 1);
});

test("execution is idempotent, sanitizes evidence, and persists lifecycle changes", async () => {
    const persisted: PersistedExecution[] = [];
    const secret = "never-show-this-value";
    let calls = 0;
    const service = new ExecutionService(
        new FakeConnections([safeTool], async () => {
            calls += 1;
            return {
                content: [{ type: "text", text: `result ${secret}` }],
                structuredContent: { token: secret },
            };
        }),
        {
            redactor: new SecretRedactor({ secretValues: [secret] }),
            persistence: {
                async saveExecution(execution) {
                    persisted.push(structuredClone(execution));
                    return execution;
                },
            },
        },
    );

    const request = {
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 1_000,
        idempotencyKey: "same-submission",
    } as const;
    const accepted = await service.start(request);
    const duplicate = await service.start(request);
    assert.equal(duplicate.id, accepted.id);

    const finished = await waitForTerminal(service, accepted.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(finished), new RegExp(secret, "u"));
    assert.match(JSON.stringify(finished), /\[REDACTED\]/u);
    assert.ok(persisted.some((execution) => execution.status === "queued"));
    assert.ok(persisted.some((execution) => execution.status === "succeeded"));

    await assert.rejects(
        service.start({ ...request, arguments: { message: "different" } }),
        ExecutionConflictError,
    );
});

test("background persistence failure becomes sanitized observable terminal evidence", async () => {
    const secret = "background-persistence-secret";
    let saves = 0;
    let calls = 0;
    const service = new ExecutionService(
        new FakeConnections([safeTool], async () => {
            calls += 1;
            return { content: [{ type: "text", text: "unexpected" }] };
        }),
        {
            redactor: new SecretRedactor({ secretValues: [secret] }),
            persistence: {
                async saveExecution(execution) {
                    saves += 1;
                    if (saves > 1) throw new Error(`could not persist ${secret}`);
                    return { ...execution, streamEventId: saves };
                },
            },
        },
    );

    const accepted = await service.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 1_000,
        idempotencyKey: "background-persistence-failure",
    });
    const failed = await waitForTerminal(service, accepted.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "execution_background_failed");
    assert.match(failed.error?.message ?? "", /\[REDACTED\]/u);
    assert.doesNotMatch(failed.error?.message ?? "", new RegExp(secret, "u"));
    assert.equal(calls, 0);
});

test("concurrent execution idempotency coalesces one invocation and rejects payload conflicts", async () => {
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
    });
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        lookupStarted = resolve;
    });
    let lookups = 0;
    let calls = 0;
    const service = new ExecutionService(
        new FakeConnections([safeTool], async () => {
            calls += 1;
            return { content: [{ type: "text", text: "done" }] };
        }),
        {
            persistence: {
                async findExecutionByIdempotency() {
                    lookups += 1;
                    lookupStarted();
                    await lookupGate;
                    return undefined;
                },
                async saveExecution(execution) {
                    return execution;
                },
            },
        },
    );
    const request = {
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "coalesce" },
        timeoutMs: 1_000,
        idempotencyKey: "concurrent-submission",
    } as const;

    const first = service.start(request);
    await started;
    const duplicate = service.start(structuredClone(request));
    await assert.rejects(
        service.start({ ...request, arguments: { message: "different" } }),
        ExecutionConflictError,
    );
    releaseLookup();

    const [firstAccepted, duplicateAccepted] = await Promise.all([first, duplicate]);
    assert.equal(duplicateAccepted.id, firstAccepted.id);
    const finished = await waitForTerminal(service, firstAccepted.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(lookups, 1);
    assert.equal(calls, 1);
});

test("execution distinguishes tool errors and protocol timeouts", async () => {
    const telemetry = new McpTelemetry({ QYL_MCP_TELEMETRY: "0" });
    const telemetryInputs: McpOperationInput[] = [];
    telemetry.startOperation = captureTelemetry(telemetryInputs);
    const toolErrorService = new ExecutionService(
        new FakeConnections([safeTool], async () => ({
            content: [{ type: "text", text: "tool refused" }],
            isError: true,
        })),
        { telemetry },
    );
    const toolAccepted = await toolErrorService.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 1_000,
        idempotencyKey: "tool-error-key",
    });
    const toolFailed = await waitForTerminal(toolErrorService, toolAccepted.id);
    assert.equal(toolFailed.status, "failed");
    assert.equal(toolFailed.error?.category, "tool_error");
    assert.equal(telemetryInputs[0]?.errorType, "tool_error");

    const timeoutService = new ExecutionService(
        new FakeConnections([safeTool], async () => {
            throw new McpError(ErrorCode.RequestTimeout, "timed out");
        }),
        { telemetry },
    );
    const timeoutAccepted = await timeoutService.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 100,
        idempotencyKey: "timeout-key",
    });
    const timedOut = await waitForTerminal(timeoutService, timeoutAccepted.id);
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.error?.category, "timeout");
    assert.equal(telemetryInputs.at(-1)?.errorType, "request_timeout");
    assert.equal(telemetryInputs.at(-1)?.rpcResponseStatusCode, undefined);

    const connectionService = new ExecutionService(
        new FakeConnections([safeTool], async () => {
            throw new McpError(ErrorCode.ConnectionClosed, "connection closed");
        }),
        { telemetry },
    );
    const connectionAccepted = await connectionService.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 1_000,
        idempotencyKey: "connection-failure-key",
    });
    const connectionFailed = await waitForTerminal(connectionService, connectionAccepted.id);
    assert.equal(connectionFailed.status, "failed");
    assert.equal(connectionFailed.error?.category, "transport");
    assert.equal(telemetryInputs.at(-1)?.errorType, "connection_closed");
    assert.equal(telemetryInputs.at(-1)?.rpcResponseStatusCode, undefined);

    const journal = new ProtocolJournal();
    const protocolService = new ExecutionService(
        new FakeConnections([safeTool], async () => {
            const correlation = { executionId: "protocol-error-execution", workspaceId: "workspace" };
            journal.recordMessage("outbound", {
                jsonrpc: "2.0",
                id: 42,
                method: "tools/call",
                params: { name: "echo", arguments: { message: "hello" } },
            }, correlation);
            journal.recordMessage("inbound", {
                jsonrpc: "2.0",
                id: 42,
                error: { code: ErrorCode.InvalidParams, message: "invalid params" },
            });
            throw new McpError(ErrorCode.InvalidParams, "invalid params");
        }, journal),
        {
            telemetry,
            id: () => "protocol-error-execution",
        },
    );
    const protocolAccepted = await protocolService.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 1_000,
        idempotencyKey: "protocol-error-key",
    });
    const protocolFailed = await waitForTerminal(protocolService, protocolAccepted.id);
    assert.equal(protocolFailed.status, "failed");
    assert.equal(protocolFailed.error?.category, "protocol");
    assert.equal(telemetryInputs.at(-1)?.errorType, String(ErrorCode.InvalidParams));
    assert.equal(telemetryInputs.at(-1)?.rpcResponseStatusCode, String(ErrorCode.InvalidParams));
});

test("execution activates a pre-call span and clears its traceparent after completion", async () => {
    const telemetry = new McpTelemetry({ QYL_MCP_TELEMETRY: "0" });
    const events: string[] = [];
    const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
    telemetry.startOperation = (input) => {
        events.push(`start:${input.method}`);
        return {
            traceparent,
            propagation: { traceparent },
            correlation: {
                traceId: "11111111111111111111111111111111",
                spanId: "2222222222222222",
            },
            run: (operation) => operation(),
            end(completion) {
                events.push(`end:${completion.errorType ?? "ok"}`);
                return this.correlation;
            },
        };
    };
    const service = new ExecutionService(
        new FakeConnections([safeTool], async (params) => {
            events.push(`invoke:${currentMcpTraceparent() ?? "missing"}`);
            assert.equal(params._meta?.traceparent, traceparent);
            return { content: [{ type: "text", text: "ok" }] };
        }),
        { telemetry },
    );

    const accepted = await service.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "hello" },
        timeoutMs: 1_000,
        idempotencyKey: "pre-call-span",
    });
    assert.equal((await waitForTerminal(service, accepted.id)).status, "succeeded");
    assert.deepEqual(events, [
        "start:tools/call",
        `invoke:${traceparent}`,
        "end:ok",
    ]);
    assert.equal(currentMcpTraceparent(), undefined);
});

test("execution cancellation aborts the real in-flight request signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const service = new ExecutionService(new FakeConnections([safeTool], async (_params, options) => {
        observedSignal = options?.signal;
        return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            }, { once: true });
        });
    }));
    const accepted = await service.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "wait" },
        timeoutMs: 10_000,
        idempotencyKey: "cancel-key",
    });
    await service.cancel("workspace", "server", accepted.id);
    const cancelled = await waitForTerminal(service, accepted.id);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error?.category, "cancelled");
});

test("cancellation aborts before persistence and wins over a late successful result", async () => {
    const secret = "late-result-secret";
    const persisted: PersistedExecution[] = [];
    let observedSignal: AbortSignal | undefined;
    let resolveCall!: (result: unknown) => void;
    let markInvocationStarted!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
        markInvocationStarted = resolve;
    });
    let releaseCancellingWrite!: () => void;
    let cancellationWritePending = false;

    const service = new ExecutionService(
        new FakeConnections([safeTool], async (_params, options) => {
            observedSignal = options?.signal;
            markInvocationStarted();
            return new Promise((resolve) => {
                resolveCall = resolve;
            });
        }),
        {
            redactor: new SecretRedactor({ secretValues: [secret] }),
            persistence: {
                async saveExecution(execution) {
                    if (execution.status === "cancelling") {
                        cancellationWritePending = true;
                        await new Promise<void>((resolve) => {
                            releaseCancellingWrite = resolve;
                        });
                        throw new Error("cannot persist cancellation transition");
                    }
                    persisted.push(structuredClone(execution));
                    return { ...execution, streamEventId: persisted.length };
                },
            },
        },
    );

    const accepted = await service.start({
        workspaceId: "workspace",
        serverId: "server",
        toolName: "echo",
        arguments: { message: "wait" },
        timeoutMs: 10_000,
        idempotencyKey: "cancel-persistence-race",
    });
    await invocationStarted;

    const cancellation = service.cancel("workspace", "server", accepted.id);
    const cancellationFailure = assert.rejects(
        cancellation,
        /cannot persist cancellation transition/u,
    );

    // cancel() must synchronously cross the transport safety boundary before
    // its first await, even while the lifecycle write is still pending.
    assert.equal(observedSignal?.aborted, true);
    assert.equal(cancellationWritePending, true);

    const terminal = waitForTerminal(service, accepted.id);
    resolveCall({ content: [{ type: "text", text: `ignored ${secret}` }] });
    const cancelled = await terminal;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.result, undefined);
    assert.equal(cancelled.error?.category, "cancelled");
    assert.equal(typeof cancelled.cancelRequestedAt, "string");
    assert.equal(typeof cancelled.cancelledAt, "string");

    releaseCancellingWrite();
    await cancellationFailure;

    const durableCancellation = [...persisted].reverse().find((execution) => execution.status === "cancelled");
    assert.ok(durableCancellation);
    assert.equal((durableCancellation.evidence as ExecutionRecord).status, "cancelled");
    assert.equal(persisted.some((execution) => execution.status === "succeeded"), false);
    assert.doesNotMatch(JSON.stringify(durableCancellation), new RegExp(secret, "u"));
});

async function waitForTerminal(service: ExecutionService, executionId: string): Promise<ExecutionRecord> {
    const immediate = service.get("workspace", "server", executionId);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(immediate.status)) return immediate;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Execution '${executionId}' did not finish.`));
        }, 2_000);
        const unsubscribe = service.subscribe((record) => {
            if (record.id !== executionId || !["succeeded", "failed", "cancelled", "timed_out"].includes(record.status)) return;
            clearTimeout(timer);
            unsubscribe();
            resolve(record);
        });
    });
}

function captureTelemetry(
    inputs: McpOperationInput[],
): (input: McpOperationStartInput) => ActiveMcpOperation {
    return (input) => ({
        run: (operation) => operation(),
        end(completion) {
            inputs.push(structuredClone({ ...input, ...completion }));
            return undefined;
        },
    });
}
