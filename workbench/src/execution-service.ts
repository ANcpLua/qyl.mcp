import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type {
    WorkbenchExecutionCost,
    WorkbenchError,
    WorkbenchErrorCategory,
    WorkbenchExecutionConfirmationEvidence,
    WorkbenchExecutionConfirmationRequest,
    WorkbenchExecutionEffect,
    WorkbenchExecutionStatus,
    WorkbenchExecutionTokenUsage,
} from "@ancplua/qyl-api-schema/types";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { ProtocolError, SdkErrorCode, SdkError } from "@modelcontextprotocol/client";
import type { Client, Tool } from "@modelcontextprotocol/client";
import type {
    ConnectionInitializationSnapshot,
    ConnectionSnapshot,
} from "./connection-manager.js";
import type {
    ProtocolExecutionCorrelation,
    ProtocolJournal,
    ProtocolJournalEntry,
} from "./protocol-journal.js";
import { SecretRedactor } from "./secret-redactor.js";
import { classifyToolSafety, type ToolSafetyDecision } from "./tool-safety.js";
import type { PersistedExecution } from "./workbench-repository.js";
import { validateJsonSchemaIsolated } from "./json-schema-validator.js";
import type { WorkbenchCorrelationRegistry } from "./observability-correlation.js";
import { extractExecutionEvidence } from "./execution-evidence.js";
import {
    MAX_PERSISTED_RESULT_CHARACTERS,
    sanitizePersistedToolResult,
} from "qyl-mcp-server/execution-result";
import {
    runWithMcpPropagation,
    type ActiveMcpOperation,
    type McpTelemetry,
} from "./telemetry.js";

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_STREAM_EVENTS = 10_000;

export type ExecutionStatus = WorkbenchExecutionStatus;
export type ExecutionErrorCategory = WorkbenchErrorCategory;
export type ExecutionEffect = WorkbenchExecutionEffect;
export type ExecutionError = WorkbenchError;
export type ExecutionConfirmationRequest = WorkbenchExecutionConfirmationRequest;
export type ExecutionConfirmationEvidence = WorkbenchExecutionConfirmationEvidence;

export interface StartExecutionRequest {
    workspaceId: string;
    serverId: string;
    toolName: string;
    arguments?: unknown;
    timeoutMs: number;
    idempotencyKey: string;
    confirmation?: ExecutionConfirmationRequest;
    correlation?: Omit<ProtocolExecutionCorrelation, "executionId" | "workspaceId">;
}

export interface ExecutionRecord {
    id: string;
    workspaceId: string;
    serverId: string;
    request: {
        toolName: string;
        arguments: Record<string, unknown>;
        timeoutMs: number;
        idempotencyKey: string;
    };
    effect: ExecutionEffect;
    safety: ToolSafetyDecision;
    confirmation?: ExecutionConfirmationEvidence;
    status: ExecutionStatus;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    attemptCount: number;
    retryCount: number;
    cancelRequestedAt?: string;
    cancelledAt?: string;
    result?: unknown;
    error?: ExecutionError;
    tokenUsage?: WorkbenchExecutionTokenUsage;
    cost?: WorkbenchExecutionCost;
    correlation: ProtocolExecutionCorrelation;
}

/** One immutable lifecycle transition in the execution SSE journal. */
export interface ExecutionStreamEvent {
    sequence: number;
    execution: ExecutionRecord;
}

export interface ExecutionConnectionPort {
    get(connectionId: string): ConnectionSnapshot;
    getClient(connectionId: string): Pick<Client, "callTool">;
    getJournal?(connectionId: string): ProtocolJournal | undefined;
}

export interface ExecutionPersistencePort {
    saveExecution(execution: PersistedExecution): Promise<PersistedExecution>;
    findExecutionByIdempotency?(
        workspaceId: string,
        serverId: string,
        idempotencyKey: string,
    ): Promise<PersistedExecution | undefined>;
}

export interface ExecutionServiceOptions {
    persistence?: ExecutionPersistencePort;
    redactor?: SecretRedactor;
    now?: () => number;
    id?: () => string;
    telemetry?: McpTelemetry;
    correlations?: WorkbenchCorrelationRegistry;
}

interface PendingInvocation {
    arguments: Record<string, unknown>;
    controller: AbortController;
    cancelledByUser: boolean;
    correlation: ProtocolExecutionCorrelation;
}

interface IdempotencyEntry {
    fingerprint: string;
    executionId: string;
}

interface IdempotencyReservation {
    fingerprint: string;
    promise: Promise<ExecutionRecord>;
}

