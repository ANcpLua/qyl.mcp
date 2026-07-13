// The runnable qyl.mcp host. From the repo root:
//     node runner/dist/main.js
//
// Hosts the qyl telemetry MCP server IN-PROCESS (no child process, no sibling
// checkout) and blocks with the runner API live. Resource state is exposed at
// http://127.0.0.1:18888/runner/resources (+ /stream) for the dashboard, and
// every managed server is reachable through http://127.0.0.1:18888/runner/mcp/<name>.
//
// The in-process server reads its configuration from THIS process's
// environment: QYL_COLLECTOR_URL (default http://127.0.0.1:5100) for live
// mode, or QYL_DEMO=1 to select generated demo telemetry explicitly.

import { createServer } from "qyl-mcp-server";
import { McpAppBuilder } from "./src/app-builder.js";

const app = McpAppBuilder.create();

app.addInProcessServer("qyl-telemetry", createServer);

await app.build().run();
