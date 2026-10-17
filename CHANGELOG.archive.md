# Changelog archive

Entries older than the three in [CHANGELOG.md](CHANGELOG.md), verbatim.

## 8.2.0

- Pin SemanticConventions 10.1.0 (`@ancplua/qyl-semantic-conventions`, server and workbench), including the generator compatibility fix and inspection cleanup. The telemetry attribute contract is unchanged.
- Allow a release whose version and workspace pins were committed before the gate, so publication uses the exact checked inputs.

## 8.1.4

- Pin SemanticConventions 10.0.1 (`@ancplua/qyl-semantic-conventions`, server and workbench): a `qyl.app.` key now follows the registry's denied keys and prefixes, plain token counts are token-exempt, four vendor keys are not persisted. No server code change.

## 8.1.3

- Pin SemanticConventions 10.0.0 (`@ancplua/qyl-semantic-conventions`, server and workbench): the `qyl.app` key and the `qyl.instrumentation.domain` values `app`, `messaging.process`, `gen_ai.invoke_agent`, `gen_ai.execute_tool`. Pairs with qyl 13.0.0. No server code change.

## 8.1.2

- Pin SemanticConventions 9.9.2 (no attribute changes over 9.9.1).
- The plugin bundle README says the write tools also record failure status. The mcp.qyl.at landing page lists all 32 tools, `update_failure_status` among the writes, and numbers them 01 to 32. No server code change since 8.1.1.

## 8.1.1

- Package the corrected qyl-investigate skill: `verify_fix` needs `since` or `release` beside the `failure_id`.
- Documentation only otherwise: the plugin bundle README, the Anthropic listing draft and both plugin manifests describe the 32-tool surface; the release contract records the OpenAI plugin draft and the verified domain; the threat model states the single scope check. No code change since 8.1.0.

## 8.1.0

- Serve the qyl-investigate skill from the server through the MCP skills extension (`io.modelcontextprotocol/skills`: `skills/list`, `skills/get` and `resources/read` under `skill://qyl/`), so the OpenAI plugin portal imports it at Scan Tools and the npm package carries it in `dist/skills`. The skill now names the tool to start with for each question, the defaults every tool applies, the accepted `aggregate_telemetry` measures, and the one-call connection rule: no fan-out before one call has returned telemetry, one retry after sign-in, then stop.
- Advertise output schemas inlined rather than hoisted into `$defs`: ChatGPT does not resolve `$ref`, so `verify_fix.verdict` and most of `get_failure_context` reached the model as `unknown`. The redundant date-time regex is dropped from advertised schemas.
- Use collector contract 12.1.2, whose tool descriptions state the default window, baseline, page sizes, span selection and the accepted measure and ordering values.

## 8.0.0

- The executable now requires Bun 1.4 or later, including stdio. Library subpaths remain usable on Node 24; TypeScript 7 continues to emit the package.
- Start HTTP explicitly with a 60-second idle timeout so quiet SSE responses survive the SDK keep-alive. Stop the HTTP server during shutdown.
- Request read, write and delete scopes at initial sign-in; step-up challenges name only missing scopes.
- Return useful text summaries, bounded evidence and continuations; validate failure updates and make create retries idempotent by default.
- Use collector contract 12.1.1 for corrected analysis paging, coverage and failure timestamps. Remove the obsolete demo runtime and duplicate read implementations.
- Pin SemanticConventions 9.9.1, including the canonical `qyl.gen_ai.tool.call.arguments_hash` definition used by collector 12.1.1 for repeated-call analysis.
- Preserve note drafts, render trace drill-down results and use consistent dashboard filters. Gate the real OTLP answer-key and Bun quiet-stream regressions.

## 7.7.0

- Expand to 32 tools: failure triage and lifecycle, trace/group comparisons, fix verification, telemetry aggregation and discovery, agent runs, releases, service maps, telemetry health and MCP statistics.
- Use the collector's shared typed analysis contracts for filtering, pagination, coverage and saved-query execution; retain official SDKs/exporters and project-scoped authorization.
- Add responsive trace comparison, explicit note/bookmark controls, dashboard filters and drill-downs, with denominator counts behind rates.
- Preserve numeric agent token usage during secret redaction, and verify the new surface against real OTLP fixtures plus both protocol eras.