export class ExecutionConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExecutionConflictError";
    }
}

export class ExecutionValidationError extends Error {
    constructor(readonly field: string, message: string) {
        super(message);
        this.name = "ExecutionValidationError";
    }
}

export class ExecutionNotFoundError extends Error {
    constructor(readonly executionId: string) {
        super(`Execution '${executionId}' was not found.`);
        this.name = "ExecutionNotFoundError";
    }
}

/**
 * Owns schema validation, confirmation, idempotency, cancellation, and sanitized
 * evidence for real SDK tool calls. The connection manager remains the sole
 * owner of transports and SDK clients.
 */
export class ExecutionService {
    private readonly records = new Map<string, ExecutionRecord>();
    private readonly idempotency = new Map<string, IdempotencyEntry>();
    private readonly idempotencyReservations = new Map<string, IdempotencyReservation>();
    private readonly pending = new Map<string, PendingInvocation>();
    // Each SDK request inherits its own async context; ProtocolJournal then
    // retains that correlation by JSON-RPC request id until the response.
    private readonly correlationContext = new AsyncLocalStorage<ProtocolExecutionCorrelation>();
    private readonly subscribers = new Set<(record: ExecutionRecord) => void>();
    private readonly streamSubscribers = new Set<(event: ExecutionStreamEvent) => void>();
    private readonly streamEvents: ExecutionStreamEvent[] = [];
    private readonly latestStreamEventByExecution = new Map<string, ExecutionStreamEvent>();
    private nextStreamSequence = 1;
    private readonly persistence?: ExecutionPersistencePort;
    private readonly redactor: SecretRedactor;
    private readonly now: () => number;
    private readonly id: () => string;
    private readonly telemetry?: McpTelemetry;
    private readonly correlations?: WorkbenchCorrelationRegistry;

    constructor(
        private readonly connections: ExecutionConnectionPort,
        options: ExecutionServiceOptions = {},
    ) {
        this.persistence = options.persistence;
        this.redactor = options.redactor ?? new SecretRedactor({
            environment: process.env,
            maxStringLength: MAX_PERSISTED_RESULT_CHARACTERS + 1,
        });
        this.now = options.now ?? Date.now;
        this.id = options.id ?? randomUUID;
        this.telemetry = options.telemetry;
        this.correlations = options.correlations;
    }

    list(workspaceId: string, serverId: string): ExecutionRecord[] {
        return [...this.records.values()]
            .filter((record) => record.workspaceId === workspaceId && record.serverId === serverId)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map(clone);
    }

    get(workspaceId: string, serverId: string, executionId: string): ExecutionRecord {
        const record = this.records.get(executionId);
        if (!record || record.workspaceId !== workspaceId || record.serverId !== serverId) {
            throw new ExecutionNotFoundError(executionId);
        }
        return clone(record);
    }

    /**
     * Drop terminal in-memory history after the repository has atomically
     * deleted its owning server. Active work is never eligible for deletion.
     */
    ensureServerForgettable(workspaceId: string, serverId: string): void {
        const matchesScope = (record: Pick<ExecutionRecord, "workspaceId" | "serverId">): boolean =>
            record.workspaceId === workspaceId && record.serverId === serverId;
        if ([...this.pending.keys()].some((id) => {
            const record = this.records.get(id);
            return record !== undefined && matchesScope(record);
        })) {
            throw new ExecutionConflictError("An MCP server with active executions cannot be forgotten.");
        }
        const prefix = `${workspaceId}\u0000${serverId}\u0000`;
        if ([...this.idempotencyReservations.keys()].some((key) => key.startsWith(prefix))) {
            throw new ExecutionConflictError("An MCP server with reserved executions cannot be forgotten.");
        }
        for (const record of this.records.values()) {
            if (!matchesScope(record)) continue;
            if (!isTerminal(record.status)) {
                throw new ExecutionConflictError("An MCP server with active executions cannot be forgotten.");
            }
        }
    }

    forgetServer(workspaceId: string, serverId: string): void {
        this.ensureServerForgettable(workspaceId, serverId);
        const matchesScope = (record: Pick<ExecutionRecord, "workspaceId" | "serverId">): boolean =>
            record.workspaceId === workspaceId && record.serverId === serverId;
        const prefix = `${workspaceId}\u0000${serverId}\u0000`;
        const removedIds = new Set<string>();
        for (const [id, record] of this.records) {
            if (!matchesScope(record)) continue;
            removedIds.add(id);
            this.records.delete(id);
        }
        for (const key of this.idempotency.keys()) {
            if (key.startsWith(prefix)) this.idempotency.delete(key);
        }
        for (let index = this.streamEvents.length - 1; index >= 0; index -= 1) {
            if (matchesScope(this.streamEvents[index]!.execution)) this.streamEvents.splice(index, 1);
        }
        for (const id of removedIds) this.latestStreamEventByExecution.delete(id);
    }

