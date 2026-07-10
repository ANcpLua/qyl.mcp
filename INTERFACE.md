# qyl Apps Server — Interface Contract

MCP Apps server for **qyl telemetry**: an interactive trace/log explorer rendered in the chat,
backed by the qyl collector's REST API. Successor to the deleted `services/qyl.mcp` Apps
(TraceExplorer/ErrorExplorer — prior art extracted to the scratchpad `qyl-mcp-prior-art/` dir),
rebuilt on `@modelcontextprotocol/ext-apps` following the same architecture as
`x-apps-server` (the pattern reference — deleted locally, GitHub-only at
`github.com/ANcpLua/x-apps-server`; read its server.ts/src for idioms).

Binding for both builders. Build setup (tsc + vite singlefile + bun, package scripts) is
inherited from the scaffold — do not change it.

## Modes & config

- `QYL_COLLECTOR_URL` (default `http://127.0.0.1:5100`) → live mode against the collector REST API.
- `QYL_DEMO=1`, or any live fetch failing with connection-refused at startup probe → **demo mode**
  with canned telemetry. Every tool fully functional offline. Structured results carry
  `mode: "live" | "demo"`.
- Collector read API has no auth (only OTLP ingest does) — no token handling needed.

## Collector wire format (CRITICAL)

Response bodies are **snake_case with dotted OTel keys** (e.g. `trace_id`, `start_time_unix_nano`,
`"service.name"`); query params are **camelCase** (`?serviceName=&limit=`). Demo data MUST use the
exact same wire shapes so live mode is a drop-in. Authoritative shapes (from the collector):

```ts
interface CursorPage<T> { items: T[]; has_more: boolean; next_cursor?: string | null }

interface QylTrace {
  trace_id: string; spans: QylSpan[]; root_span?: QylSpan;
  span_count: number; duration_ns: number;
  start_time: string; end_time: string;           // ISO 8601
  services: string[]; has_error: boolean;
}
interface QylSpan {
  span_id: string; trace_id: string; parent_span_id?: string;
  name: string; kind: 0|1|2|3|4|5;                 // Unspecified/Internal/Server/Client/Producer/Consumer
  start_time_unix_nano: number; end_time_unix_nano: number;
  attributes?: Array<{ key: string; value: unknown }>;
  events?: Array<{ name: string; time_unix_nano: number; attributes?: unknown[] }>;
  status: { code: 0|1|2; message?: string };       // Unset/Ok/Error
  resource: Record<string, unknown>;               // dotted keys; "service.name" always present
}
interface QylLogRecord {
  time_unix_nano: number; severity_number: number; severity_text?: string;
  body: string; attributes?: Array<{ key: string; value: unknown }>;
  trace_id?: string; span_id?: string; resource: Record<string, unknown>;
}
interface QylSession {
  "session.id": string; "user.id"?: string;
  start_time: string; end_time?: string; duration_ms?: number;
  trace_count: number; span_count: number; error_count: number;
  services: string[]; state: string;
  genai_usage?: { request_count: number; total_input_tokens: number; total_output_tokens: number;
                  models_used: string[]; providers_used: string[]; estimated_cost_usd?: number };
}
```

Collector endpoints used (the ONLY real ones): `GET /api/v1/traces?limit=`,
`GET /api/v1/traces/{traceId}`, `GET /api/v1/traces/{traceId}/spans`,
`GET /api/v1/sessions?limit=&isActive=`, `GET /api/v1/sessions/{id}/traces`,
`GET /api/v1/logs?traceId=&serviceName=&severityMin=&query=&limit=`.
Do NOT call /issues, /errors, /services, /metrics — they don't exist on the standalone collector.

## Model-facing tools (server.ts)

1. `list_traces` — { limit?: number (1–100, default 20) } → GET /api/v1/traces.
   Text: compact table (trace id short, root span name, services, duration ms, spans, error flag).
   structuredContent { traces: QylTrace[] (spans omitted — summary fields only), mode }.
2. `get_trace` — { trace_id: string } → GET /api/v1/traces/{id}.
   Text: root span, duration, per-service span counts, error spans listed.
   structuredContent { trace: QylTrace (full spans), mode }.
