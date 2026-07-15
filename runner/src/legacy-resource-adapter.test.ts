import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LogStore } from "./log-store.js";
import { McpTelemetry } from "./telemetry.js";
import type { McpResource, McpResourceState, ResourceLifecycle } from "./resources.js";
import { WorkbenchApi } from "./workbench-api.js";
import { WorkbenchRepository } from "./workbench-repository.js";

test("managed resources have one runtime owner and legacy actions control that connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-legacy-owner-"));
    let factoryCalls = 0;
    const resource: McpResource = {
        name: "single-owner",
        kind: "inproc",
        waitForNames: [],
        serverFactory: () => fixtureServer("single-owner", String(++factoryCalls)),
    };
    const logs = new LogStore();
    const workbench = new WorkbenchApi([resource], {
        repository: new WorkbenchRepository({ filePath: join(directory, "state.json") }),
        telemetry: new McpTelemetry({ QYL_MCP_TELEMETRY: "0" }),
        logStore: logs,
    });
    try {
        await workbench.initialize();
        assert.equal(factoryCalls, 0);
        await workbench.startAutoConnect();
        assert.equal(factoryCalls, 1);

        const ready = workbench.legacyResources.lookup("single-owner");
        assert(ready);
        assert.equal(ready.state.lifecycle, "ready");
        assert.deepEqual(ready.state.serverIdentity, { name: "single-owner", version: "1" });
        assert.equal(workbench.connections.list().length, 1);
        const serverId = ready.serverId;
        const firstClient = workbench.connections.getClient(serverId);

        assert.equal(workbench.legacyResources.stop("single-owner"), "accepted");
        await waitForLifecycle(workbench, "single-owner", "stopped");
        assert.equal(workbench.connections.get(serverId).lifecycle, "disconnected");
        assert.equal(factoryCalls, 1);

        assert.equal(workbench.legacyResources.restart("single-owner"), "accepted");
        await waitForLifecycle(workbench, "single-owner", "ready");
        assert.equal(factoryCalls, 2);
        assert.equal(workbench.connections.list().length, 1);
        assert.notEqual(workbench.connections.getClient(serverId), firstClient);
        assert.equal(workbench.legacyResources.lookup("single-owner")?.serverId, serverId);

        assert(logs.snapshot("single-owner").length > 0);
        assert(logs.snapshot("single-owner").every((line) =>
            line.line.includes("lifecycle") || line.line.includes("requested")));
    } finally {
        await workbench.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("managed automatic connection honors waitFor dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-legacy-dependencies-"));
    const starts: string[] = [];
    const dependency: McpResource = {
        name: "dependency",
        kind: "inproc",
        waitForNames: [],
        serverFactory: () => {
            starts.push("dependency");
            return fixtureServer("dependency", "1");
        },
    };
    const dependent: McpResource = {
        name: "dependent",
        kind: "inproc",
        waitForNames: ["dependency"],
        serverFactory: () => {
            starts.push("dependent");
            return fixtureServer("dependent", "1");
        },
    };
    const workbench = new WorkbenchApi([dependent, dependency], {
        repository: new WorkbenchRepository({ filePath: join(directory, "state.json") }),
        telemetry: new McpTelemetry({ QYL_MCP_TELEMETRY: "0" }),
    });
    try {
        await workbench.initialize();
        await workbench.startAutoConnect();
        assert.deepEqual(starts, ["dependency", "dependent"]);
        assert.equal(workbench.legacyResources.lookup("dependency")?.state.lifecycle, "ready");
        assert.equal(workbench.legacyResources.lookup("dependent")?.state.lifecycle, "ready");
    } finally {
        await workbench.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("managed bootstrap rejects a persisted same-name configuration collision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-legacy-collision-"));
    const repository = new WorkbenchRepository({ filePath: join(directory, "state.json") });
    await repository.initialize();
    await repository.createServer("default", {
        name: "managed-name",
        configuration: {
            kind: "streamable_http",
            endpoint: "http://127.0.0.1:3000/mcp",
            headers: [],
        },
        autoConnect: true,
    });
    const workbench = new WorkbenchApi([
        {
            name: "managed-name",
            kind: "http",
            endpoint: "http://127.0.0.1:4000/mcp",
            waitForNames: [],
        },
    ], {
        repository,
        telemetry: new McpTelemetry({ QYL_MCP_TELEMETRY: "0" }),
    });
    try {
        await assert.rejects(
            workbench.initialize(),
            /managed-name.*different configuration/u,
        );
    } finally {
        await workbench.close();
        await rm(directory, { recursive: true, force: true });
    }
});

function fixtureServer(name: string, version: string): McpServer {
    const server = new McpServer({ name, version });
    server.registerTool(
        "probe",
        { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    return server;
}

function waitForLifecycle(
    workbench: WorkbenchApi,
    name: string,
    lifecycle: ResourceLifecycle,
): Promise<McpResourceState> {
    const current = workbench.legacyResources.lookup(name)?.state;
    if (current?.lifecycle === lifecycle) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Timed out waiting for ${name} to reach ${lifecycle}.`));
        }, 2_000);
        const unsubscribe = workbench.legacyResources.subscribe((state) => {
            if (state.name !== name || state.lifecycle !== lifecycle) return;
            clearTimeout(timeout);
            unsubscribe();
            resolve(state);
        });
    });
}
