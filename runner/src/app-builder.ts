// Fluent host builder over immutable resource definitions.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpApp } from "./app.js";
import type { McpResource } from "./resources.js";

export interface StdioServerOptions {
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    cwd?: string;
}

export class McpAppBuilder {
    private readonly resources: McpResource[] = [];

    private constructor() {}

    static create(): McpAppBuilder {
        return new McpAppBuilder();
    }

    addStdioServer(name: string, options: StdioServerOptions): McpResourceBuilder {
        if (!name.trim()) throw new Error("Resource name must not be empty.");
        if (!options.command.trim()) throw new Error(`Resource '${name}' needs a command to launch.`);

        return this.register({
            name,
            kind: "stdio",
            launch: {
                command: options.command,
                args: options.args ?? [],
                env: options.env ?? {},
                cwd: options.cwd,
            },
            waitForNames: [],
        });
    }

    addHttpServer(name: string, endpointUrl: string): McpResourceBuilder {
        if (!name.trim()) throw new Error("Resource name must not be empty.");
        if (!endpointUrl.trim()) throw new Error(`Resource '${name}' needs an endpoint URL.`);

        return this.register({
            name,
            kind: "http",
            endpoint: endpointUrl,
            waitForNames: [],
        });
    }

    // Host an MCP server inside the runner process itself (in-memory transport,
    // no child process). The factory runs once per (re)start so restarts get a
    // fresh server instance. Configuration flows through the runner's own
    // environment — there is no per-resource env for an in-process server.
    addInProcessServer(
        name: string,
        serverFactory: () => McpServer,
    ): McpResourceBuilder {
        if (!name.trim()) throw new Error("Resource name must not be empty.");

        return this.register({
            name,
            kind: "inproc",
            serverFactory,
            waitForNames: [],
        });
    }

    build(): McpApp {
        return new McpApp([...this.resources]);
    }

    private register(resource: McpResource): McpResourceBuilder {
        if (this.resources.some((r) => r.name === resource.name)) {
            throw new Error(`Resource '${resource.name}' was already added; names must be unique.`);
        }

        this.resources.push(resource);
        return new McpResourceBuilder(this, resource, (oldResource, newResource) => {
            const index = this.resources.indexOf(oldResource);
            if (index >= 0) this.resources[index] = newResource;
        });
    }
}

export class McpResourceBuilder {
    #resource: McpResource;

    constructor(
        public readonly app: McpAppBuilder,
        resource: McpResource,
        private readonly replace: (oldResource: McpResource, newResource: McpResource) => void,
    ) {
        this.#resource = resource;
    }

    get resource(): McpResource {
        return this.#resource;
    }

    update(mutate: (resource: McpResource) => McpResource): this {
        const updated = mutate(this.#resource);
        this.replace(this.#resource, updated);
        this.#resource = updated;
        return this;
    }

    waitFor(...others: McpResourceBuilder[]): this {
        if (others.length === 0) return this;

        const merged = [...this.#resource.waitForNames];
        for (const other of others) {
            if (!merged.includes(other.resource.name)) merged.push(other.resource.name);
        }

        return this.update((r) => ({ ...r, waitForNames: merged }));
    }

}