## 7.6.1

- Manage existing Auth0 API permissions, client grants and mapped-user permissions with scoped tenant configuration and a drift check.

- Use the qyl-owned semantic conventions package generated from the same registry as C#. MCP attribute names, values, operation events, duration metrics and seconds remain consistent across both languages. The official OpenTelemetry SDKs and exporters and the shared API contracts remain in use.

## 7.6.0

- Contract 12.0.0 (`@ancplua/qyl-api-schema` 12.0.0, revision
  `sha256:b29439eba28e752b`): the server is generated from it and refuses a
  Collector on another revision, so it deploys only after the Collector serves
  12.0.0.
- Every problem the Collector or the workbench reports is RFC 9457 with a
  `type` URI (`https://qyl.at/problems/<name>`) and a stable `code`. A tool
  error's code now follows the problem's `code` (`not_found`, `conflict`,
  `precondition_failed`, `precondition_required`, `collector_unauthorized`,
  `collector_error`) and falls back to the HTTP status only for a body
  without one.
- One page limit on every list: 1 to 1000, 100 when omitted. The workbench
  reads Collector logs in pages of 1000 following `next_cursor` (up to ten
  pages, the same bound as before), and its protocol-event page defaults to
  100. `next_cursor` is absent on the last page.
- The workbench's HTTP errors no longer carry `X-Request-Id`; no server sent
  it.

## 7.5.0

- Write tools, each a separate tool so a host can approve it on its own:
  `create_annotation` and `update_annotation` (notes on a trace, span or
  session), `create_saved_query` and `update_saved_query` (named filters), and
  one `delete` for either kind. They change only those objects, in the
  caller's Collector project; no tool deletes or edits telemetry.
  `list_saved_queries` and `run_saved_query` read saved queries, and
  `get_trace` and `list_sessions` return annotations.
- Scopes: `qyl:write` for create and update, `qyl:delete` for `delete`;
  `qyl:read` alone keeps the read tools. The protected-resource metadata lists
  all three, and a call without the scope it needs gets a `403`
  `insufficient_scope` challenge. The Collector key needs the `write` and
  `delete` roles.

## 7.4.0

- Contract package `@ancplua/qyl-api-schema` 11.6.0 (revision
  `sha256:d926c3c6ab829cbf`). The hosted server starts only against a
  Collector built from `Qyl.Api.Contracts` 11.6.0, so the Collector deploys
  first.
- Paging on every list tool: `list_traces`, `list_sessions`, `search_logs`,
  `list_metrics` and `get_metric_series` return `has_more` and `next_cursor`
  and take `cursor`. Demo mode pages too, with its own opaque cursor.
- `list_traces` filters: `start_time`, `end_time`, `service_name`,
  `errors_only`. `list_sessions` and `search_logs` take the window;
  `search_logs` also takes `session_id`.
- Metric matchers are structured: `matchers: [{ key, op: "eq" | "prefix",
  value }]` replaces the `attr` / `attr_prefix` strings on `get_metric_series`
  and `query_metric`; `step_ms` and `hours` are integers.
- `fetch_telemetry` input is a discriminated union over `view`, published with
  an object root, and the tool now advertises its output schema. The `traces`
  view accepts a `trace_id` to return that one trace selected.
- Every tool output model admits `error`; the server's error codes are the
  contract's `ToolErrorCode` enum.

## 7.3.1

- Transient answers without a contract body keep their status code: an HTML
  `502`/`503` from the edge during a deploy window, or an empty `429`, now
  yield `collector_error` or `collector_rate_limited` with `retryable: true`
  instead of `contract_mismatch`. Any other unexpected body stays
  `contract_mismatch`.

## 7.3.0

- Every failed tool call now carries `structuredContent.error` with a stable
  `code`, the `message` and `retryable`, next to the unchanged text content and
  `isError: true`. Codes: `invalid_argument`, `not_found`, `no_project_access`,
  `collector_unreachable`, `collector_timeout`, `cancelled`,
  `collector_unauthorized`, `collector_rate_limited`, `collector_rejected`,
  `collector_error`, `contract_mismatch`, `internal`. Additive: clients that read
  only the text see no change.
