# qyl-apps-server

An [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) server for **qyl telemetry**:
an interactive trace/log explorer rendered directly in the chat, backed by the qyl collector's
REST API.

This is the successor to the deleted `services/qyl.mcp` Apps (`TraceExplorerTools` /
`ErrorExplorerTools`), rebuilt in TypeScript on `@modelcontextprotocol/ext-apps` following the
same architecture as the x-apps-server example. Where the old C# tools embedded JSON payloads in
markdown for a hand-rolled UI bridge, this server uses first-class MCP Apps: structured tool
results plus a self-contained viewer resource (`ui://qyl-explorer/mcp-app.html`) with a span
waterfall, span detail panel, and correlated-logs tab.

## Tools

| Tool | Kind | What it does |
|------|------|--------------|
| `list_traces` | model | Recent trace summaries (root span, services, duration, span count, error flag) — spans omitted |
| `get_trace` | model | One trace by id with full spans (timing, attributes, events, status) |
| `list_sessions` | model | Sessions with trace/span/error counts, state, and GenAI token usage where present |
| `search_logs` | model | Log search by trace id, service, minimum OTel severity, and body substring |
| `display_traces` | app | Opens the trace explorer UI — a `trace_id`, a `session_id`, or recent traces |
| `fetch_telemetry` | app-only | Called by the viewer iframe (refresh, drill-down, logs tab); hidden from the model |

Every result carries both a compact text summary (for non-UI hosts and the model) and
`structuredContent` in the collector's exact wire shapes (snake_case with dotted OTel keys),
including `mode: "live" | "demo"`.

## Configuration

| Variable | Default | Effect |
|----------|---------|--------|
| `QYL_COLLECTOR_URL` | `http://127.0.0.1:5100` | Base URL of the qyl collector REST API |
| `QYL_DEMO` | unset | `1` forces demo mode (canned telemetry, fully offline) |

Mode selection: `QYL_DEMO=1` always serves the demo dataset. Otherwise the first tool call
probes the collector (`GET /api/v1/traces?limit=1`); if the connection is refused, the server
logs a notice and serves demo data for the rest of the process. The collector read API has no
auth (only OTLP ingest does), so there is no token handling.

The demo dataset is 8 coherent traces across three services (`qyl-collector`, `checkout-api`,
`agent-worker`) — GenAI agent runs with `gen_ai.*` token attributes, a failed checkout with an
exception event and stacktrace, DB and messaging spans, and a 13-span async pipeline — plus ~30
correlated log records and 3 sessions (one active, one with GenAI usage/cost, one errored).
Timestamps are relative to process start, so the data always looks fresh. All filters
(trace id, service, severity, query, limit) work in demo mode.

## Collector endpoints used

- `GET /api/v1/traces?limit=`
- `GET /api/v1/traces/{traceId}`
- `GET /api/v1/sessions?limit=&isActive=`
- `GET /api/v1/sessions/{id}/traces`
- `GET /api/v1/logs?traceId=&serviceName=&severityMin=&query=&limit=`

Query params are camelCase; response bodies are snake_case (`trace_id`,
`start_time_unix_nano`, `"service.name"`, …) and pass through unmodified.

## Build & run

```bash
npm install
npm run build          # typecheck, bundle the viewer (vite singlefile), compile the server

node dist/index.js --stdio          # stdio transport
node dist/index.js                  # Streamable HTTP on :3001 (/mcp)

QYL_DEMO=1 node dist/index.js --stdio   # demo mode, no collector needed
```

Smoke test (demo mode, spawns the built server over stdio):

```bash
node smoke-test.mjs
```

## v2 direction

The old qyl.mcp also had error-group (issues), services, and metrics tools. Today's standalone
collector does not serve `/api/v1/issues`, `/errors`, `/services`, or `/metrics`, so those are
deliberately out of scope here. When the collector regrows those endpoints, the natural v2
additions are an error-explorer view (issue groups with occurrence counts, like the old
`ErrorExplorerTools`), a service map, and metrics querying. Profiles UI, query studio, writes/
annotations, and auth remain out of scope.
