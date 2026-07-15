import { RunnerResourceStateSchema } from "qyl-mcp-server/contract-validation";
import type { ConnectionManager, ConnectionSnapshot } from "./connection-manager.js";
import type { LogStore } from "./log-store.js";
import type { McpResource, McpResourceState, ResourceLifecycle } from "./resources.js";
import type { ServerRecord } from "./workbench-repository.js";

export type LegacyResourceActionResult = "accepted" | "not_found" | "conflict";

export interface LegacyResourceBinding {
    resource: McpResource;
    server: ServerRecord;
}

interface BoundResource extends LegacyResourceBinding {
    restarts: number;
    actionInProgress: boolean;
    action?: "restart" | "stop";
    started: boolean;
}

/**
 * Compatibility projection for the original /runner/resources surface.
 *
 * This class never creates an MCP client, transport, child process, or server.
 * It projects and controls the exact ConnectionManager entries owned by the
 * workbench, which keeps the legacy routes useful without introducing a second
 * runtime owner.
 */
export class LegacyResourceAdapter {
    private readonly byName = new Map<string, BoundResource>();
    private readonly byServerId = new Map<string, BoundResource>();
    private readonly latest = new Map<string, McpResourceState>();
    private readonly subscribers = new Set<(state: McpResourceState) => void>();
    private readonly unsubscribe: () => void;

    constructor(
        private readonly resources: readonly McpResource[],
        private readonly connections: ConnectionManager,
        private readonly logStore: LogStore,
        private readonly now: () => Date = () => new Date(),
    ) {
        this.unsubscribe = connections.subscribe((snapshot) => this.onConnectionSnapshot(snapshot));
    }

    bind(bindings: readonly LegacyResourceBinding[]): void {
        if (this.byName.size > 0) throw new Error("Legacy MCP resources are already bound.");
        const byResourceName = new Map(bindings.map((binding) => [binding.resource.name, binding]));
        if (byResourceName.size !== bindings.length) {
            throw new Error("Legacy MCP resource bindings contain duplicate names.");
        }
        for (const resource of this.resources) {
            const binding = byResourceName.get(resource.name);
            if (!binding) throw new Error(`Legacy MCP resource '${resource.name}' has no persisted server binding.`);
            const bound: BoundResource = {
                ...binding,
                restarts: 0,
                actionInProgress: false,
                started: false,
            };
            if (this.byServerId.has(binding.server.id)) {
                throw new Error(`Persisted MCP server '${binding.server.id}' is bound to multiple resources.`);
            }
            this.byName.set(resource.name, bound);
            this.byServerId.set(binding.server.id, bound);
            this.publish(this.project(bound));
        }
        if (byResourceName.size !== this.resources.length) {
            throw new Error("Legacy MCP resource bindings contain an unknown resource.");
        }
    }

    dispose(): void {
        this.unsubscribe();
        this.subscribers.clear();
    }

