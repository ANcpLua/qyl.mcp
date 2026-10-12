# qyl-mcp-server

MCP tools over a live [qyl](https://github.com/ANcpLua/qyl) collector — traces,
logs, metrics, sessions and CI runs, plus the Trace Explorer and MCP Dashboard
viewers for hosts that render MCP Apps.

```bash
npx qyl-mcp-server --stdio    # stdio MCP server
npx qyl-mcp-server            # Streamable HTTP on 127.0.0.1:3001
```

Use a modern or 2025-era MCP client. Point it at a collector:

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

Both use MCP TypeScript SDK v2: Streamable HTTP through `createMcpHandler`
and stdio through `serveStdio`, with their documented compatibility defaults.
One factory serves revision `2026-07-28` and supported 2025-era requests.
The HTTP server serves a product page at `/`; `/mcp` is the only protocol
endpoint.

## Hosted authentication

The hosted Auth0 profile requires CIMD and DCR discovery, Authorization Code
with PKCE S256, both `private_key_jwt` and `none` for ChatGPT CIMD compatibility,
`none` for Claude CIMD, and issuer identification. Auth0 owns registration and token
issuance; this server validates resource-bound RFC 9068 access tokens on every
MCP request. It rejects malformed/query credentials, invalid tokens and
insufficient scopes with distinct 400/401/403 responses. Every request needs
`qyl:read`; a write tool called without `qyl:write` or `qyl:delete` gets a
`403` with `error="insufficient_scope"` naming the scopes to request, in both
protocol eras, before the handler runs.

Optional resource-server integrations are selected explicitly:

```sh
MCP_AUTH_EXTENSIONS=enterprise-managed-authorization@1.0.0,oauth-client-credentials@1.0.0
```

Enterprise-managed authorization is stable upstream; client credentials is a
draft extension. Both preserve the core token verifier and require matching
Auth0 capabilities and separately provisioned client grants. Integration versions
are independent of the MCP wire version. Embedders can use the exported
`qyl-mcp-server/auth` composition API for additional declarative modules and
explicit scope hierarchies.

See the [deployment and authentication guide](https://github.com/ANcpLua/qyl.mcp#authentication)
for Auth0 configuration, extension responsibilities, and verification. Auth0
requires Enterprise for `private_key_jwt`. Neither a provider capability flag nor
an enabled module proves a client has been provisioned.

## Tools

The server publishes 32 tools, including one app-only read tool. Reads use the collector's
analysis queries and the generated qyl API contracts.

| Purpose | Tools |
| --- | --- |
| Investigate failures | `triage`, `list_failures`, `get_failure_context`, `compare_groups`, `compare_traces`, `verify_fix` |
| Explore telemetry | `aggregate_telemetry`, `discover_attributes`, `get_agent_run`, `list_releases`, `get_service_map`, `check_telemetry_health`, `get_mcp_stats` |
| Read executions | `list_sessions`, `list_traces`, `get_trace`, `search_logs`, `ci_log` |
| Read metrics | `list_metrics`, `get_metric_series`, `query_metric` |
| Saved questions | `list_saved_queries`, `run_saved_query` |
| Interactive views | `display_traces`, `display_mcp_dashboard`, `fetch_telemetry` (app-only) |
| Write project records | `create_annotation`, `update_annotation`, `create_saved_query`, `update_saved_query`, `delete`, `update_failure_status` |

Read tools accept an absolute RFC 3339 time window or `lookback_minutes` and report the
resolved `window` and `coverage`: examined, matched and returned counts, truncation,
scan completeness and observation time. Unknown counts are null. Filtering happens before
pagination; reuse an opaque `next_cursor` with the same filters to continue a page.

Shared matchers support `eq`, `neq`, `in`, `prefix`, `contains`, `exists`, `gt`, `gte`,
`lt` and `lte`, with span, resource or log scope. Span durations are milliseconds;
metrics retain their recorded units. Histogram percentiles identify their approximation,
and cumulative counter changes account for resets. Verification reports insufficient
traffic as pending rather than calling an unobserved failure fixed.

`get_trace` supports all spans, errors, errors with ancestors, or the critical path,
selected attributes and correlated logs. `display_traces` preserves the selected span
and can compare two executions. Notes and bookmarks are created only through explicit
viewer actions. `display_mcp_dashboard` uses the same MCP aggregates as `get_mcp_stats`,
shows the numerator and denominator behind rates, classifies failures, and opens matching
calls from aggregate selections. `fetch_telemetry` serves five app-only views: traces,
trace, logs, MCP statistics and comparison, with incremental refresh and field selection.

The 26 read tools carry `readOnlyHint: true`. Six write tools change annotations, saved
queries or failure status in the caller's project. An annotation can target a trace, span,
session or failure and has optional labels and a classification. A bookmark is a note
labelled `bookmark`. Updates and deletes require the current `etag`; stale writes are
rejected. Optional `idempotency_key` on create calls reuses the stored result for 24 hours.
Omitting it creates a new record. No tool edits or deletes recorded telemetry.

`qyl:read` covers reads, `qyl:write` adds creation and updates, and `qyl:delete` permits
`delete`. A missing scope returns the supported OAuth step-up challenge. Failed calls
carry a stable code, retryability, the problem type and field-level validation details
when available. Secrets are redacted before model text or structured content is returned.

Every tool runs inside its request scope, forwarding cancellation to the collector.
Requested progress reports completion; no logging notifications are sent to clients.
Analysis reads require a live collector. Synthetic demo data remains available for local
UI fixtures, and is never substituted when a collector fails.

Every inbound `tools/call` on a local server — `--stdio`, or HTTP without
`MCP_PUBLIC_URL` — records only its tool name, timing, status and error type,
plus a server-generated execution ID, atomically in
`~/.qyl/mcp-native-executions.json`. Arguments, request metadata, result bodies
and error messages are not retained. Known version-1/2 files are reduced to
this format on load; unreadable files still use the existing archive recovery
path, and pre-existing archives are not purged. A public deployment (`MCP_PUBLIC_URL` set)
records nothing to disk; that evidence file is a local developer artifact, not a
multi-tenant audit log.

## Configuration

| Variable | Meaning |
| --- | --- |
| `QYL_COLLECTOR_URL` | Collector read API base; default `http://127.0.0.1:5100`. Also the OTLP base when set. |
| `QYL_API_KEY` | Collector credential for reads and OTLP; the write tools need the Collector's `write` and `delete` roles on it. Outgoing only. |
| `QYL_PROJECT` | Server-owned collector project scope. Unset, the server sends no project-scope header, so the Collector's default project applies. Never accepted as tool input. This is the only place that states the default; other documents link here. |
| `MCP_COLLECTOR_PROJECTS` | Optional secret JSON mapping validated Auth0 subjects to project-bound Collector keys; see account isolation below. |
| `QYL_OTLP_ENDPOINT` | Optional OTLP base for self-telemetry. |
| `QYL_DEMO=1` | Local synthetic UI fixtures; analysis tools require a live collector. |
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans, metrics, and operation logs. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Workbench content capture; native incoming tool-call telemetry never supplies request or response bodies. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native execution-evidence path. |
| `MCP_EVENTS_STORE` | Optional internal Events subscription file; leave unset for the shared ChatGPT/Claude deployment. |
| `MCP_EVENTS_AUTH0_CLIENT_ID` / `MCP_EVENTS_AUTH0_CLIENT_SECRET` | Dedicated Management API application with `read:users`, `read:clients`, `read:client_grants`, `read:grants`; resolves CIMD identities and keeps access checks current without storing subscriber tokens. |
| `MCP_EVENTS_POLL_MS` | Collector polling interval, at least 5000 ms; default 30000 ms. |
| `PORT` | HTTP listener port; default `3001`. |

Secrets are redacted before results reach the model, structured content, or
durable evidence.

`--stdio` runs under Node.js 24 or Bun 1.4, which is what `npx` gives you.
The HTTP entry is a web-standard fetch handler served by its default export,
so serving it requires Bun.

### Account isolation for hosted Auth0

The existing tenant's API scopes, named client grants and mapped-user permissions
are managed by [the Auth0 configuration and drift checker](https://github.com/ANcpLua/qyl.mcp/tree/main/tools/auth0).
Run its check before applying changes; it preserves unrelated tenant configuration
and never creates identities or rotates credentials.

To give a reviewer access to sample data, provision a separate Collector
project/key through the Collector's `QYL_OTLP_PROJECT_KEYS` configuration and
assign that key to the reviewer's validated Auth0 subject. Configure the MCP
service's secret `MCP_COLLECTOR_PROJECTS` with this shape (placeholder values):

```json
[
  { "project": "default", "apiKey": "OWNER_COLLECTOR_KEY", "subjects": ["auth0|owner-example"] },
  { "project": "review", "apiKey": "REVIEW_COLLECTOR_KEY", "subjects": ["auth0|reviewer-example"] }
]
```

Include every account that should retain access, including the owner. An
enabled map rejects unmapped callers and never falls back to `QYL_API_KEY`.
Missing, malformed, duplicate or conflicting entries fail validation. The
feature requires the hosted Auth0 configuration; local stdio and Cloudflare
Access deployments cannot enable this map. When the variable is absent, the
existing deployment-wide credential behavior is retained.

Only the verified SDK `AuthInfo.extra.subject` selects the project. Tool inputs
and request metadata cannot override it. All telemetry tools, viewer refreshes
use that account's project credential. Project
keys are redacted from text and structured results, including keys nested in
this JSON configuration. Keep the map in host secrets and out of the plugin ZIP.

`bun run smoke:projects` from the repository root checks every tool, the
writes included, viewer query paths and both protocol eras against a
real local Collector with two temporary projects. Set `QYL_COLLECTOR_PROJECT` to its
`.csproj` when using a different checkout. The script uses local test identities
and an in-process signed webhook receiver; the hosted reviewer OAuth login and
real ChatGPT demonstration are separate checks before upload.

### Seeded analysis verification

The collector fixture `tests/Qyl.Collector.Tests/Fixtures/seed-answer-key.py`
emits real OTLP data and writes the trace IDs and absolute windows used by
`server/verify-answer-key.mjs`. Seed a fresh temporary collector database before
each run because the checks exercise annotations and failure status changes.
After building this workspace, run the verifier from `server/`:

```sh
QYL_ANSWER_KEY_FILE=/tmp/qyl-answer-key.json \
QYL_ANSWER_KEY_COLLECTOR=http://127.0.0.1:5510 \
QYL_ANSWER_KEY_OTLP=http://127.0.0.1:5518 \
node --test verify-answer-key.mjs
```

`QYL_BIN=/path/to/installed/qyl node live-tools-smoke.mjs` additionally checks
all 32 tools against an isolated collector started by the published CLI.

## Release notes

### 7.7.0

- Expand to 32 tools: failure triage and lifecycle, trace/group comparisons, fix verification, telemetry aggregation and discovery, agent runs, releases, service maps, telemetry health and MCP statistics.
- Use the collector's shared typed analysis contracts for filtering, pagination, coverage and saved-query execution; retain official SDKs/exporters and project-scoped authorization.
- Add responsive trace comparison, explicit note/bookmark controls, dashboard filters and drill-downs, with denominator counts behind rates.
- Preserve numeric agent token usage during secret redaction, and verify the new surface against real OTLP fixtures plus both protocol eras.


### 7.6.1

- Manage existing Auth0 API permissions, client grants and mapped-user permissions with scoped tenant configuration and a drift check.

- Use the qyl-owned semantic conventions package generated from the same registry as C#. MCP attribute names, values, operation events, duration metrics and seconds remain consistent across both languages. The official OpenTelemetry SDKs and exporters and the shared API contracts remain in use.

### 7.6.0

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

### 7.5.0

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

### 7.4.0

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

### 7.3.1

- Transient answers without a contract body keep their status code: an HTML
  `502`/`503` from the edge during a deploy window, or an empty `429`, now
  yield `collector_error` or `collector_rate_limited` with `retryable: true`
  instead of `contract_mismatch`. Any other unexpected body stays
  `contract_mismatch`.

### 7.3.0

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

### 7.2.3

- Contract package `@ancplua/qyl-api-schema` 11.5.0. The release changes only
  qyl-api-schema's toolchain: the contract revision stays
  `sha256:3605ae27d2edf632`, so a Collector built from `Qyl.Api.Contracts`
  11.4.0 or 11.5.0 passes the startup handshake.

### 7.2.2

- MCP Apps viewers check both the SDK client name and the `User-Agent` when
  choosing their domain. A recognized client name wins over a conflicting
  User-Agent, and an unknown name no longer hides a recognized one; 7.2.0 and
  7.2.1 read the User-Agent only when no client name was sent. When neither is
  recognized, `ui.domain` and `openai/widgetDomain` are both omitted and the
  host uses its default sandbox.
- The viewers are now `ui://qyl-explorer/mcp-app-v6.html` and
  `ui://qyl-explorer/mcp-dashboard-v4.html`, so hosts drop metadata cached for
  the previous versions.

### 7.2.1

- Contract package `@ancplua/qyl-api-schema` 11.4.0 (TypeSpec 1.17). The
  contract revision is now `sha256:3605ae27d2edf632`. The server refuses to
  start against a Collector that advertises another revision, so run it with a
  Collector built from `Qyl.Api.Contracts` 11.4.0.
- OpenTelemetry 0.223.0 / 2.12.0 and the remaining dependencies at their latest
  releases.

### 7.2.0

- Removed deprecated MCP logging capability and per-call log notifications;
  retained requested progress, cancellation and native operation telemetry.
  [Dated verification, 2026-10-08](https://github.com/ANcpLua/qyl.mcp/blob/main/docs/evidence/2026-10-08-followup-01.md).

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

### 7.1.1

- SDK v2.3.1 serving defaults accept modern and 2025-era tool clients over HTTP
  and stdio. The workbench negotiates automatically. The strict policy described
  under 6.0.0 below has been removed.
- Events recheck account status, explicit client access, user permissions and
  consent through Auth0. Unsubscribe aborts outstanding deliveries; restart
  cleanup removes expired subscriptions and obsolete signing keys.
- Public viewers declare their deployment origin and keep the requested trace
  limit on refresh. Release verification exercises a fresh npm consumer with
  modern and 2025-era discovery and a real demo-tool call.

### 7.1.0

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

### 7.0.0

- Contract `@ancplua/qyl-api-schema` 11.1.0 -> 11.2.0. Demo series ids are
  computed with the contract's `attributeIdentity`, the same string the
  collector computes in C#, so a demo series id and a live one are comparable;
  every demo series id changes, which is why this is a major. A contract major
  moves this package's major from now on.

### 6.2.1

- Contract `@ancplua/qyl-api-schema` 11.0.1 -> 11.1.0. Every tool shape is
  `contractSchema("<definition>")`, typed by the contract at compile time, so
  the textual shape gate is gone; trace, span and session ids are parsed
  through the contract's generated parsers instead of cast; the nanosecond
  helpers come from the contract's `/runtime`.

### 6.2.0

- Contract `@ancplua/qyl-api-schema` 10.0.1 -> 11.0.1, revision
  `sha256:cd69d9c37a41916c` -> `sha256:5c1aa27ccdf48067`. Attribute values are
  decoded through the contract's own `/runtime` subpath instead of a local
  copy of the dashboard's decoder; bytes and key-value lists render as their
  values, never as `[object Object]`. A log body is an `AttributeValue`: a plain
  string body is a bare string, and the three body shapes the collector never
  produced are gone from the contract and from this server.

### 6.1.2

- The landing page at `mcp.qyl.at` states what 6.1.0 added: a request-scope
  section for cancellation, progress and the per-call log line, the full
  eleven-tool surface, and a hero fact for it. Surfaces take the ink of the
  original qyl site (`#050706`) and its family; the cyan accent is unchanged.
- The page no longer embeds the whole `package.json`: a default JSON import
  inlined the dependency and export tables into every visitor's download; a
  named import of `version` ships the one field the footer shows.

### 6.1.1

- The bundled viewers no longer ask for progress they never read: the MCP
  Apps client passed a no-op `onprogress` on every `tools/call`, which put a
  `progressToken` on each request and, since 6.1.0, had the server answer
  with notifications nobody consumed. A viewer that wants progress passes its
  own callback.
- `verify:frame` runs as a step of `bun run test`: every tool in the manifest
  must be registered inside `runTool` under its own name, so a tool cannot
  ship without cancellation, progress and its log line.

### 6.1.0

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

### 6.0.0

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

### 5.2.0

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

### 5.1.0

- Contract `@ancplua/qyl-api-schema` 10.0.0 -> 10.0.1, revision
  `sha256:264a9e4f1d70289a` -> `sha256:cd69d9c37a41916c`. The contract's
  operations and shapes are unchanged; the revision moved because the
  TypeSpec toolchain that emits the canonical OpenAPI projection did. The
  startup handshake refuses a collector on the old revision, so this server
  pairs with `qyl` 5.1.0 and later; `server/tool-manifest.snapshot.json`
  differs only in its `contract_revision`.
- The workspace root package no longer pins its own members, and the matrix
  no longer compares itself to a tool inventory that no longer exists.

### 5.0.0

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

### 4.0.1

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
