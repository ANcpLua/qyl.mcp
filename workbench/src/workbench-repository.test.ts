import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretRedactor } from "./secret-redactor.js";
import {
    RepositoryConflictError,
    RepositoryNotFoundError,
    WorkbenchRepository,
} from "./workbench-repository.js";

async function temporaryRepository(options: { secretValues?: readonly string[] } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-repository-"));
    const filePath = join(directory, "state.json");
    const repository = new WorkbenchRepository({
        filePath,
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        redactor: new SecretRedactor({ secretValues: options.secretValues }),
    });
    await repository.initialize();
    return {
        directory,
        filePath,
        repository,
        close: () => rm(directory, { recursive: true, force: true }),
    };
}

test("repository persists sanitized workspace configuration across reopen", async () => {
    const fixture = await temporaryRepository();
    try {
        const server = await fixture.repository.createServer("default", {
            name: "remote",
            configuration: {
                kind: "streamable_http",
                endpoint: "https://mcp.example.test/mcp",
                headers: [{
                    header: "Authorization",
                    scheme: "bearer",
                    secret: { source: "environment", environmentVariable: "MCP_ACCESS_TOKEN" },
                }],
            },
            autoConnect: true,
        });

        const reopened = new WorkbenchRepository({
            filePath: fixture.filePath,
            now: () => new Date("2026-07-15T11:00:00.000Z"),
        });
        await reopened.initialize();

        assert.deepEqual(await reopened.getServer("default", server.id), server);
        const onDisk = await readFile(fixture.filePath, "utf8");
        assert.match(onDisk, /MCP_ACCESS_TOKEN/u);
        assert.doesNotMatch(onDisk, /Bearer [A-Za-z0-9]/u);
    } finally {
        await fixture.close();
    }
});

test("repository rejects credentials embedded in endpoints and stdio arguments", async () => {
    const fixture = await temporaryRepository();
    try {
        await assert.rejects(
            fixture.repository.createServer("default", {
                name: "credential-url",
                configuration: {
                    kind: "streamable_http",
                    endpoint: "https://user:secret@mcp.example.test/mcp",
                    headers: [],
                },
                autoConnect: false,
            }),
            /cannot embed credentials/u,
        );
        await assert.rejects(
            fixture.repository.createServer("default", {
                name: "secret-argument",
                configuration: {
                    kind: "stdio",
                    command: "mcp-server",
                    args: ["--token=plaintext"],
                    environment: [],
                },
                autoConnect: false,
            }),
            /cannot contain plaintext credential arguments/u,
        );
    } finally {
        await fixture.close();
    }
});

test("repository redacts secret values before durable test evidence is written", async () => {
    const secret = "this-value-must-never-reach-disk";
    const fixture = await temporaryRepository({ secretValues: [secret] });
    try {
        const server = await fixture.repository.createServer("default", {
            name: "fixture",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });
        await fixture.repository.saveTestCase({
            id: "case-1",
            workspaceId: "default",
            serverId: server.id,
            name: "sanitized",
            toolName: "echo",
            arguments: { authorization: secret, nested: { value: secret } },
            assertions: [],
            timeoutMs: 1_000,
            createdAt: "2026-07-15T10:00:00.000Z",
            updatedAt: "2026-07-15T10:00:00.000Z",
        });

        const onDisk = await readFile(fixture.filePath, "utf8");
        assert.doesNotMatch(onDisk, new RegExp(secret, "u"));
        assert.match(onDisk, /\[REDACTED\]/u);
    } finally {
        await fixture.close();
    }
});

test("repository enforces workspace scope and referential integrity", async () => {
    const fixture = await temporaryRepository();
    try {
        const second = await fixture.repository.createWorkspace({ name: "Second" });
        const server = await fixture.repository.createServer(second.id, {
            name: "fixture",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });

        await assert.rejects(
            fixture.repository.getServer("default", server.id),
            RepositoryNotFoundError,
        );
        await fixture.repository.deleteWorkspace(second.id);
        await assert.rejects(
            fixture.repository.getWorkspace(second.id),
            RepositoryNotFoundError,
        );
        await assert.rejects(
            fixture.repository.deleteWorkspace("default"),
            RepositoryConflictError,
        );
    } finally {
        await fixture.close();
    }
});

test("repository refuses to delete workspaces with active executions or evaluations", async () => {
    const fixture = await temporaryRepository();
    try {
        const executionWorkspace = await fixture.repository.createWorkspace({ name: "Active execution" });
        const server = await fixture.repository.createServer(executionWorkspace.id, {
            name: "fixture",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });
        await fixture.repository.saveExecution({
            id: "active-execution",
            workspaceId: executionWorkspace.id,
            serverId: server.id,
            status: "cancelling",
            createdAt: "2026-07-15T10:00:00.000Z",
            evidence: {},
        });

        const evaluationWorkspace = await fixture.repository.createWorkspace({ name: "Active evaluation" });
        await fixture.repository.saveEvaluationRun({
            id: "active-evaluation",
            workspaceId: evaluationWorkspace.id,
            suiteId: "suite",
            suiteName: "suite",
            status: "running",
            startedAt: "2026-07-15T10:00:00.000Z",
            results: [],
            summary: {
                total: 0,
                passed: 0,
                failed: 0,
                errors: 0,
                skipped: 0,
                successRate: 0,
                reliability: 0,
            },
        });

        await assert.rejects(
            fixture.repository.deleteWorkspace(executionWorkspace.id),
            /active executions/u,
        );
        await assert.rejects(
            fixture.repository.deleteWorkspace(evaluationWorkspace.id),
            /active evaluation runs/u,
        );
        assert.equal((await fixture.repository.getWorkspace(executionWorkspace.id)).name, "Active execution");
        assert.equal((await fixture.repository.getWorkspace(evaluationWorkspace.id)).name, "Active evaluation");
    } finally {
        await fixture.close();
    }
});

