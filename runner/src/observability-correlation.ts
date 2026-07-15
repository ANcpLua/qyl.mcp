import { createHash } from "node:crypto";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { ProtocolExecutionCorrelation } from "./protocol-journal.js";
import { SecretRedactor } from "./secret-redactor.js";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;
const DEFAULT_MAX_EXECUTIONS = 10_000;

export interface WorkbenchExecutionCorrelationSeed {
    executionId: string;
    workspaceId?: string;
    evaluationRunId?: string;
    testCaseId?: string;
}

export interface McpRequestLinkInput {
    executionId: string;
    serverId: string;
    requestId: RequestId;
    method: string;
}

export interface McpRequestLink extends WorkbenchExecutionCorrelationSeed {
    serverId: string;
    method: string;
}

export interface WorkbenchTelemetryCorrelation {
    executionId: string;
    evaluationRunId?: string;
    testCaseId?: string;
    traceIds: string[];
    spanIds: string[];
}

interface MutableExecutionCorrelation extends WorkbenchExecutionCorrelationSeed {
    traceIds: Set<string>;
    spanIds: Set<string>;
    requestKeys: Set<string>;
}

export interface WorkbenchCorrelationRegistryOptions {
    maxExecutions?: number;
    redactor?: SecretRedactor;
}

/**
 * Bounded correlation index joining an evaluation/test to its execution, MCP
 * request, exported client span, and downstream trace. It stores no MCP
 * arguments, results, headers, credentials, log bodies, or telemetry payloads.
 */
export class WorkbenchCorrelationRegistry {
    private readonly executions = new Map<string, MutableExecutionCorrelation>();
    private readonly requests = new Map<string, McpRequestLink>();
    private readonly maxExecutions: number;
    private readonly redactor: SecretRedactor;

    constructor(options: WorkbenchCorrelationRegistryOptions = {}) {
        this.maxExecutions = positiveInteger(
            options.maxExecutions ?? DEFAULT_MAX_EXECUTIONS,
            "maxExecutions",
        );
        this.redactor = options.redactor ?? new SecretRedactor();
    }

    beginExecution(seed: WorkbenchExecutionCorrelationSeed): ProtocolExecutionCorrelation {
        const normalized = normalizeSeed(seed);
        const previous = this.executions.get(normalized.executionId);
        if (previous) {
            assertSeedMatches(previous, normalized);
            return protocolCorrelation(previous);
        }

        this.executions.set(normalized.executionId, {
            ...normalized,
            traceIds: new Set(),
            spanIds: new Set(),
            requestKeys: new Set(),
        });
        this.trim();
        return protocolCorrelation(normalized);
    }

    linkMcpRequest(input: McpRequestLinkInput): McpRequestLink {
        const execution = this.requireExecution(input.executionId);
        const serverId = identifier(input.serverId, "serverId");
        const method = this.redactor.redactText(input.method).trim();
        if (method.length === 0) throw new Error("method must not be empty.");

        const key = requestKey(serverId, input.requestId);
        const existing = this.requests.get(key);
        if (existing && existing.executionId !== execution.executionId) {
            throw new Error("MCP request identifier is already linked to another execution.");
        }

        const link: McpRequestLink = {
            ...seedSnapshot(execution),
            serverId,
            method,
        };
        this.requests.set(key, link);
        execution.requestKeys.add(key);
        return { ...link };
    }

    resolveMcpRequest(serverId: string, requestId: RequestId): McpRequestLink | undefined {
        const link = this.requests.get(requestKey(identifier(serverId, "serverId"), requestId));
        return link === undefined ? undefined : { ...link };
    }

    linkTelemetry(executionId: string, traceId: string, spanId?: string): WorkbenchTelemetryCorrelation {
        const execution = this.requireExecution(executionId);
        execution.traceIds.add(w3cId(traceId, TRACE_ID_PATTERN, "traceId"));
        if (spanId !== undefined) {
            execution.spanIds.add(w3cId(spanId, SPAN_ID_PATTERN, "spanId"));
        }
        return telemetrySnapshot(execution);
    }

