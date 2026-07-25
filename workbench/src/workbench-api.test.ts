import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import test from "node:test";
import {
    WorkbenchExecutionRecordSchema,
    WorkbenchProtocolEventSchema,
} from "qyl-mcp-server/contract-validation";
import { createFixtureMcpServer } from "./fixture-server.js";
import type { QylObservabilityProvider, QylObservabilityQuery } from "./qyl-observability.js";
import type { ProtocolMessageEntry } from "./protocol-journal.js";
import { SecretRedactor } from "./secret-redactor.js";
import {
    McpTelemetry,
    type McpOperationInput,
} from "./telemetry.js";
import { WorkbenchApi, type BuiltinMcpServer } from "./workbench-api.js";
import { WorkbenchRepository } from "./workbench-repository.js";

const fixtureResource: BuiltinMcpServer = {
    name: "conformance-fixture",
    serverFactory: () => createFixtureMcpServer().server,
};

test("workbench API authenticates, scopes, discovers, validates, and invokes idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-api-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const denied = await fetch(`${harness.origin}/workbench/workspaces`);
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get("www-authenticate"), "Cookie");

        const forged = await fetch(`${harness.origin}/workbench/workspaces`, {
            headers: { cookie: "qyl-workbench-session=forged" },
        });
        assert.equal(forged.status, 401);

        const secondBootstrap = await fetch(`${harness.origin}/workbench/session`, { method: "POST" });
        assert.equal(secondBootstrap.status, 200);
        const secondCookieHeader = secondBootstrap.headers.get("set-cookie");
        const secondCookie = cookieValue(secondCookieHeader);
        const secondSession = await responseJson(secondBootstrap);
        assert.notEqual(secondCookie, harness.cookie);
        assert.notEqual(secondSession.id, harness.session.id);
        assert(!("token" in secondSession));
        assert.match(secondCookieHeader ?? "", /HttpOnly/u);
        assert.match(secondCookieHeader ?? "", /SameSite=Strict/u);
        assert.match(secondCookieHeader ?? "", /Path=\/workbench/u);
        assert.equal((await fetch(`${harness.origin}/workbench/workspaces`, {
            headers: { cookie: secondCookie },
        })).status, 200);

        const serverId = await fixtureServerId(harness);
        const discovery = await getJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/discovery`,
        );
        assert.equal(discovery.response.status, 200);
        const tools = record(discovery.body.tools).items as Array<Record<string, unknown>>;
        assert.deepEqual(
            tools.map((tool) => tool.name),
            [
                "fixture.safe_lookup",
                "fixture.rich_result",
                "fixture.evidence",
                "fixture.delete_record",
                "fixture.delayed",
                "fixture.tool_error",
            ],
        );

        const invocation = {
            tool_name: "fixture.safe_lookup",
            arguments: { query: "Alpha" },
            timeout_ms: 5_000,
            idempotency_key: "safe-lookup-0001",
        };
        const accepted = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            invocation,
        );
        assert.equal(accepted.response.status, 202);
        const executionId = String(record(accepted.body.execution).id);

        const duplicate = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            invocation,
        );
        assert.equal(duplicate.response.status, 202);
        assert.equal(record(duplicate.body.execution).id, executionId);

        const completed = await waitForExecution(harness, serverId, executionId);
        assert.equal(completed.status, "succeeded");
        assert.equal(completed.effect, "read_only");
        assert.equal(record(record(completed.result).structuredContent).query, "Alpha");
        assert(!("safety" in completed));
        assert(!("tokenUsage" in completed));
        assert(!("cost" in completed));

        const conflictingReplay = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            { ...invocation, arguments: { query: "Different" } },
        );
        assert.equal(conflictingReplay.response.status, 409);

        const toolErrorAccepted = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.tool_error",
                arguments: { message: "intentional failure" },
                timeout_ms: 5_000,
                idempotency_key: "tool-error-0001",
            },
        );
        assert.equal(toolErrorAccepted.response.status, 202);
        const toolError = await waitForExecution(
            harness,
            serverId,
            String(record(toolErrorAccepted.body.execution).id),
        );
        assert.equal(toolError.status, "failed");
        assert.equal(record(toolError.error).category, "tool_error");
        assert.equal(record(toolError.result).isError, true);

        const schemaError = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: 42 },
                timeout_ms: 5_000,
                idempotency_key: "schema-error-0001",
            },
        );
        assert.equal(schemaError.response.status, 400);
        assert.equal((schemaError.body.errors as Array<Record<string, unknown>>)[0]?.field, "arguments");

        const otherWorkspace = await postJson(harness, "/workbench/workspaces", { name: "Other" });
        assert.equal(otherWorkspace.response.status, 200);
        const crossWorkspace = await getJson(
            harness,
            `/workbench/workspaces/${String(otherWorkspace.body.id)}/servers/${serverId}`,
        );
        assert.equal(crossWorkspace.response.status, 404);
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("exposes only provider-reported usage and cost in execution and evaluation evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-usage-evidence-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const accepted = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.evidence",
                arguments: { query: "explicit" },
                timeout_ms: 5_000,
                idempotency_key: "evidence-execution-0001",
            },
        );
        const executionId = String(record(accepted.body.execution).id);
        const execution = await waitForExecution(harness, serverId, executionId);
        assert.deepEqual(execution.token_usage, {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
            estimated: false,
        });
        assert.deepEqual(execution.cost, {
            amount_usd: 0.000123,
            estimated: false,
            source: "fixture",
        });

        const testCase = await postJson(harness, "/workbench/workspaces/default/test-cases", {
            server_id: serverId,
            name: "Explicit evidence",
            tool_name: "fixture.evidence",
            arguments: { query: "evaluation" },
            timeout_ms: 5_000,
            assertions: [{ id: "status", kind: "status", expected: ["succeeded"] }],
        });
        const testCaseId = String(testCase.body.id);
        const suite = await postJson(harness, "/workbench/workspaces/default/suites", {
            name: "Evidence suite",
            test_case_ids: [testCaseId],
        });
        const runAccepted = await postJson(
            harness,
            `/workbench/workspaces/default/suites/${String(suite.body.id)}/run`,
            { idempotency_key: "evidence-evaluation-0001" },
        );
        const runId = String(record(runAccepted.body.run).id);
        const run = await waitForEvaluation(harness, runId);
        assert.deepEqual(record(run.summary).token_usage, {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
            estimated: false,
        });
        assert.deepEqual(record(run.summary).cost, {
            amount_usd: 0.000123,
            estimated: false,
            source: "fixture",
        });
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("keeps live protocol traffic metadata-only and does not reconstruct it after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-journal-restart-"));
    const filePath = join(directory, "state.json");
    const first = await startHarness(filePath);
    let serverId = "";
    try {
        serverId = await fixtureServerId(first);
        await first.workbench.connections.getClient(serverId).callTool({
            name: "fixture.safe_lookup",
            arguments: { query: "unattached-live-traffic" },
        });
        const live = await getJson(first, `/workbench/workspaces/default/servers/${serverId}/protocol`);
        const serializedLive = JSON.stringify(live.body);
        assert.doesNotMatch(serializedLive, /unattached-live-traffic/u);
        assert.match(serializedLive, /fixture\.safe_lookup/u);
    } finally {
        await first.close();
    }

    const reopened = await startHarness(filePath);
    try {
        const restored = await getJson(reopened, `/workbench/workspaces/default/servers/${serverId}/protocol`);
        assert.doesNotMatch(JSON.stringify(restored.body), /unattached-live-traffic/u);
    } finally {
        await reopened.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("workbench API exposes cancellation, timeout, and connection failure states", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-failures-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const delayed = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.delayed",
                arguments: { delayMs: 1_000 },
                timeout_ms: 5_000,
                idempotency_key: "cancel-execution-0001",
            },
        );
        assert.equal(delayed.response.status, 202);
        const delayedId = String(record(delayed.body.execution).id);
        const cancellation = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions/${delayedId}/cancel`,
            { reason: "exercise cancellation", idempotency_key: "cancel-request-0001" },
        );
        assert.equal(cancellation.response.status, 202);
        const cancelled = await waitForExecution(harness, serverId, delayedId);
        assert.equal(cancelled.status, "cancelled");
        assert.equal(record(cancelled.error).category, "cancelled");
        assert.equal(typeof cancelled.cancel_requested_at, "string");
        assert.equal(typeof cancelled.cancelled_at, "string");

        const timed = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.delayed",
                arguments: { delayMs: 250 },
                timeout_ms: 20,
                idempotency_key: "timeout-execution-0001",
            },
        );
        assert.equal(timed.response.status, 202);
        const timedOut = await waitForExecution(
            harness,
            serverId,
            String(record(timed.body.execution).id),
        );
        assert.equal(timedOut.status, "timed_out");
        assert.equal(record(timedOut.error).category, "timeout");
        assert.equal(record(timedOut.error).code, "request_timeout");

        const missing = await postJson(harness, "/workbench/workspaces/default/servers", {
            name: "Missing builtin",
            configuration: { transport: "builtin", name: "not-registered" },
            auto_connect: false,
        });
        assert.equal(missing.response.status, 200);
        const missingId = String(missing.body.id);
        const failedConnection = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${missingId}/connect`,
            {},
        );
        assert.equal(failedConnection.response.status, 502);
        assert.equal(failedConnection.body.dependency, "mcp");

        const failedAutoConnect = await postJson(harness, "/workbench/workspaces/default/servers", {
            name: "Missing auto-connect builtin",
            configuration: { transport: "builtin", name: "not-registered-auto" },
            auto_connect: true,
        });
        assert.equal(failedAutoConnect.response.status, 200);
        assert.equal(record(failedAutoConnect.body.connection).status, "failed");

        const disconnected = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/disconnect`,
            {},
        );
        assert.equal(disconnected.response.status, 202);
        const invokeWhileDisconnected = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: "offline" },
                timeout_ms: 1_000,
                idempotency_key: "offline-call-0001",
            },
        );
        assert.equal(invokeWhileDisconnected.response.status, 409);
        assert.match(String(invokeWhileDisconnected.body.detail), /not connected/u);
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("server configuration persistence failure preserves the connected runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-server-patch-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const created = await postJson(harness, "/workbench/workspaces/default/servers", {
            name: "Mutable fixture",
            configuration: { transport: "builtin", name: fixtureResource.name },
            auto_connect: true,
        });
        assert.equal(created.response.status, 200);
        const serverId = String(created.body.id);
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");
        const originalUpdate = harness.workbench.repository.updateServer.bind(harness.workbench.repository);
        harness.workbench.repository.updateServer = async () => {
            throw new Error("injected server persistence failure");
        };
        try {
            const failed = await json(
                `${harness.origin}/workbench/workspaces/default/servers/${serverId}`,
                {
                    method: "PATCH",
                    headers: { cookie: harness.cookie, "content-type": "application/json" },
                    body: JSON.stringify({
                        configuration: { transport: "builtin", name: "replacement-that-must-not-apply" },
                    }),
                },
            );
            assert.equal(failed.response.status, 500);
        } finally {
            harness.workbench.repository.updateServer = originalUpdate;
        }
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");
        assert.deepEqual(
            (await harness.workbench.repository.getServer("default", serverId)).configuration,
            { kind: "builtin", builtin: fixtureResource.name },
        );
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("final-workspace deletion rejection preserves its live runtime registration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-workspace-delete-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const rejected = await json(`${harness.origin}/workbench/workspaces/default`, {
            method: "DELETE",
            headers: { cookie: harness.cookie },
        });
        assert.equal(rejected.response.status, 409);
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");
        assert.equal(
            (await getJson(harness, `/workbench/workspaces/default/servers/${serverId}`)).response.status,
            200,
        );
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("referenced-server deletion rejection leaves the server connected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-server-delete-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const created = await postJson(harness, "/workbench/workspaces/default/test-cases", {
            server_id: serverId,
            name: "server delete guard",
            tool_name: "fixture.safe_lookup",
            arguments: { query: "guard" },
            timeout_ms: 5_000,
            assertions: [{ id: "status-1", kind: "status", expected: ["succeeded"] }],
        });
        assert.equal(created.response.status, 200);
        const rejected = await json(
            `${harness.origin}/workbench/workspaces/default/servers/${serverId}`,
            { method: "DELETE", headers: { cookie: harness.cookie } },
        );
        assert.equal(rejected.response.status, 409);
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("server deletion shuts down first and restores the runtime when persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-server-delete-rollback-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const created = await postJson(harness, "/workbench/workspaces/default/servers", {
            name: "Deletion rollback fixture",
            configuration: { transport: "builtin", name: fixtureResource.name },
            auto_connect: true,
        });
        assert.equal(created.response.status, 200);
        const serverId = String(created.body.id);
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");

        const originalDelete = harness.workbench.repository.deleteServer.bind(harness.workbench.repository);
        harness.workbench.repository.deleteServer = async () => {
            assert.equal(harness.workbench.connections.has(serverId), false);
            throw new Error("injected server deletion persistence failure");
        };
        try {
            const failed = await json(
                `${harness.origin}/workbench/workspaces/default/servers/${serverId}`,
                { method: "DELETE", headers: { cookie: harness.cookie } },
            );
            assert.equal(failed.response.status, 500);
        } finally {
            harness.workbench.repository.deleteServer = originalDelete;
        }

        assert.equal((await harness.workbench.repository.getServer("default", serverId)).id, serverId);
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("server deletion cannot overtake an active execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-server-delete-active-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const created = await postJson(harness, "/workbench/workspaces/default/servers", {
            name: "Active deletion fixture",
            configuration: { transport: "builtin", name: fixtureResource.name },
            auto_connect: true,
        });
        assert.equal(created.response.status, 200);
        const serverId = String(created.body.id);
        const accepted = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.delayed",
                arguments: { delayMs: 500 },
                timeout_ms: 5_000,
                idempotency_key: "active-delete-guard-0001",
            },
        );
        assert.equal(accepted.response.status, 202);
        const executionId = String(record(accepted.body.execution).id);

        const rejected = await json(
            `${harness.origin}/workbench/workspaces/default/servers/${serverId}`,
            { method: "DELETE", headers: { cookie: harness.cookie } },
        );
        assert.equal(rejected.response.status, 409);
        assert.equal(harness.workbench.connections.get(serverId).lifecycle, "connected");
        assert.equal((await harness.workbench.repository.getServer("default", serverId)).id, serverId);
        const terminal = await waitForExecution(harness, serverId, executionId);
        assert.equal(terminal.status, "succeeded");
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("workbench SSE frames conform to the generated protocol and execution contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-sse-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const accepted = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: "SSE" },
                timeout_ms: 5_000,
                idempotency_key: "sse-contract-0001",
            },
        );
        const executionId = String(record(accepted.body.execution).id);
        await waitForExecution(harness, serverId, executionId);

        const protocolPayload = await firstSseData(
            `${harness.origin}/workbench/workspaces/default/servers/${serverId}/protocol/stream`,
            harness.cookie,
        );
        assert.doesNotThrow(() => WorkbenchProtocolEventSchema.parse(protocolPayload));

        const executionFrames = await readSseFrames(
            `${harness.origin}/workbench/workspaces/default/servers/${serverId}/executions/stream?executionId=${executionId}`,
            harness.cookie,
            3,
        );
        const executions = executionFrames.map((frame) => WorkbenchExecutionRecordSchema.parse(frame.data));
        assert(executions.every((execution) => execution.id === executionId));
        assert.deepEqual(executions.map((execution) => execution.status), ["queued", "running", "succeeded"]);
        assert(executionFrames.every((frame, index) => index === 0 || Number(frame.id) > Number(executionFrames[index - 1]!.id)));
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("protocol SSE closes the snapshot race and resumes across reconnect generations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-protocol-sse-race-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const journal = harness.workbench.connections.getJournal(serverId);
        assert(journal);
        const lastSeen = journal.highWaterMark();
        const originalSnapshot = journal.snapshot.bind(journal);
        let racedSequence = 0;
        journal.snapshot = () => {
            const beforeRace = originalSnapshot();
            if (racedSequence === 0) {
                racedSequence = journal.recordTransportError(
                    new Error("protocol stream snapshot race"),
                ).sequence;
            }
            return beforeRace;
        };
        try {
            const [raced] = await readSseFrames(
                `${harness.origin}/workbench/workspaces/default/servers/${serverId}/protocol/stream`,
                harness.cookie,
                1,
                { "Last-Event-ID": String(lastSeen) },
            );
            assert.equal(raced?.id, String(racedSequence));
            assert.doesNotThrow(() => WorkbenchProtocolEventSchema.parse(raced?.data));
        } finally {
            journal.snapshot = originalSnapshot;
        }

        const reconnect = await postJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/reconnect`,
            {},
        );
        assert.equal(reconnect.response.status, 202);
        const replacement = harness.workbench.connections.getJournal(serverId);
        assert(replacement);
        assert.notEqual(replacement, journal);
        const replacementEntries = replacement.snapshot();
        assert(replacementEntries.length > 0);
        assert(replacementEntries.every((entry) => entry.sequence > journal.highWaterMark()));

        const [resumed] = await readSseFrames(
            `${harness.origin}/workbench/workspaces/default/servers/${serverId}/protocol/stream`,
            harness.cookie,
            1,
            { "Last-Event-ID": String(racedSequence) },
        );
        assert(Number(resumed?.id) > racedSequence);
        assert.doesNotThrow(() => WorkbenchProtocolEventSchema.parse(resumed?.data));
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("execution SSE replays lifecycle cursors, closes the snapshot race, and survives reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-execution-sse-race-"));
    const filePath = join(directory, "state.json");
    const first = await startHarness(filePath);
    let serverId = "";
    let racedExecutionId = "";
    let racedEventId = 0;
    try {
        serverId = await fixtureServerId(first);
        const accepted = await postJson(
            first,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: "execution SSE lifecycle" },
                timeout_ms: 5_000,
                idempotency_key: "execution-sse-lifecycle-0001",
            },
        );
        const executionId = String(record(accepted.body.execution).id);
        await waitForExecution(first, serverId, executionId);
        const lifecycle = await waitForExecutionStreamEvents(first, serverId, executionId, 3);
        assert.deepEqual(lifecycle.map((event) => event.execution.status), ["queued", "running", "succeeded"]);
        const replayed = await readSseFrames(
            `${first.origin}/workbench/workspaces/default/servers/${serverId}/executions/stream?executionId=${executionId}`,
            first.cookie,
            lifecycle.length - 1,
            { "Last-Event-ID": String(lifecycle[0]!.sequence) },
        );
        assert.deepEqual(
            replayed.map((frame) => Number(frame.id)),
            lifecycle.slice(1).map((event) => event.sequence),
        );
        assert.deepEqual(
            replayed.map((frame) => record(frame.data).status),
            ["running", "succeeded"],
        );

        const persisted = (await first.workbench.repository.listExecutions("default", serverId))
            .find((execution) => execution.id === executionId);
        assert(persisted?.idempotency);
        const raced = structuredClone(persisted);
        racedExecutionId = "execution-sse-snapshot-race";
        raced.id = racedExecutionId;
        raced.idempotency = {
            ...persisted.idempotency,
            key: "execution-sse-snapshot-race-key",
        };
        const racedEvidence = record(raced.evidence);
        racedEvidence.id = racedExecutionId;
        const racedRequest = record(racedEvidence.request);
        racedRequest.idempotencyKey = raced.idempotency.key;
        record(racedEvidence.correlation).executionId = racedExecutionId;
        const savedRace = await first.workbench.repository.saveExecution(raced);
        assert(savedRace.streamEventId);
        racedEventId = savedRace.streamEventId;

        const originalSnapshot = first.workbench.executions.streamSnapshot.bind(first.workbench.executions);
        let injected = false;
        first.workbench.executions.streamSnapshot = (workspaceId, scopedServerId) => {
            const beforeRace = originalSnapshot(workspaceId, scopedServerId);
            if (!injected) {
                injected = true;
                first.workbench.executions.restorePersisted([savedRace]);
            }
            return beforeRace;
        };
        try {
            const [racedFrame] = await readSseFrames(
                `${first.origin}/workbench/workspaces/default/servers/${serverId}/executions/stream?executionId=${racedExecutionId}`,
                first.cookie,
                1,
                { "Last-Event-ID": String(racedEventId - 1) },
            );
            assert.equal(racedFrame?.id, String(racedEventId));
            assert.equal(record(racedFrame?.data).id, racedExecutionId);
            assert.doesNotThrow(() => WorkbenchExecutionRecordSchema.parse(racedFrame?.data));
        } finally {
            first.workbench.executions.streamSnapshot = originalSnapshot;
        }
    } finally {
        await first.close();
    }

    const reopened = await startHarness(filePath);
    try {
        const [persistedFrame] = await readSseFrames(
            `${reopened.origin}/workbench/workspaces/default/servers/${serverId}/executions/stream?executionId=${racedExecutionId}`,
            reopened.cookie,
            1,
            { "Last-Event-ID": String(racedEventId - 1) },
        );
        assert.equal(persistedFrame?.id, String(racedEventId));
        assert.equal(record(persistedFrame?.data).id, racedExecutionId);
        assert.equal(record(persistedFrame?.data).status, "succeeded");
        assert.doesNotThrow(() => WorkbenchExecutionRecordSchema.parse(persistedFrame?.data));
    } finally {
        await reopened.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("workbench API persists evaluations, comparisons, exports, and sanitized evidence across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-persistence-"));
    const filePath = join(directory, "state.json");
    const secret = "workbench-secret-that-must-not-persist";
    const first = await startHarness(filePath, { secretValues: [secret] });
    let firstCookie = first.cookie;
    let serverId = "";
    let testCaseId = "";
    let suiteId = "";
    let baselineRunId = "";
    let candidateRunId = "";
    let executionId = "";
    let directExecutionId = "";
    let jsonExportId = "";
    let reportExportId = "";
    try {
        serverId = await fixtureServerId(first);

        const referencedConnection = await postJson(first, "/workbench/workspaces/default/servers", {
            name: "Referenced remote",
            configuration: {
                transport: "streamable_http",
                endpoint: "https://mcp.example.test/mcp",
                headers: [{
                    name: "Authorization",
                    scheme: "bearer",
                    secret: { source: "environment", environment_variable: "WORKBENCH_TEST_TOKEN" },
                }],
            },
            auto_connect: false,
        });
        assert.equal(referencedConnection.response.status, 200);

        const testCase = await postJson(first, "/workbench/workspaces/default/test-cases", {
            server_id: serverId,
            name: "Sanitized lookup",
            tool_name: "fixture.safe_lookup",
            arguments: { query: secret },
            timeout_ms: 5_000,
            assertions: [{ id: "status-succeeds", kind: "status", expected: ["succeeded", "failed"] }],
            tags: ["persistence"],
        });
        assert.equal(testCase.response.status, 200);
        testCaseId = String(testCase.body.id);

        const suite = await postJson(first, "/workbench/workspaces/default/suites", {
            name: "Persistence suite",
            test_case_ids: [testCaseId],
            tags: ["regression"],
        });
        assert.equal(suite.response.status, 200);
        suiteId = String(suite.body.id);

        const baselineAccepted = await postJson(
            first,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "baseline-evaluation-0001" },
        );
        assert.equal(baselineAccepted.response.status, 202);
        baselineRunId = String(record(baselineAccepted.body.run).id);
        const baselineReplay = await postJson(
            first,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "baseline-evaluation-0001" },
        );
        assert.equal(record(baselineReplay.body.run).id, baselineRunId);
        const baseline = await waitForEvaluation(first, baselineRunId);
        assert.equal(baseline.status, "completed");
        assert.equal(record(baseline.summary).passed, 1);
        executionId = String(record((baseline.results as Array<Record<string, unknown>>)[0]).executionId);

        const candidateAccepted = await postJson(
            first,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "candidate-evaluation-0001" },
        );
        candidateRunId = String(record(candidateAccepted.body.run).id);
        const candidate = await waitForEvaluation(first, candidateRunId);
        assert.equal(record(candidate.summary).passed, 1);

        const comparison = await postJson(first, "/workbench/workspaces/default/evaluation-runs/compare", {
            baseline_run_id: baselineRunId,
            candidate_run_id: candidateRunId,
        });
        assert.equal(comparison.response.status, 200);
        assert.equal(comparison.body.baseline_run_id, baselineRunId);
        assert.equal(comparison.body.candidate_run_id, candidateRunId);
        assert.equal(comparison.body.success_rate_delta, 0);
        assert.equal((comparison.body.tests as Array<Record<string, unknown>>)[0]?.status, "unchanged");

        const jsonExport = await postJson(
            first,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/export`,
            {
                format: "json",
                include_protocol_events: true,
                include_telemetry: false,
                idempotency_key: "json-export-0001",
            },
        );
        assert.equal(jsonExport.response.status, 202);
        jsonExportId = String(record(jsonExport.body.export).id);
        const jsonExportReplay = await postJson(
            first,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/export`,
            {
                format: "json",
                include_protocol_events: true,
                include_telemetry: false,
                idempotency_key: "json-export-0001",
            },
        );
        assert.equal(record(jsonExportReplay.body.export).id, jsonExportId);
        const jsonContent = await getJson(
            first,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/exports/${jsonExportId}/content`,
        );
        assert.doesNotMatch(JSON.stringify(jsonContent.body), new RegExp(secret, "u"));
        assert.match(JSON.stringify(jsonContent.body), /\[REDACTED\]/u);

        const reportExport = await postJson(
            first,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/export`,
            { format: "report", idempotency_key: "report-export-0001" },
        );
        reportExportId = String(record(reportExport.body.export).id);
        const reportContent = await getJson(
            first,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/exports/${reportExportId}/content`,
        );
        assert.match(String(record(reportContent.body.payload).markdown), /Persistence suite/u);
        assert.doesNotMatch(JSON.stringify(reportContent.body), new RegExp(secret, "u"));

        const preferences = await putJson(first, "/workbench/workspaces/default/preferences", {
            selected_server_id: serverId,
            selected_tool_name: "fixture.safe_lookup",
            input_mode: "json",
            active_panel: "protocol",
            compact_mode: true,
        });
        assert.equal(preferences.response.status, 200);

        const directExecution = await postJson(
            first,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: "durable idempotency" },
                timeout_ms: 5_000,
                idempotency_key: "durable-execution-0001",
            },
        );
        directExecutionId = String(record(directExecution.body.execution).id);
        await waitForExecution(first, serverId, directExecutionId);

        const baselineExecution = (await first.workbench.repository.listExecutions("default", serverId))
            .find((item) => item.id === executionId);
        assert(baselineExecution);
        await first.workbench.repository.saveExecution({
            ...baselineExecution,
            telemetryCorrelation: {
                executionId,
                evaluationRunId: baselineRunId,
                testCaseId,
                traceIds: ["11111111111111111111111111111111"],
                spanIds: ["2222222222222222"],
            },
        });

        const onDisk = await readFile(filePath, "utf8");
        assert.doesNotMatch(onDisk, new RegExp(secret, "u"));
        assert.match(onDisk, /\[REDACTED\]/u);
        assert.match(onDisk, /WORKBENCH_TEST_TOKEN/u);
        assert.doesNotMatch(onDisk, new RegExp(first.cookie.split("=")[1] ?? "never-match", "u"));
    } finally {
        await first.close();
    }

    const reopened = await startHarness(filePath, { secretValues: [secret] });
    try {
        assert.equal((await fetch(`${reopened.origin}/workbench/workspaces`, {
            headers: { cookie: firstCookie },
        })).status, 401);
        assert.notEqual(reopened.cookie, firstCookie);

        const server = await getJson(reopened, `/workbench/workspaces/default/servers/${serverId}`);
        assert.equal(record(server.body.connection).status, "connected");
        const persistedTest = await getJson(reopened, `/workbench/workspaces/default/test-cases/${testCaseId}`);
        assert.equal(record(persistedTest.body.arguments).query, "[REDACTED]");
        assert.deepEqual(
            record((persistedTest.body.assertions as Array<Record<string, unknown>>)[0]).expected,
            ["succeeded", "failed"],
        );
        assert.equal((await getJson(reopened, `/workbench/workspaces/default/suites/${suiteId}`)).response.status, 200);

        const persistedRun = await getJson(
            reopened,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}`,
        );
        assert.equal(persistedRun.body.status, "completed");
        assert.equal(record(persistedRun.body.summary).passed, 1);
        const persistedExecution = await getJson(
            reopened,
            `/workbench/workspaces/default/servers/${serverId}/executions/${executionId}`,
        );
        assert.equal(persistedExecution.body.status, "succeeded");

        const replayedEvaluation = await postJson(
            reopened,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "baseline-evaluation-0001" },
        );
        assert.equal(record(replayedEvaluation.body.run).id, baselineRunId);
        const conflictingEvaluation = await postJson(
            reopened,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "baseline-evaluation-0001", concurrency: 2 },
        );
        assert.equal(conflictingEvaluation.response.status, 409);

        const replayedExecution = await postJson(
            reopened,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: "durable idempotency" },
                timeout_ms: 5_000,
                idempotency_key: "durable-execution-0001",
            },
        );
        assert.equal(replayedExecution.response.status, 202);
        assert.equal(record(replayedExecution.body.execution).id, directExecutionId);
        const conflictingExecution = await postJson(
            reopened,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            {
                tool_name: "fixture.safe_lookup",
                arguments: { query: "different durable payload" },
                timeout_ms: 5_000,
                idempotency_key: "durable-execution-0001",
            },
        );
        assert.equal(conflictingExecution.response.status, 409);

        const telemetry = await getJson(
            reopened,
            `/workbench/workspaces/default/servers/${serverId}/executions/${executionId}/telemetry`,
        );
        assert.deepEqual(record(telemetry.body.correlation).trace_ids, ["11111111111111111111111111111111"]);
        assert.deepEqual(record(telemetry.body.correlation).span_ids, ["2222222222222222"]);

        const repeatedExport = await postJson(
            reopened,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/export`,
            {
                format: "json",
                include_protocol_events: true,
                include_telemetry: false,
                idempotency_key: "json-export-0001",
            },
        );
        assert.equal(record(repeatedExport.body.export).id, jsonExportId);
        const reopenedExport = await postJson(
            reopened,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/export`,
            {
                format: "json",
                include_protocol_events: true,
                include_telemetry: false,
                idempotency_key: "json-export-after-reopen-0001",
            },
        );
        const reopenedExportId = String(record(reopenedExport.body.export).id);
        const reopenedContent = await getJson(
            reopened,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/exports/${reopenedExportId}/content`,
        );
        const reopenedEvents = record(reopenedContent.body.payload).protocol_events;
        assert(Array.isArray(reopenedEvents));
        assert(reopenedEvents.some((event) => record(event).method === "tools/call"));
        assert.doesNotMatch(JSON.stringify(reopenedContent.body), new RegExp(secret, "u"));
        assert.equal((await getJson(
            reopened,
            `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/exports/${reportExportId}`,
        )).response.status, 200);

        const comparison = await postJson(reopened, "/workbench/workspaces/default/evaluation-runs/compare", {
            baseline_run_id: baselineRunId,
            candidate_run_id: candidateRunId,
        });
        assert.equal(comparison.response.status, 200);
        const preferences = await getJson(reopened, "/workbench/workspaces/default/preferences");
        assert.equal(preferences.body.selected_server_id, serverId);
        assert.equal(preferences.body.input_mode, "json");
        assert.equal(preferences.body.compact_mode, true);

        const persistedText = await readFile(filePath, "utf8");
        assert.doesNotMatch(persistedText, new RegExp(secret, "u"));
        assert.doesNotMatch(
            JSON.stringify((await getJson(
                reopened,
                `/workbench/workspaces/default/evaluation-runs/${baselineRunId}/exports/${jsonExportId}/content`,
            )).body),
            new RegExp(secret, "u"),
        );
    } finally {
        await reopened.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("startup reconciles crashed executions and evaluations before idempotent replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-crash-recovery-"));
    const filePath = join(directory, "state.json");
    const first = await startHarness(filePath);
    let serverId = "";
    let executionId = "";
    let evaluationRunId = "";
    let suiteId = "";
    const invocation = {
        toolName: "fixture.safe_lookup",
        arguments: { query: "recover after crash" },
        timeoutMs: 5_000,
        idempotencyKey: "crash-recovery-execution",
    } as const;
    // The same invocation as the contract's request body: the replay below
    // crosses HTTP, where the published wire names apply.
    const invocationRequest = {
        tool_name: invocation.toolName,
        arguments: invocation.arguments,
        timeout_ms: invocation.timeoutMs,
        idempotency_key: invocation.idempotencyKey,
    } as const;
    try {
        serverId = await fixtureServerId(first);
        const accepted = await first.workbench.executions.start({
            workspaceId: "default",
            serverId,
            ...invocation,
            correlation: {
                evaluationRunId: "crashed-parent-evaluation",
                testCaseId: "crashed-parent-case",
            },
        });
        executionId = accepted.id;
        await waitForExecution(first, serverId, executionId);
        await waitForPersistedToolEvents(first, serverId, [executionId]);
        const persistedExecution = (await first.workbench.repository.listExecutions("default", serverId))
            .find((item) => item.id === executionId);
        assert(persistedExecution);
        const crashedExecution = structuredClone(persistedExecution);
        crashedExecution.status = "running";
        delete crashedExecution.completedAt;
        const crashedEvidence = record(crashedExecution.evidence);
        crashedEvidence.status = "running";
        delete crashedEvidence.completedAt;
        delete crashedEvidence.durationMs;
        delete crashedEvidence.result;
        delete crashedEvidence.error;
        await first.workbench.repository.saveExecution(crashedExecution);

        const testCase = await postJson(first, "/workbench/workspaces/default/test-cases", {
            server_id: serverId,
            name: "Crash recovery case",
            tool_name: "fixture.safe_lookup",
            arguments: { query: "evaluation recovery" },
            timeout_ms: 5_000,
            assertions: [{ id: "status-succeeds", kind: "status", expected: ["succeeded"] }],
        });
        const suite = await postJson(first, "/workbench/workspaces/default/suites", {
            name: "Crash recovery suite",
            test_case_ids: [String(testCase.body.id)],
        });
        suiteId = String(suite.body.id);
        const evaluation = await postJson(
            first,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "crash-recovery-evaluation" },
        );
        evaluationRunId = String(record(evaluation.body.run).id);
        await waitForEvaluation(first, evaluationRunId);
        const completedRun = await first.workbench.repository.getEvaluationRun("default", evaluationRunId);
        const { completedAt: _completedAt, error: _error, ...preservedRun } = completedRun;
        await first.workbench.repository.saveEvaluationRun({
            ...preservedRun,
            status: "running",
            results: [],
            summary: {
                ...completedRun.summary,
                passed: 0,
                failed: 0,
                errors: 0,
                skipped: 0,
                successRate: 0,
                reliability: 0,
            },
        });
    } finally {
        await first.close();
    }

    const reopened = await startHarness(filePath);
    try {
        const recoveredExecution = await getJson(
            reopened,
            `/workbench/workspaces/default/servers/${serverId}/executions/${executionId}`,
        );
        assert.equal(recoveredExecution.body.status, "failed");
        assert.equal(record(recoveredExecution.body.error).code, "execution_interrupted");
        assert.equal(typeof recoveredExecution.body.completed_at, "string");
        const replayedExecution = await postJson(
            reopened,
            `/workbench/workspaces/default/servers/${serverId}/executions`,
            invocationRequest,
        );
        assert.equal(replayedExecution.response.status, 202);
        assert.equal(record(replayedExecution.body.execution).id, executionId);
        assert.equal(record(replayedExecution.body.execution).status, "failed");
        const durableExecution = (await reopened.workbench.repository.listExecutions("default", serverId))
            .find((item) => item.id === executionId);
        assert(durableExecution);
        const durableCorrelation = record(record(durableExecution.evidence).correlation);
        assert.equal(durableCorrelation.evaluationRunId, "crashed-parent-evaluation");
        assert.equal(durableCorrelation.testCaseId, "crashed-parent-case");
        assert.equal(durableExecution.idempotency?.key, invocation.idempotencyKey);

        const recoveredEvaluation = await getJson(
            reopened,
            `/workbench/workspaces/default/evaluation-runs/${evaluationRunId}`,
        );
        assert.equal(recoveredEvaluation.body.status, "failed");
        assert.equal(record(recoveredEvaluation.body.error).code, "evaluation_interrupted");
        assert.equal(record(recoveredEvaluation.body.summary).errors, 1);
        const replayedEvaluation = await postJson(
            reopened,
            `/workbench/workspaces/default/suites/${suiteId}/run`,
            { idempotency_key: "crash-recovery-evaluation" },
        );
        assert.equal(replayedEvaluation.response.status, 202);
        assert.equal(record(replayedEvaluation.body.run).id, evaluationRunId);
        assert.equal(record(replayedEvaluation.body.run).status, "failed");
        const durableEvaluation = await reopened.workbench.repository.getEvaluationRun("default", evaluationRunId);
        assert.equal(durableEvaluation.idempotencyKey, "crash-recovery-evaluation");
        assert.equal(typeof durableEvaluation.idempotencyFingerprint, "string");
    } finally {
        await reopened.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("workbench API persists background evaluation failures as failed runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-evaluation-failure-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const testCase = await postJson(harness, "/workbench/workspaces/default/test-cases", {
            server_id: serverId,
            name: "Failure evidence",
            tool_name: "fixture.safe_lookup",
            arguments: { query: "never invoked" },
            timeout_ms: 5_000,
            assertions: [{ id: "status-succeeds", kind: "status", expected: ["succeeded"] }],
        });
        const suite = await postJson(harness, "/workbench/workspaces/default/suites", {
            name: "Failing evaluation",
            test_case_ids: [String(testCase.body.id)],
        });
        Object.defineProperty(harness.workbench.evaluations, "runSuite", {
            configurable: true,
            value: async () => {
                throw new Error("synthetic evaluator failure");
            },
        });

        const accepted = await postJson(
            harness,
            `/workbench/workspaces/default/suites/${String(suite.body.id)}/run`,
            { idempotency_key: "failed-evaluation-0001" },
        );
        assert.equal(accepted.response.status, 202);
        const runId = String(record(accepted.body.run).id);
        const failed = await waitForEvaluation(harness, runId);
        assert.equal(failed.status, "failed");
        assert.equal(record(failed.error).code, "evaluation_failed");
        assert.equal(record(failed.summary).errors, 1);
        assert.equal((failed.results as unknown[]).length, 0);

        const persisted = await harness.workbench.repository.getEvaluationRun("default", runId);
        assert.equal(persisted.status, "failed");
        assert.equal(persisted.error?.code, "evaluation_failed");
        assert.equal(persisted.idempotencyKey, "failed-evaluation-0001");
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("concurrent evaluation idempotency coalesces one run and rejects payload conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-evaluation-idempotency-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const testCase = await postJson(harness, "/workbench/workspaces/default/test-cases", {
            server_id: serverId,
            name: "Concurrent evaluation",
            tool_name: "fixture.safe_lookup",
            arguments: { query: "coalesce" },
            timeout_ms: 5_000,
            assertions: [{ id: "status-succeeds", kind: "status", expected: ["succeeded"] }],
        });
        const suite = await postJson(harness, "/workbench/workspaces/default/suites", {
            name: "Concurrent suite",
            test_case_ids: [String(testCase.body.id)],
        });
        const suiteId = String(suite.body.id);

        let releaseLookup!: () => void;
        const lookupGate = new Promise<void>((resolve) => {
            releaseLookup = resolve;
        });
        let lookupStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            lookupStarted = resolve;
        });
        let lookups = 0;
        const originalFind = harness.workbench.repository.findEvaluationRunByIdempotency.bind(
            harness.workbench.repository,
        );
        Object.defineProperty(harness.workbench.repository, "findEvaluationRunByIdempotency", {
            configurable: true,
            value: async (...args: Parameters<typeof originalFind>) => {
                if (args[2] === "concurrent-evaluation-0001") {
                    lookups += 1;
                    lookupStarted();
                    await lookupGate;
                }
                return originalFind(...args);
            },
        });

        let runCalls = 0;
        const originalRunSuite = harness.workbench.evaluations.runSuite.bind(harness.workbench.evaluations);
        Object.defineProperty(harness.workbench.evaluations, "runSuite", {
            configurable: true,
            value: async (...args: Parameters<typeof originalRunSuite>) => {
                runCalls += 1;
                return originalRunSuite(...args);
            },
        });

        const path = `/workbench/workspaces/default/suites/${suiteId}/run`;
        const first = postJson(harness, path, { idempotency_key: "concurrent-evaluation-0001" });
        await started;
        const duplicate = postJson(harness, path, { idempotency_key: "concurrent-evaluation-0001" });
        const conflict = await postJson(harness, path, {
            idempotency_key: "concurrent-evaluation-0001",
            concurrency: 2,
        });
        assert.equal(conflict.response.status, 409);
        releaseLookup();

        const [firstAccepted, duplicateAccepted] = await Promise.all([first, duplicate]);
        assert.equal(firstAccepted.response.status, 202);
        assert.equal(duplicateAccepted.response.status, 202);
        const runId = String(record(firstAccepted.body.run).id);
        assert.equal(record(duplicateAccepted.body.run).id, runId);
        const completed = await waitForEvaluation(harness, runId);
        assert.equal(completed.status, "completed");
        assert.equal(lookups, 1);
        assert.equal(runCalls, 1);
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("overlapping tool calls retain request-bound correlation through journals, spans, and persistence", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-overlap-correlation-"));
    const harness = await startHarness(join(directory, "state.json"));
    try {
        const serverId = await fixtureServerId(harness);
        const spanInputs: McpOperationInput[] = [];
        harness.workbench.telemetry.recordOperation = (input) => {
            spanInputs.push(structuredClone(input));
            return undefined;
        };
        harness.workbench.telemetry.startOperation = (input) => ({
            run: (operation) => operation(),
            end(completion) {
                spanInputs.push(structuredClone({ ...input, ...completion }));
                return undefined;
            },
        });

        let releaseFirstRunning!: () => void;
        const firstRunningGate = new Promise<void>((resolve) => {
            releaseFirstRunning = resolve;
        });
        let releaseSecondRunning!: () => void;
        const secondRunningGate = new Promise<void>((resolve) => {
            releaseSecondRunning = resolve;
        });
        let firstRunningEntered!: () => void;
        const firstRunning = new Promise<void>((resolve) => {
            firstRunningEntered = resolve;
        });
        let secondRunningEntered!: () => void;
        const secondRunning = new Promise<void>((resolve) => {
            secondRunningEntered = resolve;
        });

        const originalSave = harness.workbench.repository.saveExecution.bind(harness.workbench.repository);
        Object.defineProperty(harness.workbench.repository, "saveExecution", {
            configurable: true,
            value: async (...args: Parameters<typeof originalSave>) => {
                const [execution] = args;
                if (execution.status === "running") {
                    const testCaseId = String(record(record(execution.evidence).correlation).testCaseId);
                    if (testCaseId === "overlap-case-a") {
                        firstRunningEntered();
                        await firstRunningGate;
                    } else if (testCaseId === "overlap-case-b") {
                        secondRunningEntered();
                        await secondRunningGate;
                    }
                }
                return originalSave(...args);
            },
        });

        const first = await harness.workbench.executions.start({
            workspaceId: "default",
            serverId,
            toolName: "fixture.delayed",
            arguments: { delayMs: 100 },
            timeoutMs: 5_000,
            idempotencyKey: "overlap-execution-a",
            correlation: { evaluationRunId: "overlap-evaluation", testCaseId: "overlap-case-a" },
        });
        await firstRunning;
        const second = await harness.workbench.executions.start({
            workspaceId: "default",
            serverId,
            toolName: "fixture.delayed",
            arguments: { delayMs: 100 },
            timeoutMs: 5_000,
            idempotencyKey: "overlap-execution-b",
            correlation: { evaluationRunId: "overlap-evaluation", testCaseId: "overlap-case-b" },
        });
        await secondRunning;

        releaseFirstRunning();
        await waitForToolRequestCount(harness, serverId, 1);
        releaseSecondRunning();
        await waitForToolRequestCount(harness, serverId, 2);
        const [firstCompleted, secondCompleted] = await Promise.all([
            waitForExecution(harness, serverId, first.id),
            waitForExecution(harness, serverId, second.id),
        ]);
        assert.equal(firstCompleted.status, "succeeded");
        assert.equal(secondCompleted.status, "succeeded");
        await waitForPersistedToolEvents(harness, serverId, [first.id, second.id]);

        const expected = new Map([
            [first.id, "overlap-case-a"],
            [second.id, "overlap-case-b"],
        ]);
        for (const journal of [
            harness.workbench.connections.getJournal(serverId),
            harness.workbench.connections.getServerJournal(serverId),
        ]) {
            assert(journal);
            const entries = journal.snapshot().filter(isToolsCallProtocolEvent);
            assert.equal(entries.length, 4);
            for (const [executionId, testCaseId] of expected) {
                const correlated = entries.filter((entry) => entry.correlation?.executionId === executionId);
                assert.deepEqual(
                    correlated.map((entry) => entry.messageKind).sort(),
                    ["request", "response"],
                );
                assert(correlated.every((entry) => entry.correlation?.evaluationRunId === "overlap-evaluation"));
                assert(correlated.every((entry) => entry.correlation?.testCaseId === testCaseId));
            }
        }

        const toolSpans = spanInputs.filter((input) => input.method === "tools/call");
        assert.equal(toolSpans.length, 4);
        for (const [executionId, testCaseId] of expected) {
            const correlated = toolSpans.filter((input) => input.executionId === executionId);
            assert.deepEqual(correlated.map((input) => input.role).sort(), ["client", "server"]);
            assert(correlated.every((input) => input.evaluationRunId === "overlap-evaluation"));
            assert(correlated.every((input) => input.testCaseId === testCaseId));
        }

        const persisted = await harness.workbench.repository.listExecutions("default", serverId);
        for (const [executionId, testCaseId] of expected) {
            const execution = persisted.find((item) => item.id === executionId);
            assert(execution);
            const entries = (execution.protocolEvents ?? []).filter(isToolsCallProtocolEvent);
            assert.deepEqual(entries.map((entry) => entry.messageKind).sort(), ["request", "response"]);
            assert(entries.every((entry) => entry.correlation?.executionId === executionId));
            assert(entries.every((entry) => entry.correlation?.evaluationRunId === "overlap-evaluation"));
            assert(entries.every((entry) => entry.correlation?.testCaseId === testCaseId));
        }
    } finally {
        await harness.close();
        await rm(directory, { recursive: true, force: true });
    }
});