    subscribe(push: (record: ExecutionRecord) => void): () => void {
        this.subscribers.add(push);
        return () => this.subscribers.delete(push);
    }

    streamSnapshot(workspaceId: string, serverId: string): ExecutionStreamEvent[] {
        const events = new Map<number, ExecutionStreamEvent>();
        for (const event of this.latestStreamEventByExecution.values()) {
            if (event.execution.workspaceId === workspaceId && event.execution.serverId === serverId) {
                events.set(event.sequence, event);
            }
        }
        for (const event of this.streamEvents) {
            if (event.execution.workspaceId === workspaceId && event.execution.serverId === serverId) {
                events.set(event.sequence, event);
            }
        }
        return [...events.values()].sort((left, right) => left.sequence - right.sequence).map(clone);
    }

    subscribeStream(push: (event: ExecutionStreamEvent) => void): () => void {
        this.streamSubscribers.add(push);
        return () => this.streamSubscribers.delete(push);
    }

    /** Hydrate durable current states and their repository-assigned stream cursors on startup. */
    restorePersisted(executions: readonly PersistedExecution[]): void {
        for (const persisted of [...executions].sort(comparePersistedStreamOrder)) {
            this.restorePersistedExecution(persisted);
        }
    }

    correlationFor(_serverId: string): ProtocolExecutionCorrelation | undefined {
        const correlation = this.correlationContext.getStore();
        return correlation === undefined ? undefined : { ...correlation };
    }

    async start(request: StartExecutionRequest): Promise<ExecutionRecord> {
        validateRequest(request);
        const fingerprint = requestFingerprint(request);
        const scopeKey = `${request.workspaceId}\u0000${request.serverId}\u0000${request.idempotencyKey}`;
        const reservation = this.idempotencyReservations.get(scopeKey);
        if (reservation !== undefined) {
            assertMatchingExecutionFingerprint(reservation.fingerprint, fingerprint);
            return clone(await reservation.promise);
        }
        const previous = this.idempotency.get(scopeKey);
        if (previous) {
            assertMatchingExecutionFingerprint(previous.fingerprint, fingerprint);
            return clone(this.records.get(previous.executionId)!);
        }

        const promise = this.startReserved(request, fingerprint, scopeKey);
        this.idempotencyReservations.set(scopeKey, { fingerprint, promise });
        try {
            return clone(await promise);
        } finally {
            if (this.idempotencyReservations.get(scopeKey)?.promise === promise) {
                this.idempotencyReservations.delete(scopeKey);
            }
        }
    }

    private async startReserved(
        request: StartExecutionRequest,
        fingerprint: string,
        scopeKey: string,
    ): Promise<ExecutionRecord> {
        const persisted = await this.persistence?.findExecutionByIdempotency?.(
            request.workspaceId,
            request.serverId,
            request.idempotencyKey,
        );
        if (persisted?.idempotency !== undefined) {
            assertMatchingExecutionFingerprint(persisted.idempotency.fingerprint, fingerprint);
            const restored = this.restorePersistedExecution(persisted);
            return clone(restored);
        }

        const initialization = connectedInitialization(this.connections.get(request.serverId));
        const tool = findTool(initialization, request.toolName);
        const args = await validateArguments(tool, request.arguments ?? {});
        const safety = classifyToolSafety(tool);
        const effect = effectFor(safety);
        const confirmation = confirmationEvidence(safety, request.confirmation, this.now);

        const executionId = this.id();
        const createdAt = timestamp(this.now());
        const correlation: ProtocolExecutionCorrelation = {
            executionId,
            workspaceId: request.workspaceId,
            ...(request.correlation ?? {}),
        };
        const record: ExecutionRecord = {
            id: executionId,
            workspaceId: request.workspaceId,
            serverId: request.serverId,
            request: {
                toolName: request.toolName,
                arguments: sanitizeObject(args, this.redactor),
                timeoutMs: request.timeoutMs,
                idempotencyKey: request.idempotencyKey,
            },
            effect,
            safety,
            ...(confirmation === undefined ? {} : { confirmation }),
            status: "queued",
            createdAt,
            attemptCount: 0,
            retryCount: 0,
            correlation,
        };
        this.correlations?.beginExecution(correlation);
        this.records.set(executionId, record);
        this.idempotency.set(scopeKey, { fingerprint, executionId });
        const pending: PendingInvocation = {
            arguments: args,
            controller: new AbortController(),
            cancelledByUser: false,
            correlation,
        };
        this.pending.set(executionId, pending);
        try {
            await this.publish(record);
        } catch (error) {
            this.pending.delete(executionId);
            this.records.delete(executionId);
            if (this.idempotency.get(scopeKey)?.executionId === executionId) {
                this.idempotency.delete(scopeKey);
            }
            throw error;
        }
        void this.execute(record, pending).catch((error: unknown) => {
            try {
                this.failBackground(record, error);
            } catch {
                console.error(`Execution '${record.id}' background failure could not be published.`);
            }
        });
        return clone(record);
    }

