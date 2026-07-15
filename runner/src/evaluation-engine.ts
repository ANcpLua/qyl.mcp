import { randomUUID } from "node:crypto";
import type {
    RunnerMcpAssertionResult,
    RunnerMcpError,
    RunnerMcpEvaluationResultStatus,
    RunnerMcpEvaluationRunStatus,
    RunnerMcpExecutionConfirmationEvidence,
    RunnerMcpExecutionStatus,
    RunnerMcpTestAssertion,
} from "@ancplua/qyl-api-schema/types";
import {
    evaluateAssertions,
    type ExecutionOutcome,
} from "./assertions.js";

export type EvaluationCaseStatus = RunnerMcpEvaluationResultStatus;

export interface WorkbenchTestCase {
    id: string;
    workspaceId: string;
    name: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    assertions: readonly RunnerMcpTestAssertion[];
    timeoutMs: number;
    tags?: readonly string[];
}

export interface WorkbenchSuite {
    id: string;
    workspaceId: string;
    name: string;
    testCaseIds: readonly string[];
}

export interface InvocationCorrelation {
    evaluationRunId: string;
    testCaseId: string;
}

export interface EvaluationInvocationRequest {
    workspaceId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    confirmed: boolean;
    idempotencyKey: string;
    correlation: InvocationCorrelation;
}

export interface InvocationUsage {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
}

export interface EvaluationInvocationEvidence {
    executionId: string;
    status: RunnerMcpExecutionStatus;
    outcome: ExecutionOutcome;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    result?: unknown;
    errorKind?: string;
    errorMessage?: string;
    usage?: InvocationUsage;
    traceId?: string;
    spanId?: string;
}

export interface EvaluationInvocationPort {
    invoke(request: EvaluationInvocationRequest): Promise<EvaluationInvocationEvidence>;
}

export interface EvaluationCaseResult {
    testCaseId: string;
    testCaseName: string;
    status: EvaluationCaseStatus;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    executionId?: string;
    outcome?: ExecutionOutcome;
    assertionResults: readonly RunnerMcpAssertionResult[];
    message?: string;
    usage?: InvocationUsage;
    traceId?: string;
    spanId?: string;
}

export interface EvaluationSummary {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    successRate: number;
    reliability: number;
    averageLatencyMs?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    p99LatencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
}

export interface EvaluationRun {
    id: string;
    workspaceId: string;
    suiteId: string;
    suiteName: string;
    /** Immutable suite and case snapshots make historical runs self-contained. */
    suite?: WorkbenchSuite;
    testCases?: readonly WorkbenchTestCase[];
    status: RunnerMcpEvaluationRunStatus;
    startedAt: string;
    completedAt?: string;
    results: readonly EvaluationCaseResult[];
    summary: EvaluationSummary;
    /** Internal durable key; omitted from the generated HTTP representation. */
    idempotencyKey?: string;
    /** Internal durable request fingerprint; omitted from the generated HTTP representation. */
    idempotencyFingerprint?: string;
    confirmation?: RunnerMcpExecutionConfirmationEvidence;
    error?: RunnerMcpError;
}

export interface RunSuiteOptions {
    workspaceId: string;
    suite: WorkbenchSuite;
    testCases: readonly WorkbenchTestCase[];
    approvedConsequential: boolean;
    concurrency?: number;
    failFast?: boolean;
    confirmation?: RunnerMcpExecutionConfirmationEvidence;
    runId?: string;
}

export interface EvaluationRunComparison {
    baselineRunId: string;
    candidateRunId: string;
    successRateChange: number;
    reliabilityChange: number;
    p95LatencyChangeMs?: number;
    cases: readonly EvaluationCaseComparison[];
}

export interface EvaluationCaseComparison {
    testCaseId: string;
    testCaseName: string;
    baselineStatus?: EvaluationCaseStatus;
    candidateStatus?: EvaluationCaseStatus;
    statusChange: "improved" | "regressed" | "unchanged" | "added" | "removed";
    latencyChangeMs?: number;
}

