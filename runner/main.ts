// The runnable qyl.mcp host. From the repo root:
//     node runner/dist/main.js
//
// Hosts the qyl telemetry MCP server IN-PROCESS (no child process, no sibling
// checkout) and blocks with the runner API live. The authenticated workbench
// API owns server connections, discovery, executions, tests, evaluations, and
// protocol evidence under http://127.0.0.1:18888/runner. Legacy resource
// lifecycle state remains available at /runner/resources (+ /stream).
//
// The in-process server reads its configuration from THIS process's
// environment: QYL_COLLECTOR_URL (default http://127.0.0.1:5100) for live
// mode, or QYL_DEMO=1 to select generated demo telemetry explicitly.

import { createServer } from "qyl-mcp-server";
import { McpAppBuilder } from "./src/app-builder.js";

const app = McpAppBuilder.create();

app.addInProcessServer("qyl-telemetry", createServer);

await app.build().run();