    async cancel(
        workspaceId: string,
        serverId: string,
        executionId: string,
    ): Promise<ExecutionRecord> {
        const record = this.requireRecord(workspaceId, serverId, executionId);
        const pending = this.pending.get(executionId);
        if (!pending || isTerminal(record.status)) {
            throw new ExecutionConflictError(`Execution '${executionId}' is already ${record.status}.`);
        }
        pending.cancelledByUser = true;
        record.status = "cancelling";
        record.cancelRequestedAt = timestamp(this.now());
        // Cancellation is a safety boundary: abort the live SDK request before
        // any persistence or observer can delay (or reject) the lifecycle write.
        pending.controller.abort();
        await this.publish(record);
        return clone(record);
    }

    private async execute(record: ExecutionRecord, pending: PendingInvocation): Promise<void> {
        const startedMs = this.now();
        record.status = "running";
        record.startedAt = timestamp(startedMs);
        record.attemptCount += 1;
        await this.publish(record);
        const telemetryOperation = this.startTelemetry(record, startedMs);

        try {
            const result = CallToolResultSchema.parse(await runWithMcpPropagation(
                telemetryOperation?.propagation,
                () => this.correlationContext.run(
                    pending.correlation,
                    () => this.connections.getClient(record.serverId).callTool(
                        {
                            name: record.request.toolName,
                            arguments: pending.arguments,
                            ...(telemetryOperation?.propagation === undefined
                                ? {}
                                : { _meta: { ...telemetryOperation.propagation } }),
                        },
                        {
                            signal: pending.controller.signal,
                            timeout: record.request.timeoutMs,
                            maxTotalTimeout: record.request.timeoutMs,
                        },
                    ),
                ),
            ));
            const completedMs = this.now();
            const evidence = extractExecutionEvidence(result);
            if (evidence.tokenUsage !== undefined) record.tokenUsage = evidence.tokenUsage;
            if (evidence.cost !== undefined) record.cost = evidence.cost;
            // Abort is advisory at the transport boundary. A server may still
            // resolve the request, so the synchronous cancellation flag is the
            // lifecycle linearization point and must win over that late result.
            const cancellationWon = pending.cancelledByUser;
            const toolErrorType = cancellationWon
                ? "cancelled"
                : result.isError === true ? "tool_error" : undefined;
            this.finishTelemetry(
                record,
                telemetryOperation,
                completedMs,
                toolErrorType,
                this.redactor.redact(result),
            );
            if (cancellationWon) {
                record.status = "cancelled";
                record.cancelledAt = timestamp(completedMs);
                record.error = cancellationError(completedMs);
                delete record.result;
            } else if (result.isError === true) {
                record.result = sanitizePersistedToolResult(result, this.redactor);
                record.status = "failed";
                record.error = {
                    category: "tool_error",
                    code: "tool_result_error",
                    message: "The MCP tool returned an error result.",
                    occurred_at: timestamp(completedMs),
                    retryable: false,
                };
            } else {
                record.result = sanitizePersistedToolResult(result, this.redactor);
                record.status = "succeeded";
            }
            finish(record, startedMs, completedMs);
            await this.publish(record);
        } catch (error) {
            const completedMs = this.now();
            const classified = classifyExecutionError(error, pending.cancelledByUser, this.redactor, completedMs);
            this.finishTelemetry(
                record,
                telemetryOperation,
                completedMs,
                telemetryErrorType(error, classified.error.code),
                this.redactor.redact({ error: classified.error }),
                classified.error.message,
            );
            record.status = classified.status;
            record.error = classified.error;
            if (classified.status === "cancelled") record.cancelledAt = timestamp(completedMs);
            finish(record, startedMs, completedMs);
            await this.publish(record);
        } finally {
            this.pending.delete(record.id);
        }
    }

