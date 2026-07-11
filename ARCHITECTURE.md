# qyl.mcp — Architecture Contract

ONE MCP surface for qyl, two runtime concerns in one repo:

- **`runner/`** — the host half: an Aspire-style app host for MCP servers,
  deliberately shaped 1:1 after `qyl/packages/Qyl.Run` (+ `.Host`, `.Console`)
  so it can later be ported onto `Qyl.Host` mechanically. Orchestrator, runner
  API + MCP passthrough, OTLP self-monitoring.
- **`server/`** — the visual half: the qyl telemetry MCP Apps server (trace
  explorer + MCP dashboard rendered in-chat), hosted **in-process** by the
  runner. Its own binding contract is [server/INTERFACE.md](./server/INTERFACE.md).
- **`dashboard/`** — the runner's resource dashboard (React 19 + Vite) with
  sandboxed MCP Apps rendering.

Merged 2026-07-11 from `mcp-run` (host) + `qyl-apps-server` (visual); both
histories preserved (subtree merge). The predecessor `services/qyl.mcp` was
deleted in qyl commit `43d032f9` — history to mine, not code to resurrect.

This file is the single source of truth for names, shapes, ports, and routes.
Builders must not deviate from it.

## Qyl.Run → qyl.mcp mapping

| Qyl.Run (C#) | qyl.mcp (TS) | File |
|---|---|---|
| `QylConstants` | `constants.ts` (same nesting: `Product`, `Ports`, `ResourceKinds`, `Environments`, `Network`, `Env`, `Routes`, `Orchestrator`, `LogEvents` — keep the 11xx event ids) | `runner/src/constants.ts` |
| `QylResource` / `QylLaunchSpec` / `QylResourceState` / `ResourceLifecycle` | `McpResource` / `McpLaunchSpec` / `McpResourceState` / `ResourceLifecycle` (+ `serverFactory` for inproc — ≈ `Func<IMcpServer>` in the port) | `runner/src/resources.ts` |
| `QylAppBuilder` / `IQylResourceBuilder` | `McpAppBuilder` / `McpResourceBuilder` (+ `.waitFor()`, `.withReference()`, `.addInProcessServer()` — new here, no C# counterpart yet) | `runner/src/app-builder.ts` |
| `QylApp` | `McpApp` (`run()`: start orchestrator + runner API, resolve on SIGINT/SIGTERM after graceful stop) | `runner/src/app.ts` |
| `QylLogStore` | `LogStore` (per-resource ring buffer, 1000 lines, snapshot+subscribe) | `runner/src/log-store.ts` |
| `QylOrchestrator` | `Orchestrator` | `runner/src/orchestrator.ts` |
| `QylRunnerApi` | `RunnerApi` (express) | `runner/src/runner-api.ts` |
| `Qyl.Run.Host/Program.cs` | `runner/main.ts` (the host program) | `runner/main.ts` |
| `Qyl.Run.Console` | `dashboard/` (React 19 + Vite, no other runtime deps besides `@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps` for the App Bridge) | `dashboard/src/*` |

## Resource model (`runner/src/resources.ts`)

```ts
export type ResourceLifecycle = "Pending" | "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed";
export type ResourceKind = "stdio" | "http" | "inproc";

export interface McpLaunchSpec {           // ≈ QylLaunchSpec
  command: string;                          // executable for stdio kind; "" for http/inproc kinds
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface McpResource {             // ≈ QylResource (immutable; builder replaces on update)
  name: string;                             // unique, ordinal-compared
  kind: ResourceKind;
  environment: string;                      // "dev" | "staging" | "prod"
  launch: McpLaunchSpec;                    // http/inproc kinds: empty command
  endpoint?: string;                        // http kind only: upstream MCP URL
  serverFactory?: () => McpServer;          // inproc kind only: fresh server per (re)start
  waitForNames: readonly string[];
  references: readonly string[];            // referencing implies waiting
  description?: string;
}

export interface McpResourceState {        // ≈ QylResourceState — EXACT wire shape of /runner API
  name: string;
  lifecycle: ResourceLifecycle;
  timestamp: string;                        // ISO 8601
  allocatedPort: number | null;             // stdio/inproc: null (no port); http: upstream port if parseable
  endpoint: string | null;                  // the RUNNER PROXY url for this server (see Routes)
  lastError: string | null;
  // qyl.mcp extensions (additive — qyl dashboard ignores unknown fields):
  kind?: ResourceKind;
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
  .addInProcessServer(name, serverFactory, { description? }): McpResourceBuilder
  .build(): McpApp
```

- Duplicate names throw (`Resource '<name>' was already added; names must be unique.`).
- `McpResourceBuilder.waitFor(...others)` / `.withReference(...others)` — Aspire-style
  wait/reference semantics (Qyl.Run's `IQylResourceBuilder` has only `Update`):
  reference ⇒ wait; merged, deduped, ordinal.
- `withReference` env injection at launch: for each referenced resource, inject
  `MCP_ENDPOINT_<NAME_UPPER_SNAKE>=<runner proxy url>` into the child env once the
  reference is Ready (start-ordering guarantees it). Not applicable to inproc
  resources — an in-process server reads the RUNNER's environment.

## Constants (`runner/src/constants.ts`) — keep qyl values where they exist

- `Ports.RunnerApi = 18888`, `Ports.Sandbox = 18889`, `Ports.DynamicAllocation = 0`.
- `Orchestrator`: `HealthPollIntervalMs = 500`, `HealthProbeAttemptTimeoutSeconds = 5`,
  `StartupTimeoutSeconds = 60`, `MaxRestarts = 3`.
- `LogEvents`: same names/ids as QylConstants (1100–1114); log lines to the orchestrator's own
  console output include the event id.
- `Routes.Runner = "/runner"`, `Routes.Health = "/health"`.
- `Product = { name: "qyl.mcp", version: "0.1.0", tagline: "qyl mcp app host" }`.

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
- **inproc resource**: no process and no socket. `serverFactory()` builds the MCP server
  inside the runner; the same ONE `Client` connects to it over
  `InMemoryTransport.createLinkedPair()`. Identical Ready/ping/passthrough semantics; the
  server instance is closed on stop/restart and rebuilt fresh by the factory.
- State changes are timestamped, stored in a registry (name → McpResourceState), and pushed
  to all SSE subscribers. Registry replay-on-subscribe (snapshot then deltas) — identical
  contract to qyl's runner API.
- Graceful stop: Stopping → close MCP client (+ inproc server) → SIGTERM child (2s grace,
  then SIGKILL) → Stopped.
- Restart requests (from API): stop + relaunch, does not count toward MaxRestarts
  (mirrors QylRestartRequests being user-initiated, LogEvent 1114).

## Runner API (`runner/src/runner-api.ts`) — express on 127.0.0.1:18888

Wire-compatible with qyl.run.console where routes overlap:

- `GET  /runner/resources` → `McpResourceState[]`
- `GET  /runner/resources/stream` → SSE; on connect replay snapshot (one message per resource), then deltas. `data: <json McpResourceState>`
- `GET  /runner/resources/:name/logs/stream` → SSE of `LogLine`; snapshot replay then live.
- `POST /runner/resources/:name/restart` → 202
- `POST /runner/resources/:name/stop` → 202
- `GET  /health` → 200 `{ status: "ok" }`

MCP passthrough (one origin for every managed server; backed by the
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

## Dashboard (`dashboard/`) — qyl.run.console upgraded with basic-host's App Bridge

Stack: React 19, Vite, TypeScript. `vite.config.ts` dev-proxies `/runner` → `http://127.0.0.1:18888`.
Build outputs `dashboard/dist` (main app) AND `dashboard/dist-sandbox/sandbox.html`
(separate vite `--mode sandbox` build, self-contained, no module preload polyfill leakage).

- `src/types.ts`, `src/useResources.ts`, `src/useLogs.ts`: port of the qyl.run.console versions
  (same SSE contract; types extended with the additive qyl.mcp fields).
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
  `AppBridge` over `PostMessageTransport`, `sendToolInput` → `sendToolResult`, teardown on
  unmount. AppBridge's client parameter is a minimal facade backed by the REST passthrough.
- `src/sandbox.ts` + `sandbox.html`: port of basic-host's (referrer check adjusted to allow
  `http://127.0.0.1:18888` and `http://localhost:5173`).
- Styling: single `styles.css`, dark/light via `prefers-color-scheme`, qyl-dashboard-plain
  (tables, monospace logs, small lifecycle badges). No component libraries.

## Host program (`runner/main.ts`) — ≈ Qyl.Run.Host/Program.cs

```ts
import { createServer } from "qyl-mcp-server";
import { McpAppBuilder } from "./src/app-builder.js";

const app = McpAppBuilder.create(process.argv.slice(2));
app.addInProcessServer("qyl-telemetry", createServer, {
    description: "qyl telemetry explorer (MCP Apps; in-process, live against the collector with demo fallback)",
});
await app.build().run();
```

The telemetry tools run in-process — no sibling checkout, no child process.
Configuration flows through the runner's environment: `QYL_COLLECTOR_URL`
(default `http://127.0.0.1:5100`), `QYL_DEMO=1` to force demo telemetry.

## Build / packages

- Root `package.json`: private, npm workspaces `["server", "runner", "dashboard"]`, scripts:
  `build` (server → runner → dashboard; the runner typechecks against the server's emitted
  d.ts), `start` (`node runner/dist/main.js`), `smoke`, `dev`.
- `server`: package `qyl-mcp-server` — deps `@modelcontextprotocol/ext-apps`,
  `@modelcontextprotocol/sdk`, `express`, `cors`, `zod` (v4); tsc build (NodeNext, ES2022)
  of `src/` to `dist/` + two vite singlefile viewer builds into the same `dist/`.
  Tool surface policy lives in `src/surfaces.ts` (see server/INTERFACE.md).
- `runner`: deps `@modelcontextprotocol/sdk`, `express`, `cors`, `qyl-mcp-server`
  (workspace); tsc build (NodeNext, ES2022) to `runner/dist`. No bundler needed.
- `dashboard`: deps `react`, `react-dom`, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`;
  devDeps vite, @vitejs/plugin-react, vite-plugin-singlefile, typescript.
- Node ≥ 22. No other runtime deps. Clean clone: `npm ci && npm run build`.

## Host-side telemetry (`runner/src/telemetry.ts`) — no Qyl.Run counterpart yet

`McpTelemetry` self-monitors the MCP passthrough: every proxied request emits an OTLP/HTTP
JSON span (zero deps, `POST {endpoint}/v1/traces`, endpoint from `QYL_OTLP_ENDPOINT`,
default `http://127.0.0.1:4318`) carrying `mcp.method.name`, `mcp.tool.name` +
`gen_ai.tool.name` (both on purpose — semconv canonical + GenAI alias), and a per-run
`session.id` resource attribute so the qyl collector groups one runner run into one session.
Sentry-MCP-style record-inputs/outputs are opt-in via `QYL_MCP_RECORD_INPUTS=1` /
`QYL_MCP_RECORD_OUTPUTS=1`; `QYL_MCP_TELEMETRY=0` disables the exporter.

## Out of scope (v1)

Container resources, TUI console keys, auth on the runner API (loopback bind only),
transparent Streamable-HTTP⇄stdio proxying (REST passthrough instead — noted for v2),
skill→capability authorization and the eval harness (seams left in `server/src/tools.ts`
and `server/src/surfaces.ts`; deliberately the NEXT step, not this merge).
