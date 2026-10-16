# qyl-mcp-server

MCP tools over a live [qyl](https://github.com/ANcpLua/qyl) collector — traces,
logs, metrics, sessions and CI runs, plus the Trace Explorer and MCP Dashboard
viewers for hosts that render MCP Apps.

```bash
bunx qyl-mcp-server --stdio    # stdio MCP server
bunx qyl-mcp-server      # Streamable HTTP on 127.0.0.1:3001
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
`qyl:read`. The initial 401 requests `qyl:read qyl:write qyl:delete` so new
connections can authorize the complete tool set. A write tool called without `qyl:write` or `qyl:delete` gets a
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
rejected. Create calls reuse the stored result for 24 hours. Without an explicit
`idempotency_key`, the server derives one from the project, operation and request
body, so identical retries are safe. Supply a different key to deliberately create
another identical record. No tool edits or deletes recorded telemetry.

`qyl:read` covers reads, `qyl:write` adds creation and updates, and `qyl:delete` permits
`delete`. A missing scope returns the supported OAuth step-up challenge. Failed calls
carry a stable code, retryability, the problem type and field-level validation details
when available. Secrets are redacted before model text or structured content is returned.

Every tool runs inside its request scope, forwarding cancellation to the collector.
Requested progress reports completion; no logging notifications are sent to clients.
Analysis reads require a live collector. Synthetic data is used only by test fixtures, and is never substituted when a collector fails.

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
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans, metrics, and operation logs. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Workbench content capture; native incoming tool-call telemetry never supplies request or response bodies. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native execution-evidence path. |
| `MCP_EVENTS_STORE` | Optional internal Events subscription file; leave unset for the shared ChatGPT/Claude deployment. |
| `MCP_EVENTS_AUTH0_CLIENT_ID` / `MCP_EVENTS_AUTH0_CLIENT_SECRET` | Dedicated Management API application with `read:users`, `read:clients`, `read:client_grants`, `read:grants`; resolves CIMD identities and keeps access checks current without storing subscriber tokens. |
| `MCP_EVENTS_POLL_MS` | Collector polling interval, at least 5000 ms; default 30000 ms. |
| `PORT` | HTTP listener port; default `3001`. |

Secrets are redacted before results reach the model, structured content, or
durable evidence.

`npx` and `pnpm dlx` also work when Bun 1.4 or newer is installed.
Both the HTTP and stdio executables use Bun 1.4 or newer.

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
and request metadata cannot override it. Telemetry tools, viewer refreshes and
tool-call OTLP exports use that account's project credential. Export pipelines
are bounded by the configured projects; an unassigned caller gets no fallback
export destination. Project
keys are redacted from text and structured results, including keys nested in
this JSON configuration. Keep the map in host secrets and out of the plugin ZIP.

`bun run smoke:projects` from the repository root checks every tool, the
writes included, viewer query paths and both protocol eras against a
real local Collector with two temporary projects. It reuses the completed Release
build; set `QYL_COLLECTOR_DLL` for another build. The script uses local test identities
and an in-process signed webhook receiver.

### Seeded analysis verification

`bun run --cwd server test:answer-key` starts a fresh temporary collector database,
seeds real OTLP, and runs the 32 analysis checks through MCP and generated validators.
It reuses the collector's completed build; set `QYL_COLLECTOR_DLL` when its location
or configuration differs. `mise run check` includes this verification and the quiet
SSE check. No pre-existing temporary file or manually seeded database is required.

`QYL_BIN=/path/to/installed/qyl node live-tools-smoke.mjs` additionally checks
all 32 tools against an isolated collector started by the published CLI.

## Release notes

In the repository's [CHANGELOG.md](https://github.com/ANcpLua/qyl.mcp/blob/main/CHANGELOG.md).