    private startTelemetry(
        record: ExecutionRecord,
        startedMs: number,
    ): ActiveMcpOperation | undefined {
        let operation: ActiveMcpOperation | undefined;
        try {
            const snapshot = this.connections.get(record.serverId);
            operation = this.telemetry?.startOperation({
                role: "client",
                method: "tools/call",
                serverId: record.serverId,
                toolName: record.request.toolName,
                transport: telemetryTransport(snapshot.kind),
                protocolVersion: snapshot.initialization?.protocolVersion,
                executionId: record.id,
                ...(record.correlation.evaluationRunId === undefined ? {} : { evaluationRunId: record.correlation.evaluationRunId }),
                ...(record.correlation.testCaseId === undefined ? {} : { testCaseId: record.correlation.testCaseId }),
                requestBody: this.redactor.redact({
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: {
                        name: record.request.toolName,
                        arguments: record.request.arguments,
                    },
                }),
                startTimeMs: startedMs,
            });
            if (operation?.correlation) {
                this.correlations?.linkTelemetry(
                    record.id,
                    operation.correlation.traceId,
                    operation.correlation.spanId,
                );
            }
        } catch {
            // Self-telemetry must never prevent the real MCP invocation.
        }
        return operation;
    }

    private finishTelemetry(
        record: ExecutionRecord,
        operation: ActiveMcpOperation | undefined,
        completedMs: number,
        errorType?: string,
        responseBody?: unknown,
        errorMessage?: string,
    ): void {
        if (operation === undefined) return;
        let requestId: string | number | undefined;
        let rpcResponseStatusCode: string | undefined;
        try {
            const journalEntries = this.connections.getJournal?.(record.serverId)?.snapshot() ?? [];
            const requestEntry = [...journalEntries]
                .reverse()
                .find((entry) => entry.kind === "message"
                    && entry.direction === "outbound"
                    && entry.messageKind === "request"
                    && entry.method === "tools/call"
                    && entry.correlation?.executionId === record.id);
            if (requestEntry?.kind === "message" && requestEntry.requestId !== undefined) {
                requestId = requestEntry.requestId;
                this.correlations?.linkMcpRequest({
                    executionId: record.id,
                    serverId: record.serverId,
                    requestId: requestEntry.requestId,
                    method: "tools/call",
                });
            }
            rpcResponseStatusCode = requestEntry?.kind === "message" && requestEntry.requestId !== undefined
                ? correlatedJsonRpcErrorCode(journalEntries, record.id, requestEntry.requestId)
                : undefined;
        } catch {
            // Protocol evidence is best-effort for telemetry and cannot change the tool result.
        }
        try {
            const effectiveErrorType = rpcResponseStatusCode ?? errorType;
            const span = operation.end({
                endTimeMs: completedMs,
                ...(requestId === undefined ? {} : { jsonRpcRequestId: requestId }),
                ...(effectiveErrorType === undefined ? {} : { errorType: effectiveErrorType }),
                ...(errorMessage === undefined ? {} : { errorMessage }),
                ...(rpcResponseStatusCode === undefined ? {} : { rpcResponseStatusCode }),
                ...(responseBody === undefined ? {} : { responseBody }),
            });
            if (span) {
                try {
                    this.correlations?.linkTelemetry(record.id, span.traceId, span.spanId);
                } catch {
                    // Correlation indexing must not change the MCP result.
                }
            }
        } catch {
            return;
        }
    }

    private failBackground(record: ExecutionRecord, error: unknown): void {
        const completedMs = this.now();
        if (record.cancelRequestedAt !== undefined) {
            // A failed lifecycle write cannot reverse an already accepted
            // cancellation. Retain the cancellation as volatile evidence and
            // emit only a generic process-level persistence diagnostic.
            record.status = "cancelled";
            record.cancelledAt ??= timestamp(completedMs);
            record.error = cancellationError(completedMs);
            delete record.result;
        } else {
            record.status = "failed";
            record.error = {
                category: "internal",
                code: "execution_background_failed",
                message: this.redactor.redactText(error instanceof Error ? error.message : String(error)),
                occurred_at: timestamp(completedMs),
                retryable: true,
            };
        }
        if (record.completedAt === undefined) {
            if (record.startedAt !== undefined) {
                finish(record, Date.parse(record.startedAt), completedMs);
            } else {
                record.completedAt = timestamp(completedMs);
            }
        }
        this.pending.delete(record.id);
        const snapshot = clone(record);
        this.appendStreamEvent(snapshot);
        this.notifyRecordSubscribers(snapshot);
        console.error(record.status === "cancelled"
            ? `Execution '${record.id}' cancellation could not be persisted; volatile cancellation evidence was retained.`
            : `Execution '${record.id}' failed after acceptance; volatile failure evidence was retained.`);
    }

