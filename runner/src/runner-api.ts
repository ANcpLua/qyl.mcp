// Loopback-only HTTP surface for the dashboard, with control verbs
// (restart/stop) and MCP passthrough: one origin for every managed
// server, backed by the orchestrator's per-resource SDK Client.
//
// A second, separate-origin server (:18889) serves ONLY the dashboard's sandbox.html with CSP
// response headers derived from a ?csp= query param — same mechanism as ext-apps basic-host's
// serve.ts (headers, unlike meta tags, cannot be tampered with by the sandboxed content).

import extAppsSchema from "@modelcontextprotocol/ext-apps/schema.json" with { type: "json" };
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import type { McpUiAppResourceConfig } from "@modelcontextprotocol/ext-apps/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    CallToolRequestParamsSchema,
    ReadResourceRequestParamsSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Constants } from "./constants.js";
import {
    RunnerMcpResourceReadRequestSchema,
    RunnerMcpResourceReadResponseSchema,
    RunnerMcpToolCallRequestSchema,
    RunnerMcpToolCallResponseSchema,
    RunnerMcpToolsResponseSchema,
} from "./contracts.js";
import {
    loopbackRequestGuard,
    RunnerAllowedOrigins,
    SandboxAllowedOrigins,
} from "./http-security.js";
import { LogStore } from "./log-store.js";
import { Orchestrator } from "./orchestrator.js";
import {
    sendBadGateway,
    sendConflict,
    sendInternalServerError,
    sendNotFound,
    sendValidationProblem,
} from "./problems.js";
import { McpTelemetry } from "./telemetry.js";

const { Ports, Network, Routes, LogEvents } = Constants;
const RUNNER_SSE_EVENT =
    qylOpenApi.paths["/runner/resources/stream"].get.responses["200"]
        .content["text/event-stream"].itemSchema.oneOf[0].properties.event.const;
if (typeof RUNNER_SSE_EVENT !== "string" || RUNNER_SSE_EVENT.length === 0) {
    throw new Error("published Qyl OpenAPI has no runner SSE event name");
}