interface Harness {
    workbench: WorkbenchApi;
    server: Server;
    origin: string;
    cookie: string;
    session: Record<string, unknown>;
    close(): Promise<void>;
}

async function startHarness(
    filePath: string,
    options: { secretValues?: readonly string[] } = {},
): Promise<Harness> {
    const repository = new WorkbenchRepository({
        filePath,
        ...(options.secretValues === undefined
            ? {}
            : { redactor: new SecretRedactor({ secretValues: options.secretValues }) }),
    });
    const workbench = new WorkbenchApi([fixtureResource], {
        repository,
        telemetry: new McpTelemetry({ QYL_MCP_TELEMETRY: "0" }),
        observability: {
            async queryExecution(query: QylObservabilityQuery) {
                const unavailable = {
                    status: "unavailable" as const,
                    unavailable_reason: "No collector is configured for this test.",
                    item_count: 0,
                };
                return {
                    signals: {
                        traces: unavailable,
                        logs: unavailable,
                        exceptions: unavailable,
                        tool_call_events: unavailable,
                    },
                    correlation: query.correlation,
                    traces: [],
                    logs: [],
                    queriedAt: new Date().toISOString(),
                    selfExportSuppressed: true as const,
                };
            },
        } as unknown as QylObservabilityProvider,
    });
    await workbench.initialize();

    const app = express();
    app.use(express.json());
    workbench.register(app);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await workbench.startAutoConnect();
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const bootstrap = await fetch(`${origin}/workbench/session`, { method: "POST" });
    assert.equal(bootstrap.status, 200);
    const setCookie = bootstrap.headers.get("set-cookie");
    const cookie = cookieValue(setCookie);
    const session = await responseJson(bootstrap);
    assert(!("token" in session));
    assert.equal(session.active_workspace_id, "default");

    let closed = false;
    return {
        workbench,
        server,
        origin,
        cookie,
        session,
        async close() {
            if (closed) return;
            closed = true;
            await workbench.close();
            await closeServer(server);
        },
    };
}

