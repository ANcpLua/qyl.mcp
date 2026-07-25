import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import test from "node:test";
import { startFixtureHttpServer } from "./fixture-http.js";
import type { QylObservabilityProvider } from "./qyl-observability.js";
import { McpTelemetry } from "./telemetry.js";
import { WorkbenchApi } from "./workbench-api.js";
import { WorkbenchRepository } from "./workbench-repository.js";

test("authenticated workbench API discovers and invokes real stdio and Streamable HTTP servers", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-transports-"));
    const secret = "workbench-transport-arbitrary-secret";
    const environment = { MCP_AUTH: secret, QYL_MCP_TELEMETRY: "0" };
    const fixture = await startFixtureHttpServer({ bearerToken: secret });
    const repository = new WorkbenchRepository({
        filePath: join(directory, "state.json"),
        environment,
    });
    const workbench = new WorkbenchApi([], {
        repository,
        environment,
        telemetry: new McpTelemetry(environment),
        observability: unavailableObservability(),
    });
    const app = express();
    app.use(express.json());
    workbench.register(app);
    const server = createServer(app);

    try {
        await workbench.initialize();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert(address && typeof address === "object");
        const origin = `http://127.0.0.1:${address.port}`;
        const bootstrap = await fetch(`${origin}/workbench/session`, { method: "POST" });
        assert.equal(bootstrap.status, 200);
        const cookie = cookieValue(bootstrap.headers.get("set-cookie"));
        const stdioScript = fileURLToPath(
            new URL("../../fixtures/mcp-conformance-stdio.mjs", import.meta.url),
        );

        const configurations = [
            {
                name: "Real stdio fixture",
                counts: { tools: 6, resources: 3, resourceTemplates: 3, prompts: 3 },
                configuration: {
                    transport: "stdio",
                    command: process.execPath,
                    arguments: [stdioScript],
                },
            },
            {
                name: "Real Streamable HTTP fixture",
                counts: { tools: 6, resources: 3, resourceTemplates: 3, prompts: 3 },
                configuration: {
                    transport: "streamable_http",
                    endpoint: fixture.streamableUrl.toString(),
                    headers: [{
                        name: "Authorization",
                        scheme: "bearer",
                        secret: {
                            source: "environment",
                            environmentVariable: "MCP_AUTH",
                        },
                    }],
                },
            },
        ];

        for (const item of configurations) {
            const created = await requestJson(origin, cookie, "/workbench/workspaces/default/servers", {
                method: "POST",
                body: {
                    name: item.name,
                    configuration: item.configuration,
                    autoConnect: false,
                },
            });
            assert.equal(created.response.status, 200);
            const serverId = String(created.body.id);

            const connected = await requestJson(
                origin,
                cookie,
                `/workbench/workspaces/default/servers/${serverId}/connect`,
                { method: "POST", body: {} },
            );
            assert.equal(connected.response.status, 202);
            await waitForConnection(origin, cookie, serverId);

            const discovery = await requestJson(
                origin,
                cookie,
                `/workbench/workspaces/default/servers/${serverId}/discovery`,
            );
            assert.equal(discovery.response.status, 200);
            assert.equal(record(discovery.body.tools).items instanceof Array, true);
            assert.equal((record(discovery.body.tools).items as unknown[]).length, item.counts.tools);
            assert.equal((record(discovery.body.resources).items as unknown[]).length, item.counts.resources);
            assert.equal(
                (record(discovery.body.resourceTemplates).items as unknown[]).length,
                item.counts.resourceTemplates,
            );
            assert.equal((record(discovery.body.prompts).items as unknown[]).length, item.counts.prompts);

            const accepted = await requestJson(
                origin,
                cookie,
                `/workbench/workspaces/default/servers/${serverId}/executions`,
                {
                    method: "POST",
                    body: {
                        toolName: "fixture.safe_lookup",
                        arguments: { query: item.name },
                        timeoutMs: 5_000,
                        idempotencyKey: `transport-${serverId}`,
                    },
                },
            );
            assert.equal(accepted.response.status, 202);
            const completed = await waitForExecution(
                origin,
                cookie,
                serverId,
                String(record(accepted.body.execution).id),
            );
            assert.equal(completed.status, "succeeded");
            assert.equal(
                record(record(completed.result).structuredContent).query,
                item.name,
            );
        }
    } finally {
        await workbench.close().catch(() => undefined);
        await closeServer(server);
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

function unavailableObservability(): QylObservabilityProvider {
    return {
        async queryExecution() {
            return {
                signals: {
                    traces: { status: "unavailable", unavailableReason: "fixture", itemCount: 0 },
                    logs: { status: "unavailable", unavailableReason: "fixture", itemCount: 0 },
                    exceptions: { status: "unavailable", unavailableReason: "fixture", itemCount: 0 },
                    toolCallEvents: { status: "unavailable", unavailableReason: "fixture", itemCount: 0 },
                },
                correlation: { executionId: "fixture", traceIds: [], spanIds: [] },
                traces: [],
                logs: [],
                queriedAt: new Date(0).toISOString(),
                selfExportSuppressed: true,
            };
        },
    } as unknown as QylObservabilityProvider;
}

async function waitForConnection(origin: string, cookie: string, serverId: string): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const response = await requestJson(
            origin,
            cookie,
            `/workbench/workspaces/default/servers/${serverId}`,
        );
        const connection = record(response.body.connection);
        if (connection.status === "connected") return;
        if (connection.status === "failed") {
            throw new Error(`fixture connection failed: ${String(connection.recentError)}`);
        }
        await delay(20);
    }
    throw new Error("fixture connection did not become ready");
}

async function waitForExecution(
    origin: string,
    cookie: string,
    serverId: string,
    executionId: string,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const response = await requestJson(
            origin,
            cookie,
            `/workbench/workspaces/default/servers/${serverId}/executions/${executionId}`,
        );
        const status = String(response.body.status);
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) return response.body;
        await delay(20);
    }
    throw new Error("fixture execution did not finish");
}

async function requestJson(
    origin: string,
    cookie: string,
    path: string,
    options: { method?: string; body?: unknown } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}${path}`, {
        method: options.method ?? "GET",
        headers: {
            cookie,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, body: record(await response.json()) };
}

function cookieValue(value: string | null): string {
    assert(value);
    return value.split(";", 1)[0]!;
}

function record(value: unknown): Record<string, unknown> {
    assert(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}
