# qyl.mcp

ONE MCP surface for [qyl](https://github.com/ANcpLua/qyl) — the merge of the former
`mcp-run` (host half) and `qyl-apps-server` (visual half), both histories preserved.

Two runtime concerns, one repo:

- **`runner/`** — a Qyl.Run-shaped app host for MCP servers (Aspire-style orchestrator,
  runner API on `:18888`, MCP passthrough at `/runner/mcp/<name>`, OTLP self-monitoring).
  Hosts the qyl telemetry tools **in-process** — no child process, no sibling checkout.
- **`server/`** — the qyl telemetry MCP Apps server: interactive trace explorer +
  MCP dashboard rendered in-chat, live against the qyl collector with automatic
  demo fallback. Curated `tools/list` + search/execute catalog, budget enforced in code.
- **`dashboard/`** — the runner's resource dashboard (React 19 + Vite) with sandboxed
  MCP Apps rendering via a separate-origin CSP-headered sandbox on `:18889`.

Binding contracts: [ARCHITECTURE.md](./ARCHITECTURE.md) (host) and
[server/INTERFACE.md](./server/INTERFACE.md) (visual).

## Quickstart

```bash
npm ci && npm run build     # server → runner → dashboard
npm start                   # boots the host; dashboard at http://127.0.0.1:18888
```

Live mode needs a qyl collector on `:5100`
(`QYL_OTLP_AUTH_MODE=Unsecured dotnet run --project services/qyl.collector` in the qyl
repo); without one, the telemetry tools serve a fully functional demo dataset.

Direct chat-client wiring (stdio, no runner): `node server/dist/main.js --stdio`.

```bash
npm run smoke               # server contract smoke test (demo mode)
```

## Strategy

Why this exists and where it goes next (hosted remote endpoint, NL→query agent on
first-party semconv, visual root cause, self-instrumenting polyglot host):
`qyl/docs/design/qyl-host/MCP-STRATEGY.md`, grounded against the `sentry-mcp` clone
in `~/RiderProjects/qyl-references/`.
