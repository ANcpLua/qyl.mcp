// ≈ Qyl.Run/Internal/QylOrchestrator.cs + QylResourceRegistry.cs — dependency-ordered startup,
// MCP-handshake health, bounded restart-on-crash supervision, graceful teardown.
//
// A stdio resource's "spawn" is the SDK's StdioClientTransport spawning the child itself: the
// runner owns the child's stdio, so the ONE Client opened over that transport is both the health
// probe and the proxy backend. stdout is the JSON-RPC channel and never goes to the log store;
// stderr is piped into it line by line.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Constants } from "./constants.js";
import { LogStore } from "./log-store.js";
import type { McpResource, McpResourceState, ResourceLifecycle } from "./resources.js";

const { Orchestrator: Timing, LogEvents, Ports, Network, Product, Env } = Constants;

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
        this.latest.set(state.name, state);
        if (state.lifecycle === "Ready") this.signal(state.name).resolve();
        for (const push of this.subscribers) push(state);
    }

    get(name: string): McpResourceState | undefined {
        return this.latest.get(name);
    }

    // Completes the first time the named resource reaches Ready.
    whenReady(name: string): Promise<void> {
        const signal = this.signal(name);
        const state = this.latest.get(name);
        if (state?.lifecycle === "Ready") signal.resolve();
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
    transport: StdioClientTransport | StreamableHTTPClientTransport | null;
    pingTimer: NodeJS.Timeout | null;
    restarts: number; // crash budget consumed; user restarts reset it
    generation: number; // guards stale onclose/ping callbacks across restarts
    stopping: boolean;
    // Published facts, carried into every state transition:
    endpoint: string; // the runner proxy url for this server
    allocatedPort: number | null;
    serverInfo: { name: string; version: string } | null;
    toolCount: number | null;
    hasAppUi: boolean;
}

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
                pingTimer: null,
                restarts: 0,
                generation: 0,
                stopping: false,
                endpoint: proxyUrl(resource.name),
                allocatedPort: resource.kind === "http" ? parsePort(resource.endpoint) : null,
                serverInfo: null,
                toolCount: null,
                hasAppUi: false,
            };
            this.managed.set(resource.name, managed);
            this.publish(managed, "Pending");
        }

        for (const managed of this.managed.values()) {
            void this.runResource(managed);
        }
    }

    // For the API's MCP passthrough: null means unknown resource.
    lookup(name: string): { state: McpResourceState; client: Client | null; resource: McpResource } | null {
        const managed = this.managed.get(name);
        const state = this.registry.get(name);
        if (!managed || !state) return null;
        return { state, client: managed.client, resource: managed.resource };
    }

    // User-initiated restart: same launch spec, fresh crash budget — does not count toward
    // MaxRestarts (mirrors QylRestartRequests, LogEvent 1114).
    async restart(name: string): Promise<boolean> {
        const managed = this.managed.get(name);
        if (!managed) return false;

        console.error(`[${LogEvents.ResourceUserRestart}] resource '${name}' restarting on request`);
        managed.generation++;
        managed.stopping = false;
        managed.restarts = 0;
        this.clearPing(managed);
        await this.closeConnection(managed);
        void this.launch(managed, "Restart requested");
        return true;
    }

    async stop(name: string): Promise<boolean> {
        const managed = this.managed.get(name);
        if (!managed) return false;
        await this.stopResource(managed);
        return true;
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.managed.values()].map((managed) => this.stopResource(managed)));
    }

    private async runResource(managed: Managed): Promise<void> {
        await Promise.all(managed.resource.waitForNames.map((name) => this.registry.whenReady(name)));
        await this.launch(managed);
    }

    // One start attempt: connect the SDK client (which spawns the child for stdio), then require a
    // successful tools/list before declaring Ready. The whole handshake fits in the startup budget.
    private async launch(managed: Managed, startingNote?: string): Promise<void> {
        const generation = ++managed.generation;
        const name = managed.resource.name;

        this.publish(managed, "Starting", startingNote ?? null);
        console.error(`[${LogEvents.ResourceStarting}] resource '${name}' Starting`);

        const deadline = Date.now() + Timing.StartupTimeoutSeconds * 1000;
        try {
            const { client, transport } =
                managed.resource.kind === "stdio"
                    ? await this.connectStdio(managed, deadline)
                    : await this.connectHttp(managed, generation, deadline);

            if (generation !== managed.generation) {
                // Superseded by a stop/restart while connecting — discard quietly.
                await client.close().catch(() => {});
                return;
            }

            const { tools } = await client.listTools(undefined, { timeout: remaining(deadline) });
            if (generation !== managed.generation) {
                await client.close().catch(() => {});
                return;
            }

            managed.client = client;
            managed.transport = transport;
            const serverVersion = client.getServerVersion();
            managed.serverInfo = serverVersion ? { name: serverVersion.name, version: serverVersion.version } : null;
            managed.toolCount = tools.length;
            managed.hasAppUi = tools.some((tool) => Boolean((tool._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri));

            client.onclose = () => this.onConnectionLost(managed, generation, "connection closed");
            client.onerror = () => {
                // Fatal transport errors also fire onclose; non-fatal ones are not a lifecycle event.
            };

            this.publish(managed, "Ready");
            console.error(`[${LogEvents.ResourceReady}] resource '${name}' Ready`);
            this.startPing(managed, generation);
        } catch (error) {
            if (generation !== managed.generation) return;
            this.onLaunchFailed(managed, errorMessage(error));
        }
    }

    private async connectStdio(
        managed: Managed,
        deadline: number,
    ): Promise<{ client: Client; transport: StdioClientTransport }> {
        const { launch } = managed.resource;

        // The SDK filters the child env down to a safe allowlist by default — merge explicitly so
        // launch.env and the injected MCP_ENDPOINT_* references actually reach the child.
        const env: Record<string, string> = {
            ...getDefaultEnvironment(),
            ...launch.env,
            ...this.referenceEnv(managed.resource),
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

    // No process to own — retry the connect within the startup budget until the upstream answers.
    private async connectHttp(
        managed: Managed,
        generation: number,
        deadline: number,
    ): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
        const url = new URL(managed.resource.endpoint!);
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

    // A lost connection while the runner is up is a crash: relaunch, bounded by MaxRestarts.
    private onConnectionLost(managed: Managed, generation: number, reason: string): void {
        if (managed.stopping || generation !== managed.generation) return;
        managed.generation++;
        this.clearPing(managed);
        void this.closeConnection(managed);

        const name = managed.resource.name;
        if (managed.restarts >= Timing.MaxRestarts) {
            this.publish(managed, "Failed", `${reason}; restart limit (${Timing.MaxRestarts}) reached`);
            console.error(
                `[${LogEvents.ResourceFailed}] resource '${name}' failed: ${reason}; restart limit (${Timing.MaxRestarts}) reached`,
            );
            return;
        }

        managed.restarts++;
        console.error(
            `[${LogEvents.ResourceRestarting}] resource '${name}' ${reason}; restarting (attempt ${managed.restarts})`,
        );
        void this.launch(managed, `${reason}; restarting (${managed.restarts}/${Timing.MaxRestarts})`);
    }

    private onLaunchFailed(managed: Managed, reason: string): void {
        managed.generation++;
        this.clearPing(managed);
        void this.closeConnection(managed);
        this.publish(managed, "Failed", reason);
        console.error(`[${LogEvents.ResourceFailed}] resource '${managed.resource.name}' failed to start: ${reason}`);
    }

    // Graceful stop: Stopping → close the MCP client (SIGTERMs a stdio child) → 2s grace, then
    // SIGKILL if the child is still alive → Stopped.
    private async stopResource(managed: Managed): Promise<void> {
        managed.generation++;
        managed.stopping = true;
        this.clearPing(managed);

        this.publish(managed, "Stopping");
        const pid = managed.transport instanceof StdioClientTransport ? managed.transport.pid : null;
        await this.closeConnection(managed);
        if (pid !== null) await ensureExited(pid);

        this.publish(managed, "Stopped");
        console.error(`[${LogEvents.ResourceStopped}] resource '${managed.resource.name}' Stopped`);
    }

    private async closeConnection(managed: Managed): Promise<void> {
        const client = managed.client;
        managed.client = null;
        managed.transport = null;
        if (client) await client.close().catch(() => {});
    }

    private clearPing(managed: Managed): void {
        if (managed.pingTimer) {
            clearInterval(managed.pingTimer);
            managed.pingTimer = null;
        }
    }

    // Env-based service discovery: each referenced resource's runner proxy url is published into
    // this resource's environment (start ordering guarantees the reference is Ready by then).
    private referenceEnv(resource: McpResource): Record<string, string> {
        const env: Record<string, string> = {};
        for (const referenceName of resource.references) {
            env[`${Env.McpEndpointPrefix}${upperSnake(referenceName)}`] = proxyUrl(referenceName);
        }
        return env;
    }

    private publish(managed: Managed, lifecycle: ResourceLifecycle, lastError: string | null = null): void {
        this.registry.publish({
            name: managed.resource.name,
            kind: managed.resource.kind,
            lifecycle,
            timestamp: new Date().toISOString(),
            allocatedPort: managed.allocatedPort,
            endpoint: managed.endpoint,
            lastError,
            serverInfo: managed.serverInfo,
            toolCount: managed.toolCount,
            hasAppUi: managed.hasAppUi,
            restarts: managed.restarts,
        });
    }
}

function proxyUrl(name: string): string {
    return `${Network.HttpScheme}://${Network.Loopback}:${Ports.RunnerApi}${Constants.Routes.Runner}/mcp/${name}`;
}

function upperSnake(name: string): string {
    return name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function parsePort(endpoint: string | undefined): number | null {
    if (!endpoint) return null;
    try {
        const url = new URL(endpoint);
        if (url.port) return Number.parseInt(url.port, 10);
        return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : null;
    } catch {
        return null;
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
        // already gone
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
