// A stdio resource's "spawn" is the SDK's StdioClientTransport spawning the child itself: the
// runner owns the child's stdio, so the ONE Client opened over that transport is both the health
// probe and the proxy backend. stdout is the JSON-RPC channel and never goes to the log store;
// stderr is piped into it line by line.
//
// An inproc resource has no process at all: the resource's serverFactory builds an MCP server
// inside the runner and the same ONE Client connects to it over an in-memory linked transport
// pair — identical health/ping/passthrough semantics, zero IPC.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Constants } from "./constants.js";
import { RunnerResourceStateSchema } from "qyl-mcp-server/contract-validation";
import { LogStore } from "./log-store.js";
import type { McpResource, McpResourceState, ResourceLifecycle } from "./resources.js";

const { Orchestrator: Timing, LogEvents, Product } = Constants;

// Broadcast fan-out of timestamped state transitions: every subscriber gets every event, and a
// late subscriber replays the snapshot first (keyed by name, so duplicate replay is idempotent).
export class ResourceRegistry {
    private readonly latest = new Map<string, McpResourceState>();
    private readonly subscribers = new Set<(state: McpResourceState) => void>();
    private readonly readySignals = new Map<string, { promise: Promise<void>; resolve: () => void }>();

    snapshot(): McpResourceState[] {
        return [...this.latest.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    subscribe(push: (state: McpResourceState) => void): () => void {
        this.subscribers.add(push);
        return () => this.subscribers.delete(push);
    }

    publish(state: McpResourceState): void {
        const published = RunnerResourceStateSchema.parse(state);
        this.latest.set(published.name, published);
        if (published.lifecycle === "ready") this.signal(published.name).resolve();
        for (const push of this.subscribers) push(published);
    }

    get(name: string): McpResourceState | undefined {
        return this.latest.get(name);
    }

    whenReady(name: string): Promise<void> {
        const signal = this.signal(name);
        const state = this.latest.get(name);
        if (state?.lifecycle === "ready") signal.resolve();
        return signal.promise;
    }

    private signal(name: string): { promise: Promise<void>; resolve: () => void } {
        let entry = this.readySignals.get(name);
        if (!entry) {
            let resolve!: () => void;
            const promise = new Promise<void>((r) => (resolve = r));
            entry = { promise, resolve };
            this.readySignals.set(name, entry);
        }
        return entry;
    }
}

// Unknown waitFor names and dependency cycles are configuration bugs — fail fast with a clear
// error instead of deadlocking the start order.
export function validateDependencies(resources: readonly McpResource[]): void {
    const byName = new Map(resources.map((r) => [r.name, r]));
    for (const resource of resources) {
        for (const wait of resource.waitForNames) {
            if (!byName.has(wait)) {
                throw new Error(`Resource '${resource.name}' waits for unknown resource '${wait}'.`);
            }
        }
    }

    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]): void => {
        if (done.has(name)) return;
        if (visiting.has(name)) {
            throw new Error(`Resource dependency cycle detected: ${[...path, name].join(" -> ")}.`);
        }
        visiting.add(name);
        for (const wait of byName.get(name)!.waitForNames) visit(wait, [...path, name]);
        visiting.delete(name);
        done.add(name);
    };
    for (const resource of resources) visit(resource.name, []);
}

interface Managed {
    resource: McpResource;
    client: Client | null;
    transport: StdioClientTransport | StreamableHTTPClientTransport | InMemoryTransport | null;
    server: McpServer | null;
    pingTimer: NodeJS.Timeout | null;
    restarts: number; // crash budget consumed; user restarts reset it
    generation: number; // guards stale onclose/ping callbacks across restarts
    stopping: boolean;
    actionInProgress: boolean;
    endpoint?: string; // http kind only: the actual upstream MCP endpoint
    allocatedPort?: number;
    serverInfo?: { name: string; version: string };
    toolCount?: number;
}

export type RunnerActionResult = "accepted" | "not_found" | "conflict";

export class Orchestrator {
    readonly registry = new ResourceRegistry();
    private readonly managed = new Map<string, Managed>();
    private started = false;

