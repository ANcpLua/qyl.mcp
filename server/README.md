# qyl-mcp-server

MCP tools over a live [qyl](https://github.com/ANcpLua/qyl) collector — traces,
logs, sessions, CI runs, and a graph view of agent runs you can watch while they
execute.

```bash
npx qyl-mcp-server --stdio    # stdio MCP server
npx qyl-mcp-server            # Streamable HTTP on 127.0.0.1:3001
```

Works with any MCP client. Point it at a collector:

```bash
export QYL_COLLECTOR_URL=http://127.0.0.1:5100
export QYL_API_KEY='your-collector-key'   # omit for an unsecured local collector
```

`QYL_API_KEY` is an *outgoing* collector credential — it does not authenticate
incoming MCP clients, which is why the local server binds to loopback only.

There is also a hosted instance at `https://mcp.qyl.at/mcp` needing no install.
It is an OAuth 2.1 resource server, so an unauthenticated request answers `401`
with an RFC 9728 protected-resource document that a stock MCP client follows on
its own.

Both accept only protocol revision `2026-07-28`, on MCP TypeScript SDK 2.0.0 —
Streamable HTTP through `createMcpHandler`, stdio through `serveStdio`.
The HTTP server serves a product page at `/`; `/mcp` is the only protocol
endpoint.

## Tools

**Telemetry** — `list_traces`, `get_trace`, `list_sessions`, `search_logs`,
`ci_log`, `display_traces`, `display_mcp_dashboard`.

**Metrics** — `list_metrics`, `get_metric_series`, `query_metric`. Read in that
order: the catalog gives you an exact instrument name and how many attribute
streams it has, series discovery tells you which attribute keys are worth
grouping or filtering on, and the range query answers the actual question —
a window, a bucket width (`step_ms`), a reducer (`avg`, `min`, `max`, `sum`,
`count`, `last`, `p50`, `p90`, `p95`, `p99`), optional `group_by` keys, and
optional `attr` / `attr_prefix` matchers written `key=value`. One bucket
spanning the whole window collapses the answer to a single number.

**App-only** — `fetch_telemetry` is called by the bundled MCP Apps, not by a
model.

Every tool is read-only: the server queries the configured collector and never
mutates it. On the hosted server they all sit behind the single `qyl:read` scope.

The `display_*` tools return MCP Apps UI resources as single-file viewers.

Every inbound `tools/call` on a local server — `--stdio`, or HTTP without
`MCP_PUBLIC_URL` — is recorded natively: validated result, lifecycle, duration,
redacted JSON-RPC timeline, and trace/span correlation, persisted atomically to
`~/.qyl/mcp-native-executions.json`. A public deployment (`MCP_PUBLIC_URL` set)
records nothing to disk; that evidence file is a local developer artifact, not a
multi-tenant audit log.

## Configuration

| Variable | Meaning |
| --- | --- |
| `QYL_COLLECTOR_URL` | Collector read API base; default `http://127.0.0.1:5100`. Also the OTLP base when set. |
| `QYL_API_KEY` | Collector read and OTLP credential. Outgoing only. |
| `QYL_PROJECT` | Server-owned collector project scope; defaults to `default`. Never accepted as tool input. |
| `QYL_OTLP_ENDPOINT` | Optional OTLP base for self-telemetry. |
| `QYL_DEMO=1` | Explicit, visibly labelled demo telemetry. A collector failure never silently substitutes demo data. |
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans, metrics, and operation logs. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Include redacted, size-bounded request and response bodies in operation logs. Off by default. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native execution-evidence path. |
| `PORT` | HTTP listener port; default `3001`. |

Secrets are redacted before results reach the model, structured content, or
durable evidence.

`--stdio` runs under Node.js 24 or Bun 1.3, which is what `npx` gives you.
The HTTP entry is a web-standard fetch handler served by its default export,
so serving it requires Bun.

## Release notes

### 4.0.0

- **Breaking.** The Codex workflow tools are gone: `list_workflow_runs`,
  `get_workflow_graph`, `display_workflow_graph`, `inspect_workflow_events`,
  `fetch_workflow_graph_updates`, and `control_workflow_run`. The tool surface is
  11 read-only tools; `tools/list` shrank about 31%.
- The `ui://qyl-explorer/observe-graph.html` MCP App resource and its viewer
  bundle are gone with them, as is the `qyl:control` OAuth scope — no tool
  required it any more, so the hosted server advertises `qyl:read` alone.
- These existed only to observe and control Codex runs, and were removed in one
  wave with the qyl observer and the qyl-api-schema contract.
- Contract major: `@ancplua/qyl-api-schema` 9.0.0, revision
  `sha256:d1c859393b628164`. The startup handshake refuses a collector that
  advertises anything else, so this server and the collector move together.

### 3.0.0

- Metrics reading: `list_metrics`, `get_metric_series`, and `query_metric` over
  the collector's metrics API. Each carries the read-only safety annotations.
- Contract major: `@ancplua/qyl-api-schema` 8.0.0, revision
  `sha256:64c464569005a485`. The startup handshake refuses a collector that
  advertises anything else, so this server and the collector move together.

### 2.1.0

- `tools/list` shrank 44.6%: shared models in the output schemas are emitted as
  `$defs`/`$ref` where that is smaller, and the app-only tools no longer publish
  an output schema at all.
- Native execution evidence is written only by a local server; see above.

Full documentation, the workbench, and self-hosting:
[github.com/ANcpLua/qyl.mcp](https://github.com/ANcpLua/qyl.mcp)