- `list_metrics` and `get_metric_series` report the page's own `has_more`
  instead of a hardcoded `false`, so a catalog truncated by `limit` no longer
  reads as complete.
- Contract package `@ancplua/qyl-api-schema` stays 11.5.0 (revision
  `sha256:3605ae27d2edf632`); no Collector change is needed.

## 7.2.3

- Contract package `@ancplua/qyl-api-schema` 11.5.0. The release changes only
  qyl-api-schema's toolchain: the contract revision stays
  `sha256:3605ae27d2edf632`, so a Collector built from `Qyl.Api.Contracts`
  11.4.0 or 11.5.0 passes the startup handshake.

## 7.2.2

- MCP Apps viewers check both the SDK client name and the `User-Agent` when
  choosing their domain. A recognized client name wins over a conflicting
  User-Agent, and an unknown name no longer hides a recognized one; 7.2.0 and
  7.2.1 read the User-Agent only when no client name was sent. When neither is
  recognized, `ui.domain` and `openai/widgetDomain` are both omitted and the
  host uses its default sandbox.
- The viewers are now `ui://qyl-explorer/mcp-app-v6.html` and
  `ui://qyl-explorer/mcp-dashboard-v4.html`, so hosts drop metadata cached for
  the previous versions.

## 7.2.1

- Contract package `@ancplua/qyl-api-schema` 11.4.0 (TypeSpec 1.17). The
  contract revision is now `sha256:3605ae27d2edf632`. The server refuses to
  start against a Collector that advertises another revision, so run it with a
  Collector built from `Qyl.Api.Contracts` 11.4.0.
- OpenTelemetry 0.223.0 / 2.12.0 and the remaining dependencies at their latest
  releases.

## 7.2.0

- Removed deprecated MCP logging capability and per-call log notifications;
  retained requested progress, cancellation and native operation telemetry.

- Optional Auth0-account-to-Collector project isolation, also applied to Events.
- Events share polling for accounts assigned to the same project; independent
  projects are polled concurrently. Invalid stdio project configuration fails
  before accepting a connection.
- Workbench telemetry recognizes the SDK's per-request server factory so native
  tool spans are not duplicated by the surrounding protocol journal, while
  failed server construction still produces a correlated failure span.
- `get_trace` accepts optional `errors_only`, `max_spans` and
  `include_attributes`; `ci_log` accepts an optional `service_prefix` (default
  `qyl-ci`).
- Advertised output schemas use portable spelling (`additionalProperties: true`,
  `anyOf` instead of type arrays); validation is unchanged.
- MCP Apps viewers declare the UI domain Claude and ChatGPT each expect, and
  none for other hosts.

## 7.1.1

- SDK v2.3.1 serving defaults accept modern and 2025-era tool clients over HTTP
  and stdio. The workbench negotiates automatically. The strict policy described
  under 6.0.0 below has been removed.
- Events recheck account status, explicit client access, user permissions and
  consent through Auth0. Unsubscribe aborts outstanding deliveries; restart
  cleanup removes expired subscriptions and obsolete signing keys.
- Public viewers declare their deployment origin and keep the requested trace
  limit on refresh. Release verification exercises a fresh npm consumer with
  modern and 2025-era discovery and a real demo-tool call.

## 7.1.0

- The hosted server can sit behind Cloudflare Access Managed OAuth:
  `MCP_AUTH_PROVIDER=cloudflare-access` with `MCP_ACCESS_TEAM_DOMAIN` and
  `MCP_ACCESS_AUD`. Access performs the client OAuth flow and owns discovery;
  the origin serves `/mcp` only for a `Cf-Access-Jwt-Assertion` it has verified
  against the team's signing keys for RS256, issuer, application audience,
  expiry and subject, so a direct request to the origin without one is
  rejected. The default stays the pinned Auth0 issuer; unknown modes, partial
  Access settings and non-Cloudflare team URLs fail closed.
