# qyl-mcp-server

qyl telemetry MCP server: trace explorer, MCP dashboard, log search, and CI-run
inspection for a live [qyl](https://github.com/ANcpLua/qyl) collector — or an
explicit, visibly labelled demo mode.

```bash
npx qyl-mcp-server --stdio    # stdio MCP server
npx qyl-mcp-server            # Streamable HTTP on loopback
```

Works standalone with any MCP client. Point `QYL_COLLECTOR_URL` and
`QYL_OTLP_ENDPOINT` at a local or hosted Qyl collector; MCP process supervision
and interactive connections belong to the qyl.mcp workbench runner.

The HTTP server publishes a product and setup page at `/`; the protocol remains
available only at `/mcp`.

The server uses the MCP v2 serving entries. Streamable HTTP uses
`createMcpHandler` and stdio uses `serveStdio`; both accept only protocol
revision `2026-07-28`.

## Tools

`fetch_telemetry`, `list_traces`, `get_trace`, `list_sessions`, `search_logs`,
`display_traces`, `display_mcp_dashboard`, `ci_log` — all published with
read-only safety annotations. The two `display_*` tools return MCP Apps UI
resources (single-file viewers).

Every inbound `tools/call` is recorded natively: validated result, lifecycle,
duration, redacted JSON-RPC timeline, and trace/span correlation are persisted
atomically to `~/.qyl/mcp-native-executions.json`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `QYL_COLLECTOR_URL` | qyl read API base; default `http://127.0.0.1:5100`. Also the OTLP base when set. |
| `QYL_API_KEY` | Collector read and OTLP credential. |
| `QYL_OTLP_ENDPOINT` | Optional OTLP base for self-telemetry. |
| `QYL_DEMO=1` | Explicit generated demo telemetry. Collector failure never silently substitutes demo data. |
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans, metrics, and operation logs. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Include redacted, size-bounded request and response bodies in MCP operation logs. Disabled by default. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native execution-evidence path. |

Secrets are redacted before results reach the model, structured content, or
durable evidence.

Full documentation: [github.com/ANcpLua/qyl.mcp](https://github.com/ANcpLua/qyl.mcp)