    private requireRecord(workspaceId: string, serverId: string, executionId: string): ExecutionRecord {
        const record = this.records.get(executionId);
        if (!record || record.workspaceId !== workspaceId || record.serverId !== serverId) {
            throw new ExecutionNotFoundError(executionId);
        }
        return record;
    }

    private restorePersistedExecution(persisted: PersistedExecution): ExecutionRecord {
        const existing = this.records.get(persisted.id);
        if (existing !== undefined) return existing;
        const restored = restoreExecutionRecord(persisted);
        const idempotency = persisted.idempotency;
        if (idempotency === undefined) {
            throw new ExecutionConflictError(
                `Persisted execution '${persisted.id}' has no durable idempotency evidence.`,
            );
        }
        const scope = idempotencyScope(restored);
        const previous = this.idempotency.get(scope);
        if (previous !== undefined) {
            assertMatchingExecutionFingerprint(previous.fingerprint, idempotency.fingerprint);
            if (previous.executionId !== restored.id) {
                throw new ExecutionConflictError(
                    `Persisted executions '${previous.executionId}' and '${restored.id}' reuse one idempotency key.`,
                );
            }
        }
        this.records.set(restored.id, restored);
        this.idempotency.set(scope, { fingerprint: idempotency.fingerprint, executionId: restored.id });
        this.appendStreamEvent(restored, persisted.streamEventId);
        return restored;
    }

    private async publish(record: ExecutionRecord): Promise<void> {
        const snapshot = clone(record);
        let streamEventId: number | undefined;
        if (this.persistence) {
            const protocolEvents = isTerminal(record.status)
                ? (this.connections.getJournal?.(record.serverId)?.snapshot() ?? [])
                    .filter((entry) => entry.correlation?.executionId === record.id)
                : undefined;
            const telemetryCorrelation = isTerminal(record.status)
                ? this.correlations?.correlation(record.id)
                : undefined;
            const persisted: PersistedExecution = {
                id: record.id,
                workspaceId: record.workspaceId,
                serverId: record.serverId,
                status: record.status,
                createdAt: record.createdAt,
                ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
                evidence: snapshot,
                idempotency: {
                    key: record.request.idempotencyKey,
                    fingerprint: this.idempotency.get(idempotencyScope(record))!.fingerprint,
                },
                ...(protocolEvents === undefined ? {} : { protocolEvents: [...protocolEvents] }),
                ...(telemetryCorrelation === undefined ? {} : { telemetryCorrelation }),
            };
            streamEventId = (await this.persistence.saveExecution(persisted)).streamEventId;
        }
        this.appendStreamEvent(snapshot, streamEventId);
        this.notifyRecordSubscribers(snapshot);
    }

    private notifyRecordSubscribers(record: ExecutionRecord): void {
        for (const push of this.subscribers) {
            try {
                push(clone(record));
            } catch {
                console.error(`Execution '${record.id}' lifecycle observer failed.`);
            }
        }
    }

    private appendStreamEvent(record: ExecutionRecord, persistedSequence?: number): void {
        const sequence = persistedSequence !== undefined
            && Number.isSafeInteger(persistedSequence)
            && persistedSequence >= this.nextStreamSequence
            ? persistedSequence
            : this.nextStreamSequence;
        this.nextStreamSequence = sequence + 1;
        const event = { sequence, execution: clone(record) };
        this.streamEvents.push(event);
        this.latestStreamEventByExecution.set(record.id, event);
        while (this.streamEvents.length > MAX_STREAM_EVENTS) this.streamEvents.shift();
        for (const push of this.streamSubscribers) {
            try {
                push(clone(event));
            } catch {
                console.error(`Execution '${record.id}' stream observer failed.`);
            }
        }
    }
}

function telemetryErrorType(error: unknown, fallback: string): string {
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return "request_timeout";
    if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) return "connection_closed";
    return fallback;
}