async function fixtureServerId(harness: Harness): Promise<string> {
    const listed = await getJson(harness, "/workbench/workspaces/default/servers");
    assert.equal(listed.response.status, 200);
    const configured = (listed.body.servers as Array<Record<string, unknown>>)
        .find((server) => server.name === fixtureResource.name);
    assert(configured, "The in-process conformance fixture was not configured.");
    assert.equal(record(configured.connection).status, "connected");
    return String(configured.id);
}

async function waitForExecution(
    harness: Harness,
    serverId: string,
    executionId: string,
): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await getJson(
            harness,
            `/workbench/workspaces/default/servers/${serverId}/executions/${executionId}`,
        );
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(String(response.body.status))) {
            return response.body;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Execution '${executionId}' did not complete.`);
}

async function waitForExecutionStreamEvents(
    harness: Harness,
    serverId: string,
    executionId: string,
    expected: number,
) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const events = harness.workbench.executions.streamSnapshot("default", serverId)
            .filter((event) => event.execution.id === executionId);
        if (events.length >= expected
            && events.some((event) => ["succeeded", "failed", "cancelled", "timed_out"]
                .includes(event.execution.status))) {
            return events;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Execution '${executionId}' did not publish ${expected} lifecycle events.`);
}

async function waitForEvaluation(
    harness: Harness,
    runId: string,
): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await getJson(
            harness,
            `/workbench/workspaces/default/evaluation-runs/${runId}`,
        );
        if (["completed", "failed", "cancelled"].includes(String(response.body.status))) return response.body;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Evaluation run '${runId}' did not complete.`);
}

async function waitForToolRequestCount(
    harness: Harness,
    serverId: string,
    expected: number,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const count = harness.workbench.connections.getServerJournal(serverId)?.snapshot().filter((entry) =>
            entry.kind === "message"
            && entry.messageKind === "request"
            && entry.method === "tools/call").length ?? 0;
        if (count >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Server journal did not retain ${expected} overlapping tool requests.`);
}

