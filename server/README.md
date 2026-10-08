# qyl-mcp-server

MCP tools over a live [qyl](https://github.com/ANcpLua/qyl) collector — traces,
logs, sessions, CI runs, and a graph view of agent runs you can watch while they
execute.

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
Events require `2026-07-28`.
The HTTP server serves a product page at `/`; `/mcp` is the only protocol
endpoint.

## Hosted authentication

The hosted Auth0 profile requires CIMD and DCR discovery, Authorization Code
with PKCE S256, both `private_key_jwt` and `none` for ChatGPT CIMD compatibility,
`none` for Claude CIMD, and issuer identification. Auth0 owns registration and token
issuance; this server validates resource-bound RFC 9068 access tokens on every
MCP request. It rejects malformed/query credentials, invalid tokens and
insufficient scopes with distinct 400/401/403 responses.

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

Every tool runs inside its request scope. Cancellation: a
`notifications/cancelled` for the request, or a closed connection, aborts the
in-flight collector fetch instead of waiting out its timeout. Progress: a
request that carries a `progressToken` gets `notifications/progress` per
completed step, one per collector round trip plus a final "Result ready"
(`ci_log` with a `run_id` reports the flatten into legs as a step of its own).
Logging: the server declares no `logging` capability and sends no
`notifications/message`, including when a client supplies a log level.
Operational error diagnostics go to stderr; native tool timing/status telemetry
uses OpenTelemetry. Requested progress and cancellation remain available.
[Source and test commands/output, 2026-10-08](https://github.com/ANcpLua/qyl.mcp/blob/main/docs/evidence/2026-10-08-followup-01.md).


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
| `QYL_API_KEY` | Collector read and OTLP credential. Outgoing only. |
| `QYL_PROJECT` | Server-owned collector project scope; defaults to `default`. Never accepted as tool input. |
| `MCP_COLLECTOR_PROJECTS` | Optional secret JSON mapping validated Auth0 subjects to project-bound Collector keys; see account isolation below. |
| `QYL_OTLP_ENDPOINT` | Optional OTLP base for self-telemetry. |
| `QYL_DEMO=1` | Explicit, visibly labelled demo telemetry. A collector failure never silently substitutes demo data. |
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans, metrics, and operation logs. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Workbench content capture; native incoming tool-call telemetry never supplies request or response bodies. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native execution-evidence path. |
| `MCP_EVENTS_STORE` | Persistent Events subscription file; requires Auth0 and the access-check credentials below. |
| `MCP_EVENTS_AUTH0_CLIENT_ID` / `MCP_EVENTS_AUTH0_CLIENT_SECRET` | Dedicated Management API application with `read:users`, `read:clients`, `read:client_grants`, `read:grants`; resolves CIMD identities and keeps access checks current without storing subscriber tokens. |
| `MCP_EVENTS_POLL_MS` | Collector polling interval, at least 5000 ms; default 30000 ms. |
| `PORT` | HTTP listener port; default `3001`. |

Secrets are redacted before results reach the model, structured content, or
durable evidence.

`--stdio` runs under Node.js 24 or Bun 1.4, which is what `npx` gives you.
The HTTP entry is a web-standard fetch handler served by its default export,
so serving it requires Bun.

### Account isolation for hosted Auth0

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
and Events queries use that account's project credential. Removing the account
assignment revokes its Events subscription on the next access check. Project
keys are redacted from text and structured results, including keys nested in
this JSON configuration. Keep the map in host secrets and out of the plugin ZIP.

`bun run smoke:projects` from the repository root checks all eleven tools,
viewer query paths, both protocol eras and Events against a real local
Collector with two temporary projects. Set `QYL_COLLECTOR_PROJECT` to its
`.csproj` when using a different checkout. The script uses local test identities
and an in-process signed webhook receiver; the hosted reviewer OAuth login and
real ChatGPT demonstration are separate checks before upload.

## Release notes

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