- The assertion header is redacted from diagnostic objects and text, like the
  other credentials.

## 7.0.0

- Contract `@ancplua/qyl-api-schema` 11.1.0 -> 11.2.0. Demo series ids are
  computed with the contract's `attributeIdentity`, the same string the
  collector computes in C#, so a demo series id and a live one are comparable;
  every demo series id changes, which is why this is a major. A contract major
  moves this package's major from now on.

## 6.2.1

- Contract `@ancplua/qyl-api-schema` 11.0.1 -> 11.1.0. Every tool shape is
  `contractSchema("<definition>")`, typed by the contract at compile time, so
  the textual shape gate is gone; trace, span and session ids are parsed
  through the contract's generated parsers instead of cast; the nanosecond
  helpers come from the contract's `/runtime`.

## 6.2.0

- Contract `@ancplua/qyl-api-schema` 10.0.1 -> 11.0.1, revision
  `sha256:cd69d9c37a41916c` -> `sha256:5c1aa27ccdf48067`. Attribute values are
  decoded through the contract's own `/runtime` subpath instead of a local
  copy of the dashboard's decoder; bytes and key-value lists render as their
  values, never as `[object Object]`. A log body is an `AttributeValue`: a plain
  string body is a bare string, and the three body shapes the collector never
  produced are gone from the contract and from this server.

## 6.1.2

- The landing page at `mcp.qyl.at` states what 6.1.0 added: a request-scope
  section for cancellation, progress and the per-call log line, the full
  eleven-tool surface, and a hero fact for it. Surfaces take the ink of the
  original qyl site (`#050706`) and its family; the cyan accent is unchanged.
- The page no longer embeds the whole `package.json`: a default JSON import
  inlined the dependency and export tables into every visitor's download; a
  named import of `version` ships the one field the footer shows.

## 6.1.1

- The bundled viewers no longer ask for progress they never read: the MCP
  Apps client passed a no-op `onprogress` on every `tools/call`, which put a
  `progressToken` on each request and, since 6.1.0, had the server answer
  with notifications nobody consumed. A viewer that wants progress passes its
  own callback.
- `verify:frame` runs as a step of `bun run test`: every tool in the manifest
  must be registered inside `runTool` under its own name, so a tool cannot
  ship without cancellation, progress and its log line.

## 6.1.0

- Every tool handler runs inside `runTool`, which resolves the SDK request
  context once and hands the work a plain scope. Cancellation: the request's
  signal reaches every collector fetch, which already raced a signal against
  its timeout but had no caller passing one, so a client's
  `notifications/cancelled` or a dropped connection now aborts the fetch at
  once. Data-layer functions (`fetchTraces`, `fetchLogs`, `listMetrics`, …)
  gained a trailing `CollectorRequestOptions` argument; existing callers are
  unaffected.
- Progress on every tool: a request with a `progressToken` gets one
  `notifications/progress` per completed collector round trip and a final
  "Result ready"; `ci_log` with a `run_id` reports its per-leg flatten as a
  step of its own. Progress increases per token by construction. A request
  without a token gets nothing.
- The `logging` capability is declared and every call sends one
  `notifications/message` (`info` on success, `warning` on failure, logger
  `qyl.mcp`) to a request that carries a log level in its `_meta` envelope.
  Deprecated as of `2026-07-28` (SEP-2577), kept through the deprecation
  window beside stderr and OpenTelemetry. Tool surface, manifest snapshot and
  contract handshake are unchanged.

## 6.0.0

- Revision `2026-07-28` only, again, on both transports: `createMcpHandler`
  and `serveStdio` run with `legacy: "reject"`, so a 2025-era `initialize` is
  answered with `-32022` naming the served revision. 5.2.0 served the 2025 era
  for one release; that serving mode is withdrawn. Breaking for any host that
  opens with `initialize`, Claude Code's stdio client included: such a host
  needs a client that opens with `server/discover`. On the SDK's own client that
  is `versionNegotiation: { mode: "auto" }` (or a pin on `2026-07-28`); the
  default `mode: "legacy"` cannot reach this server.