function correlatedJsonRpcErrorCode(
    entries: readonly ProtocolJournalEntry[],
    executionId: string,
    requestId: string | number,
): string | undefined {
    const response = [...entries].reverse().find((entry) =>
        entry.kind === "message"
        && entry.direction === "inbound"
        && entry.messageKind === "error_response"
        && entry.requestId === requestId
        && entry.correlation?.executionId === executionId);
    if (response?.kind !== "message"
        || typeof response.payload !== "object"
        || response.payload === null
        || Array.isArray(response.payload)) return undefined;
    const error = (response.payload as Record<string, unknown>).error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === "number" && Number.isSafeInteger(code) ? String(code) : undefined;
}

function restoreExecutionRecord(persisted: PersistedExecution): ExecutionRecord {
    const candidate = persisted.evidence;
    if (!isExecutionRecord(candidate)
        || candidate.id !== persisted.id
        || candidate.workspaceId !== persisted.workspaceId
        || candidate.serverId !== persisted.serverId
        || candidate.request.idempotencyKey !== persisted.idempotency?.key) {
        throw new ExecutionConflictError(
            `Persisted execution '${persisted.id}' cannot be replayed because its evidence is invalid.`,
        );
    }
    return clone(candidate);
}

function comparePersistedStreamOrder(left: PersistedExecution, right: PersistedExecution): number {
    const bySequence = (left.streamEventId ?? Number.MAX_SAFE_INTEGER)
        - (right.streamEventId ?? Number.MAX_SAFE_INTEGER);
    if (bySequence !== 0) return bySequence;
    const byCreation = left.createdAt.localeCompare(right.createdAt);
    return byCreation === 0 ? left.id.localeCompare(right.id) : byCreation;
}

function assertMatchingExecutionFingerprint(previous: string, candidate: string): void {
    if (previous !== candidate) {
        throw new ExecutionConflictError(
            "The idempotency key was already used for a different invocation.",
        );
    }
}

function isExecutionRecord(value: unknown): value is ExecutionRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const candidate = value as Partial<ExecutionRecord>;
    if (typeof candidate.id !== "string"
        || typeof candidate.workspaceId !== "string"
        || typeof candidate.serverId !== "string"
        || typeof candidate.createdAt !== "string"
        || !isExecutionStatus(candidate.status)) return false;
    const request = candidate.request;
    return typeof request === "object"
        && request !== null
        && typeof request.toolName === "string"
        && typeof request.idempotencyKey === "string"
        && typeof request.timeoutMs === "number"
        && typeof request.arguments === "object"
        && request.arguments !== null
        && !Array.isArray(request.arguments);
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
    return value === "queued"
        || value === "running"
        || value === "cancelling"
        || value === "succeeded"
        || value === "failed"
        || value === "cancelled"
        || value === "timed_out";
}

function idempotencyScope(record: ExecutionRecord): string {
    return `${record.workspaceId}\u0000${record.serverId}\u0000${record.request.idempotencyKey}`;
}

function connectedInitialization(snapshot: ConnectionSnapshot): ConnectionInitializationSnapshot {
    if (snapshot.lifecycle !== "connected" || snapshot.initialization === undefined) {
        throw new ExecutionConflictError(`MCP server '${snapshot.id}' is not connected.`);
    }
    return snapshot.initialization;
}

function findTool(initialization: ConnectionInitializationSnapshot, name: string): Tool {
    const tool = initialization.discovery.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new ExecutionValidationError("toolName", `MCP tool '${name}' was not discovered.`);
    return tool;
}

async function validateArguments(tool: Tool, value: unknown): Promise<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ExecutionValidationError("arguments", "MCP tool arguments must be a JSON object.");
    }
    const parsed = await validateJsonSchemaIsolated(tool.inputSchema, value);
    switch (parsed.kind) {
        case "invalid":
            throw new ExecutionValidationError(
                "arguments",
                parsed.issues.map((issue) => `${jsonPointer([...issue.path])}: ${issue.message}`).join("; "),
            );
        case "invalid_schema":
            throw new ExecutionValidationError(
                "arguments",
                "The discovered tool input schema could not be compiled.",
            );
        case "too_large":
            throw new ExecutionValidationError(
                "arguments",
                `The discovered tool input ${parsed.subject} exceeds the safety limit.`,
            );
        case "timeout":
            throw new ExecutionValidationError(
                "arguments",
                "Tool argument schema evaluation exceeded the safety deadline.",
            );
        case "worker_error":
            throw new ExecutionValidationError(
                "arguments",
                "Tool argument schema evaluation failed in its isolated worker.",
            );
        case "valid":
            if (typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) {
                throw new ExecutionValidationError("arguments", "The tool schema must validate an argument object.");
            }
            return parsed.data as Record<string, unknown>;
    }
}

