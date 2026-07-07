// ≈ Qyl.Run.Host/Program.cs — the runnable mcp distributed-app launcher. From the repo root:
//     node runner/dist/main.js
//
// Starts the managed MCP servers, then blocks with the runner API live. Resource state is
// exposed at http://127.0.0.1:18888/runner/resources (+ /stream) for the dashboard, and every
// managed server is reachable through http://127.0.0.1:18888/runner/mcp/<name>.

import { McpAppBuilder } from "./src/app-builder.js";

const app = McpAppBuilder.create(process.argv.slice(2));

app.addStdioServer("x-apps", {
    command: "node",
    args: ["dist/index.js", "--stdio"],
    cwd: "/Users/ancplua/Desktop/x-apps-server",
    env: { X_DEMO: "1" },
    description: "X timeline MCP Apps server (demo mode)",
});

await app.build().run();
