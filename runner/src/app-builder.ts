// ≈ Qyl.Run/QylAppBuilder.cs + IQylResourceBuilder.cs — fluent host builder over immutable
// resource records. A builder never mutates a record: update() produces a replacement and
// swaps it into the app's resource list.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Constants } from "./constants.js";
import { McpApp } from "./app.js";
import type { McpResource } from "./resources.js";

export interface StdioServerOptions {
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    cwd?: string;
    description?: string;
}

export interface HttpServerOptions {
    description?: string;
}

export interface InProcessServerOptions {
    description?: string;
}

export class McpAppBuilder {
    private readonly resources: McpResource[] = [];

    private constructor(public readonly args: readonly string[]) {}

    static create(args?: string[]): McpAppBuilder {
        return new McpAppBuilder(args ?? []);
    }

    addStdioServer(name: string, options: StdioServerOptions): McpResourceBuilder {
        if (!name.trim()) throw new Error("Resource name must not be empty.");
        if (!options.command.trim()) throw new Error(`Resource '${name}' needs a command to launch.`);

        return this.register({
            name,
            kind: "stdio",
            environment: Constants.Environments.Dev,
            launch: {
                command: options.command,
                args: options.args ?? [],
                env: options.env ?? {},
                cwd: options.cwd,
            },
            waitForNames: [],
            references: [],
            description: options.description,
        });
    }

    addHttpServer(name: string, endpointUrl: string, options?: HttpServerOptions): McpResourceBuilder {
        if (!name.trim()) throw new Error("Resource name must not be empty.");
        if (!endpointUrl.trim()) throw new Error(`Resource '${name}' needs an endpoint URL.`);

        return this.register({
            name,
            kind: "http",
            environment: Constants.Environments.Dev,
            launch: { command: "", args: [], env: {} },
            endpoint: endpointUrl,
            waitForNames: [],
            references: [],
            description: options?.description,
        });
    }

    // Host an MCP server inside the runner process itself (in-memory transport,
    // no child process). The factory runs once per (re)start so restarts get a
    // fresh server instance. Configuration flows through the runner's own
    // environment — there is no per-resource env for an in-process server.
    addInProcessServer(
        name: string,
        serverFactory: () => McpServer,
        options?: InProcessServerOptions,
    ): McpResourceBuilder {
        if (!name.trim()) throw new Error("Resource name must not be empty.");

        return this.register({
            name,
            kind: "inproc",
            environment: Constants.Environments.Dev,
            launch: { command: "", args: [], env: {} },
            serverFactory,
            waitForNames: [],
            references: [],
            description: options?.description,
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

    // Inject the referenced resources' resolved endpoints into this resource's environment once
    // they are ready (env-based service discovery). Referencing implies waiting — the endpoint
    // must exist first.
    withReference(...others: McpResourceBuilder[]): this {
        if (others.length === 0) return this;

        const merged = [...this.#resource.references];
        for (const other of others) {
            if (!merged.includes(other.resource.name)) merged.push(other.resource.name);
        }

        return this.waitFor(...others).update((r) => ({ ...r, references: merged }));
    }
}
