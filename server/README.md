# qyl-mcp-server

qyl telemetry MCP server: trace explorer, MCP dashboard, log search, and CI-run
inspection for a live [qyl](https://github.com/ANcpLua/qyl) collector — or an
explicit, visibly labelled demo mode.

```bash
npx qyl-mcp-server --stdio    # stdio MCP server
npx qyl-mcp-server            # Streamable HTTP on loopback
```

Works standalone with any MCP client, and composes with the qyl local stack —
`qyl up --mcp-stdio npx qyl-mcp-server --stdio` supervises it next to the
collector with reads and OTLP export pre-wired.

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
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans and duration metrics. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native execution-evidence path. |

Secrets are redacted before results reach the model, structured content, or
durable evidence.

Full documentation: [github.com/ANcpLua/qyl.mcp](https://github.com/ANcpLua/qyl.mcp)