3. `list_sessions` — { limit?: number, active_only?: boolean } → /api/v1/sessions.
   structuredContent { sessions: QylSession[], mode }.
4. `search_logs` — { trace_id?: string, service_name?: string, severity_min?: number,
   query?: string, limit?: number (default 50) } → /api/v1/logs.
   structuredContent { logs: QylLogRecord[], mode }.
5. `display_traces` — THE app tool. `_meta: { ui: { resourceUri: "ui://qyl-explorer/mcp-app.html" } }`.
   Input: { trace_id?: string, session_id?: string, limit?: number (default 20) }.
   Server-side: trace_id → that one trace (full spans); session_id → that session's traces;
   neither → recent traces. structuredContent { traces: QylTrace[] (FULL spans — the UI renders
   waterfalls from them), selected_trace_id?: string, mode }.
   Text: one-line summary. Description tells the model to prefer this when the user wants to LOOK at traces.

## App-only tool (viewer → server; `_meta: { ui: { visibility: ["app"] } }`)

6. `fetch_telemetry` — { view: "traces" | "trace" | "logs",
   trace_id?: string, service_name?: string, severity_min?: number, query?: string, limit?: number }.
   view "traces" → recent trace list (full spans); "trace" → single trace; "logs" → log search
   (typically with trace_id to show a trace's logs in the detail panel).
   Returns the same structuredContent shapes as the corresponding model tools.
   Used by the UI for refresh, drill-down, and the logs tab.

## UI resource

- URI: `ui://qyl-explorer/mcp-app.html`, mimeType RESOURCE_MIME_TYPE, serves DIST_DIR/mcp-app.html,
  cached module-level. `_meta.ui.csp`: `{ connectDomains: [], resourceDomains: [] }` — fully
  self-contained, no external origins (system font stack, no CDN).

## Viewer (mcp-app.html + src/mcp-app.ts + src/mcp-app.css; vanilla TS; keep template App wiring:
applyDocumentTheme/applyHostStyleVariables/applyHostFonts, ontoolinput/ontoolresult, autoResize)

Layout — a trace explorer in the spirit of the deleted TraceExplorer/ErrorExplorer (study the
prior-art HTML for visual language: dense dark-friendly list, slide-in detail, status tints):

- **Header**: "qyl · traces", mode badge ("DEMO DATA" when demo), refresh button
  (fetch_telemetry view:"traces").
- **Trace list** (left / top on narrow): row = root span name (fallback: first span name),
  short trace id, service chips, duration (humanized ms/s), span count, red tint + ⚠ when
  has_error. Click → select.
- **Waterfall** (main): for the selected trace, nested spans ordered by start time —
  indent by parent depth, horizontal bar offset+width proportional to
  (start−trace_start)/trace_duration, min-width 2px. Bar color by span flavor derived from
  attributes/kind: gen_ai.* → purple, http.* → blue, db.* → green, messaging.* → orange,
  error status → red border; else neutral. Row shows name, service, duration. Click a span →
  **detail panel**: full name, kind label, timing, status (+message), attributes table
  (key/value, stringify arrays), events list. Escape/× closes.
- **Logs tab** in the detail area for the selected trace: fetch_telemetry view:"logs" with
  trace_id; rows severity-tinted (WARN amber, ERROR/FATAL red), monospace body, time.
- Empty/loading/error states; ontoolcancelled restores prior view (learned from x-apps review).
- XSS safety: ALL telemetry strings rendered via textContent — never innerHTML with data.
- Number formatting: durations ns→"1.24 s"/"87 ms"/"640 µs"; token counts compact.

## Demo dataset (server-side module)

8 traces telling a plausible qyl story (agentic GenAI app + web backend), exact wire shapes:
- 2–3 traces with gen_ai.* spans (attributes: gen_ai.system "anthropic", gen_ai.request.model,
  gen_ai.usage.input_tokens/output_tokens) nested under an HTTP server root span;
- 1 trace with an error span (status code 2 + message, exception event with
  exception.type/exception.message/exception.stacktrace attributes);
- DB spans (db.system "duckdb"/"postgresql", db.statement), a messaging span, a deep async chain
  (10+ spans, 3+ levels);
