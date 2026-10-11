# qyl MCP tool-use matrix

Source inventory checked **2026-10-08** using the command and actual manifest
output in [point-8 evidence](docs/evidence/2026-10-08-point-8-options.md), superseding
the [step-7 inventory](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory).
This maps existing tools to user needs; it does not claim a particular client,
repository or production service currently emits telemetry.

## Tool inventory, as of 2026-10-08

The 11 tools of that inventory have `readOnlyHint: true` and
`destructiveHint: false` in the inspected manifest, and keep them. Ten are
model-facing; `fetch_telemetry` is app-only. The manifest's contract revision
was `sha256:3605ae27d2edf632`. The write tools below arrived on 2026-10-11. Since
the evening of 2026-10-11 the manifest's revision is `sha256:b29439eba28e752b`
(Contract 12.0.0): every problem carries a `type` URI and a stable `code`, and
every list has one page limit of 1 to 1000; no tool, input or hint changed.

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

## Write tools, as of 2026-10-11

Seven tools arrived with Contract 11.6.0 (revision `sha256:d926c3c6ab829cbf`).
The five writes change only objects users create in qyl inside the caller's
Collector project; no tool changes or deletes traces, logs or metrics.

| Tool | User need and behavior | Hints and scope |
| --- | --- | --- |
| `create_annotation` | Record a finding as a plain-text note (at most 2000 characters) on a trace, span or session. | Not read-only, not destructive, not idempotent; `qyl:write`. |
| `update_annotation` | Correct a note's text; the target stays fixed. A stale `etag` fails with `precondition_failed`. | Destructive, idempotent; `qyl:write`. |
| `create_saved_query` | Name a filter over traces, logs or metrics to ask again later; names are unique per project (`conflict`). | Not read-only, not destructive, not idempotent; `qyl:write`. |
| `update_saved_query` | Rename a saved query or change its description or filter; omitted fields keep their value. | Destructive, idempotent; `qyl:write`. |
| `delete` | Remove one annotation or saved query by `kind`, `id` and `etag`. Alert rules follow with Contract 11.7.0. | Destructive, idempotent; `qyl:delete`. |
| `list_saved_queries` | Find a stored question by name, optionally per signal; pages with `cursor`. | Read-only; `qyl:read`. |
| `run_saved_query` | Answer a stored question now: trace summaries, log records or a metric range result. | Read-only; `qyl:read`. |

`get_trace` and `list_sessions` return the annotations on what they read.
Demo mode keeps no annotations or saved queries and refuses these tools.

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

## Protocol and viewers, 2026-10-08 and 2026-10-11

The local pinned Inspector 2.9.0 check passed `tools/list` for modern and legacy
eras and schema portability; see [dated command/output](docs/evidence/2026-10-08-step4.md#both-era).
That result does not establish a production client connection. Workbench's
source uses automatic negotiation; Events is a separate opt-in lifecycle.

| Resource | Tool | Source, 2026-10-11 |
| --- | --- | --- |
| `ui://qyl-explorer/mcp-app-v6.html` | `display_traces` | [Viewer constants](server/src/config.ts), [registration](server/src/server.ts) |
| `ui://qyl-explorer/mcp-dashboard-v4.html` | `display_mcp_dashboard` | [Viewer constants](server/src/config.ts), [registration](server/src/server.ts) |

[Per-request domain selection](server/src/ui-domain.ts) checks both client name
and User-Agent: Claude receives the exact connector-URL hash domain, ChatGPT
receives the configured HTTPS origin plus `openai/widgetDomain`, and unknown
hosts omit both fields. Both hints are evaluated: a recognized client name
wins a conflict; a missing or unrecognized name can use a recognized UA.
When neither hint is recognized, omitting the optional domain lets a supporting
host use its default sandbox without disabling the viewer or rejecting the
MCP client. Local viewers also omit the domain.

[Verified requirements](docs/evidence/2026-10-08-point-10-ui-domain.md#clarification-and-current-behavior-2026-10-11)
support Claude's hash format when supplied and OpenAI's origin format and UI
submission requirement. Using the MCP server's origin for ChatGPT is qyl's
configuration choice. The client hints remain compatibility heuristics;
actual identifiers and authenticated rendering still need observation.
External connection/resource CSP allowlists remain empty. Hosted resource
responses use a zero TTL and private cache scope; the shared HTML cache remains
independent of the caller. [Regression tests](server/src/ui-domain.test.ts)
cover both viewers.
