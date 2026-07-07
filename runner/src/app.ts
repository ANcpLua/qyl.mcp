// ≈ Qyl.Run/QylApp.cs — the built, runnable host. run() starts the orchestrator and the runner
// API, then blocks until SIGINT/SIGTERM, gracefully stops every resource, and resolves.

import { LogStore } from "./log-store.js";
import { Orchestrator, validateDependencies } from "./orchestrator.js";
import { RunnerApi } from "./runner-api.js";
import type { McpResource } from "./resources.js";

export class McpApp {
    private readonly orchestrator: Orchestrator;
    private readonly api: RunnerApi;

    constructor(public readonly resources: readonly McpResource[]) {
        // Fail fast at build: unknown waitFor names and cycles are configuration bugs.
        validateDependencies(resources);
        const logStore = new LogStore();
        this.orchestrator = new Orchestrator(resources, logStore);
        this.api = new RunnerApi(this.orchestrator, logStore);
    }

    async run(): Promise<void> {
        await this.api.listen();
        this.orchestrator.start();

        await new Promise<void>((resolve) => {
            let shuttingDown = false;
            const shutdown = (signal: string) => {
                if (shuttingDown) return;
                shuttingDown = true;
                console.error(`${signal} received — stopping resources`);
                void this.orchestrator
                    .stopAll()
                    .then(() => this.api.close())
                    .then(resolve);
            };
            process.once("SIGINT", () => shutdown("SIGINT"));
            process.once("SIGTERM", () => shutdown("SIGTERM"));
        });
    }
}