- 2–3 services across traces ("qyl-collector", "checkout-api", "agent-worker");
- realistic nano timestamps (recent, coherent parent/child containment) — timestamps may be
  computed relative to server start.
- ~30 log records correlated to trace/span ids (severities TRACE→ERROR, a stacktrace body on
  the error trace); 3 sessions (one active, one with genai_usage + estimated_cost_usd, one errored).
- Demo mode honors filters (trace_id, service_name, severity_min, query substring, limit).

## Wiring into mcp-run (integrator)

`~/RiderProjects/qyl-workspace/mcp-run/runner/main.ts`: replace the x-apps resource with
`app.addStdioServer("qyl-apps", { command: "node", args: ["dist/index.js", "--stdio"],
cwd: "/Users/ancplua/RiderProjects/qyl-workspace/qyl-apps-server", env: { QYL_DEMO: "1" }, description:
"qyl telemetry explorer (MCP Apps)" })` — keep x-apps present but commented out as the reference.

## Out of scope

Issues/errors endpoints (not served by today's collector), profiles UI, query studio,
writes/annotations, auth. README should note these as the v2 direction once the collector
grows the endpoints back.

---

## Addendum: MCP Dashboard (Sentry "MCP monitoring" equivalent, qyl-based)

New app tool `display_mcp_dashboard` — an aggregate dashboard over the MCP spans that
mcp-run's passthrough emits into the collector (service.name "mcp.run", spans carrying the
`mcp.method.name` attribute). Second UI resource: `ui://qyl-explorer/mcp-dashboard.html`
(own vite INPUT build → dist/mcp-dashboard.html; same CSP: no external origins).

### Aggregate shape (computed SERVER-side; UI renders only this)

```ts
interface McpToolRow { name: string; requests: number; errors: number; error_rate: number; avg_ms: number; p95_ms: number }
interface McpDashboardStats {
  window: { start: string; end: string; bucket_ms: number };   // bucket count 24-48
  buckets: Array<{ start: string; requests: number; errors: number }>;
  totals: { requests: number; errors: number; error_rate: number };
  by_server: Array<{ name: string; requests: number }>;        // mcp.server.name (≈ Sentry "by client")
  by_transport: Array<{ name: string; requests: number }>;     // app.transport
  by_method: Array<{ name: string; requests: number }>;        // mcp.method.name
  tools: McpToolRow[];                                          // by mcp.tool.name, desc requests
  resources: Array<McpToolRow & { name: string }>;              // name = mcp.resource.uri
  span_count_analyzed: number;
  truncated: boolean;                                           // hit the 1000-trace fetch cap
  mode: "live" | "demo";
}
```

- Durations ms from span nano fields; p95 = nearest-rank. error = status.code 2.
- Live source: GET /api/v1/traces?limit=1000 → flatten spans → keep spans with an
  `mcp.method.name` attribute → filter to window (`hours` arg) → aggregate.
- Tools: `display_mcp_dashboard` — { hours?: number (1-168, default 24) }, model-facing,
  `_meta.ui.resourceUri` = the dashboard resource. Text content: compact summary table
  (top tools with requests/error-rate/p95). structuredContent { stats: McpDashboardStats }.
- `fetch_telemetry` gains view `"mcp_stats"` (+ hours) returning the same — used by the
  dashboard UI's refresh + window selector (1h / 24h / 7d).
- Demo mode: synthesize ~2 weeks of plausible MCP spans (4 tools incl. one failing-ish,
  2 resources, 2 transports, 3 server names, daily traffic rhythm) and aggregate through
  the SAME aggregation code as live.

### Dashboard UI (mcp-dashboard.html + src/mcp-dashboard.ts + css)

Widget grid mirroring Sentry's MCP dashboard, qyl vocabulary: Traffic (stacked ok/error
bars over time + error-rate line), Traffic by Server, Transport Distribution, Most Used
Tools, Slowest Tools (p95), Most Failing Tools, then detail tables Tools and Resources
(REQUESTS / ERROR RATE / AVG / P95, sortable by column click). Window selector buttons
(1h/24h/7d) + refresh → fetch_telemetry view "mcp_stats". Charts hand-rolled inline SVG
(no libs). Same theme/App wiring as the explorer. "Prompts" widget intentionally absent
(no prompt telemetry) — do not fake it.
