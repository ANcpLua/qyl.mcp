// Loopback API for the authenticated workbench and managed-resource lifecycle state.

import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import express, { type ErrorRequestHandler, type Response } from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
    RunnerLogLineSchema,
    RunnerResourceStateSchema,
} from "qyl-mcp-server/contract-validation";
import { Constants } from "./constants.js";
import {
    loopbackRequestGuard,
    RunnerAllowedOrigins,
} from "./http-security.js";
import { LogStore } from "./log-store.js";
import {
    sendConflict,
    sendInternalServerError,
    sendNotFound,
    sendValidationProblem,
} from "./problems.js";
import type { McpResource } from "./resources.js";
import { WorkbenchApi } from "./workbench-api.js";

const { Ports, Network, Routes, LogEvents } = Constants;
const RUNNER_SSE_EVENT =
    qylOpenApi.paths["/runner/resources/stream"].get.responses["200"]
        .content["text/event-stream"].itemSchema.oneOf[0].properties.event.const;
if (typeof RUNNER_SSE_EVENT !== "string" || RUNNER_SSE_EVENT.length === 0) {
    throw new Error("published Qyl OpenAPI has no runner SSE event name");
}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dashboardDist = join(workspaceRoot, "dashboard", "dist");

export class RunnerApi {
    private server: Server | null = null;
    private readonly workbench: WorkbenchApi;

    constructor(
        private readonly logStore: LogStore,
        resources: readonly McpResource[],
    ) {
        this.workbench = new WorkbenchApi(resources, { logStore });
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

        app.get(`${Routes.Runner}/resources`, (_request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.json(this.workbench.legacyResources.snapshot().map((state) => RunnerResourceStateSchema.parse(state)));
        });

        app.get(`${Routes.Runner}/resources/stream`, (req, res) => {
            openSse(res);
            // Subscribe first, then replay the snapshot: no state change can slip between the two,
            // and a duplicate replay is idempotent because clients key resources by name.
            const unsubscribe = this.workbench.legacyResources.subscribe((state) => writeFrame(res, state, RunnerResourceStateSchema));
            for (const state of this.workbench.legacyResources.snapshot()) writeFrame(res, state, RunnerResourceStateSchema);
            req.on("close", unsubscribe);
        });

        app.get(`${Routes.Runner}/resources/:name/logs/stream`, (req, res) => {
            const name = String(req.params.name);
            if (!this.workbench.legacyResources.lookup(name)) {
                sendNotFound(res, "runner resource", name);
                return;
            }
            openSse(res);
            const unsubscribe = this.logStore.subscribe(name, (line) => writeFrame(res, line, RunnerLogLineSchema));
            for (const line of this.logStore.snapshot(name)) writeFrame(res, line, RunnerLogLineSchema);
            req.on("close", unsubscribe);
        });

        app.get(`${Routes.Runner}/resources/:name/logs`, (req, res) => {
            const name = String(req.params.name);
            if (!this.workbench.legacyResources.lookup(name)) {
                sendNotFound(res, "runner resource", name);
                return;
            }
            res.setHeader("Cache-Control", "no-store");
            res.json(this.logStore.snapshot(name).map((line) => RunnerLogLineSchema.parse(line)));
        });

        app.post(`${Routes.Runner}/resources/:name/restart`, (req, res) => {
            this.respondToAction(res, String(req.params.name), "restart");
        });

        app.post(`${Routes.Runner}/resources/:name/stop`, (req, res) => {
            this.respondToAction(res, String(req.params.name), "stop");
        });

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

    private respondToAction(response: Response, name: string, action: "restart" | "stop"): void {
        const result = this.workbench.legacyResources[action](name);
        if (result === "not_found") {
            sendNotFound(response, "runner resource", name);
            return;
        }
        if (result === "conflict") {
            const lifecycle = this.workbench.legacyResources.lookup(name)?.state.lifecycle ?? "unknown";
            sendConflict(
                response,
                name,
                `Resource '${name}' cannot ${action} while its lifecycle is '${lifecycle}'.`,
            );
            return;
        }
        response.status(202).end();
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

function openSse(res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
}

function writeFrame<T>(res: Response, payload: unknown, schema: z.ZodType<T>): void {
    const validated = schema.parse(payload);
    res.write(`event: ${RUNNER_SSE_EVENT}\ndata: ${JSON.stringify(validated)}\n\n`);
}

function closeServer(server: Server | null): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        // SSE connections hold the server open past close(); sever them so shutdown is prompt.
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