test("repository rejects deleting referenced servers and test cases", async () => {
    const fixture = await temporaryRepository();
    try {
        const server = await fixture.repository.createServer("default", {
            name: "fixture",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });
        await fixture.repository.saveTestCase({
            id: "case-1",
            workspaceId: "default",
            serverId: server.id,
            name: "case",
            toolName: "echo",
            arguments: {},
            assertions: [],
            timeoutMs: 1_000,
            createdAt: "2026-07-15T10:00:00.000Z",
            updatedAt: "2026-07-15T10:00:00.000Z",
        });
        await fixture.repository.saveSuite({
            id: "suite-1",
            workspaceId: "default",
            name: "suite",
            testCaseIds: ["case-1"],
            createdAt: "2026-07-15T10:00:00.000Z",
            updatedAt: "2026-07-15T10:00:00.000Z",
        });

        await assert.rejects(
            fixture.repository.deleteServer("default", server.id),
            RepositoryConflictError,
        );
        await assert.rejects(
            fixture.repository.deleteTestCase("default", "case-1"),
            RepositoryConflictError,
        );
    } finally {
        await fixture.close();
    }
});

test("server deletion preflight preserves active work and cascades terminal execution state", async () => {
    const fixture = await temporaryRepository();
    try {
        const server = await fixture.repository.createServer("default", {
            name: "execution-owner",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });
        await fixture.repository.savePreferences("default", {
            selectedServerId: server.id,
            selectedToolName: "echo",
        });
        await fixture.repository.saveExecution({
            id: "server-delete-execution",
            workspaceId: "default",
            serverId: server.id,
            status: "running",
            createdAt: "2026-07-15T10:00:00.000Z",
            evidence: {},
        });

        await assert.rejects(
            fixture.repository.ensureServerDeletable("default", server.id),
            /active executions/u,
        );
        await assert.rejects(
            fixture.repository.deleteServer("default", server.id),
            /active executions/u,
        );
        assert.equal((await fixture.repository.getServer("default", server.id)).id, server.id);

        await fixture.repository.saveExecution({
            id: "server-delete-execution",
            workspaceId: "default",
            serverId: server.id,
            status: "succeeded",
            createdAt: "2026-07-15T10:00:00.000Z",
            completedAt: "2026-07-15T10:00:01.000Z",
            evidence: {},
        });
        await fixture.repository.ensureServerDeletable("default", server.id);
        await fixture.repository.deleteServer("default", server.id);

        await assert.rejects(
            fixture.repository.getServer("default", server.id),
            RepositoryNotFoundError,
        );
        const state = JSON.parse(await readFile(fixture.filePath, "utf8")) as {
            executions: Array<{ id: string }>;
            preferences: Record<string, { selectedServerId?: string; selectedToolName?: string }>;
        };
        assert.equal(state.executions.some((execution) => execution.id === "server-delete-execution"), false);
        assert.equal(state.preferences.default?.selectedServerId, undefined);
        assert.equal(state.preferences.default?.selectedToolName, "echo");
    } finally {
        await fixture.close();
    }
});

test("server deletion preserves self-contained historical evaluation evidence", async () => {
    const fixture = await temporaryRepository();
    try {
        const server = await fixture.repository.createServer("default", {
            name: "evaluated-server",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });
        await fixture.repository.saveEvaluationRun({
            id: "historical-evaluation",
            workspaceId: "default",
            suiteId: "deleted-suite-snapshot",
            suiteName: "Historical suite",
            status: "completed",
            startedAt: "2026-07-15T10:00:00.000Z",
            completedAt: "2026-07-15T10:00:01.000Z",
            testCases: [{
                id: "historical-case",
                workspaceId: "default",
                name: "Historical case",
                serverId: server.id,
                toolName: "echo",
                arguments: {},
                assertions: [],
                timeoutMs: 1_000,
            }],
            results: [{
                testCaseId: "historical-case",
                testCaseName: "Historical case",
                status: "passed",
                assertionResults: [],
            }],
            summary: {
                total: 1,
                passed: 1,
                failed: 0,
                errors: 0,
                skipped: 0,
                successRate: 1,
                reliability: 1,
            },
        });

        await assert.rejects(
            fixture.repository.ensureServerDeletable("default", server.id),
            /evaluation evidence/u,
        );
        await assert.rejects(
            fixture.repository.deleteServer("default", server.id),
            /evaluation evidence/u,
        );
        assert.equal((await fixture.repository.getServer("default", server.id)).id, server.id);
    } finally {
        await fixture.close();
    }
});

