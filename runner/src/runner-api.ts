// ≈ Qyl.Run/Internal/QylRunnerApi.cs — loopback-only HTTP surface for the dashboard, extended
// with control verbs (restart/stop) and the MCP passthrough: one origin for every managed
// server, backed by the orchestrator's per-resource SDK Client.
//
// A second, separate-origin server (:18889) serves ONLY the dashboard's sandbox.html with CSP
// response headers derived from a ?csp= query param — same mechanism as ext-apps basic-host's
// serve.ts (headers, unlike meta tags, cannot be tampered with by the sandboxed content).

import cors from "cors";
import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Constants } from "./constants.js";
import { LogStore } from "./log-store.js";
import { Orchestrator } from "./orchestrator.js";

const { Ports, Network, Routes, LogEvents } = Constants;

// runner/dist/src/ → ../../.. = the workspace root that holds dashboard/.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dashboardDist = join(workspaceRoot, "dashboard", "dist");
const sandboxHtml = join(workspaceRoot, "dashboard", "dist-sandbox", "sandbox.html");

// Shape of the ?csp= JSON (mirrors ext-apps' McpUiResourceCsp; declared locally so the runner
// does not depend on the ext-apps package).
interface UiResourceCsp {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
}

export class RunnerApi {
    private server: Server | null = null;
    private sandboxServer: Server | null = null;

    constructor(
        private readonly orchestrator: Orchestrator,
        private readonly logStore: LogStore,
    ) {}

    async listen(): Promise<void> {
        await Promise.all([this.listenMain(), this.listenSandbox()]);
    }

    async close(): Promise<void> {
        await Promise.all([closeServer(this.server), closeServer(this.sandboxServer)]);
        this.server = null;
        this.sandboxServer = null;
    }

    private listenMain(): Promise<void> {
        const app = express();
        app.use(cors());
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
            const name = req.params.name;
            if (!this.orchestrator.lookup(name)) {
                res.status(404).json({ error: `Unknown resource '${name}'` });
                return;
            }
            openSse(res);
            const unsubscribe = this.logStore.subscribe(name, (line) => writeFrame(res, line));
            for (const line of this.logStore.snapshot(name)) writeFrame(res, line);
            req.on("close", unsubscribe);
        });

        app.post(`${Routes.Runner}/resources/:name/restart`, (req, res) => {
            const name = req.params.name;
            if (!this.orchestrator.lookup(name)) {
                res.status(404).json({ error: `Unknown resource '${name}'` });
                return;
            }
            void this.orchestrator.restart(name);
            res.status(202).end();
        });

        app.post(`${Routes.Runner}/resources/:name/stop`, (req, res) => {
            const name = req.params.name;
            if (!this.orchestrator.lookup(name)) {
                res.status(404).json({ error: `Unknown resource '${name}'` });
                return;
            }
            void this.orchestrator.stop(name);
            res.status(202).end();
        });

        // MCP passthrough. Errors: 404 unknown resource, 409 not Ready, 502 upstream MCP error.
        app.get(`${Routes.Runner}/mcp/:name/tools`, (req, res) => {
            void this.passthrough(req, res, (client) => client.listTools().then(({ tools }) => ({ tools })));
        });

        app.post(`${Routes.Runner}/mcp/:name/tools/call`, (req, res) => {
            const { name, arguments: args } = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
            if (typeof name !== "string" || name.length === 0) {
                res.status(400).json({ error: "Body must be { name: string, arguments?: object }" });
                return;
            }
            void this.passthrough(req, res, (client) =>
                client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }),
            );
        });

        app.post(`${Routes.Runner}/mcp/:name/resources/read`, (req, res) => {
            const { uri } = (req.body ?? {}) as { uri?: unknown };
            if (typeof uri !== "string" || uri.length === 0) {
                res.status(400).json({ error: "Body must be { uri: string }" });
                return;
            }
            void this.passthrough(req, res, (client) => client.readResource({ uri }));
        });

        app.get(Routes.Health, (_req, res) => {
            res.json({ status: "ok" });
        });

        // Prod mode: the built dashboard is served from the runner's own origin.
        if (existsSync(dashboardDist)) {
            app.use(express.static(dashboardDist));
        }

        return new Promise((resolvePromise) => {
            this.server = app.listen(Ports.RunnerApi, Network.Loopback, () => {
                console.error(
                    `[${LogEvents.RunnerApiListening}] Runner API listening on ${Network.HttpScheme}://${Network.Loopback}:${Ports.RunnerApi}${Routes.Runner}`,
                );
                resolvePromise();
            });
            // Mirrors qyl: a bind failure disables the state feed but does not kill the runner.
            this.server.on("error", (error) => {
                console.error(
                    `[${LogEvents.RunnerApiBindFailed}] Runner API could not bind :${Ports.RunnerApi} — dashboard state feed disabled: ${error.message}`,
                );
                this.server = null;
                resolvePromise();
            });
        });
    }

    private async passthrough(
        req: Request,
        res: Response,
        invoke: (client: import("@modelcontextprotocol/sdk/client/index.js").Client) => Promise<unknown>,
    ): Promise<void> {
        const name = req.params.name as string;
        const entry = this.orchestrator.lookup(name);
        if (!entry) {
            res.status(404).json({ error: `Unknown resource '${name}'` });
            return;
        }
        if (entry.state.lifecycle !== "Ready" || !entry.client) {
            res.status(409).json({ error: `Resource '${name}' is not Ready (currently ${entry.state.lifecycle})` });
            return;
        }
        try {
            res.json(await invoke(entry.client));
        } catch (error) {
            console.error(
                `[${LogEvents.RunnerApiRequestFailed}] Runner API request failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
        }
    }

    private listenSandbox(): Promise<void> {
        const app = express();
        app.use(cors());

        app.get("/sandbox.html", (req, res) => {
            if (!existsSync(sandboxHtml)) {
                res.status(404).send("dashboard/dist-sandbox/sandbox.html is not built");
                return;
            }

            let cspConfig: UiResourceCsp | undefined;
            if (typeof req.query.csp === "string") {
                try {
                    cspConfig = JSON.parse(req.query.csp) as UiResourceCsp;
                } catch (error) {
                    console.warn("[Sandbox] Invalid CSP query param:", error);
                }
            }

            // CSP via HTTP header — tamper-proof unlike meta tags.
            res.setHeader("Content-Security-Policy", buildCspHeader(cspConfig));
            // Prevent caching to ensure fresh CSP on each load.
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
            res.sendFile(sandboxHtml);
        });

        app.use((_req, res) => {
            res.status(404).send("Only sandbox.html is served on this port");
        });

        return new Promise((resolvePromise) => {
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
                resolvePromise();
            });
        });
    }
}

// Validate CSP domain entries to prevent injection attacks. Rejects entries containing characters
// that could break out to a new CSP directive (;, newlines), inject CSP keywords (quotes), or
// inject multiple sources in one entry (space). Same logic as basic-host's serve.ts.
function sanitizeCspDomains(domains?: string[]): string[] {
    if (!domains) return [];
    return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

function buildCspHeader(csp?: UiResourceCsp): string {
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
        // Base URI: use baseUriDomains if provided, otherwise block all
        baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
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
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function closeServer(server: Server | null): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        // SSE connections hold the server open past close(); sever them so shutdown is prompt.
        server.closeAllConnections();
    });
}
