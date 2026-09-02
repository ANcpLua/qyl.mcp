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

**Workflow graph** — `list_workflow_runs`, `get_workflow_graph`,
`display_workflow_graph`, `inspect_workflow_events`, `control_workflow_run`.

### Agent diagnostic snapshots

```text
record_diagnostic_snapshot -> validate/check -> redact/encrypt
  -> content_captured + content_ref -> fixed OTel event -> inspect_workflow_events
```

Format `qyl.agent.diagnostic.snapshot` version `1` stores dynamic names only in
protected JSON. Public/internal values are encrypted, sensitive values are redacted,
and secret values are omitted before IPC. The journal and OTel event expose only a
value-free summary; models retrieve protected evidence explicitly by `content_ref`.
`inspect_workflow_events` performs an immediate bounded journal read; graph cursors
and long-poll controls remain exclusive to the app-only graph update tool.

**App-only** — `fetch_telemetry` and `fetch_workflow_graph_updates` are called by
the bundled MCP Apps, not by a model.

All are read-only except **`control_workflow_run`**, which steers, interrupts, or
resumes a run. It is approval-gated and, on the hosted server, requires the
`qyl:control` scope in addition to `qyl:read`.

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

Full documentation, the workbench, and self-hosting:
[github.com/ANcpLua/qyl.mcp](https://github.com/ANcpLua/qyl.mcp)