test("repository atomically reconciles orphaned active work after a crash", async () => {
    const fixture = await temporaryRepository();
    try {
        const server = await fixture.repository.createServer("default", {
            name: "fixture",
            configuration: { kind: "builtin", builtin: "fixture" },
            autoConnect: false,
        });
        for (const [index, status] of ["queued", "running", "cancelling"].entries()) {
            const id = `interrupted-${status}`;
            const idempotencyKey = `interrupted-key-${status}`;
            const evidence = {
                id,
                workspaceId: "default",
                serverId: server.id,
                request: { toolName: "echo", arguments: { index }, timeoutMs: 5_000, idempotencyKey },
                effect: "read_only",
                safety: { classification: "explicitly_read_only", requiresConfirmation: false, reasons: [] },
                status,
                createdAt: "2026-07-15T09:00:00.000Z",
                ...(status === "queued" ? {} : { startedAt: "2026-07-15T09:01:00.000Z" }),
                ...(status === "cancelling" ? { cancelRequestedAt: "2026-07-15T09:02:00.000Z" } : {}),
                attemptCount: status === "queued" ? 0 : 1,
                retryCount: 0,
                correlation: {
                    executionId: id,
                    workspaceId: "default",
                    evaluationRunId: "evaluation-before-crash",
                    testCaseId: `case-${index}`,
                },
            };
            await fixture.repository.saveExecution({
                id,
                workspaceId: "default",
                serverId: server.id,
                status,
                createdAt: evidence.createdAt,
                evidence,
                idempotency: { key: idempotencyKey, fingerprint: String(index + 1).repeat(64) },
            });
        }
        for (const status of ["queued", "running"] as const) {
            await fixture.repository.saveEvaluationRun({
                id: `evaluation-${status}`,
                workspaceId: "default",
                suiteId: "suite-before-crash",
                suiteName: "Interrupted suite",
                status,
                startedAt: "2026-07-15T09:00:00.000Z",
                results: [],
                summary: {
                    total: 2,
                    passed: 0,
                    failed: 0,
                    errors: 0,
                    skipped: 0,
                    successRate: 0,
                    reliability: 0,
                },
                idempotencyKey: `evaluation-key-${status}`,
                idempotencyFingerprint: status === "queued" ? "a".repeat(64) : "b".repeat(64),
            });
        }

        const reconciled = await fixture.repository.reconcileInterruptedWork();
        assert.deepEqual(
            reconciled.executionIds.sort(),
            ["interrupted-cancelling", "interrupted-queued", "interrupted-running"],
        );
        assert.deepEqual(
            reconciled.evaluationRunIds.sort(),
            ["evaluation-queued", "evaluation-running"],
        );
        const executions = await fixture.repository.listExecutions("default", server.id);
        const recoveredStreamIds = executions.map((execution) => execution.streamEventId);
        assert.deepEqual(recoveredStreamIds, [4, 5, 6]);
        for (const execution of executions) {
            assert.equal(execution.status, "failed");
            assert.equal(execution.completedAt, "2026-07-15T10:00:00.000Z");
            const evidence = execution.evidence as Record<string, unknown>;
            assert.equal(evidence.status, "failed");
            assert.equal(evidence.createdAt, "2026-07-15T09:00:00.000Z");
            assert.equal((evidence.error as Record<string, unknown>).code, "execution_interrupted");
            assert.equal((evidence.correlation as Record<string, unknown>).evaluationRunId, "evaluation-before-crash");
            assert.equal(execution.idempotency?.key, `interrupted-key-${execution.id.replace("interrupted-", "")}`);
            if (execution.id === "interrupted-queued") {
                assert.equal(evidence.startedAt, undefined);
            } else {
                assert.equal(evidence.startedAt, "2026-07-15T09:01:00.000Z");
                assert.equal(evidence.durationMs, 59 * 60 * 1_000);
            }
            if (execution.id === "interrupted-cancelling") {
                assert.equal(evidence.cancelRequestedAt, "2026-07-15T09:02:00.000Z");
            }
        }
        for (const runId of ["evaluation-queued", "evaluation-running"]) {
            const run = await fixture.repository.getEvaluationRun("default", runId);
            assert.equal(run.status, "failed");
            assert.equal(run.completedAt, "2026-07-15T10:00:00.000Z");
            assert.equal(run.startedAt, "2026-07-15T09:00:00.000Z");
            assert.equal(run.error?.code, "evaluation_interrupted");
            assert.equal(run.summary.errors, 2);
            assert.equal(run.idempotencyKey, `evaluation-key-${runId.replace("evaluation-", "")}`);
        }

        assert.deepEqual(await fixture.repository.reconcileInterruptedWork(), {
            executionIds: [],
            evaluationRunIds: [],
        });
        assert.deepEqual(
            (await fixture.repository.listExecutions("default", server.id))
                .map((execution) => execution.streamEventId),
            recoveredStreamIds,
        );
    } finally {
        await fixture.close();
    }
});
