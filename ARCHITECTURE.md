# mcp-run — Architecture Contract

An Aspire-style app host for **MCP servers**, deliberately shaped 1:1 after
`qyl/packages/Qyl.Run` (+ `.Host`, `.Dashboard`) so it can later be ported into qyl
mechanically. TypeScript/Node throughout. The dashboard is `ext-apps/examples/basic-host`
upgraded into a qyl.run.dashboard-style resource dashboard with sandboxed MCP Apps rendering.

This file is the single source of truth for names, shapes, ports, and routes.
Builders must not deviate from it.

## Qyl.Run → mcp-run mapping

| Qyl.Run (C#) | mcp-run (TS) | File |
|---|---|---|
| `QylConstants` | `constants.ts` (same nesting: `Product`, `Ports`, `ResourceKinds`, `Environments`, `Network`, `Env`, `Routes`, `Orchestrator`, `LogEvents` — keep the 11xx event ids) | `runner/src/constants.ts` |
| `QylResource` / `QylLaunchSpec` / `QylResourceState` / `ResourceLifecycle` | `McpResource` / `McpLaunchSpec` / `McpResourceState` / `ResourceLifecycle` | `runner/src/resources.ts` |
| `QylAppBuilder` / `IQylResourceBuilder` (+ `WaitFor`, `WithReference`) | `McpAppBuilder` / `McpResourceBuilder` (+ `.waitFor()`, `.withReference()`) | `runner/src/app-builder.ts` |
| `QylApp` | `McpApp` (`run()`: start orchestrator + runner API, resolve on SIGINT/SIGTERM after graceful stop) | `runner/src/app.ts` |
| `QylLogStore` | `LogStore` (per-resource ring buffer, 1000 lines, snapshot+subscribe) | `runner/src/log-store.ts` |
| `QylOrchestrator` | `Orchestrator` | `runner/src/orchestrator.ts` |
| `QylRunnerApi` | `RunnerApi` (express) | `runner/src/runner-api.ts` |
| `Qyl.Run.Host/Program.cs` | `runner/main.ts` (sample host program) | `runner/main.ts` |
| `Qyl.Run.Dashboard` | `dashboard/` (React 19 + Vite, no other runtime deps besides `@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps` for the App Bridge) | `dashboard/src/*` |

## Resource model (`runner/src/resources.ts`)

```ts
export type ResourceLifecycle = "Pending" | "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed";

export interface McpLaunchSpec {           // ≈ QylLaunchSpec
  command: string;                          // executable for stdio kind; "" for http kind
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface McpResource {             // ≈ QylResource (immutable; builder replaces on update)
  name: string;                             // unique, ordinal-compared
  kind: "stdio" | "http";                   // ResourceKinds
  environment: string;                      // "dev" | "staging" | "prod"
  launch: McpLaunchSpec;                    // http kind: empty command, endpoint below
  endpoint?: string;                        // http kind only: upstream MCP URL
  waitForNames: readonly string[];
  references: readonly string[];            // referencing implies waiting (same as qyl)
  description?: string;
}

export interface McpResourceState {        // ≈ QylResourceState — EXACT wire shape of /runner API
  name: string;
  lifecycle: ResourceLifecycle;
  timestamp: string;                        // ISO 8601
  allocatedPort: number | null;             // stdio: null (no port); http: upstream port if parseable
  endpoint: string | null;                  // the RUNNER PROXY url for this server (see Routes)
  lastError: string | null;
  // mcp-run extensions (additive — qyl dashboard ignores unknown fields):
  serverInfo?: { name: string; version: string } | null;   // from MCP initialize
  toolCount?: number | null;
  hasAppUi?: boolean;                       // any tool with _meta.ui.resourceUri
  restarts?: number;
}

export interface LogLine { resource: string; stream: "out" | "err"; line: string; }
```

## Builder (`runner/src/app-builder.ts`)

```ts
McpAppBuilder.create(args?: string[]): McpAppBuilder
  .addStdioServer(name, { command, args?, env?, cwd?, description? }): McpResourceBuilder
  .addHttpServer(name, endpointUrl, { description? }): McpResourceBuilder
  .build(): McpApp
```

- Duplicate names throw (`Resource '<name>' was already added; names must be unique.`).
- `McpResourceBuilder.waitFor(...others)` / `.withReference(...others)` mirror qyl semantics:
  reference ⇒ wait; merged, deduped, ordinal.
- `withReference` env injection at launch: for each referenced resource, inject
  `MCP_ENDPOINT_<NAME_UPPER_SNAKE>=<runner proxy url>` into the child env once the
  reference is Ready (start-ordering guarantees it).

## Constants (`runner/src/constants.ts`) — keep qyl values where they exist

- `Ports.RunnerApi = 18888`, `Ports.Sandbox = 18889` (new), `Ports.DynamicAllocation = 0`.
- `Orchestrator`: `HealthPollIntervalMs = 500`, `HealthProbeAttemptTimeoutSeconds = 5`,
  `StartupTimeoutSeconds = 60`, `MaxRestarts = 3`.
- `LogEvents`: same names/ids as QylConstants (1100–1114); log lines to the orchestrator's own
  console output include the event id.
- `Routes.Runner = "/runner"`, `Routes.Health = "/health"`.
- `Product = { name: "mcp.run", version: "0.1.0", tagline: "mcp distributed-app runner" }`.

## Orchestrator (`runner/src/orchestrator.ts`)

- Start order: dependency-respecting (waitForNames) — start a resource only when all its
  waits are Ready; cycle or unknown name ⇒ fail fast at build/start with a clear error.
- **stdio resource**: spawn child (`launch`), pipe stderr → LogStore("err"). Do NOT pipe stdout
  to the log store — stdout is the JSON-RPC channel. Health = MCP handshake: the runner opens
  ONE SDK `Client` over `StdioClientTransport` per child (this connection is also the proxy
  backend). Ready when `initialize` completes + `tools/list` succeeds (captures serverInfo,
  toolCount, hasAppUi). Liveness afterwards: `ping` every `HealthPollIntervalMs * 10` (5s);
  child exit or ping failure ⇒ Failed ⇒ restart up to `MaxRestarts`, then stays Failed.
  IMPORTANT: because the runner owns the child's stdio, "spawn" means
  `StdioClientTransport` spawns the process itself (pass command/args/env/cwd to it); stderr
  is captured via its `stderr: "pipe"` option.
- **http resource**: no process. Health = SDK `Client` over `StreamableHTTPClientTransport`
  to `resource.endpoint`, same Ready/ping semantics. Connect retry loop within
  `StartupTimeoutSeconds`.
- State changes are timestamped, stored in a registry (name → McpResourceState), and pushed
  to all SSE subscribers. Registry replay-on-subscribe (snapshot then deltas) — identical
  contract to qyl's runner API.
- Graceful stop: Stopping → close MCP client → SIGTERM child (2s grace, then SIGKILL) → Stopped.
- Restart requests (from API): stop + relaunch, does not count toward MaxRestarts
  (mirrors QylRestartRequests being user-initiated, LogEvent 1114).

## Runner API (`runner/src/runner-api.ts`) — express on 127.0.0.1:18888

Wire-compatible with qyl.run.dashboard where routes overlap:

- `GET  /runner/resources` → `McpResourceState[]`
- `GET  /runner/resources/stream` → SSE; on connect replay snapshot (one message per resource), then deltas. `data: <json McpResourceState>`
- `GET  /runner/resources/:name/logs/stream` → SSE of `LogLine`; snapshot replay then live.
- `POST /runner/resources/:name/restart` → 202
- `POST /runner/resources/:name/stop` → 202
- `GET  /health` → 200 `{ status: "ok" }`

MCP passthrough (the enterprise piece — one origin for every managed server; backed by the
orchestrator's per-resource SDK Client):

- `GET  /runner/mcp/:name/tools` → `{ tools: Tool[] }` (full tool objects incl. `_meta`)
- `POST /runner/mcp/:name/tools/call` body `{ name, arguments }` → `CallToolResult`
- `POST /runner/mcp/:name/resources/read` body `{ uri }` → `ReadResourceResult`
- Errors: 404 unknown resource, 409 not Ready, 502 upstream MCP error `{ error: string }`.

Static serving:
- `:18888` also serves `dashboard/dist` at `/` when it exists (prod mode).
- `:18889` (separate origin for iframe isolation) serves ONLY the dashboard's built
  `sandbox.html` + nothing else, with CSP response headers derived from a `?csp=` query param
  — same mechanism as basic-host's `serve.ts`.

## Dashboard (`dashboard/`) — qyl.run.dashboard upgraded with basic-host's App Bridge

Stack: React 19, Vite, TypeScript. `vite.config.ts` dev-proxies `/runner` → `http://127.0.0.1:18888`.
Build outputs `dashboard/dist` (main app) AND `dashboard/dist-sandbox/sandbox.html`
(separate vite input, self-contained, no module preload polyfill leakage — copy basic-host's approach).

- `src/types.ts`, `src/useResources.ts`, `src/useLogs.ts`: port of the qyl dashboard versions
  (same SSE contract; types extended with the additive mcp-run fields).
- `src/App.tsx`: left = resource table (name, kind, lifecycle badge with qyl-style colors,
  serverInfo, toolCount, restarts, endpoint link, restart/stop buttons hitting the POST routes);
  bottom/right = logs pane for the selected resource (useLogs); main = tools panel for the
  selected Ready resource.
- Tools panel: `GET /runner/mcp/:name/tools`, filter `_meta.ui.visibility` app-only tools out
  of the list (same `isToolVisibleToModel` logic as basic-host), JSON args textarea prefilled
  from inputSchema defaults, Call button → `POST .../tools/call`.
- **App rendering** (`src/app-frame.tsx` + `src/bridge.ts`, adapted from basic-host
  `implementation.ts`): when a called tool has `_meta.ui.resourceUri`, read the resource via
  the passthrough, then render basic-host's double-iframe sandbox: outer iframe src
  `http://127.0.0.1:18889/sandbox.html?csp=<json>`, inner iframe from the sandbox proxy,
  `AppBridge` over `PostMessageTransport(iframe.contentWindow, iframe.contentWindow)`,
  `sendToolInput` → `sendToolResult`, teardown on unmount.
  AppBridge's client parameter: implement a minimal facade backed by the REST passthrough —
  BEFORE writing it, read `ext-apps/src/app-bridge.ts` and implement exactly the member
  surface AppBridge uses (at minimum tool calls + resource reads); cast to the expected type
  at the single construction site with a comment explaining the facade.
- `src/sandbox.ts` + `sandbox.html`: port of basic-host's (referrer check adjusted to allow
  `http://127.0.0.1:18888` and `http://localhost:5173`).
- Styling: single `styles.css`, dark/light via `prefers-color-scheme`, qyl-dashboard-plain
  (tables, monospace logs, small lifecycle badges). No component libraries.

## Sample host program (`runner/main.ts`) — ≈ Qyl.Run.Host/Program.cs

```ts
const app = McpAppBuilder.create(process.argv.slice(2));
app.addStdioServer("qyl-apps", {
  command: "node", args: ["dist/index.js", "--stdio"],
  cwd: "/Users/ancplua/RiderProjects/qyl-workspace/qyl-apps-server",
  env: { QYL_COLLECTOR_URL: "http://127.0.0.1:5100" },
  description: "qyl telemetry explorer (MCP Apps; live against the collector, demo fallback)",
});
await app.build().run();
```

## Build / packages

- Root `package.json`: private, npm workspaces `["runner", "dashboard"]`, scripts:
  `build` (both), `start` (`node runner/dist/main.js`), `dev`.
- `runner`: deps `@modelcontextprotocol/sdk`, `express`, `cors`, `zod`; tsc build (NodeNext, ES2022)
  to `runner/dist`. No bundler needed.
- `dashboard`: deps `react`, `react-dom`, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`;
  devDeps vite, @vitejs/plugin-react, typescript.
- Node ≥ 20. No other runtime deps.

## Out of scope (v1)

Container resources, TUI console keys, OTLP, auth on the runner API (loopback bind only),
transparent Streamable-HTTP⇄stdio proxying (REST passthrough instead — noted for v2).
