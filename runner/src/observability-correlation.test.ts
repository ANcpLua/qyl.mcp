import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchCorrelationRegistry } from "./observability-correlation.js";

test("correlation registry joins evaluation, test, MCP request, execution, and telemetry", () => {
    const registry = new WorkbenchCorrelationRegistry();
    const protocol = registry.beginExecution({
        executionId: "execution-1",
        workspaceId: "workspace-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
    });
    assert.deepEqual(protocol, {
        executionId: "execution-1",
        workspaceId: "workspace-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
    });

    registry.linkMcpRequest({
        executionId: "execution-1",
        serverId: "server-1",
        requestId: 17,
        method: "tools/call",
    });
    assert.deepEqual(registry.resolveMcpRequest("server-1", 17), {
        executionId: "execution-1",
        workspaceId: "workspace-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
        serverId: "server-1",
        method: "tools/call",
    });

    const correlation = registry.linkTelemetry(
        "execution-1",
        "A".repeat(32),
        "B".repeat(16),
    );
    assert.deepEqual(correlation, {
        executionId: "execution-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
        traceIds: ["a".repeat(32)],
        spanIds: ["b".repeat(16)],
    });
});

test("request identifiers are server-scoped and never exposed by snapshots", () => {
    const registry = new WorkbenchCorrelationRegistry();
    registry.beginExecution({ executionId: "execution-1" });
    registry.beginExecution({ executionId: "execution-2" });
    registry.linkMcpRequest({
        executionId: "execution-1",
        serverId: "server-1",
        requestId: "credential-looking-request",
        method: "tools/call",
    });
    registry.linkMcpRequest({
        executionId: "execution-2",
        serverId: "server-2",
        requestId: "credential-looking-request",
        method: "resources/read",
    });

    assert.equal(registry.resolveMcpRequest("server-1", "credential-looking-request")?.executionId, "execution-1");
    assert.equal(registry.resolveMcpRequest("server-2", "credential-looking-request")?.executionId, "execution-2");
    assert.equal(JSON.stringify(registry.correlation("execution-1")).includes("credential-looking"), false);
});

test("registry rejects correlation mutation, identifier reuse, and invalid telemetry ids", () => {
    const registry = new WorkbenchCorrelationRegistry();
    registry.beginExecution({ executionId: "execution-1", testCaseId: "test-1" });
    assert.throws(
        () => registry.beginExecution({ executionId: "execution-1", testCaseId: "test-2" }),
        /cannot change testCaseId/u,
    );

    registry.beginExecution({ executionId: "execution-2" });
    registry.linkMcpRequest({
        executionId: "execution-1",
        serverId: "server-1",
        requestId: 9,
        method: "tools/call",
    });
    assert.throws(
        () => registry.linkMcpRequest({
            executionId: "execution-2",
            serverId: "server-1",
            requestId: 9,
            method: "tools/call",
        }),
        /already linked/u,
    );
    assert.throws(() => registry.linkTelemetry("execution-1", "short"), /traceId/u);
});

test("bounded registry removes request indexes with the evicted execution", () => {
    const registry = new WorkbenchCorrelationRegistry({ maxExecutions: 1 });
    registry.beginExecution({ executionId: "execution-1" });
    registry.linkMcpRequest({
        executionId: "execution-1",
        serverId: "server-1",
        requestId: "request-1",
        method: "tools/call",
    });
    registry.beginExecution({ executionId: "execution-2" });

    assert.equal(registry.correlation("execution-1"), undefined);
    assert.equal(registry.resolveMcpRequest("server-1", "request-1"), undefined);
    assert.deepEqual(registry.correlation("execution-2"), {
        executionId: "execution-2",
        traceIds: [],
        spanIds: [],
    });
});
