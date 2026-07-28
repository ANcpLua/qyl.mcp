import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { isJSONRPCErrorResponse, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResultResponse } from "@modelcontextprotocol/server";
import type { Transport, TransportSendOptions, JSONRPCMessage, MessageExtraInfo, RequestId } from "@modelcontextprotocol/server";
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
    /** Persist redacted MCP arguments and results. Disabled by default. */
    captureContent?: boolean;
    /** First connection-global SSE sequence allocated by this journal generation. */
    initialSequence?: number;
    redactor?: SecretRedactor;
    now?: () => number;
    onOperationStart?: (operation: StartedProtocolOperation) => ActiveProtocolOperation | undefined;
    onOperation?: (operation: CompletedProtocolOperation) => void;
}

interface PendingRequest {
    timestampMs: number;
    method: string;
    correlation?: ProtocolExecutionCorrelation;
    target: ProtocolOperationTarget;
    requestBody?: unknown;
    remotePropagation?: ProtocolPropagationCarrier;
    activeOperation?: ActiveProtocolOperation;
}

interface RecordMessageOptions {
    activeOperation?: ActiveProtocolOperation;
    /** Transport failure that prevented an outbound response from being sent. */
    responseSendErrorType?: string;
}

export interface ProtocolOperationTarget {
    toolName?: string;
    promptName?: string;
    resourceUri?: string;
}

export type ProtocolPropagationCarrier = Readonly<Record<string, string>>;

export interface StartedProtocolOperation extends ProtocolOperationTarget {
    role: "client" | "server";
    direction: ProtocolDirection;
    method: string;
    requestId?: RequestId;
    correlation?: ProtocolExecutionCorrelation;
    startTimeMs: number;
    requestBody?: unknown;
    /** Configured propagation fields extracted from inbound MCP params._meta. */
    remotePropagation?: ProtocolPropagationCarrier;
}

export interface CompletedProtocolOperation extends StartedProtocolOperation {
    endTimeMs: number;
    errorType?: string;
    errorMessage?: string;
    rpcResponseStatusCode?: string;
    responseBody?: unknown;
    /** Negotiated protocol revision supplied by the connected transport. */
    protocolVersion?: string;
}

export interface ActiveProtocolOperation {
    readonly startTimeMs: number;
    /** Configured fields to inject into the outbound MCP params._meta bag. */
    readonly propagation?: ProtocolPropagationCarrier;
    /** Run SDK dispatch with this operation as the execution-local context. */
    run<T>(operation: () => T): T;
    complete(operation: CompletedProtocolOperation): void;
}

/** Bounded, sanitized record of messages already validated by the MCP SDK. */
export class ProtocolJournal {
    private readonly entries: ProtocolJournalEntry[] = [];
    private readonly pendingRequests = new Map<string, PendingRequest>();
    private readonly subscribers = new Set<(entry: ProtocolJournalEntry) => void>();
    private readonly maxEntries: number;
    private readonly maxPayloadCharacters: number;
    private readonly captureContent: boolean;
    private readonly redactor: SecretRedactor;
    private readonly now: () => number;
    private readonly onOperationStart?: (
        operation: StartedProtocolOperation,
    ) => ActiveProtocolOperation | undefined;
    private readonly onOperation?: (operation: CompletedProtocolOperation) => void;
    private nextSequence: number;

