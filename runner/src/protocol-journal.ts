import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    JSONRPCMessageSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    type JSONRPCMessage,
    type MessageExtraInfo,
    type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { SecretRedactor } from "./secret-redactor.js";

export type ProtocolDirection = "outbound" | "inbound";
export type ProtocolMessageKind = "request" | "notification" | "response" | "error_response";

export interface ProtocolExecutionCorrelation {
    executionId: string;
    workspaceId?: string;
    testCaseId?: string;
    evaluationRunId?: string;
}

interface ProtocolJournalEntryBase {
    sequence: number;
    timestamp: string;
    timestampMs: number;
    correlation?: ProtocolExecutionCorrelation;
}

export interface ProtocolMessageEntry extends ProtocolJournalEntryBase {
    kind: "message";
    direction: ProtocolDirection;
    messageKind: ProtocolMessageKind;
    method?: string;
    requestId?: RequestId;
    durationMs?: number;
    payload: unknown;
}

export interface ProtocolTransportErrorEntry extends ProtocolJournalEntryBase {
    kind: "transport_error";
    message: string;
}

export interface ProtocolTransportCloseEntry extends ProtocolJournalEntryBase {
    kind: "transport_close";
}

export interface ProtocolObserverErrorEntry extends ProtocolJournalEntryBase {
    kind: "observer_error";
    message: string;
}

export type ProtocolJournalEntry =
    | ProtocolMessageEntry
    | ProtocolTransportErrorEntry
    | ProtocolTransportCloseEntry
    | ProtocolObserverErrorEntry;

export interface ProtocolJournalOptions {
    maxEntries?: number;
    maxPayloadCharacters?: number;
    /** First connection-global SSE sequence allocated by this journal generation. */
    initialSequence?: number;
    redactor?: SecretRedactor;
    now?: () => number;
    onOperation?: (operation: CompletedProtocolOperation) => void;
}

interface PendingRequest {
    timestampMs: number;
    method: string;
    correlation?: ProtocolExecutionCorrelation;
    target: ProtocolOperationTarget;
}

export interface ProtocolOperationTarget {
    toolName?: string;
    promptName?: string;
    resourceUri?: string;
}

export interface CompletedProtocolOperation extends ProtocolOperationTarget {
    role: "client" | "server";
    direction: ProtocolDirection;
    method: string;
    requestId?: RequestId;
    correlation?: ProtocolExecutionCorrelation;
    startTimeMs: number;
    endTimeMs: number;
    errorType?: string;
    rpcResponseStatusCode?: string;
}

/** Bounded, sanitized record of messages already validated by the MCP SDK. */
export class ProtocolJournal {
    private readonly entries: ProtocolJournalEntry[] = [];
    private readonly pendingRequests = new Map<string, PendingRequest>();
    private readonly subscribers = new Set<(entry: ProtocolJournalEntry) => void>();
    private readonly maxEntries: number;
    private readonly maxPayloadCharacters: number;
    private readonly redactor: SecretRedactor;
    private readonly now: () => number;
    private readonly onOperation?: (operation: CompletedProtocolOperation) => void;
    private nextSequence: number;

    constructor(options: ProtocolJournalOptions = {}) {
        this.maxEntries = positiveInteger(options.maxEntries ?? 1_000, "maxEntries");
        this.maxPayloadCharacters = positiveInteger(
            options.maxPayloadCharacters ?? 64_000,
            "maxPayloadCharacters",
        );
        this.redactor = options.redactor ?? new SecretRedactor();
        this.now = options.now ?? Date.now;
        this.onOperation = options.onOperation;
        this.nextSequence = positiveInteger(options.initialSequence ?? 1, "initialSequence");
    }

    snapshot(): readonly ProtocolJournalEntry[] {
        return structuredClone(this.entries);
    }

    highWaterMark(): number {
        return this.nextSequence - 1;
    }

    subscribe(push: (entry: ProtocolJournalEntry) => void): () => void {
        this.subscribers.add(push);
        return () => this.subscribers.delete(push);
    }

