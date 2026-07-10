// ≈ Qyl.Run.Host/Program.cs — the runnable mcp distributed-app launcher. From the repo root:
//     node runner/dist/main.js
//
// Starts the managed MCP servers, then blocks with the runner API live. Resource state is
// exposed at http://127.0.0.1:18888/runner/resources (+ /stream) for the dashboard, and every
// managed server is reachable through http://127.0.0.1:18888/runner/mcp/<name>.

import { McpAppBuilder } from "./src/app-builder.js";

const app = McpAppBuilder.create(process.argv.slice(2));

app.addStdioServer("qyl-apps", {
    command: "node",
    args: ["dist/index.js", "--stdio"],
    cwd: "/Users/ancplua/RiderProjects/qyl-workspace/qyl-apps-server",
    // No QYL_DEMO here on purpose: the server probes QYL_COLLECTOR_URL and falls back to
    // demo telemetry by itself when no collector is running. Set QYL_DEMO=1 to force demo.
    env: { QYL_COLLECTOR_URL: "http://127.0.0.1:5100" },
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
