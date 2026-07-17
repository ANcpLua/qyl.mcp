import assert from "node:assert/strict";
import test from "node:test";
import {
    EvaluationEngine,
    compareEvaluationRuns,
    exportEvaluationJson,
    exportEvaluationReport,
    type EvaluationInvocationPort,
    type EvaluationRun,
    type WorkbenchSuite,
    type WorkbenchTestCase,
} from "./evaluation-engine.js";

const suite: WorkbenchSuite = {
    id: "suite-1",
    workspaceId: "workspace-1",
    name: "Core tools",
    testCaseIds: ["pass", "fail", "consequential", "plain"],
};

const cases: WorkbenchTestCase[] = [
    {
        id: "pass",
        workspaceId: "workspace-1",
        name: "Returns answer",
        serverId: "server-1",
        toolName: "answer",
        arguments: {},
        assertions: [
            { id: "status", kind: "status", expected: ["succeeded"] },
            { id: "value", kind: "exact", path: "/answer", expected: 42 },
        ],
        timeoutMs: 5_000,
    },
    {
        id: "fail",
        workspaceId: "workspace-1",
        name: "Detects regression",
        serverId: "server-1",
        toolName: "answer",
        arguments: {},
        assertions: [{ id: "value", kind: "exact", path: "/answer", expected: 7 }],
        timeoutMs: 5_000,
    },
    {
        id: "consequential",
        workspaceId: "workspace-1",
        name: "Mutates state",
        serverId: "server-1",
        toolName: "mutate",
        arguments: {},
        assertions: [],
        timeoutMs: 5_000,
    },
    {
        id: "plain",
        workspaceId: "workspace-1",
        name: "No assertions",
        serverId: "server-1",
        toolName: "plain",
        arguments: {},
        assertions: [],
        timeoutMs: 5_000,
    },
];

test("evaluation runner uses real invocation evidence and preserves suite order", async () => {
    const requests: string[] = [];
    const invocations: EvaluationInvocationPort = {
        async invoke(request) {
            requests.push(request.idempotencyKey);
            return {
                executionId: `execution-${request.correlation.testCaseId}`,
                status: "succeeded",
                outcome: "succeeded",
                startedAt: "2026-07-15T00:00:00.000Z",
                completedAt: "2026-07-15T00:00:00.100Z",
                durationMs: request.correlation.testCaseId === "fail" ? 200 : 100,
                result: { answer: 42 },
                usage: {
                    tokenUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, estimated: false },
                    cost: { amountUsd: 0.0001, estimated: false, source: "fixture" },
                },
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
            };
        },
    };
    const times = [new Date("2026-07-15T00:00:00Z"), new Date("2026-07-15T00:00:01Z")];
    const engine = new EvaluationEngine(invocations, () => times.shift() ?? new Date());
    const run = await engine.runSuite({
        workspaceId: "workspace-1",
        suite,
        testCases: cases,
        approvedConsequential: false,
        concurrency: 2,
        runId: "run-1",
    });

    assert.deepEqual(run.results.map((result) => result.status), ["passed", "failed", "passed", "passed"]);
    assert.deepEqual(requests.sort(), ["run-1:consequential", "run-1:fail", "run-1:pass", "run-1:plain"]);
    assert.deepEqual(run.summary, {
        total: 4,
        passed: 3,
        failed: 1,
        errors: 0,
        skipped: 0,
        successRate: 0.75,
        reliability: 1,
        averageLatencyMs: 125,
        p50LatencyMs: 100,
        p95LatencyMs: 200,
        p99LatencyMs: 200,
        tokenUsage: { inputTokens: 16, outputTokens: 8, totalTokens: 24, estimated: false },
        cost: { amountUsd: 0.0004, estimated: false, source: "fixture" },
    });
});

