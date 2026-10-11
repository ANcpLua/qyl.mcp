# qyl MCP tool-use matrix

Source inventory checked **2026-10-08** using the command and actual manifest
output in [point-8 evidence](docs/evidence/2026-10-08-point-8-options.md), superseding
the [step-7 inventory](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory).
This maps existing tools to user needs; it does not claim a particular client,
repository or production service currently emits telemetry.

All 11 tools have `readOnlyHint: true` and `destructiveHint: false` in the
inspected manifest. Ten are model-facing; `fetch_telemetry` is app-only.
The manifest's contract revision is `sha256:382526f13652d18b`.

| Tool | User need and existing behavior | Limits / routing |
| --- | --- | --- |
| `list_sessions` | Find active or failing sessions with counts, state and recorded token usage. | Use returned IDs; `active_only` and `limit` are existing inputs. |
| `list_traces` | Get a compact overview of traces, duration, services and error flags. | Summary only; span data is omitted. |
| `get_trace` | Inspect span data for a returned `trace_id`. | Defaults to the full trace. `errors_only` filters first, `max_spans` (1–1000) caps matching spans, and `include_attributes=false` omits attribute collections. Trace totals stay unchanged; text states matching/returned counts. |
| `search_logs` | Find correlated logs or error details. | `trace_id`, `service_name`, `severity_min`, body query and limit; ERROR starts at 17. |
| `list_metrics` | Discover exact recorded instrument names, units and kinds. | Start here before choosing a metric name. |
| `get_metric_series` | Discover a metric's attribute streams and grouping/filter keys. | Use the returned attributes to choose the range query's groups. |
| `query_metric` | Compare a metric over time or across groups. | With `step_ms` equal to the window, each grouping produces one bucket: one number per series. |
| `ci_log` | Inspect recent CI runs or per-leg phases. | Case-sensitive `service_prefix` (default `qyl-ci`) filters both sessions and phase spans. Run `session.id` and span `ci.leg` identify runs/legs; failed phases use error status. List filters 50 recent sessions before its limit (default 10); detail reads up to 100 traces. |
| `display_traces` | See a trace waterfall, session traces or recent traces. | Interactive viewer; empty-input refresh preserves the original query in covered local tests. |
| `display_mcp_dashboard` | Inspect recorded MCP usage, tool latency and errors. | Requires spans carrying `mcp.method.name`; only recorded telemetry in the selected project can appear. |
| `fetch_telemetry` | Refresh or filter the trace explorer. | `_meta.ui.visibility: ["app"]`; UI plumbing, not a model-facing tool. |

Descriptions and input/annotation fields are in the source inventory above;
query-restoration and empty-result behavior are covered in the
[2026-10-08 local tests](docs/evidence/2026-10-08-step4.md#test).

## Applying the tools across repositories

These are conditional recommendations, not assertions about emission or ownership:

| Work area | Use qyl when… | Otherwise… |
| --- | --- | --- |
| `qyl` / `qyl.mcp` | The authorized Collector contains the service's runtime or CI telemetry. | Inspect source/build/test results through the agent's repository tools. |
| `qyl.at` | The user wants to compare documented telemetry behavior with actual recorded data. | Use site sources and local page checks; do not assume the site emits OTLP. |
| Semantic conventions / instrumentation | Emitted attributes, instruments or spans reached the authorized Collector. | Verify generation/instrumentation locally before claiming runtime evidence. |
| Any other CI | It emits the `ci_log` convention above into the authorized Collector. | Use that CI system's own authorized connector for its records or actions. |

No repository has an exclusive claim on the emitter convention or MCP span
attributes. Third-party mutations such as GitHub PRs or deployments are outside
qyl tools; see the first-party boundary in [AGENTS.md](AGENTS.md).

## Protocol and viewers

The local pinned Inspector 2.9.0 check passed `tools/list` for modern and legacy
eras and schema portability; see [dated command/output](docs/evidence/2026-10-08-step4.md#both-era).
That result does not establish a production client connection. Workbench's
source uses automatic negotiation; Events is a separate opt-in lifecycle.

| Resource | Tool | Source evidence, 2026-10-08 |
| --- | --- | --- |
| `ui://qyl-explorer/mcp-app-v4.html` | `display_traces` | [Viewer constants and registration](docs/evidence/2026-10-08-step7.md#viewers) |
| `ui://qyl-explorer/mcp-dashboard-v2.html` | `display_mcp_dashboard` | [Viewer constants and registration](docs/evidence/2026-10-08-step7.md#viewers) |

The same source declares a configured hosted UI origin and empty external
connection/resource CSP allowlists. No viewer resource or runtime code changed
in this documentation step.
