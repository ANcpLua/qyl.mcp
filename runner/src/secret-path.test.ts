import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import test from "node:test";
import { startFixtureHttpServer } from "./fixture-http.js";
import type { QylObservabilityProvider } from "./qyl-observability.js";
import { McpTelemetry } from "./telemetry.js";
import { WorkbenchApi } from "./workbench-api.js";
import { WorkbenchRepository } from "./workbench-repository.js";

test("env-referenced transport credentials cannot leak through echoed results, protocol, or disk", { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-workbench-secret-path-"));
    const statePath = join(directory, "state.json");
    const secret = "arbitrary-name-credential-that-must-not-persist";
    const environment = {
        MCP_AUTH: secret,
        QYL_MCP_TELEMETRY: "0",
    };
    const fixture = await startFixtureHttpServer({ bearerToken: secret });
    const repository = new WorkbenchRepository({
        filePath: statePath,
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
        const bootstrap = await fetch(`${origin}/runner/session`, { method: "POST" });
        assert.equal(bootstrap.status, 200);
        const cookie = cookieValue(bootstrap.headers.get("set-cookie"));

        const created = await requestJson(origin, cookie, "/runner/workspaces/default/servers", {
            method: "POST",
            body: {
                name: "Authenticated fixture",
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
                autoConnect: false,
            },
        });
        assert.equal(created.response.status, 200);
        const serverId = String(created.body.id);

        const connected = await requestJson(
            origin,
            cookie,
            `/runner/workspaces/default/servers/${serverId}/connect`,
            { method: "POST", body: {} },
        );
        assert.equal(connected.response.status, 202);
        await waitForConnection(origin, cookie, serverId);

        const accepted = await requestJson(
            origin,
            cookie,
            `/runner/workspaces/default/servers/${serverId}/executions`,
            {
                method: "POST",
                body: {
                    toolName: "fixture.safe_lookup",
                    arguments: { query: secret },
                    timeoutMs: 5_000,
                    idempotencyKey: "env-secret-echo-0001",
                },
            },
        );
        assert.equal(accepted.response.status, 202);
        const executionId = String(record(accepted.body.execution).id);
        const completed = await waitForExecution(origin, cookie, serverId, executionId);
        assert.equal(completed.status, "succeeded");
        assert.doesNotMatch(JSON.stringify(completed), new RegExp(secret, "u"));
        assert.match(JSON.stringify(completed), /\[REDACTED\]/u);

        const protocol = await requestJson(
            origin,
            cookie,
            `/runner/workspaces/default/servers/${serverId}/protocol`,
        );
        assert.equal(protocol.response.status, 200);
        assert.doesNotMatch(JSON.stringify(protocol.body), new RegExp(secret, "u"));

        const persisted = await readFile(statePath, "utf8");
        assert.doesNotMatch(persisted, new RegExp(secret, "u"));
        assert.match(persisted, /MCP_AUTH/u);
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
                executionId: "unused",
                availability: "unavailable",
                signals: [],
                traces: [],
                logs: [],
            };
        },
    } as unknown as QylObservabilityProvider;
}

async function waitForConnection(origin: string, cookie: string, serverId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = await requestJson(
            origin,
            cookie,
            `/runner/workspaces/default/servers/${serverId}`,
        );
        if (record(result.body.connection).status === "connected") return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("fixture connection did not become ready");
}

async function waitForExecution(
    origin: string,
    cookie: string,
    serverId: string,
    executionId: string,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = await requestJson(
            origin,
            cookie,
            `/runner/workspaces/default/servers/${serverId}/executions/${executionId}`,
        );
        const status = String(result.body.status);
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) return result.body;
        await new Promise((resolve) => setTimeout(resolve, 20));
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

function cookieValue(header: string | null): string {
    assert(header);
    return header.split(";", 1)[0]!;
}

function record(value: unknown): Record<string, unknown> {
    assert(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}