async function waitForPersistedToolEvents(
    harness: Harness,
    serverId: string,
    executionIds: readonly string[],
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const executions = await harness.workbench.repository.listExecutions("default", serverId);
        if (executionIds.every((executionId) => {
            const execution = executions.find((item) => item.id === executionId);
            return (execution?.protocolEvents ?? []).filter(isToolsCallProtocolEvent).length === 2;
        })) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Terminal persistence did not retain correlated tool request and response evidence.");
}

function isToolsCallProtocolEvent(value: unknown): value is ProtocolMessageEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const candidate = value as Partial<ProtocolMessageEntry>;
    return candidate.kind === "message" && candidate.method === "tools/call";
}

function getJson(harness: Harness, path: string): Promise<JsonResponse> {
    return json(`${harness.origin}${path}`, { headers: { cookie: harness.cookie } });
}

function postJson(harness: Harness, path: string, body: unknown): Promise<JsonResponse> {
    return json(`${harness.origin}${path}`, {
        method: "POST",
        headers: { cookie: harness.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function putJson(harness: Harness, path: string, body: unknown): Promise<JsonResponse> {
    return json(`${harness.origin}${path}`, {
        method: "PUT",
        headers: { cookie: harness.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

interface JsonResponse {
    response: Response;
    body: Record<string, unknown>;
}

async function json(url: string, init?: RequestInit): Promise<JsonResponse> {
    const response = await fetch(url, init);
    return { response, body: await responseJson(response) };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return await response.json() as Record<string, unknown>;
}

async function firstSseData(url: string, cookie: string): Promise<unknown> {
    return (await readSseFrames(url, cookie, 1))[0]!.data;
}

interface SseFrame {
    id?: string;
    event?: string;
    data: unknown;
}

async function readSseFrames(
    url: string,
    cookie: string,
    count: number,
    headers: Readonly<Record<string, string>> = {},
): Promise<SseFrame[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch(url, {
            headers: { cookie, accept: "text/event-stream", ...headers },
            signal: controller.signal,
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
        assert(response.body);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const frames: SseFrame[] = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) throw new Error("SSE stream ended before its first event.");
            buffer += decoder.decode(value, { stream: true });
            for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const lines = frame.split("\n");
                const data = lines
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (!data) throw new Error("SSE frame had no data field.");
                const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trimStart();
                const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trimStart();
                frames.push({
                    ...(id === undefined ? {} : { id }),
                    ...(event === undefined ? {} : { event }),
                    data: JSON.parse(data) as unknown,
                });
                if (frames.length === count) {
                    await reader.cancel();
                    return frames;
                }
            }
        }
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

function record(value: unknown): Record<string, unknown> {
    assert(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
}

function cookieValue(setCookie: string | null): string {
    const cookie = setCookie?.split(";", 1)[0];
    if (!cookie?.startsWith("qyl-workbench-session=")) throw new Error("Session cookie was not set.");
    return cookie;
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
    }));
}