// The ext-apps package's root declaration file currently uses extensionless
// relative exports, which NodeNext cannot resolve. Build the runtime validator
// and its inferred type from the package's official JSON Schema instead of
// copying the Apps contract into the runner.
type McpUiResourceMeta = NonNullable<NonNullable<McpUiAppResourceConfig["_meta"]>["ui"]>;
type McpUiResourceCsp = NonNullable<McpUiResourceMeta["csp"]>;
const McpUiResourceCspSchema = z.fromJSONSchema({
    $schema: extAppsSchema.$schema,
    $defs: extAppsSchema.$defs,
    $ref: "#/$defs/McpUiResourceCsp",
} as unknown as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<McpUiResourceCsp>;

// runner/dist/src/ → ../../.. = the workspace root that holds dashboard/.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dashboardDist = join(workspaceRoot, "dashboard", "dist");
const sandboxHtml = join(workspaceRoot, "dashboard", "dist-sandbox", "sandbox.html");

export class RunnerApi {
    private server: Server | null = null;
    private sandboxServer: Server | null = null;
    // MCP self-monitoring: every passthrough call becomes an OTLP span (see telemetry.ts).
    private readonly telemetry = new McpTelemetry();

    constructor(
        private readonly orchestrator: Orchestrator,
        private readonly logStore: LogStore,
    ) {}

    async listen(): Promise<void> {
        try {
            await Promise.all([this.listenMain(), this.listenSandbox()]);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        await Promise.all([closeServer(this.server), closeServer(this.sandboxServer), this.telemetry.close()]);
        this.server = null;
        this.sandboxServer = null;
    }

    private listenMain(): Promise<void> {
        const app = express();
        app.use(loopbackRequestGuard(RunnerAllowedOrigins));
        app.use(express.json());

        app.get(`${Routes.Runner}/resources`, (_req, res) => {
            res.setHeader("Cache-Control", "no-store");
            res.json(this.orchestrator.registry.snapshot());
        });

        app.get(`${Routes.Runner}/resources/stream`, (req, res) => {
            openSse(res);
            // Subscribe first, then replay the snapshot: no state change can slip between the two,
            // and a duplicate replay is idempotent because clients key resources by name.
            const unsubscribe = this.orchestrator.registry.subscribe((state) => writeFrame(res, state));
            for (const state of this.orchestrator.registry.snapshot()) writeFrame(res, state);
            req.on("close", unsubscribe);
        });

        app.get(`${Routes.Runner}/resources/:name/logs/stream`, (req, res) => {
            const name = String(req.params.name);
            if (!this.orchestrator.lookup(name)) {
                sendNotFound(res, "runner resource", name);
                return;
            }
            openSse(res);
            const unsubscribe = this.logStore.subscribe(name, (line) => writeFrame(res, line));
            for (const line of this.logStore.snapshot(name)) writeFrame(res, line);
            req.on("close", unsubscribe);
        });

        app.get(`${Routes.Runner}/resources/:name/logs`, (req, res) => {
            const name = String(req.params.name);
            if (!this.orchestrator.lookup(name)) {
                sendNotFound(res, "runner resource", name);
                return;
            }
            res.setHeader("Cache-Control", "no-store");
            res.json(this.logStore.snapshot(name));
        });

        app.post(`${Routes.Runner}/resources/:name/restart`, (req, res) => {
            this.respondToAction(res, String(req.params.name), "restart");
        });

        app.post(`${Routes.Runner}/resources/:name/stop`, (req, res) => {
            this.respondToAction(res, String(req.params.name), "stop");
        });

        // MCP passthrough. Errors: 404 unknown resource, 409 not ready, 502 upstream MCP error.
        app.get(`${Routes.Runner}/mcp/:name/tools`, (req, res) => {
            void this.passthrough(req, res, { method: "tools/list" }, async (client) =>
                RunnerMcpToolsResponseSchema.parse(await client.listTools()),
            );
        });

        app.post(`${Routes.Runner}/mcp/:name/tools/call`, (req, res) => {
            const productRequest = RunnerMcpToolCallRequestSchema.safeParse(req.body ?? {});
            if (!productRequest.success) {
                sendValidationProblem(
                    res,
                    "body",
                    productRequest.error.issues.map((issue) => issue.message).join("; "),
                );
                return;
            }
            const protocolRequest = CallToolRequestParamsSchema.safeParse(productRequest.data);
            if (!protocolRequest.success) {
                sendValidationProblem(
                    res,
                    "body",
                    protocolRequest.error.issues.map((issue) => issue.message).join("; "),
                );
                return;
            }
            void this.passthrough(
                req,
                res,
                { method: "tools/call", toolName: protocolRequest.data.name },
                async (client) => {
                    const result = await client.callTool(protocolRequest.data);
                    return RunnerMcpToolCallResponseSchema.parse({
                        ...result,
                        isError: result.isError ?? false,
                    });
                },
            );
        });

        app.post(`${Routes.Runner}/mcp/:name/resources/read`, (req, res) => {
            const productRequest = RunnerMcpResourceReadRequestSchema.safeParse(req.body ?? {});
            if (!productRequest.success) {
                sendValidationProblem(
                    res,
                    "body",
                    productRequest.error.issues.map((issue) => issue.message).join("; "),
                );
                return;
            }
            const protocolRequest = ReadResourceRequestParamsSchema.safeParse(productRequest.data);
            if (!protocolRequest.success) {
                sendValidationProblem(
                    res,
                    "body",
                    protocolRequest.error.issues.map((issue) => issue.message).join("; "),
                );
                return;
            }
            void this.passthrough(
                req,
                res,
                { method: "resources/read", resourceUri: protocolRequest.data.uri },
                async (client) =>
                    RunnerMcpResourceReadResponseSchema.parse(
                        await client.readResource(protocolRequest.data),
                    ),
            );
        });

        // Prod mode: the built dashboard is served from the runner's own origin.
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
        const result = this.orchestrator[action](name);
        if (result === "not_found") {
            sendNotFound(response, "runner resource", name);
            return;
        }
        if (result === "conflict") {
            const lifecycle = this.orchestrator.lookup(name)?.state.lifecycle ?? "unknown";
            sendConflict(
                response,
                name,
                `Resource '${name}' cannot ${action} while its lifecycle is '${lifecycle}'.`,
            );
            return;
        }
        response.status(202).end();
    }

    private async passthrough(
        req: Request,
        res: Response,
        call: { method: string; toolName?: string; resourceUri?: string },
        invoke: (client: Client) => Promise<unknown>,
    ): Promise<void> {
        const name = String(req.params.name);
        const entry = this.orchestrator.lookup(name);
        if (!entry) {
            sendNotFound(res, "runner resource", name);
            return;
        }
        if (entry.state.lifecycle !== "ready" || !entry.client) {
            sendConflict(
                res,
                name,
                `Resource '${name}' is not ready (currently '${entry.state.lifecycle}').`,
            );
            return;
        }
        const startTimeMs = Date.now();
        try {
            const result = await invoke(entry.client);
            this.telemetry.recordCall({
                method: call.method,
                toolName: call.toolName,
                resourceUri: call.resourceUri,
                serverName: name,
                transport: entry.resource.kind,
                startTimeMs,
                endTimeMs: Date.now(),
            });
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.telemetry.recordCall({
                method: call.method,
                toolName: call.toolName,
                resourceUri: call.resourceUri,
                serverName: name,
                transport: entry.resource.kind,
                startTimeMs,
                endTimeMs: Date.now(),
                failed: true,
            });
            console.error(`[${LogEvents.RunnerApiRequestFailed}] Runner API request failed: ${message}`);
            sendBadGateway(res);
        }
    }

    private listenSandbox(): Promise<void> {
        const app = express();
        app.use(loopbackRequestGuard(SandboxAllowedOrigins));

        app.get("/sandbox.html", (req, res) => {
            if (!existsSync(sandboxHtml)) {
                res.status(404).send("dashboard/dist-sandbox/sandbox.html is not built");
                return;
            }

            let cspConfig: McpUiResourceCsp | undefined;
            if (typeof req.query.csp === "string") {
                try {
                    const parsed = McpUiResourceCspSchema.safeParse(JSON.parse(req.query.csp));
                    if (!parsed.success) {
                        sendValidationProblem(
                            res,
                            "csp",
                            parsed.error.issues.map((issue) => issue.message).join("; "),
                        );
                        return;
                    }
                    cspConfig = parsed.data;
                } catch {
                    sendValidationProblem(res, "csp", "The CSP query parameter must be valid JSON.");
                    return;
                }
            }

            // CSP via HTTP header — tamper-proof unlike meta tags.
            let cspHeader: string;
            try {
                cspHeader = buildCspHeader(cspConfig);
            } catch (error) {
                sendValidationProblem(res, "csp", error instanceof Error ? error.message : String(error));
                return;
            }
            res.setHeader("Content-Security-Policy", cspHeader);
            // Prevent caching to ensure fresh CSP on each load.
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
            res.sendFile(sandboxHtml);
        });

        app.use((_req, res) => {
            res.status(404).send("Only sandbox.html is served on this port");
        });
        app.use(errorHandler);

        return new Promise((resolvePromise, rejectPromise) => {
            this.sandboxServer = app.listen(Ports.Sandbox, Network.Loopback, () => {
                console.error(
                    `[${LogEvents.RunnerApiListening}] Sandbox server listening on ${Network.HttpScheme}://${Network.Loopback}:${Ports.Sandbox}/sandbox.html`,
                );
                resolvePromise();
            });
            this.sandboxServer.on("error", (error) => {
                console.error(
                    `[${LogEvents.RunnerApiBindFailed}] Sandbox server could not bind :${Ports.Sandbox}: ${error.message}`,
                );
                this.sandboxServer = null;
                rejectPromise(error);
            });
        });
    }
}

// Validate CSP domain entries to prevent injection attacks. Entries containing characters
// that could break out to a new directive are rejected as an invalid request.
function sanitizeCspDomains(domains?: string[]): string[] {
    if (!domains) return [];
    const invalid = domains.find((domain) => domain.length === 0 || /[;\s'"]/u.test(domain));
    if (invalid !== undefined) {
        throw new Error("CSP domains must be non-empty and cannot contain semicolons, whitespace, or quotes.");
    }
    return domains;
}

function buildCspHeader(csp?: McpUiResourceCsp): string {
    const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
    const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
    const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
    const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;

    const directives = [
        // Default: allow same-origin + inline styles/scripts (needed for bundled apps)
        "default-src 'self' 'unsafe-inline'",
        // Scripts: same-origin + inline + eval (some libs need eval) + blob (workers) + specified domains
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
        // Styles: same-origin + inline + specified domains
        `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
        // Images: same-origin + data/blob URIs + specified domains
        `img-src 'self' data: blob: ${resourceDomains}`.trim(),
        // Fonts: same-origin + data/blob URIs + specified domains
        `font-src 'self' data: blob: ${resourceDomains}`.trim(),
        // Media (audio/video): same-origin + data/blob URIs + specified domains
        `media-src 'self' data: blob: ${resourceDomains}`.trim(),
        // Network requests: same-origin + specified API/tile domains
        `connect-src 'self' ${connectDomains}`.trim(),
        // Workers: same-origin + blob (dynamic workers) + specified domains — critical for WebGL
        // apps (CesiumJS, Three.js) that use workers for tile decoding, textures, physics
        `worker-src 'self' blob: ${resourceDomains}`.trim(),
        // Nested iframes: use frameDomains if provided, otherwise block all
        frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
        // Plugins: always blocked (defense in depth)
        "object-src 'none'",
        // Base URI: use approved domains if provided; otherwise keep the
        // Apps schema's same-origin default.
        baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'self'",
    ];

    return directives.join("; ");
}

function openSse(res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
}

function writeFrame(res: Response, payload: unknown): void {
    res.write(`event: ${RUNNER_SSE_EVENT}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function closeServer(server: Server | null): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        // SSE connections hold the server open past close(); sever them so shutdown is prompt.
        server.closeAllConnections();
    });
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
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