export class EvaluationEngine {
    constructor(
        private readonly invocations: EvaluationInvocationPort,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async runSuite(options: RunSuiteOptions): Promise<EvaluationRun> {
        validateRunOptions(options);
        const runId = options.runId ?? randomUUID();
        const startedAt = this.now().toISOString();
        const byId = new Map(options.testCases.map((testCase) => [testCase.id, testCase]));
        const ordered = options.suite.testCaseIds.map((id) => {
            const testCase = byId.get(id);
            if (!testCase) throw new Error(`Evaluation suite references unknown test case '${id}'.`);
            return testCase;
        });

        const results = await mapConcurrent(
            ordered,
            normalizeConcurrency(options.concurrency),
            async (testCase) =>
                this.runCase(runId, testCase, options.approvedConsequential),
            options.failFast === true
                ? {
                    shouldStop: (result) => result.status === "failed" || result.status === "error",
                    skipped: (testCase) => skipped(testCase, "Skipped because fail-fast stopped this evaluation run."),
                }
                : undefined,
        );
        const completedAt = this.now().toISOString();
        return {
            id: runId,
            workspaceId: options.workspaceId,
            suiteId: options.suite.id,
            suiteName: options.suite.name,
            suite: structuredClone(options.suite),
            testCases: structuredClone(ordered),
            status: "completed",
            startedAt,
            completedAt,
            results,
            summary: summarizeEvaluation(results),
            ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
        };
    }

    private async runCase(
        runId: string,
        testCase: WorkbenchTestCase,
        approvedConsequential: boolean,
    ): Promise<EvaluationCaseResult> {
        try {
            const evidence = await this.invocations.invoke({
                workspaceId: testCase.workspaceId,
                serverId: testCase.serverId,
                toolName: testCase.toolName,
                arguments: testCase.arguments,
                timeoutMs: testCase.timeoutMs,
                confirmed: approvedConsequential,
                idempotencyKey: `${runId}:${testCase.id}`,
                correlation: { evaluationRunId: runId, testCaseId: testCase.id },
            });
            const assertionResults = await evaluateAssertions(testCase.assertions, {
                status: evidence.status,
                outcome: evidence.outcome,
                durationMs: evidence.durationMs,
                result: evidence.result,
            });
            const assertionsPassed = assertionResults.every((assertion) => assertion.status === "passed");
            const status = classifyCaseStatus(evidence, testCase.assertions, assertionsPassed);
            return {
                testCaseId: testCase.id,
                testCaseName: testCase.name,
                status,
                startedAt: evidence.startedAt,
                completedAt: evidence.completedAt,
                durationMs: evidence.durationMs,
                executionId: evidence.executionId,
                outcome: evidence.outcome,
                assertionResults,
                ...(evidence.errorMessage === undefined ? {} : { message: evidence.errorMessage }),
                ...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
                ...(evidence.traceId === undefined ? {} : { traceId: evidence.traceId }),
                ...(evidence.spanId === undefined ? {} : { spanId: evidence.spanId }),
            };
        } catch (error) {
            return {
                testCaseId: testCase.id,
                testCaseName: testCase.name,
                status: "error",
                assertionResults: [],
                message: evaluationInvocationFailureMessage(error),
            };
        }
    }
}

function evaluationInvocationFailureMessage(error: unknown): string {
    const record = typeof error === "object" && error !== null
        ? error as Record<string, unknown>
        : undefined;
    const category = typeof record?.name === "string"
        && /^(ConnectionManagerError|ExecutionConflictError|ExecutionValidationError|WorkbenchRepositoryError)$/u.test(record.name)
        ? record.name.replace(/Error$/u, "")
        : "internal";
    const code = typeof record?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(record.code)
        ? record.code
        : undefined;
    const detail = code === undefined ? category : `${category}/${code}`;
    return `Execution service failed before producing evaluation evidence (${detail}).`;
}

function classifyCaseStatus(
    evidence: EvaluationInvocationEvidence,
    assertions: readonly RunnerMcpTestAssertion[],
    assertionsPassed: boolean,
): EvaluationCaseStatus {
    if (!assertionsPassed) return "failed";
    if (assertions.some((assertion) => assertion.kind === "status")) return "passed";
    if (evidence.outcome === "succeeded") return "passed";
    return "error";
}

function skipped(testCase: WorkbenchTestCase, message: string): EvaluationCaseResult {
    return {
        testCaseId: testCase.id,
        testCaseName: testCase.name,
        status: "skipped",
        assertionResults: [],
        message,
    };
}

function validateRunOptions(options: RunSuiteOptions): void {
    if (options.suite.workspaceId !== options.workspaceId) {
        throw new Error("Evaluation suite belongs to a different workspace.");
    }
    const duplicates = duplicateValues(options.suite.testCaseIds);
    if (duplicates.length > 0) {
        throw new Error(`Evaluation suite contains duplicate test cases: ${duplicates.join(", ")}.`);
    }
    for (const testCase of options.testCases) {
        if (testCase.workspaceId !== options.workspaceId) {
            throw new Error(`Test case '${testCase.id}' belongs to a different workspace.`);
        }
        if (!Number.isInteger(testCase.timeoutMs) || testCase.timeoutMs < 1 || testCase.timeoutMs > 3_600_000) {
            throw new Error(`Test case '${testCase.id}' has an invalid timeout.`);
        }
    }
}

function duplicateValues(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}

function normalizeConcurrency(value: number | undefined): number {
    if (value === undefined) return 1;
    if (!Number.isInteger(value) || value < 1 || value > 8) {
        throw new Error("Evaluation concurrency must be an integer between 1 and 8.");
    }
    return value;
}

async function mapConcurrent<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T) => Promise<R>,
    failFast?: {
        shouldStop: (result: R) => boolean;
        skipped: (value: T) => R;
    },
): Promise<R[]> {
    const results = new Array<R>(values.length);
    const completed = new Array<boolean>(values.length).fill(false);
    let nextIndex = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
        while (!stopped && nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            const mapped = await map(values[index]);
            results[index] = mapped;
            completed[index] = true;
            if (failFast?.shouldStop(mapped) === true) stopped = true;
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
    if (failFast !== undefined) {
        for (let index = 0; index < values.length; index += 1) {
            if (!completed[index]) results[index] = failFast.skipped(values[index]);
        }
    }
    return results;
}

export function summarizeEvaluation(results: readonly EvaluationCaseResult[]): EvaluationSummary {
    const passed = results.filter((result) => result.status === "passed").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const errors = results.filter((result) => result.status === "error").length;
    const skippedCount = results.filter((result) => result.status === "skipped").length;
    const eligible = passed + failed;
    const attempted = eligible + errors;
    const latencies = results
        .flatMap((result) => (result.durationMs === undefined ? [] : [result.durationMs]))
        .sort((a, b) => a - b);
    const usage = results.flatMap((result) => (result.usage === undefined ? [] : [result.usage]));

    return {
        total: results.length,
        passed,
        failed,
        errors,
        skipped: skippedCount,
        successRate: eligible === 0 ? 0 : passed / eligible,
        reliability: attempted === 0 ? 0 : eligible / attempted,
        ...(latencies.length === 0
            ? {}
            : {
                  averageLatencyMs: average(latencies),
                  p50LatencyMs: percentile(latencies, 0.5),
                  p95LatencyMs: percentile(latencies, 0.95),
                  p99LatencyMs: percentile(latencies, 0.99),
              }),
        ...sumUsage(usage),
    };
}

function sumUsage(usages: readonly InvocationUsage[]): InvocationUsage {
    const sum = (select: (usage: InvocationUsage) => number | undefined): number | undefined => {
        const values = usages.flatMap((usage) => {
            const value = select(usage);
            return value === undefined ? [] : [value];
        });
        return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
    };
    const inputTokens = sum((usage) => usage.inputTokens);
    const outputTokens = sum((usage) => usage.outputTokens);
    const estimatedCostUsd = sum((usage) => usage.estimatedCostUsd);
    return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    };
}