    recordMessage(
        direction: ProtocolDirection,
        message: JSONRPCMessage,
        correlation?: ProtocolExecutionCorrelation,
    ): ProtocolMessageEntry | undefined {
        const parsed = JSONRPCMessageSchema.safeParse(message);
        if (!parsed.success) {
            this.recordTransportError(new Error("MCP SDK message validation failed before journaling."), correlation);
            return undefined;
        }

        const timestampMs = this.now();
        let messageKind: ProtocolMessageKind;
        let method: string | undefined;
        let requestId: RequestId | undefined;
        let durationMs: number | undefined;
        let effectiveCorrelation = correlation;
        let completedOperation: CompletedProtocolOperation | undefined;

        if (isJSONRPCRequest(parsed.data)) {
            messageKind = "request";
            method = parsed.data.method;
            requestId = parsed.data.id;
            this.trackRequest(direction, requestId, {
                timestampMs,
                method,
                correlation,
                target: operationTarget(parsed.data.method, parsed.data.params),
            });
        } else if (isJSONRPCNotification(parsed.data)) {
            messageKind = "notification";
            method = parsed.data.method;
            completedOperation = {
                role: direction === "outbound" ? "client" : "server",
                direction,
                method,
                ...(correlation === undefined ? {} : { correlation }),
                startTimeMs: timestampMs,
                endTimeMs: timestampMs,
                ...operationTarget(parsed.data.method, parsed.data.params),
            };
        } else if (isJSONRPCResultResponse(parsed.data)) {
            messageKind = "response";
            requestId = parsed.data.id;
            const matched = this.matchResponse(direction, requestId);
            if (matched) {
                method = matched.method;
                durationMs = Math.max(0, timestampMs - matched.timestampMs);
                effectiveCorrelation = matched.correlation ?? correlation;
                completedOperation = completedFromResponse(
                    direction,
                    requestId,
                    matched,
                    timestampMs,
                    effectiveCorrelation,
                    resultIsToolError(parsed.data.result) ? "tool_error" : undefined,
                );
            }
        } else if (isJSONRPCErrorResponse(parsed.data)) {
            messageKind = "error_response";
            requestId = parsed.data.id;
            if (requestId !== undefined) {
                const matched = this.matchResponse(direction, requestId);
                if (matched) {
                    method = matched.method;
                    durationMs = Math.max(0, timestampMs - matched.timestampMs);
                    effectiveCorrelation = matched.correlation ?? correlation;
                    const statusCode = String(parsed.data.error.code);
                    completedOperation = completedFromResponse(
                        direction,
                        requestId,
                        matched,
                        timestampMs,
                        effectiveCorrelation,
                        statusCode,
                        statusCode,
                    );
                }
            }
        } else {
            // The official union is exhaustive. Keep this as a defensive runtime
            // guard in case a future SDK adds another message variant.
            return undefined;
        }

        const entry: ProtocolMessageEntry = {
            ...this.base(timestampMs, effectiveCorrelation),
            kind: "message",
            direction,
            messageKind,
            payload: this.boundPayload(this.redactor.redact(parsed.data)),
        };
        if (method !== undefined) entry.method = method;
        if (requestId !== undefined) entry.requestId = requestId;
        if (durationMs !== undefined) entry.durationMs = durationMs;
        this.append(entry);
        if (completedOperation) this.notifyOperation(completedOperation);
        return entry;
    }

    recordTransportError(
        error: unknown,
        correlation?: ProtocolExecutionCorrelation,
    ): ProtocolTransportErrorEntry {
        const timestampMs = this.now();
        const message = error instanceof Error ? error.message : String(error);
        const entry: ProtocolTransportErrorEntry = {
            ...this.base(timestampMs, correlation),
            kind: "transport_error",
            message: this.redactor.redactText(message),
        };
        this.append(entry);
        return entry;
    }

    recordTransportClose(
        correlation?: ProtocolExecutionCorrelation,
    ): ProtocolTransportCloseEntry {
        const timestampMs = this.now();
        const entry: ProtocolTransportCloseEntry = {
            ...this.base(timestampMs, correlation),
            kind: "transport_close",
        };
        this.append(entry);
        return entry;
    }

    private base(
        timestampMs: number,
        correlation?: ProtocolExecutionCorrelation,
    ): ProtocolJournalEntryBase {
        const base: ProtocolJournalEntryBase = {
            sequence: this.nextSequence++,
            timestamp: new Date(timestampMs).toISOString(),
            timestampMs,
        };
        if (correlation !== undefined) base.correlation = { ...correlation };
        return base;
    }

    private append(entry: ProtocolJournalEntry): void {
        this.store(entry);
        const observerErrors: unknown[] = [];
        for (const push of this.subscribers) {
            try {
                push(structuredClone(entry));
            } catch (error) {
                observerErrors.push(error);
            }
        }
        for (const error of observerErrors) {
            const timestampMs = this.now();
            const message = error instanceof Error ? error.message : String(error);
            this.store({
                ...this.base(timestampMs),
                kind: "observer_error",
                message: this.redactor.redactText(message),
            });
        }
    }

    private store(entry: ProtocolJournalEntry): void {
        this.entries.push(entry);
        while (this.entries.length > this.maxEntries) this.entries.shift();
    }

    private notifyOperation(operation: CompletedProtocolOperation): void {
        if (!this.onOperation) return;
        try {
            this.onOperation(structuredClone(operation));
        } catch (error) {
            const timestampMs = this.now();
            const message = error instanceof Error ? error.message : String(error);
            this.store({
                ...this.base(timestampMs, operation.correlation),
                kind: "observer_error",
                message: this.redactor.redactText(message),
            });
        }
    }

