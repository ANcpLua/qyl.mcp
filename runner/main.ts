// ≈ Qyl.Run.Host/Program.cs — the runnable mcp distributed-app launcher. From the repo root:
//     node runner/dist/main.js
//
// Starts the managed MCP servers, then blocks with the runner API live. Resource state is
// exposed at http://127.0.0.1:18888/runner/resources (+ /stream) for the dashboard, and every
// managed server is reachable through http://127.0.0.1:18888/runner/mcp/<name>.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpAppBuilder } from "./src/app-builder.js";

// runner/dist/ → ../.. = this repo; qyl-apps-server defaults to the sibling checkout
// (same resolution idiom as runner-api.ts's workspaceRoot). QYL_APPS_SERVER_DIR
// overrides when the layout differs (another machine, CI).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const qylAppsServerDir =
    process.env.QYL_APPS_SERVER_DIR ?? resolve(repoRoot, "..", "qyl-apps-server");
if (!existsSync(resolve(qylAppsServerDir, "dist", "index.js"))) {
    console.error(
        `qyl-apps-server build not found at ${qylAppsServerDir} — ` +
            "clone it next to this repo and run `npm run build` there, " +
            "or point QYL_APPS_SERVER_DIR at the checkout.",
    );
    process.exit(1);
}

const app = McpAppBuilder.create(process.argv.slice(2));

app.addStdioServer("qyl-apps", {
    command: "node",
    args: ["dist/index.js", "--stdio"],
    cwd: qylAppsServerDir,
    // No QYL_DEMO here on purpose: the server probes QYL_COLLECTOR_URL and falls back to
    // demo telemetry by itself when no collector is running. Set QYL_DEMO=1 to force demo.
    env: { QYL_COLLECTOR_URL: process.env.QYL_COLLECTOR_URL ?? "http://127.0.0.1:5100" },
    description: "qyl telemetry explorer (MCP Apps; live against the collector, demo fallback)",
});

// Architectural reference workload (X timeline viewer) — x-apps-server was deleted
// locally (GitHub-only: github.com/ANcpLua/x-apps-server); re-clone before enabling:
// app.addStdioServer("x-apps", {
//     command: "node",
//     args: ["dist/index.js", "--stdio"],
//     cwd: "/path/to/x-apps-server",
//     env: { X_DEMO: "1" },
//     description: "X timeline MCP Apps server (demo mode)",
// });

await app.build().run();