    snapshot(): McpResourceState[] {
        return [...this.latest.values()]
            .map((state) => structuredClone(state))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    subscribe(push: (state: McpResourceState) => void): () => void {
        this.subscribers.add(push);
        return () => this.subscribers.delete(push);
    }

    lookup(name: string): { state: McpResourceState; serverId: string; resource: McpResource } | null {
        const bound = this.byName.get(name);
        const state = this.latest.get(name);
        if (!bound || !state) return null;
        return {
            state: structuredClone(state),
            serverId: bound.server.id,
            resource: bound.resource,
        };
    }

    isManagedServer(workspaceId: string, serverId: string): boolean {
        const bound = this.byServerId.get(serverId);
        return bound?.server.workspaceId === workspaceId;
    }

    workspaceHasManagedServers(workspaceId: string): boolean {
        return [...this.byName.values()].some((bound) => bound.server.workspaceId === workspaceId);
    }

    /** Connect managed bootstrap resources once, with waitFor dependencies first. */
    async startAutoConnect(signal: AbortSignal): Promise<void> {
        const attempts = new Map<string, Promise<void>>();
        const connect = (name: string): Promise<void> => {
            const existing = attempts.get(name);
            if (existing) return existing;
            const bound = this.byName.get(name);
            if (!bound) throw new Error(`Managed MCP resource '${name}' is not bound.`);
            const attempt = (async () => {
                await Promise.all(bound.resource.waitForNames.map(connect));
                if (signal.aborted) return;
                bound.started = true;
                const snapshot = this.connections.get(bound.server.id);
                if (snapshot.lifecycle !== "disconnected" && snapshot.lifecycle !== "failed") return;
                try {
                    await this.connections.connect(bound.server.id, { signal });
                } catch {
                    // ConnectionManager retains and publishes a sanitized failed snapshot.
                }
            })();
            attempts.set(name, attempt);
            return attempt;
        };
        await Promise.all(this.resources.map((resource) => connect(resource.name)));
    }

    restart(name: string): LegacyResourceActionResult {
        const bound = this.byName.get(name);
        if (!bound) return "not_found";
        const lifecycle = this.connections.get(bound.server.id).lifecycle;
        if (bound.actionInProgress || lifecycle === "connecting" || lifecycle === "disconnecting") {
            return "conflict";
        }
        bound.actionInProgress = true;
        bound.action = "restart";
        bound.started = true;
        bound.restarts += 1;
        this.appendLifecycleLine(bound, `restart requested (${bound.restarts})`, "out");
        void this.connections.reconnect(bound.server.id).catch(() => {
            // The sanitized failure is published by ConnectionManager.
        }).finally(() => {
            if (bound.action === "restart") {
                bound.actionInProgress = false;
                bound.action = undefined;
            }
        });
        return "accepted";
    }

    stop(name: string): LegacyResourceActionResult {
        const bound = this.byName.get(name);
        if (!bound) return "not_found";
        const lifecycle = this.connections.get(bound.server.id).lifecycle;
        if (
            bound.actionInProgress
            || lifecycle === "connecting"
            || lifecycle === "disconnecting"
            || lifecycle === "disconnected"
        ) {
            return "conflict";
        }
        bound.actionInProgress = true;
        bound.action = "stop";
        bound.started = true;
        this.appendLifecycleLine(bound, "stop requested", "out");
        void this.connections.disconnect(bound.server.id).catch(() => {
            // The sanitized failure is published by ConnectionManager.
        }).finally(() => {
            if (bound.action === "stop") {
                bound.actionInProgress = false;
                bound.action = undefined;
            }
        });
        return "accepted";
    }

    private onConnectionSnapshot(snapshot: ConnectionSnapshot): void {
        const bound = this.byServerId.get(snapshot.id);
        if (!bound) return;
        const previous = this.latest.get(bound.resource.name);
        const state = this.project(bound, snapshot);
        if (
            (bound.action === "stop" && snapshot.lifecycle === "disconnected")
            || (bound.action === "restart"
                && (snapshot.lifecycle === "connected" || snapshot.lifecycle === "failed"))
        ) {
            bound.actionInProgress = false;
            bound.action = undefined;
        }
        this.publish(state);
        if (previous?.lifecycle === state.lifecycle && previous.lastError === state.lastError) return;
        const suffix = state.lastError === undefined ? "" : ": connection details are available in status";
        this.appendLifecycleLine(
            bound,
            `lifecycle changed to '${state.lifecycle}'${suffix}`,
            state.lifecycle === "failed" ? "err" : "out",
        );
    }

    private project(bound: BoundResource, snapshot?: ConnectionSnapshot): McpResourceState {
        const connection = snapshot
            ?? (this.connections.has(bound.server.id) ? this.connections.get(bound.server.id) : undefined);
        const state: McpResourceState = {
            name: bound.resource.name,
            lifecycle: connection === undefined
                ? "pending"
                : projectLifecycle(connection.lifecycle, bound.started),
            timestamp: this.now().toISOString(),
            kind: bound.resource.kind,
            restarts: bound.restarts,
        };
        if (bound.resource.kind === "http") {
            state.endpoint = bound.resource.endpoint;
            const port = endpointPort(bound.resource.endpoint);
            if (port !== undefined) state.allocatedPort = port;
        }
        const initialization = connection?.initialization;
        if (initialization?.serverInfo !== undefined) state.serverIdentity = initialization.serverInfo;
        if (initialization !== undefined) state.toolCount = initialization.discovery.tools.length;
        if (connection?.lastError !== undefined) state.lastError = connection.lastError;
        return RunnerResourceStateSchema.parse(state);
    }

    private publish(state: McpResourceState): void {
        const published = RunnerResourceStateSchema.parse(state);
        this.latest.set(published.name, published);
        for (const push of this.subscribers) push(structuredClone(published));
    }

    private appendLifecycleLine(
        bound: BoundResource,
        line: string,
        stream: "out" | "err",
    ): void {
        // Deliberately only emit adapter-authored lifecycle text. Stdio stderr is
        // untrusted and may contain credentials, so it is drained elsewhere and
        // never copied into this compatibility log.
        this.logStore.append(bound.resource.name, stream, line);
    }
}

function projectLifecycle(
    lifecycle: ConnectionSnapshot["lifecycle"],
    started: boolean,
): ResourceLifecycle {
    switch (lifecycle) {
        case "disconnected":
            return started ? "stopped" : "pending";
        case "connecting":
            return "starting";
        case "connected":
            return "ready";
        case "disconnecting":
            return "stopping";
        case "failed":
            return "failed";
    }
}

function endpointPort(endpoint: string): number | undefined {
    try {
        const url = new URL(endpoint);
        if (url.port.length > 0) return Number.parseInt(url.port, 10);
        if (url.protocol === "https:") return 443;
        if (url.protocol === "http:") return 80;
    } catch {
        // Workbench validation reports invalid endpoint configuration earlier.
    }
    return undefined;
}