    private trackRequest(
        direction: ProtocolDirection,
        requestId: RequestId,
        request: PendingRequest,
    ): void {
        this.pendingRequests.set(pendingKey(direction, requestId), request);
        while (this.pendingRequests.size > this.maxEntries) {
            const oldest = this.pendingRequests.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.pendingRequests.delete(oldest);
        }
    }

    private matchResponse(
        direction: ProtocolDirection,
        requestId: RequestId,
    ): PendingRequest | undefined {
        const key = pendingKey(opposite(direction), requestId);
        const matched = this.pendingRequests.get(key);
        this.pendingRequests.delete(key);
        return matched;
    }

    private boundPayload(payload: unknown): unknown {
        const serialized = JSON.stringify(payload);
        if (serialized === undefined || serialized.length <= this.maxPayloadCharacters) return payload;
        return {
            truncated: true,
            originalCharacters: serialized.length,
            preview: `${serialized.slice(0, this.maxPayloadCharacters - 1)}…`,
        };
    }
}

export interface JournaledTransportOptions {
    correlation?: () => ProtocolExecutionCorrelation | undefined;
}

/** Transparent decorator over an official MCP SDK Transport. */
export class JournaledTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

    private protocolVersionValue?: string;
    private closeRecorded = false;

    constructor(
        private readonly inner: Transport,
        readonly journal: ProtocolJournal,
        private readonly options: JournaledTransportOptions = {},
    ) {}

    get sessionId(): string | undefined {
        return this.inner.sessionId;
    }

    get protocolVersion(): string | undefined {
        return this.protocolVersionValue;
    }

    async start(): Promise<void> {
        this.inner.onmessage = (message, extra) => {
            this.journal.recordMessage("inbound", message, this.options.correlation?.());
            this.onmessage?.(message, extra);
        };
        this.inner.onerror = (error) => {
            this.journal.recordTransportError(error, this.options.correlation?.());
            this.onerror?.(error);
        };
        this.inner.onclose = () => {
            this.recordCloseOnce();
            this.onclose?.();
        };

        try {
            await this.inner.start();
        } catch (error) {
            this.journal.recordTransportError(error, this.options.correlation?.());
            throw error;
        }
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        this.journal.recordMessage("outbound", message, this.options.correlation?.());
        try {
            await this.inner.send(message, options);
        } catch (error) {
            this.journal.recordTransportError(error, this.options.correlation?.());
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            await this.inner.close();
            this.recordCloseOnce();
        } catch (error) {
            this.journal.recordTransportError(error, this.options.correlation?.());
            throw error;
        }
    }

    setProtocolVersion(version: string): void {
        this.protocolVersionValue = version;
        this.inner.setProtocolVersion?.(version);
    }

    private recordCloseOnce(): void {
        if (this.closeRecorded) return;
        this.closeRecorded = true;
        this.journal.recordTransportClose(this.options.correlation?.());
    }
}

function pendingKey(direction: ProtocolDirection, requestId: RequestId): string {
    return `${direction}:${typeof requestId}:${String(requestId)}`;
}

function opposite(direction: ProtocolDirection): ProtocolDirection {
    return direction === "outbound" ? "inbound" : "outbound";
}

function completedFromResponse(
    responseDirection: ProtocolDirection,
    requestId: RequestId,
    matched: PendingRequest,
    endTimeMs: number,
    correlation: ProtocolExecutionCorrelation | undefined,
    errorType?: string,
    rpcResponseStatusCode?: string,
): CompletedProtocolOperation {
    const requestDirection = opposite(responseDirection);
    return {
        role: requestDirection === "outbound" ? "client" : "server",
        direction: requestDirection,
        method: matched.method,
        requestId,
        ...(correlation === undefined ? {} : { correlation }),
        startTimeMs: matched.timestampMs,
        endTimeMs,
        ...matched.target,
        ...(errorType === undefined ? {} : { errorType }),
        ...(rpcResponseStatusCode === undefined ? {} : { rpcResponseStatusCode }),
    };
}

function operationTarget(method: string, params: unknown): ProtocolOperationTarget {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
    const record = params as Record<string, unknown>;
    if (method === "tools/call" && typeof record.name === "string") {
        return { toolName: record.name };
    }
    if (method === "prompts/get" && typeof record.name === "string") {
        return { promptName: record.name };
    }
    if ((method === "resources/read" || method === "resources/subscribe"
        || method === "resources/unsubscribe" || method === "notifications/resources/updated")
        && typeof record.uri === "string") {
        return { resourceUri: record.uri };
    }
    return {};
}

function resultIsToolError(result: unknown): boolean {
    return typeof result === "object" && result !== null && !Array.isArray(result)
        && (result as Record<string, unknown>).isError === true;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}