function average(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
    const index = Math.max(0, Math.ceil(values.length * quantile) - 1);
    return values[index];
}

export function compareEvaluationRuns(
    baseline: EvaluationRun,
    candidate: EvaluationRun,
): EvaluationRunComparison {
    if (baseline.workspaceId !== candidate.workspaceId || baseline.suiteId !== candidate.suiteId) {
        throw new Error("Only runs from the same workspace and suite can be compared.");
    }
    const baselineById = new Map(baseline.results.map((result) => [result.testCaseId, result]));
    const candidateById = new Map(candidate.results.map((result) => [result.testCaseId, result]));
    const ids = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();
    return {
        baselineRunId: baseline.id,
        candidateRunId: candidate.id,
        successRateChange: candidate.summary.successRate - baseline.summary.successRate,
        reliabilityChange: candidate.summary.reliability - baseline.summary.reliability,
        ...(baseline.summary.p95LatencyMs === undefined || candidate.summary.p95LatencyMs === undefined
            ? {}
            : { p95LatencyChangeMs: candidate.summary.p95LatencyMs - baseline.summary.p95LatencyMs }),
        cases: ids.map((id) => compareCase(baselineById.get(id), candidateById.get(id))),
    };
}

function compareCase(
    baseline: EvaluationCaseResult | undefined,
    candidate: EvaluationCaseResult | undefined,
): EvaluationCaseComparison {
    const statusChange = classifyStatusChange(baseline?.status, candidate?.status);
    return {
        testCaseId: candidate?.testCaseId ?? baseline?.testCaseId ?? "unknown",
        testCaseName: candidate?.testCaseName ?? baseline?.testCaseName ?? "Unknown test case",
        ...(baseline === undefined ? {} : { baselineStatus: baseline.status }),
        ...(candidate === undefined ? {} : { candidateStatus: candidate.status }),
        statusChange,
        ...(baseline?.durationMs === undefined || candidate?.durationMs === undefined
            ? {}
            : { latencyChangeMs: candidate.durationMs - baseline.durationMs }),
    };
}

