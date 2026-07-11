# qyl-mcp-server

The visual half of [qyl.mcp](../README.md): an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
server for **qyl telemetry** — an interactive trace/log explorer rendered directly in the chat,
backed by the qyl collector's REST API.

This is the successor to the deleted `services/qyl.mcp` Apps (`TraceExplorerTools` /
`ErrorExplorerTools`), rebuilt in TypeScript on `@modelcontextprotocol/ext-apps`. Where the old
C# tools embedded JSON payloads in markdown for a hand-rolled UI bridge, this server uses
first-class MCP Apps: structured tool results plus a self-contained viewer resource
(`ui://qyl-explorer/mcp-app.html`) with a span waterfall, span detail panel, and
correlated-logs tab.

## Tool surface (tool-slot economy)

`tools/list` exposes a curated set; the rest of the tools live in a catalog reached through
`search_qyl_tools` / `execute_qyl_tool` (the Sentry MCP surfaces pattern). The budget and the
curation are enforced in code — `src/surfaces.ts` throws at server construction on drift.

| Tool | Surface | What it does |
|------|---------|--------------|
| `display_traces` | top-level, app | Opens the trace explorer UI — a `trace_id`, a `session_id`, or recent traces |
| `display_mcp_dashboard` | top-level, app | Opens the MCP dashboard UI — aggregate MCP traffic stats over a 1–168h window |
| `search_qyl_tools` | top-level | Search the catalog; returns names, descriptions, and input schemas |
| `execute_qyl_tool` | top-level | Run a catalog tool by name; returns that tool's own result |
| `fetch_telemetry` | app-only | Called by the viewer iframes (refresh, drill-down, logs tab, dashboard window selector); hidden from the model |
| `list_traces` | catalog | Recent trace summaries (root span, services, duration, span count, error flag) — spans omitted |
| `get_trace` | catalog | One trace by id with full spans (timing, attributes, events, status) |
| `list_sessions` | catalog | Sessions with trace/span/error counts, state, and GenAI token usage where present |
| `search_logs` | catalog | Log search by trace id, service, minimum OTel severity, and body substring |

Every result carries both a compact text summary (for non-UI hosts and the model) and
`structuredContent` in the collector's exact wire shapes (snake_case with dotted OTel keys),
including `mode: "live" | "demo"`. Tool failures return `isError: true` text — never a throw.

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

## MCP Dashboard

`display_mcp_dashboard` aggregates the MCP spans that the qyl.mcp runner's passthrough emits
into the collector (spans carrying an `mcp.method.name` attribute) into a Sentry-style MCP
monitoring view, rendered by a second UI resource (`ui://qyl-explorer/mcp-dashboard.html`).
The aggregate is computed server-side: a request/error timeline (24–48 time buckets over the
window), totals, breakdowns by server (`mcp.server.name`), transport (`app.transport`), and
method (`mcp.method.name`), plus per-tool (`mcp.tool.name`) and per-resource
(`mcp.resource.uri`) tables with request counts, error rates, average and nearest-rank p95
latency.

Live mode flattens the spans of up to 1000 recent traces (`truncated: true` when that cap is
hit) and filters to the requested window (`hours`, 1–168, default 24). Demo mode synthesizes
about two weeks of plausible MCP traffic — four tools with one deliberately failing-ish,
two resource URIs, three server names, stdio-dominant transports, and a day/night rhythm —
and runs it through the same aggregation code. The dashboard UI refreshes and switches
windows via `fetch_telemetry` with `view: "mcp_stats"`.

## Collector endpoints used

- `GET /api/v1/traces?limit=`
- `GET /api/v1/traces/{traceId}`
- `GET /api/v1/sessions?limit=&isActive=`
- `GET /api/v1/sessions/{id}/traces`
- `GET /api/v1/logs?traceId=&serviceName=&severityMin=&query=&limit=`

Query params are camelCase; response bodies are snake_case (`trace_id`,
`start_time_unix_nano`, `"service.name"`, …) and pass through unmodified.

## Build & run

Normally built from the repo root (`npm ci && npm run build`). Standalone:

```bash
npm run build          # ui typecheck, two vite singlefile viewer builds, tsc server compile

node dist/main.js --stdio          # stdio transport
node dist/main.js                  # Streamable HTTP on :3001 (/mcp)

QYL_DEMO=1 node dist/main.js --stdio   # demo mode, no collector needed
```

The qyl.mcp runner does not use this entry point — it hosts `createServer()`
in-process (see `../runner/main.ts`).

Smoke test (demo mode, spawns the built server over stdio):

```bash
node smoke-test.mjs
```

## v2 direction

The old qyl.mcp also had error-group (issues), services, and metrics tools. Today's standalone
collector does not serve `/api/v1/issues`, `/errors`, `/services`, or `/metrics`, so those are
deliberately out of scope here. When the collector regrows those endpoints, the natural v2
additions are an error-explorer view (issue groups with occurrence counts, like the old
`ErrorExplorerTools`), a service map, and metrics querying — as catalog tools, inside the
budget. Skill→capability authorization and the eval harness are the named next step (seams:
`capability` on every catalog def, the exported def list). Profiles UI, query studio,
writes/annotations, and auth remain out of scope.