- Gate for the flip: three independent agents, given only the endpoint and the
  stdio command and forbidden to read the source, each connected over both
  transports on their own and listed the eleven tools; each also confirmed that
  the SDK default is refused. The tool surface, manifest snapshot and contract
  handshake are unchanged from 5.2.0.

## 5.2.0

- 2025-era MCP clients are served again. Since 4.0.0 both transports rejected
  any client that did not speak revision `2026-07-28` with `-32022`, which
  refused every shipping host of the day, including Claude Code's stdio
  client on `2025-11-25`. The hosted handler now serves those clients
  statelessly (`legacy: "stateless"`, the SDK default) and the stdio server
  takes `serveStdio`'s default legacy serving. Modern clients are unchanged;
  the manifest, the contract handshake and the tool surface are the same at
  either revision.
- The README no longer points at `qyl/ARCHITECTURE-1.0.0.md`, which was
  deleted on 2026-09-07; the qyl README states the architecture in place.

## 5.1.0

- Contract `@ancplua/qyl-api-schema` 10.0.0 -> 10.0.1, revision
  `sha256:264a9e4f1d70289a` -> `sha256:cd69d9c37a41916c`. The contract's
  operations and shapes are unchanged; the revision moved because the
  TypeSpec toolchain that emits the canonical OpenAPI projection did. The
  startup handshake refuses a collector on the old revision, so this server
  pairs with `qyl` 5.1.0 and later; `server/tool-manifest.snapshot.json`
  differs only in its `contract_revision`.
- The workspace root package no longer pins its own members, and the matrix
  no longer compares itself to a tool inventory that no longer exists.

## 5.0.0

- **Breaking.** Contract major: `@ancplua/qyl-api-schema` 9.0.0 -> 10.0.0,
  revision `sha256:d1c859393b628164` -> `sha256:264a9e4f1d70289a`. The
  startup handshake refuses a collector that advertises anything else, so
  this server and the collector move together.
- The contract's revision scheme moved to `qyl-contract-revision-v3`; the
  revision string is read from the package at build time, so nothing in this
  server encodes it by hand.
- The contract's `./generated/otel-keys` TypeSpec keys projection was
  removed upstream. This server never imported it — the tool surface,
  schemas, and protocol are unchanged, and
  `server/tool-manifest.snapshot.json` differs only in its
  `contract_revision`.

## 4.0.1

- Dependencies only; no tool, schema, or protocol change. The published
  package's runtime dependencies move to their latest stable versions, so
  the tarball no longer describes a tree that has since moved on.
- OpenTelemetry: `@opentelemetry/api-logs`, `exporter-logs-otlp-proto`,
  `exporter-metrics-otlp-proto`, `exporter-trace-otlp-proto` and `sdk-logs`
  `^0.221.0` -> `^0.222.0`; `core`, `resources`, `sdk-metrics`,
  `sdk-trace-base` and `sdk-trace-node` `^2.10.0` -> `^2.11.0`.
- `jose` `^6.2.3` -> `^6.2.10`, `zod` `^4.5.0` -> `^4.5.4`.
- `@ancplua/qyl-api-schema` stays 9.0.0, revision
  `sha256:d1c859393b628164`, and `@opentelemetry/semantic-conventions`
  stays `^1.43.0` — the contract and the startup handshake are unchanged,
  so this server and the collector do not have to move together.

## 4.0.0

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

## 3.0.0

- Metrics reading: `list_metrics`, `get_metric_series`, and `query_metric` over
  the collector's metrics API. Each carries the read-only safety annotations.
- Contract major: `@ancplua/qyl-api-schema` 8.0.0, revision
  `sha256:64c464569005a485`. The startup handshake refuses a collector that
  advertises anything else, so this server and the collector move together.

## 2.1.0

- `tools/list` shrank 44.6%: shared models in the output schemas are emitted as
  `$defs`/`$ref` where that is smaller, and the app-only tools no longer publish
  an output schema at all.
- Native execution evidence is written only by a local server; see above.

Full documentation, the workbench, and self-hosting:
[github.com/ANcpLua/qyl.mcp](https://github.com/ANcpLua/qyl.mcp)
