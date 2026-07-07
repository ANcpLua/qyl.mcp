# mcp-run runner

Aspire-style app host for MCP servers, shaped 1:1 after qyl's `Qyl.Run` so it can later be
ported into qyl mechanically. The orchestrator spawns/monitors MCP servers (stdio or
Streamable HTTP), health-checks them via the MCP handshake itself, restarts crashes (bounded),
and exposes state + a REST MCP passthrough on one loopback origin.

## Qyl.Run → runner mapping

| Qyl.Run (C#) | runner (TS) |
|---|---|
| `QylConstants` | `src/constants.ts` |
| `QylResource` / `QylLaunchSpec` / `QylResourceState` / `ResourceLifecycle` | `src/resources.ts` |
| `QylAppBuilder` / `IQylResourceBuilder` | `src/app-builder.ts` |
| `QylApp` | `src/app.ts` |
| `QylLogStore` | `src/log-store.ts` |
| `QylOrchestrator` (+ `QylResourceRegistry`) | `src/orchestrator.ts` |
| `QylRunnerApi` | `src/runner-api.ts` |
| `Qyl.Run.Host/Program.cs` | `main.ts` |

## Run

```bash
npm install          # workspace root
npm run build --workspace runner
node runner/dist/main.js
```

Host programs look like `main.ts`:

```ts
const app = McpAppBuilder.create(process.argv.slice(2));
app.addStdioServer("x-apps", { command: "node", args: ["dist/index.js", "--stdio"], cwd: "…" });
await app.build().run();
```

`addHttpServer(name, url)` manages an already-running Streamable HTTP server;
`.waitFor(other)` orders startup; `.withReference(other)` additionally injects
`MCP_ENDPOINT_<NAME>=<runner proxy url>` into the child env (reference implies wait).

## API — `http://127.0.0.1:18888`

- `GET  /runner/resources` — `McpResourceState[]`
- `GET  /runner/resources/stream` — SSE, snapshot replay then deltas
- `GET  /runner/resources/:name/logs/stream` — SSE of `LogLine` (stderr ring buffer)
- `POST /runner/resources/:name/restart` — 202
- `POST /runner/resources/:name/stop` — 202
- `GET  /runner/mcp/:name/tools` — `{ tools }` (full tool objects incl. `_meta`)
- `POST /runner/mcp/:name/tools/call` — body `{ name, arguments }` → `CallToolResult`
- `POST /runner/mcp/:name/resources/read` — body `{ uri }` → `ReadResourceResult`
- `GET  /health` — `{ status: "ok" }`

Passthrough errors: 404 unknown resource, 409 not Ready, 502 upstream MCP error.
`dashboard/dist` is served at `/` when built. A separate origin `http://127.0.0.1:18889`
serves only `dashboard/dist-sandbox/sandbox.html`, with the Content-Security-Policy response
header built from its `?csp=` query param (iframe isolation for MCP Apps rendering).
