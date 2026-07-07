# mcp-run-dashboard

The mcp.run resource dashboard: a port of qyl.run's runner console (SSE resource
table + log streaming) upgraded with MCP Apps rendering from the ext-apps
basic-host (sandboxed double-iframe + AppBridge over the runner's REST
passthrough).

## Dev

```sh
npm run dev   # vite on :5173, proxies /runner → http://127.0.0.1:18888
```

The runner must be running for data, and it also serves the built sandbox proxy
on `:18889` (build once first so `dist-sandbox/sandbox.html` exists).

## Build

```sh
npm run build
```

Produces two outputs:

- `dist/` — the dashboard app, served by the runner at `http://127.0.0.1:18888/`
- `dist-sandbox/sandbox.html` — self-contained sandbox proxy, served by the
  runner from the separate `:18889` origin with CSP response headers derived
  from the `?csp=` query param

## How app rendering works

Calling a tool whose `_meta.ui.resourceUri` points at a `ui://` resource reads
that resource through `POST /runner/mcp/:name/resources/read`, loads the
sandbox proxy iframe from `:18889`, and drives it with an `AppBridge` whose
MCP client is a minimal REST facade (`RunnerRestClient` in `src/bridge.ts`)
backed by `/runner/mcp/:name/tools/call` and `/resources/read`. Tools the app
calls therefore go through the same runner passthrough as the dashboard itself.