function classifyStatusChange(
    baseline: EvaluationCaseStatus | undefined,
    candidate: EvaluationCaseStatus | undefined,
): EvaluationCaseComparison["statusChange"] {
    if (baseline === undefined) return "added";
    if (candidate === undefined) return "removed";
    if (baseline === candidate) return "unchanged";
    const rank: Record<EvaluationCaseStatus, number> = {
        passed: 3,
        skipped: 2,
        failed: 1,
        error: 0,
    };
    return rank[candidate] > rank[baseline] ? "improved" : "regressed";
}

export function exportEvaluationJson(run: EvaluationRun): string {
    return `${JSON.stringify(run, null, 2)}\n`;
}

export function exportEvaluationReport(run: EvaluationRun): string {
    const summary = run.summary;
    const lines = [
        `# ${escapeMarkdown(run.suiteName)} evaluation`,
        "",
        `Run: \`${run.id}\``,
        `Started: ${run.startedAt}`,
        `Completed: ${run.completedAt ?? "in progress"}`,
        "",
        "## Summary",
        "",
        `- Passed: ${summary.passed}`,
        `- Failed: ${summary.failed}`,
        `- Errors: ${summary.errors}`,
        `- Skipped: ${summary.skipped}`,
        `- Success rate: ${formatPercent(summary.successRate)}`,
        `- Reliability: ${formatPercent(summary.reliability)}`,
        `- P95 latency: ${summary.p95LatencyMs === undefined ? "unavailable" : `${round(summary.p95LatencyMs)} ms`}`,
        `- P99 latency: ${summary.p99LatencyMs === undefined ? "unavailable" : `${round(summary.p99LatencyMs)} ms`}`,
        `- Token usage: ${formatTokens(summary)}`,
        `- Estimated cost: ${summary.estimatedCostUsd === undefined ? "unavailable" : `$${summary.estimatedCostUsd.toFixed(6)}`}`,
        "",
        "## Test cases",
        "",
        "| Test | Status | Duration | Evidence |",
        "| --- | --- | ---: | --- |",
        ...run.results.map(
            (result) =>
                `| ${escapeMarkdown(result.testCaseName)} | ${result.status} | ${result.durationMs === undefined ? "—" : `${round(result.durationMs)} ms`} | ${result.executionId ? `\`${result.executionId}\`` : escapeMarkdown(result.message ?? "—")} |`,
        ),
        "",
    ];
    return lines.join("\n");
}

function formatPercent(value: number): string {
    return `${round(value * 100)}%`;
}

function formatTokens(summary: EvaluationSummary): string {
    if (summary.inputTokens === undefined && summary.outputTokens === undefined) return "unavailable";
    return `${summary.inputTokens ?? 0} input / ${summary.outputTokens ?? 0} output`;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function escapeMarkdown(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
