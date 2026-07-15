import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import test from "node:test";
import { LogStore } from "./log-store.js";
import { Orchestrator, type ResourceRegistry } from "./orchestrator.js";
import type { McpResource, McpResourceState, ResourceLifecycle } from "./resources.js";

function fixtureServer(): McpServer {
    const server = new McpServer({ name: "runner-fixture", version: "1.0.0" });
    server.registerTool(
        "probe",
        { description: "Test-only protocol probe" },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    return server;
}

function inProcessResource(): McpResource {
    return {
        name: "fixture",
        kind: "inproc",
        serverFactory: fixtureServer,
        waitForNames: [],
    };
}

function waitForLifecycle(
    registry: ResourceRegistry,
    name: string,
    lifecycle: ResourceLifecycle,
): Promise<McpResourceState> {
    const current = registry.get(name);
    if (current?.lifecycle === lifecycle) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Timed out waiting for ${name} to reach ${lifecycle}.`));
        }, 2_000);
        const unsubscribe = registry.subscribe((state) => {
            if (state.name !== name || state.lifecycle !== lifecycle) return;
            clearTimeout(timeout);
            unsubscribe();
            resolve(state);
        });
    });
}

test("orchestrator publishes contract states and reports action acceptance honestly", async () => {
    const orchestrator = new Orchestrator([inProcessResource()], new LogStore());
    orchestrator.start();

    const ready = await waitForLifecycle(orchestrator.registry, "fixture", "ready");
    assert.equal(ready.kind, "inproc");
    assert.deepEqual(ready.serverIdentity, { name: "runner-fixture", version: "1.0.0" });
    assert.equal(ready.toolCount, 1);
    assert.equal(ready.restarts, 0);
    assert(!("endpoint" in ready));
    assert(!("allocatedPort" in ready));
    assert(!("lastError" in ready));

    assert.equal(orchestrator.stop("missing"), "not_found");
    assert.equal(orchestrator.stop("fixture"), "accepted");
    assert.equal(orchestrator.stop("fixture"), "conflict");

    const stopped = await waitForLifecycle(orchestrator.registry, "fixture", "stopped");
    assert(!("serverIdentity" in stopped));
    assert(!("toolCount" in stopped));
    assert.equal(orchestrator.stop("fixture"), "conflict");

    assert.equal(orchestrator.restart("fixture"), "accepted");
    assert.equal(orchestrator.restart("fixture"), "conflict");
    await waitForLifecycle(orchestrator.registry, "fixture", "ready");

    assert.equal(orchestrator.stop("fixture"), "accepted");
    await waitForLifecycle(orchestrator.registry, "fixture", "stopped");
});
