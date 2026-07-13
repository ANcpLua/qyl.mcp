# qyl.mcp

qyl.mcp is Qyl's local Model Context Protocol host and telemetry explorer. It
runs MCP servers, exposes their resource state through a loopback dashboard, and
provides trace, log, session, and MCP-traffic tools backed by a Qyl collector.

## Run

```bash
npm ci
npm run build
npm start
```

The dashboard is served at <http://127.0.0.1:18888>. Live telemetry requires a
collector at `QYL_COLLECTOR_URL` (default `http://127.0.0.1:5100`). For local
development, start the collector with read access enabled:

```bash
QYL_OTLP_AUTH_MODE=Unsecured dotnet run --project ../qyl/services/qyl.collector
```

For a collector running in API-key mode, set `QYL_API_KEY`; qyl.mcp sends it
under the header owned by the generated Qyl OpenAPI contract.

The standalone MCP server can also be wired directly to a chat client over
stdio:

```bash
node server/dist/main.js --stdio
```

Collector failures are returned as errors. Generated demo telemetry is never an
automatic fallback; enable it deliberately when demonstrating the UI offline:

```bash
QYL_DEMO=1 npm start
```

Demo results carry `mode: "demo"` so clients can label them accurately.

## MCP surface

The model-visible tools are `display_traces`, `display_mcp_dashboard`,
`list_traces`, `get_trace`, `list_sessions`, and `search_logs`.
`fetch_telemetry` is app-only and supports the bundled viewers.

Qyl request, response, event, and error models are owned by
[`qyl-api-schema`](https://github.com/ANcpLua/qyl-api-schema). Standard MCP
envelopes come from the official MCP SDK; OTLP comes from official OpenTelemetry
types.

## Verify

```bash
npm run build
npm test
npm run smoke
npm run smoke:otlp
```

The local smoke test uses explicit demo mode. `smoke:otlp` starts a real,
API-key-protected Qyl collector, proves its official OTLP/protobuf receiver
parses and persists the runner's SDK export without user-content leakage, and
validates all seven tool results against the published Qyl schemas.