    constructor(
        private readonly resources: readonly McpResource[],
        private readonly logStore: LogStore,
    ) {}

    start(): void {
        if (this.started) return;
        this.started = true;
        validateDependencies(this.resources);

        console.error(
            `[${LogEvents.OrchestratorStarted}] ${Product.name} orchestrator booting with ${this.resources.length} resource(s)`,
        );

        for (const resource of this.resources) {
            const managed: Managed = {
                resource,
                client: null,
                transport: null,
                server: null,
                pingTimer: null,
                restarts: 0,
                generation: 0,
                stopping: false,
                actionInProgress: false,
                endpoint: resource.kind === "http" ? resource.endpoint : undefined,
                allocatedPort: resource.kind === "http" ? parsePort(resource.endpoint) : undefined,
                serverInfo: undefined,
                toolCount: undefined,
            };
            this.managed.set(resource.name, managed);
            this.publish(managed, "pending");
        }

        for (const managed of this.managed.values()) {
            void this.runResource(managed);
        }
    }

    lookup(name: string): { state: McpResourceState; client: Client | null; resource: McpResource } | null {
        const managed = this.managed.get(name);
        const state = this.registry.get(name);
        if (!managed || !state) return null;
        return { state, client: managed.client, resource: managed.resource };
    }

    restart(name: string): RunnerActionResult {
        const managed = this.managed.get(name);
        const state = this.registry.get(name);
        if (!managed || !state) return "not_found";
        if (
            managed.actionInProgress ||
            state.lifecycle === "pending" ||
            state.lifecycle === "starting" ||
            state.lifecycle === "stopping"
        ) {
            return "conflict";
        }

        managed.actionInProgress = true;
        void this.restartResource(managed).finally(() => {
            managed.actionInProgress = false;
        });
        return "accepted";
    }

    private async restartResource(managed: Managed): Promise<void> {
        const name = managed.resource.name;
        console.error(`[${LogEvents.ResourceUserRestart}] resource '${name}' restarting on request`);
        managed.generation++;
        managed.stopping = false;
        managed.restarts = 0;
        this.clearPing(managed);
        await this.closeConnection(managed);
        void this.launch(managed);
    }

