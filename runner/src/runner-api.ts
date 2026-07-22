// Loopback API for the authenticated MCP workbench.

import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Constants } from "./constants.js";
import {
    loopbackRequestGuard,
    RunnerAllowedOrigins,
} from "./http-security.js";
import {
    sendInternalServerError,
    sendValidationProblem,
} from "./problems.js";
import { WorkbenchApi, type BuiltinMcpServer } from "./workbench-api.js";

const { Ports, Network, Routes, LogEvents } = Constants;

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dashboardDist = join(workspaceRoot, "dashboard", "dist");

export class RunnerApi {
    private server: Server | null = null;
    private readonly workbench: WorkbenchApi;

    constructor(builtins: readonly BuiltinMcpServer[]) {
        this.workbench = new WorkbenchApi(builtins);
    }

    async listen(): Promise<void> {
        try {
            await initializeWorkbenchAndListeners(
                this.workbench,
                [() => this.listenMain()],
            );
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        await Promise.all([closeServer(this.server), this.workbench.close()]);
        this.server = null;
    }

    private listenMain(): Promise<void> {
        const app = express();
        app.use(loopbackRequestGuard(RunnerAllowedOrigins));
        app.use(express.json());
        this.workbench.register(app);

        if (existsSync(dashboardDist)) {
            app.use(express.static(dashboardDist));
        }
        app.use(errorHandler);

        return new Promise((resolvePromise, rejectPromise) => {
            this.server = app.listen(Ports.RunnerApi, Network.Loopback, () => {
                console.error(
                    `[${LogEvents.RunnerApiListening}] Runner API listening on ${Network.HttpScheme}://${Network.Loopback}:${Ports.RunnerApi}${Routes.Runner}`,
                );
                resolvePromise();
            });
            this.server.on("error", (error) => {
                console.error(
                    `[${LogEvents.RunnerApiBindFailed}] Runner API could not bind :${Ports.RunnerApi}: ${error.message}`,
                );
                this.server = null;
                rejectPromise(error);
            });
        });
    }

}

interface StartupWorkbench {
    initialize(): Promise<void>;
    startAutoConnect(): Promise<void>;
}

/**
 * Restore durable state before binding, but never make UI availability wait on
 * remote MCP initialization. Auto-connect remains observable through the
 * registered connection's disconnected/connecting/failed lifecycle.
 */
export async function initializeWorkbenchAndListeners(
    workbench: StartupWorkbench,
    listeners: readonly (() => Promise<void>)[],
): Promise<void> {
    await workbench.initialize();
    await Promise.all(listeners.map((listen) => listen()));
    void workbench.startAutoConnect().catch(() => {
        console.error(
            "Workbench automatic connection scheduling failed; connection statuses remain available.",
        );
    });
}

function closeServer(server: Server | null): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
    });
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _nextMiddleware) => {
    if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 400 &&
        "type" in error &&
        error.type === "entity.parse.failed"
    ) {
        sendValidationProblem(response, "body", "The request body must be valid JSON.");
        return;
    }
    console.error(`[${LogEvents.RunnerApiRequestFailed}] Runner API request failed: ${String(error)}`);
    if (!response.headersSent) sendInternalServerError(response);
};