test("run-level approval reaches execution without a test-case confirmation DTO flag", async () => {
    let confirmed: boolean | undefined;
    const engine = new EvaluationEngine({
        async invoke(request) {
            confirmed = request.confirmed;
            return {
                executionId: "execution",
                status: "succeeded",
                outcome: "succeeded",
                startedAt: "2026-07-15T00:00:00Z",
                completedAt: "2026-07-15T00:00:00.001Z",
                durationMs: 1,
                result: {},
            };
        },
    });
    const oneCaseSuite = { ...suite, testCaseIds: ["consequential"] };
    const confirmation = {
        acknowledged: true as const,
        acknowledgement: "Approved for the focused evaluation.",
        confirmedAt: "2026-07-15T00:00:00.000Z",
    };
    const run = await engine.runSuite({
        workspaceId: "workspace-1",
        suite: oneCaseSuite,
        testCases: [cases[2]],
        approvedConsequential: true,
        confirmation,
    });
    assert.equal(confirmed, true);
    assert.equal(run.results[0].status, "passed");
    assert.deepEqual(run.confirmation, confirmation);
});

test("invocation failures become errors without persisting raw exception text", async () => {
    const engine = new EvaluationEngine({
        invoke() {
            throw Object.assign(new Error("Authorization: Bearer must-not-leak"), {
                name: "ConnectionManagerError",
                code: "connect_failed",
            });
        },
    });
    const run = await engine.runSuite({
        workspaceId: "workspace-1",
        suite: { ...suite, testCaseIds: ["pass"] },
        testCases: [cases[0]],
        approvedConsequential: false,
    });
    assert.equal(run.results[0].status, "error");
    assert.match(run.results[0].message ?? "", /ConnectionManager\/connect_failed/u);
    assert.doesNotMatch(JSON.stringify(run), /must-not-leak/u);
});

test("fail-fast stops scheduling after the first failed result and retains suite order", async () => {
    const invoked: string[] = [];
    const engine = new EvaluationEngine({
        async invoke(request) {
            invoked.push(request.correlation.testCaseId);
            return {
                executionId: `execution-${request.correlation.testCaseId}`,
                status: "succeeded",
                outcome: "succeeded",
                startedAt: "2026-07-15T00:00:00.000Z",
                completedAt: "2026-07-15T00:00:00.001Z",
                durationMs: 1,
                result: { answer: 42 },
            };
        },
    });
    const run = await engine.runSuite({
        workspaceId: "workspace-1",
        suite: { ...suite, testCaseIds: ["fail", "pass"] },
        testCases: [cases[1], cases[0]],
        approvedConsequential: false,
        concurrency: 1,
        failFast: true,
    });

    assert.deepEqual(invoked, ["fail"]);
    assert.deepEqual(run.results.map((result) => result.status), ["failed", "skipped"]);
    assert.match(run.results[1].message ?? "", /fail-fast/u);
});

test("run comparison reports regressions and latency changes", () => {
    const baseline = fixtureRun("baseline", "passed", 100, 1);
    const candidate = fixtureRun("candidate", "failed", 140, 0);
    const comparison = compareEvaluationRuns(baseline, candidate);
    assert.equal(comparison.successRateChange, -1);
    assert.equal(comparison.p95LatencyChangeMs, 40);
    assert.equal(comparison.cases[0].statusChange, "regressed");
    assert.equal(comparison.cases[0].latencyChangeMs, 40);
});

test("exports include evidence and explicitly mark unavailable cost", () => {
    const run = fixtureRun("run-export", "passed", 12, 1);
    assert.match(exportEvaluationJson(run), /"executionId": "execution"/u);
    const report = exportEvaluationReport(run);
    assert.match(report, /# Core tools evaluation/u);
    assert.match(report, /Cost: unavailable/u);
    assert.match(report, /`execution`/u);
});

function fixtureRun(
    id: string,
    status: "passed" | "failed",
    durationMs: number,
    successRate: number,
): EvaluationRun {
    return {
        id,
        workspaceId: "workspace-1",
        suiteId: "suite-1",
        suiteName: "Core tools",
        status: "completed",
        startedAt: "2026-07-15T00:00:00Z",
        completedAt: "2026-07-15T00:00:01Z",
        results: [
            {
                testCaseId: "case-1",
                testCaseName: "Case 1",
                status,
                durationMs,
                executionId: "execution",
                assertionResults: [],
            },
        ],
        summary: {
            total: 1,
            passed: status === "passed" ? 1 : 0,
            failed: status === "failed" ? 1 : 0,
            errors: 0,
            skipped: 0,
            successRate,
            reliability: 1,
            averageLatencyMs: durationMs,
            p50LatencyMs: durationMs,
            p95LatencyMs: durationMs,
            p99LatencyMs: durationMs,
        },
    };
}