    stop(name: string): RunnerActionResult {
        const managed = this.managed.get(name);
        const state = this.registry.get(name);
        if (!managed || !state) return "not_found";
        if (managed.actionInProgress || state.lifecycle === "stopping" || state.lifecycle === "stopped") {
            return "conflict";
        }

        managed.actionInProgress = true;
        void this.stopResource(managed).finally(() => {
            managed.actionInProgress = false;
        });
        return "accepted";
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.managed.values()].map((managed) => this.stopResource(managed)));
    }

    private async runResource(managed: Managed): Promise<void> {
        await Promise.all(managed.resource.waitForNames.map((name) => this.registry.whenReady(name)));
        if (managed.stopping) return;
        await this.launch(managed);
    }

    private async launch(managed: Managed): Promise<void> {
        const generation = ++managed.generation;
        const name = managed.resource.name;

        this.publish(managed, "starting");
        console.error(`[${LogEvents.ResourceStarting}] resource '${name}' starting`);

        const deadline = Date.now() + Timing.StartupTimeoutSeconds * 1000;
        // Tracked outside the try so the catch can close a connection that was
        // established before a later handshake step (e.g. tools/list) failed —
        // at that point nothing is assigned to `managed` yet, so closeConnection()
        // alone cannot reach it (stdio: the child would run orphaned; inproc: the
        // factory-built server would stay connected).
        let connection: { client: Client; server?: McpServer } | null = null;
        try {
            const { client, transport, server } =
                managed.resource.kind === "stdio"
                    ? await this.connectStdio(managed, deadline)
                    : managed.resource.kind === "http"
                      ? await this.connectHttp(managed, generation, deadline)
                      : await this.connectInProc(managed, deadline);
            connection = { client, server };

            if (generation !== managed.generation) {
                await client.close().catch(() => {});
                await server?.close().catch(() => {});
                return;
            }

            const { tools } = await client.listTools(undefined, { timeout: remaining(deadline) });
            if (generation !== managed.generation) {
                await client.close().catch(() => {});
                await server?.close().catch(() => {});
                return;
            }

            managed.client = client;
            managed.transport = transport;
            managed.server = server ?? null;
            const serverVersion = client.getServerVersion();
            managed.serverInfo = serverVersion ? { name: serverVersion.name, version: serverVersion.version } : undefined;
            managed.toolCount = tools.length;

            client.onclose = () => this.onConnectionLost(managed, generation, "connection closed");
            client.onerror = () => {
            };

            this.publish(managed, "ready");
            console.error(`[${LogEvents.ResourceReady}] resource '${name}' ready`);
            this.startPing(managed, generation);
        } catch (error) {
            if (connection) {
                await connection.client.close().catch(() => {});
                await connection.server?.close().catch(() => {});
            }
            if (generation !== managed.generation) return;
            this.onLaunchFailed(managed, errorMessage(error));
        }
    }

    private async connectStdio(
        managed: Managed,
        deadline: number,
    ): Promise<{ client: Client; transport: StdioClientTransport; server?: McpServer }> {
        if (managed.resource.kind !== "stdio") {
            throw new Error(`Resource '${managed.resource.name}' is not a stdio resource.`);
        }
        const { launch } = managed.resource;

        // The SDK filters the child env down to a safe allowlist by default, so merge the
        // explicitly configured launch environment before spawning.
        const env: Record<string, string> = {
            ...getDefaultEnvironment(),
            ...launch.env,
        };

        const transport = new StdioClientTransport({
            command: launch.command,
            args: [...launch.args],
            env,
            cwd: launch.cwd,
            stderr: "pipe",
        });

        // stderr is available before start() so no early output is lost. With stderr: "pipe" the
        // getter returns a PassThrough, i.e. a readable stream — the SDK types it as bare Stream.
        if (transport.stderr) {
            createInterface({ input: transport.stderr as unknown as NodeJS.ReadableStream }).on("line", (line) =>
                this.logStore.append(managed.resource.name, "err", line),
            );
        }

        const client = new Client({ name: Product.name, version: Product.version });
        await client.connect(transport, { timeout: remaining(deadline) });
        return { client, transport };
    }

    private async connectHttp(
        managed: Managed,
        generation: number,
        deadline: number,
    ): Promise<{ client: Client; transport: StreamableHTTPClientTransport; server?: McpServer }> {
        if (managed.resource.kind !== "http") {
            throw new Error(`Resource '${managed.resource.name}' is not an HTTP resource.`);
        }
        const url = new URL(managed.resource.endpoint);
        for (;;) {
            const transport = new StreamableHTTPClientTransport(url);
            const client = new Client({ name: Product.name, version: Product.version });
            try {
                await client.connect(transport, {
                    timeout: Math.min(Timing.HealthProbeAttemptTimeoutSeconds * 1000, remaining(deadline)),
                });
                return { client, transport };
            } catch (error) {
                await client.close().catch(() => {});
                if (generation !== managed.generation || Date.now() >= deadline) throw error;
                await delay(Timing.HealthPollIntervalMs);
            }
        }
    }

    // No process and no socket — build the server via the resource's factory and connect the
    // usual ONE Client to it over an in-memory linked transport pair. Health/ping/passthrough
    // semantics stay identical to the other kinds.
    private async connectInProc(
        managed: Managed,
        deadline: number,
    ): Promise<{ client: Client; transport: InMemoryTransport; server: McpServer }> {
        if (managed.resource.kind !== "inproc") {
            throw new Error(`Resource '${managed.resource.name}' is not an in-process resource.`);
        }
        const factory = managed.resource.serverFactory;
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = factory();
        await server.connect(serverTransport);

        const client = new Client({ name: Product.name, version: Product.version });
        try {
            await client.connect(clientTransport, { timeout: remaining(deadline) });
        } catch (error) {
            await server.close().catch(() => {});
            throw error;
        }
        return { client, transport: clientTransport, server };
    }

    private startPing(managed: Managed, generation: number): void {
        managed.pingTimer = setInterval(() => {
            const client = managed.client;
            if (!client || generation !== managed.generation) return;
            client
                .ping({ timeout: Timing.HealthProbeAttemptTimeoutSeconds * 1000 })
                .catch((error: unknown) =>
                    this.onConnectionLost(managed, generation, `ping failed: ${errorMessage(error)}`),
                );
        }, Timing.HealthPollIntervalMs * 10);
    }

    private onConnectionLost(managed: Managed, generation: number, reason: string): void {
        if (managed.stopping || generation !== managed.generation) return;
        managed.generation++;
        this.clearPing(managed);
        void this.closeConnection(managed);

        const name = managed.resource.name;
        if (managed.restarts >= Timing.MaxRestarts) {
            this.publish(managed, "failed", `${reason}; restart limit (${Timing.MaxRestarts}) reached`);
            console.error(
                `[${LogEvents.ResourceFailed}] resource '${name}' failed: ${reason}; restart limit (${Timing.MaxRestarts}) reached`,
            );
            return;
        }

        managed.restarts++;
        console.error(
            `[${LogEvents.ResourceRestarting}] resource '${name}' ${reason}; restarting (attempt ${managed.restarts})`,
        );
        void this.launch(managed);
    }

    private onLaunchFailed(managed: Managed, reason: string): void {
        managed.generation++;
        this.clearPing(managed);
        void this.closeConnection(managed);
        this.publish(managed, "failed", reason);
        console.error(`[${LogEvents.ResourceFailed}] resource '${managed.resource.name}' failed to start: ${reason}`);
    }

    // Graceful stop: stopping → close the MCP client (SIGTERMs a stdio child) → 2s grace, then
    // SIGKILL if the child is still alive → stopped.
    private async stopResource(managed: Managed): Promise<void> {
        managed.generation++;
        managed.stopping = true;
        this.clearPing(managed);

        this.publish(managed, "stopping");
        const pid = managed.transport instanceof StdioClientTransport ? managed.transport.pid : null;
        await this.closeConnection(managed);
        if (pid !== null) await ensureExited(pid);

        // Once `stopped` is observable, a new restart may be accepted immediately.
        // Clear the action gate before publishing the terminal state rather than
        // leaving a one-microtask window where state and accepted actions disagree.
        managed.actionInProgress = false;
        this.publish(managed, "stopped");
        console.error(`[${LogEvents.ResourceStopped}] resource '${managed.resource.name}' stopped`);
    }

    private async closeConnection(managed: Managed): Promise<void> {
        const client = managed.client;
        const server = managed.server;
        managed.client = null;
        managed.transport = null;
        managed.server = null;
        managed.serverInfo = undefined;
        managed.toolCount = undefined;
        if (client) await client.close().catch(() => {});
        if (server) await server.close().catch(() => {});
    }

    private clearPing(managed: Managed): void {
        if (managed.pingTimer) {
            clearInterval(managed.pingTimer);
            managed.pingTimer = null;
        }
    }

    private publish(managed: Managed, lifecycle: ResourceLifecycle, lastError?: string): void {
        const state: McpResourceState = {
            name: managed.resource.name,
            kind: managed.resource.kind,
            lifecycle,
            timestamp: new Date().toISOString(),
            restarts: managed.restarts,
        };
        if (managed.allocatedPort !== undefined) state.allocatedPort = managed.allocatedPort;
        if (managed.endpoint !== undefined) state.endpoint = managed.endpoint;
        if (lastError !== undefined) state.lastError = lastError;
        if (managed.serverInfo !== undefined) state.serverInfo = managed.serverInfo;
        if (managed.toolCount !== undefined) state.toolCount = managed.toolCount;
        this.registry.publish(state);
    }
}

function parsePort(endpoint: string | undefined): number | undefined {
    if (!endpoint) return undefined;
    try {
        const url = new URL(endpoint);
        if (url.port) return Number.parseInt(url.port, 10);
        return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
    } catch {
        return undefined;
    }
}

function remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now());
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function ensureExited(pid: number): Promise<void> {
    const grace = Date.now() + 2000;
    while (Date.now() < grace) {
        if (!isAlive(pid)) return;
        await delay(100);
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
    }
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
