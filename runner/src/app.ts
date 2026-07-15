// Built, runnable host. The workbench ConnectionManager is the sole runtime
// owner; run() starts its API and blocks until graceful process shutdown.

import { LogStore } from "./log-store.js";
import { validateDependencies } from "./orchestrator.js";
import { RunnerApi } from "./runner-api.js";
import type { McpResource } from "./resources.js";

export class McpApp {
    private readonly api: RunnerApi;

    constructor(public readonly resources: readonly McpResource[]) {
        // Fail fast at build: unknown waitFor names and cycles are configuration bugs.
        validateDependencies(resources);
        const logStore = new LogStore();
        this.api = new RunnerApi(logStore, resources);
    }

    async run(): Promise<void> {
        await this.api.listen();

        await new Promise<void>((resolve) => {
            let shuttingDown = false;
            const shutdown = (signal: string) => {
                if (shuttingDown) return;
                shuttingDown = true;
                console.error(`${signal} received — stopping resources`);
                void this.api.close().then(resolve);
            };
            process.once("SIGINT", () => shutdown("SIGINT"));
            process.once("SIGTERM", () => shutdown("SIGTERM"));
        });
    }
}