function validateRequest(request: StartExecutionRequest): void {
    for (const [field, value] of [
        ["workspaceId", request.workspaceId],
        ["serverId", request.serverId],
        ["toolName", request.toolName],
        ["idempotencyKey", request.idempotencyKey],
    ] as const) {
        if (!value.trim()) throw new ExecutionValidationError(field, `${field} must not be empty.`);
    }
    if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 256) {
        throw new ExecutionValidationError("idempotencyKey", "Idempotency keys must contain 8 to 256 characters.");
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < MIN_TIMEOUT_MS || request.timeoutMs > MAX_TIMEOUT_MS) {
        throw new ExecutionValidationError(
            "timeoutMs",
            `Execution timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds.`,
        );
    }
}

function confirmationEvidence(
    safety: ToolSafetyDecision,
    confirmation: ExecutionConfirmationRequest | undefined,
    now: () => number,
): ExecutionConfirmationEvidence | undefined {
    if (!safety.requiresConfirmation) return undefined;
    if (
        confirmation?.acknowledged !== true ||
        confirmation.acknowledgement.trim().length < 3 ||
        confirmation.acknowledgement.length > 1_000
    ) {
        throw new ExecutionConflictError(
            "This tool is not explicitly read-only, non-destructive, and closed-world; explicit confirmation is required.",
        );
    }
    return {
        acknowledged: true,
        acknowledgement: confirmation.acknowledgement.trim(),
        confirmed_at: timestamp(now()),
    };
}

function effectFor(safety: ToolSafetyDecision): ExecutionEffect {
    if (safety.classification === "explicitly_read_only") return "read_only";
    if (safety.classification === "unknown") return "unknown";
    return "consequential";
}

function classifyExecutionError(
    error: unknown,
    cancelledByUser: boolean,
    redactor: SecretRedactor,
    now: number,
): { status: ExecutionStatus; error: ExecutionError } {
    if (cancelledByUser || (error instanceof Error && error.name === "AbortError")) {
        return {
            status: "cancelled",
            error: cancellationError(now),
        };
    }
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        return {
            status: "timed_out",
            error: {
                category: "timeout",
                code: "request_timeout",
                message: "The MCP tool call exceeded its configured timeout.",
                occurred_at: timestamp(now),
                retryable: true,
            },
        };
    }

    const message = redactor.redactText(error instanceof Error ? error.message : String(error));
    const lower = message.toLowerCase();
    const category: ExecutionErrorCategory = /401|403|unauthori[sz]ed|forbidden|authentication/u.test(lower)
        ? "authentication"
        : error instanceof SyntaxError
          ? "serialization"
          : error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
            ? "transport"
            : error instanceof ProtocolError
              ? "protocol"
              : "transport";
    return {
        status: "failed",
        error: {
            category,
            code: error instanceof ProtocolError ? `mcp_${error.code}` : `${category}_failure`,
            message,
            occurred_at: timestamp(now),
            retryable: category === "transport" || category === "authentication",
        },
    };
}

function cancellationError(now: number): ExecutionError {
    return {
        category: "cancelled",
        code: "cancelled",
        message: "Execution was cancelled.",
        occurred_at: timestamp(now),
        retryable: false,
    };
}

function sanitizeObject(value: Record<string, unknown>, redactor: SecretRedactor): Record<string, unknown> {
    const sanitized = redactor.redact(value);
    return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
        ? sanitized as Record<string, unknown>
        : {};
}

function requestFingerprint(request: StartExecutionRequest): string {
    return createHash("sha256").update(canonicalJson({
        workspaceId: request.workspaceId,
        serverId: request.serverId,
        toolName: request.toolName,
        arguments: request.arguments ?? {},
        timeoutMs: request.timeoutMs,
        confirmation: request.confirmation,
    })).digest("hex");
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function finish(record: ExecutionRecord, startedMs: number, completedMs: number): void {
    record.completedAt = timestamp(completedMs);
    record.durationMs = Math.max(0, completedMs - startedMs);
}

function timestamp(value: number): string {
    return new Date(value).toISOString();
}

function jsonPointer(path: PropertyKey[]): string {
    if (path.length === 0) return "/";
    return `/${path.map((part) => String(part).replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
}

function isTerminal(status: ExecutionStatus): boolean {
    return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function telemetryTransport(kind: ConnectionSnapshot["kind"]): "stdio" | "streamable_http" | "inproc" | "builtin" {
    return kind === "streamable-http" ? "streamable_http" : kind;
}