    constructor(options: ProtocolJournalOptions = {}) {
        this.maxEntries = positiveInteger(options.maxEntries ?? 1_000, "maxEntries");
        this.maxPayloadCharacters = positiveInteger(
            options.maxPayloadCharacters ?? 64_000,
            "maxPayloadCharacters",
        );
        this.captureContent = options.captureContent ?? false;
        this.redactor = options.redactor ?? new SecretRedactor();
        this.now = options.now ?? Date.now;
        this.onOperationStart = options.onOperationStart;
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

    /** Start a JSON-RPC request or notification before transport dispatch. */
    startOperation(
        direction: ProtocolDirection,
        message: JSONRPCMessage,
        correlation?: ProtocolExecutionCorrelation,
    ): ActiveProtocolOperation | undefined {
        if (!this.onOperationStart) return undefined;
        const parsed = JSONRPCMessageSchema.safeParse(message);
        if (!parsed.success
            || (!isJSONRPCRequest(parsed.data) && !isJSONRPCNotification(parsed.data))) {
            return undefined;
        }
        const started: StartedProtocolOperation = {
            role: direction === "outbound" ? "client" : "server",
            direction,
            method: parsed.data.method,
            ...(isJSONRPCRequest(parsed.data) ? { requestId: parsed.data.id } : {}),
            ...(correlation === undefined ? {} : { correlation }),
            startTimeMs: this.now(),
            ...operationTarget(parsed.data.method, parsed.data.params),
            ...(this.captureContent
                ? { requestBody: this.contentPayload(parsed.data) }
                : {}),
            ...(direction === "inbound" ? optionalRemotePropagation(parsed.data.params) : {}),
        };
        try {
            const active = this.onOperationStart(structuredClone(started));
            if (active === undefined) return undefined;
            return {
                startTimeMs: started.startTimeMs,
                ...(active.propagation === undefined ? {} : { propagation: active.propagation }),
                run: (operation) => active.run(operation),
                complete: (operation) => active.complete(operation),
            };
        } catch (error) {
            this.recordObserverError(error, correlation);
            return undefined;
        }
    }

    recordMessage(
        direction: ProtocolDirection,
        message: JSONRPCMessage,
        correlation?: ProtocolExecutionCorrelation,
        options: RecordMessageOptions = {},
    ): ProtocolMessageEntry | undefined {
        const parsed = JSONRPCMessageSchema.safeParse(message);
        if (!parsed.success) {
            this.recordTransportError(new Error("MCP SDK message validation failed before journaling."), correlation);
            return undefined;
        }

        const activeOperation = options.activeOperation;
        const timestampMs = activeOperation?.startTimeMs ?? this.now();
        let messageKind: ProtocolMessageKind;
        let method: string | undefined;
        let requestId: RequestId | undefined;
        let durationMs: number | undefined;
        let effectiveCorrelation = correlation;
        let completedOperation: CompletedProtocolOperation | undefined;
        let completedOperationActive: ActiveProtocolOperation | undefined;

        if (isJSONRPCRequest(parsed.data)) {
            messageKind = "request";
            method = parsed.data.method;
            requestId = parsed.data.id;
            this.trackRequest(direction, requestId, {
                timestampMs,
                method,
                correlation,
                target: operationTarget(parsed.data.method, parsed.data.params),
                ...(this.captureContent
                    ? { requestBody: this.contentPayload(parsed.data) }
                    : {}),
                ...(direction === "inbound" ? optionalRemotePropagation(parsed.data.params) : {}),
                ...(activeOperation === undefined
                    ? {}
                    : { activeOperation }),
            });
        } else if (isJSONRPCNotification(parsed.data)) {
            messageKind = "notification";
            method = parsed.data.method;
        } else if (isJSONRPCResultResponse(parsed.data)) {
            messageKind = "response";
            requestId = parsed.data.id;
            const matched = this.matchResponse(direction, requestId);
            if (matched) {
                completedOperationActive = matched.activeOperation;
                method = matched.method;
                durationMs = Math.max(0, timestampMs - matched.timestampMs);
                effectiveCorrelation = matched.correlation ?? correlation;
                completedOperation = completedFromResponse(
                    direction,
                    requestId,
                    matched,
                    timestampMs,
                    effectiveCorrelation,
                    options.responseSendErrorType
                        ?? (resultIsToolError(parsed.data.result) ? "tool_error" : undefined),
                    undefined,
                    undefined,
                    this.captureContent ? this.contentPayload(parsed.data) : undefined,
                );
            }
        } else if (isJSONRPCErrorResponse(parsed.data)) {
            messageKind = "error_response";
            requestId = parsed.data.id;
            if (requestId !== undefined) {
                const matched = this.matchResponse(direction, requestId);
                if (matched) {
                    completedOperationActive = matched.activeOperation;
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
                        options.responseSendErrorType ?? statusCode,
                        statusCode,
                        this.redactor.redactText(parsed.data.error.message),
                        this.captureContent ? this.contentPayload(parsed.data) : undefined,
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
            payload: this.journalPayload(parsed.data),
        };
        if (method !== undefined) entry.method = method;
        if (requestId !== undefined) {
            entry.requestId = sanitizeMetadataId(requestId, this.redactor);
        }
        if (durationMs !== undefined) entry.durationMs = durationMs;
        this.append(entry);
        if (completedOperation) this.notifyOperation(completedOperation, completedOperationActive);
        return entry;
    }

    /** Complete notification timing after transport send or local dispatch. */
    completeNotification(
        direction: ProtocolDirection,
        message: JSONRPCMessage,
        startTimeMs: number,
        correlation?: ProtocolExecutionCorrelation,
        errorType?: string,
        activeOperation?: ActiveProtocolOperation,
    ): void {
        const parsed = JSONRPCMessageSchema.safeParse(message);
        if (!parsed.success || !isJSONRPCNotification(parsed.data)) return;
        const endTimeMs = this.now();
        this.notifyOperation({
            role: direction === "outbound" ? "client" : "server",
            direction,
            method: parsed.data.method,
            ...(correlation === undefined ? {} : { correlation }),
            startTimeMs,
            endTimeMs: Math.max(startTimeMs, endTimeMs),
            ...operationTarget(parsed.data.method, parsed.data.params),
            ...(direction === "inbound" ? optionalRemotePropagation(parsed.data.params) : {}),
            ...(errorType === undefined ? {} : { errorType }),
        }, activeOperation);
    }

    /** Complete a request whose transport send failed before any response. */
    completeRequestFailure(
        direction: ProtocolDirection,
        message: JSONRPCMessage,
        correlation: ProtocolExecutionCorrelation | undefined,
        errorType: string,
        errorMessage?: string,
    ): void {
        const parsed = JSONRPCMessageSchema.safeParse(message);
        if (!parsed.success || !isJSONRPCRequest(parsed.data)) return;
        const key = pendingKey(direction, parsed.data.id);
        const pending = this.pendingRequests.get(key);
        this.pendingRequests.delete(key);
        if (pending === undefined) return;
        const effectiveCorrelation = pending.correlation ?? correlation;
        this.notifyOperation({
            role: direction === "outbound" ? "client" : "server",
            direction,
            method: pending.method,
            requestId: parsed.data.id,
            ...(effectiveCorrelation === undefined ? {} : { correlation: effectiveCorrelation }),
            startTimeMs: pending.timestampMs,
            endTimeMs: Math.max(pending.timestampMs, this.now()),
            ...pending.target,
            ...(pending.requestBody === undefined ? {} : { requestBody: pending.requestBody }),
            ...(direction === "inbound" && pending.remotePropagation !== undefined
                ? { remotePropagation: pending.remotePropagation }
                : {}),
            errorType,
            ...(errorMessage === undefined
                ? {}
                : { errorMessage: this.redactor.redactText(errorMessage) }),
            responseBody: {
                error: {
                    type: errorType,
                    ...(errorMessage === undefined
                        ? {}
                        : { message: this.redactor.redactText(errorMessage) }),
                },
            },
        }, pending.activeOperation);
    }

    /** Finish requests that cannot receive a response after transport close. */
    failPendingOperations(errorType: string): void {
        const endTimeMs = this.now();
        for (const [key, pending] of this.pendingRequests) {
            const direction = key.startsWith("outbound:") ? "outbound" : "inbound";
            const requestId = requestIdFromPendingKey(key);
            this.pendingRequests.delete(key);
            this.notifyOperation({
                role: direction === "outbound" ? "client" : "server",
                direction,
                method: pending.method,
                ...(requestId === undefined ? {} : { requestId }),
                ...(pending.correlation === undefined ? {} : { correlation: pending.correlation }),
                startTimeMs: pending.timestampMs,
                endTimeMs: Math.max(pending.timestampMs, endTimeMs),
                ...pending.target,
                ...(pending.requestBody === undefined ? {} : { requestBody: pending.requestBody }),
                ...(direction === "inbound" && pending.remotePropagation !== undefined
                    ? { remotePropagation: pending.remotePropagation }
                    : {}),
                errorType,
            }, pending.activeOperation);
        }
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
        this.failPendingOperations("connection_closed");
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

    private notifyOperation(
        operation: CompletedProtocolOperation,
        activeOperation?: ActiveProtocolOperation,
    ): void {
        if (activeOperation !== undefined) {
            try {
                activeOperation.complete(structuredClone(operation));
            } catch (error) {
                this.recordObserverError(error, operation.correlation);
            }
        }
        if (!this.onOperation) return;
        try {
            const summary = structuredClone(operation);
            delete summary.requestBody;
            delete summary.responseBody;
            delete summary.errorMessage;
            this.onOperation(summary);
        } catch (error) {
            this.recordObserverError(error, operation.correlation);
        }
    }

    private recordObserverError(
        error: unknown,
        correlation?: ProtocolExecutionCorrelation,
    ): void {
        const timestampMs = this.now();
        const message = error instanceof Error ? error.message : String(error);
        this.store({
            ...this.base(timestampMs, correlation),
            kind: "observer_error",
            message: this.redactor.redactText(message),
        });
    }

    private trackRequest(
        direction: ProtocolDirection,
        requestId: RequestId,
        request: PendingRequest,
    ): void {
        const key = pendingKey(direction, requestId);
        const replaced = this.pendingRequests.get(key);
        if (replaced !== undefined) {
            this.notifyOperation({
                role: direction === "outbound" ? "client" : "server",
                direction,
                method: replaced.method,
                requestId,
                ...(replaced.correlation === undefined ? {} : { correlation: replaced.correlation }),
                startTimeMs: replaced.timestampMs,
                endTimeMs: Math.max(replaced.timestampMs, this.now()),
                ...replaced.target,
                ...(replaced.requestBody === undefined ? {} : { requestBody: replaced.requestBody }),
                ...(direction === "inbound" && replaced.remotePropagation !== undefined
                    ? { remotePropagation: replaced.remotePropagation }
                    : {}),
                errorType: "request_id_reused",
            }, replaced.activeOperation);
            this.pendingRequests.delete(key);
        }
        this.pendingRequests.set(key, request);
        while (this.pendingRequests.size > this.maxEntries) {
            const oldest = this.pendingRequests.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            const evicted = this.pendingRequests.get(oldest);
            this.pendingRequests.delete(oldest);
            if (evicted !== undefined) {
                const direction = oldest.startsWith("outbound:") ? "outbound" : "inbound";
                const requestId = requestIdFromPendingKey(oldest);
                this.notifyOperation({
                    role: direction === "outbound" ? "client" : "server",
                    direction,
                    method: evicted.method,
                    ...(requestId === undefined ? {} : { requestId }),
                    ...(evicted.correlation === undefined ? {} : { correlation: evicted.correlation }),
                    startTimeMs: evicted.timestampMs,
                    endTimeMs: Math.max(evicted.timestampMs, this.now()),
                    ...evicted.target,
                    ...(evicted.requestBody === undefined ? {} : { requestBody: evicted.requestBody }),
                    ...(direction === "inbound" && evicted.remotePropagation !== undefined
                        ? { remotePropagation: evicted.remotePropagation }
                        : {}),
                    errorType: "pending_operation_evicted",
                }, evicted.activeOperation);
            }
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

    private contentPayload(message: JSONRPCMessage): unknown {
        return this.boundPayload(this.redactor.redact(message));
    }

    private journalPayload(message: JSONRPCMessage): unknown {
        return this.captureContent
            ? this.contentPayload(message)
            : metadataOnlyMessage(message, this.redactor);
    }
}

export interface JournaledTransportOptions {
    correlation?: () => ProtocolExecutionCorrelation | undefined;
    propagation?: () => ProtocolPropagationCarrier | undefined;
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

    get hasPerRequestStream(): boolean | undefined {
        return this.inner.hasPerRequestStream;
    }

    async start(): Promise<void> {
        this.inner.onmessage = (message, extra) => {
            const correlation = this.options.correlation?.();
            const activeOperation = this.journal.startOperation("inbound", message, correlation);
            const entry = this.journal.recordMessage(
                "inbound",
                message,
                correlation,
                activeOperation === undefined ? {} : { activeOperation },
            );
            if (!isJSONRPCNotification(message)) {
                try {
                    runActiveOperation(activeOperation, () => this.onmessage?.(message, extra));
                } catch (error) {
                    if (isJSONRPCRequest(message)) {
                        this.journal.completeRequestFailure(
                            "inbound",
                            message,
                            correlation,
                            operationErrorType(error),
                            operationErrorMessage(error),
                        );
                    }
                    throw error;
                }
                return;
            }
            try {
                runActiveOperation(activeOperation, () => this.onmessage?.(message, extra));
                this.journal.completeNotification(
                    "inbound",
                    message,
                    entry?.timestampMs ?? Date.now(),
                    correlation,
                    undefined,
                    activeOperation,
                );
            } catch (error) {
                this.journal.completeNotification(
                    "inbound",
                    message,
                    entry?.timestampMs ?? Date.now(),
                    correlation,
                    operationErrorType(error),
                    activeOperation,
                );
                throw error;
            }
        };
        this.inner.onerror = (error) => {
            this.journal.recordTransportError(error, this.options.correlation?.());
            this.journal.failPendingOperations(operationErrorType(error));
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
        const correlation = this.options.correlation?.();
        const activeOperation = this.journal.startOperation("outbound", message, correlation);
        const contextualMessage = injectPropagation(
            message,
            activeOperation?.propagation ?? this.options.propagation?.(),
        );
        const isResponse = isJSONRPCResultResponse(contextualMessage)
            || isJSONRPCErrorResponse(contextualMessage);
        // Requests must be tracked before the send so a fast response can match
        // them. Responses are journaled only after the send settles so the server
        // operation covers the actual response delivery attempt.
        const entry = isResponse
            ? undefined
            : this.journal.recordMessage(
                "outbound",
                contextualMessage,
                correlation,
                activeOperation === undefined ? {} : { activeOperation },
            );
        try {
            await this.inner.send(contextualMessage, options);
            if (isResponse) {
                this.journal.recordMessage("outbound", contextualMessage, correlation);
            }
            if (isJSONRPCNotification(contextualMessage)) {
                this.journal.completeNotification(
                    "outbound",
                    contextualMessage,
                    entry?.timestampMs ?? Date.now(),
                    correlation,
                    undefined,
                    activeOperation,
                );
            }
        } catch (error) {
            const errorType = operationErrorType(error);
            if (isResponse) {
                this.journal.recordMessage(
                    "outbound",
                    contextualMessage,
                    correlation,
                    { responseSendErrorType: errorType },
                );
            } else {
                this.journal.completeRequestFailure(
                    "outbound",
                    contextualMessage,
                    correlation,
                    errorType,
                    operationErrorMessage(error),
                );
            }
            this.journal.recordTransportError(error, this.options.correlation?.());
            if (isJSONRPCNotification(contextualMessage)) {
                this.journal.completeNotification(
                    "outbound",
                    contextualMessage,
                    entry?.timestampMs ?? Date.now(),
                    correlation,
                    errorType,
                    activeOperation,
                );
            }
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

function requestIdFromPendingKey(key: string): RequestId | undefined {
    const first = key.indexOf(":");
    const second = key.indexOf(":", first + 1);
    if (first < 0 || second < 0) return undefined;
    const type = key.slice(first + 1, second);
    const value = key.slice(second + 1);
    if (type === "string") return value;
    if (type === "number") {
        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }
    return undefined;
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
    errorMessage?: string,
    responseBody?: unknown,
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
        ...(matched.requestBody === undefined ? {} : { requestBody: matched.requestBody }),
        ...(requestDirection === "inbound" && matched.remotePropagation !== undefined
            ? { remotePropagation: matched.remotePropagation }
            : {}),
        ...(errorType === undefined ? {} : { errorType }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
        ...(rpcResponseStatusCode === undefined ? {} : { rpcResponseStatusCode }),
        ...(responseBody === undefined ? {} : { responseBody }),
    };
}

function optionalRemotePropagation(
    params: unknown,
): { remotePropagation: ProtocolPropagationCarrier } | Record<never, never> {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
    const meta = (params as Record<string, unknown>)._meta;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return {};
    const carrier = sanitizePropagationCarrier(meta as Record<string, unknown>);
    return Object.keys(carrier).length === 0 ? {} : { remotePropagation: carrier };
}

function metadataOnlyMessage(
    message: JSONRPCMessage,
    redactor: SecretRedactor,
): unknown {
    if (isJSONRPCRequest(message) || isJSONRPCNotification(message)) {
        const target = operationTarget(message.method, message.params);
        return {
            jsonrpc: message.jsonrpc,
            ...(isJSONRPCRequest(message) ? { id: sanitizeMetadataId(message.id, redactor) } : {}),
            method: message.method,
            ...(target.toolName === undefined
                ? {}
                : { toolName: redactor.redactText(target.toolName).slice(0, 1_024) }),
            ...(target.promptName === undefined
                ? {}
                : { promptName: redactor.redactText(target.promptName).slice(0, 1_024) }),
            ...(target.resourceUri === undefined
                ? {}
                : { resourceUri: redactor.redactUri(target.resourceUri) }),
        };
    }
    if (isJSONRPCResultResponse(message)) {
        return {
            jsonrpc: message.jsonrpc,
            id: sanitizeMetadataId(message.id, redactor),
            result: {
                ...(resultIsToolError(message.result) ? { isError: true } : {}),
            },
        };
    }
    return {
        jsonrpc: message.jsonrpc,
        ...(message.id === undefined ? {} : { id: sanitizeMetadataId(message.id, redactor) }),
        error: { code: message.error.code },
    };
}

function sanitizeMetadataId(
    value: RequestId,
    redactor: SecretRedactor,
): RequestId {
    return typeof value === "string"
        ? redactor.redactText(value).slice(0, 2_048)
        : value;
}

function isValidTraceparent(value: string): boolean {
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(value);
    return match !== null
        && match[1] !== "00000000000000000000000000000000"
        && match[2] !== "0000000000000000";
}

function operationErrorType(error: unknown): string {
    return error instanceof Error && error.name !== "Error" && error.name.length > 0
        ? error.name
        : "transport_error";
}

function operationErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function runActiveOperation<T>(
    activeOperation: ActiveProtocolOperation | undefined,
    operation: () => T,
): T {
    return activeOperation === undefined ? operation() : activeOperation.run(operation);
}

function injectPropagation(
    message: JSONRPCMessage,
    propagation: ProtocolPropagationCarrier | undefined,
): JSONRPCMessage {
    if (propagation === undefined
        || (!isJSONRPCRequest(message) && !isJSONRPCNotification(message))) return message;
    const carrier = sanitizePropagationCarrier(propagation);
    if (Object.keys(carrier).length === 0) return message;
    if (message.params !== undefined
        && (typeof message.params !== "object"
            || message.params === null
            || Array.isArray(message.params))) {
        return message;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    const existingMeta = typeof params._meta === "object"
        && params._meta !== null
        && !Array.isArray(params._meta)
        ? params._meta as Record<string, unknown>
        : {};
    return {
        ...message,
        params: {
            ...params,
            _meta: {
                ...existingMeta,
                ...carrier,
            },
        },
    };
}

function sanitizePropagationCarrier(
    value: Readonly<Record<string, unknown>>,
): Record<string, string> {
    const carrier = Object.create(null) as Record<string, string>;
    for (const [key, entry] of prioritizedPropagationEntries(value)) {
        if (key.length === 0 || key.length > 256 || typeof entry !== "string" || entry.length > 8_192) {
            continue;
        }
        if (key === "traceparent" && !isValidTraceparent(entry)) continue;
        carrier[key] = entry;
        if (Object.keys(carrier).length >= 32) break;
    }
    return carrier;
}

function prioritizedPropagationEntries(
    value: Readonly<Record<string, unknown>>,
): [string, unknown][] {
    const entries = Object.entries(value);
    const priority = new Set(["traceparent", "tracestate", "baggage"]);
    return [
        ...entries.filter(([key]) => priority.has(key)),
        ...entries.filter(([key]) => !priority.has(key)),
    ];
}

function operationTarget(method: string, params: unknown): ProtocolOperationTarget {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
    const record = params as Record<string, unknown>;
    const target: ProtocolOperationTarget = {};
    if (method === "tools/call" && typeof record.name === "string") {
        target.toolName = record.name;
    }
    if (method === "prompts/get" && typeof record.name === "string") {
        target.promptName = record.name;
    }
    if ((method === "resources/read" || method === "resources/subscribe"
        || method === "resources/unsubscribe"
        || method === "notifications/resources/updated")
        && typeof record.uri === "string") {
        target.resourceUri = record.uri;
    }
    return target;
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