    correlation(executionId: string): WorkbenchTelemetryCorrelation | undefined {
        const execution = this.executions.get(executionId);
        return execution === undefined ? undefined : telemetrySnapshot(execution);
    }

    forget(executionId: string): boolean {
        const execution = this.executions.get(executionId);
        if (!execution) return false;
        for (const key of execution.requestKeys) this.requests.delete(key);
        return this.executions.delete(executionId);
    }

    private requireExecution(executionId: string): MutableExecutionCorrelation {
        const normalizedId = identifier(executionId, "executionId");
        const execution = this.executions.get(normalizedId);
        if (!execution) throw new Error(`Execution '${normalizedId}' has no correlation context.`);
        return execution;
    }

    private trim(): void {
        while (this.executions.size > this.maxExecutions) {
            const oldest = this.executions.keys().next().value as string | undefined;
            if (oldest === undefined) return;
            this.forget(oldest);
        }
    }
}

function normalizeSeed(seed: WorkbenchExecutionCorrelationSeed): WorkbenchExecutionCorrelationSeed {
    return {
        executionId: identifier(seed.executionId, "executionId"),
        ...(seed.workspaceId === undefined
            ? {}
            : { workspaceId: identifier(seed.workspaceId, "workspaceId") }),
        ...(seed.evaluationRunId === undefined
            ? {}
            : { evaluationRunId: identifier(seed.evaluationRunId, "evaluationRunId") }),
        ...(seed.testCaseId === undefined
            ? {}
            : { testCaseId: identifier(seed.testCaseId, "testCaseId") }),
    };
}

function identifier(value: string, name: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 256) {
        throw new Error(`${name} must contain between 1 and 256 characters.`);
    }
    return normalized;
}

function w3cId(value: string, pattern: RegExp, name: string): string {
    if (!pattern.test(value)) throw new Error(`${name} is not a valid W3C telemetry identifier.`);
    return value.toLowerCase();
}

function requestKey(serverId: string, requestId: RequestId): string {
    const serialized = typeof requestId === "number"
        ? `n:${String(requestId)}`
        : `s:${requestId}`;
    const digest = createHash("sha256").update(serialized).digest("hex");
    return `${serverId}\u0000${digest}`;
}

function seedSnapshot(
    correlation: WorkbenchExecutionCorrelationSeed,
): WorkbenchExecutionCorrelationSeed {
    return {
        executionId: correlation.executionId,
        ...(correlation.workspaceId === undefined ? {} : { workspaceId: correlation.workspaceId }),
        ...(correlation.evaluationRunId === undefined
            ? {}
            : { evaluationRunId: correlation.evaluationRunId }),
        ...(correlation.testCaseId === undefined ? {} : { testCaseId: correlation.testCaseId }),
    };
}

function protocolCorrelation(
    correlation: WorkbenchExecutionCorrelationSeed,
): ProtocolExecutionCorrelation {
    return seedSnapshot(correlation);
}

function telemetrySnapshot(
    correlation: MutableExecutionCorrelation,
): WorkbenchTelemetryCorrelation {
    return {
        executionId: correlation.executionId,
        ...(correlation.evaluationRunId === undefined
            ? {}
            : { evaluationRunId: correlation.evaluationRunId }),
        ...(correlation.testCaseId === undefined ? {} : { testCaseId: correlation.testCaseId }),
        traceIds: [...correlation.traceIds],
        spanIds: [...correlation.spanIds],
    };
}

function assertSeedMatches(
    current: WorkbenchExecutionCorrelationSeed,
    candidate: WorkbenchExecutionCorrelationSeed,
): void {
    for (const key of ["workspaceId", "evaluationRunId", "testCaseId"] as const) {
        if (current[key] !== candidate[key]) {
            throw new Error(`Execution correlation cannot change ${key}.`);
        }
    }
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}
