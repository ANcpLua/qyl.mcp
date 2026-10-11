# qyl.mcp

qyl provides MCP tools for investigating traces, logs, metrics and sessions in
a qyl Collector. It measures and correlates; the agent reasons and acts.

Each section below names the date of the evidence it cites: the source and
public observations inspected on **2026-10-08**, with commands and actual
outputs in the [source evidence](docs/evidence/2026-10-08-step7.md), and the
toolchain, contract and release records of **2026-10-11** in the
[release evidence](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md).
Local test results, CI results, public HTTP observations and pending owner
checks are distinct in the [evidence ledger](MCP-V2-INTEROP-TODO.md).

| Component | Source role | Evidence |
| --- | --- | --- |
| `server/` | Telemetry MCP server and bundled MCP App viewers | [Package and tool inventory](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory) |
| `workbench/` | Local client for inspecting and invoking other MCP servers | [Workbench source](docs/evidence/2026-10-08-step7.md#workbench) |
| `dashboard/` | Browser UI built alongside the Workbench | [Build scripts](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory) |

## Use the hosted server

Endpoint: `https://mcp.qyl.at/mcp`. On 2026-10-08, `curl` returned `401` with
`resource_metadata`; the metadata identified that resource, issuer
`https://qyl-eu.eu.auth0.com/` and scope `qyl:read`.
[Exact commands and responses](docs/evidence/2026-10-08-step4.md#endpoint).
These observations establish discovery, not a successful OAuth login. The
source's metadata now also lists `qyl:write` and `qyl:delete`, which only the
[write tools](#write-tools) need; they ask for them through a step-up challenge.

### Connect

Configure that endpoint in the intended client and authorize an account with
access to the intended Collector project. Client registration and user/project
authorization must both be configured by the operator.

The following are connection instructions, not completed connection tests.
Their CLI/help and official-documentation sources were checked on 2026-10-08
in the [client setup evidence](docs/evidence/2026-10-08-step7.md#client-setup-and-owner-review-correction).

| Client | Connection setting | Registration path |
| --- | --- | --- |
| ChatGPT web | In Plugins, choose **Add custom MCP server**, enter `https://mcp.qyl.at/mcp`, select OAuth and request `qyl:read` (add `qyl:write` and `qyl:delete` for the write tools); create and install the personal plugin. | Choose CIMD, DCR or a provisioned OAuth client as offered. For CIMD, use the metadata document and callback shown by the connection page; stable metadata is `https://chatgpt.com/oauth/client.json` where issuer-bound callbacks are supported. |
| claude.ai | In **Customize → Connectors**, add a custom connector for `https://mcp.qyl.at/mcp`, select sign-in and complete OAuth. Organization users first need their owner to add the connector under organization settings. | Select Claude's published identity (CIMD), automatic registration (DCR), or a provisioned client. Public CIMD: `https://claude.ai/oauth/mcp-oauth-client-metadata`. |
| Claude Code | Run `claude mcp add --transport http qyl https://mcp.qyl.at/mcp`, then open `/mcp` to authenticate. | Automatic CIMD/DCR discovery; if a provisioned client is required, use the CLI's `--client-id` and `--client-secret` prompt, with its actual callback registered. |
| Codex CLI | Add the TOML below to the intended Codex configuration, then run `codex mcp login qyl --scopes qyl:read` (or `--scopes "qyl:read qyl:write qyl:delete"` for the write tools). | Automatic CIMD/DCR selection; for a targeted registration check, the inspected CLI accepts `--oauth-client-registration cimd` or `dcr` on login. A configured client ID takes precedence. |
| MCP Inspector | Save the JSON below as `inspector-modern.json`; run `npx -y @modelcontextprotocol/inspector@2.9.0 --config inspector-modern.json`, complete OAuth with `qyl:read`, then invoke `tools/list`. | Use the provisioned client or registration flow offered by Inspector and the issuer. Record which path was used; registration alone does not grant resource access. |

Codex configuration:

```toml
[mcp_servers.qyl]
url = "https://mcp.qyl.at/mcp"
```

Inspector configuration (repeat with `"legacy"` for the legacy check):

```json
{"mcpServers":{"qyl":{"type":"streamable-http","url":"https://mcp.qyl.at/mcp","protocolEra":"modern"}}}
```

ChatGPT, Codex, claude.ai, Claude Code and Inspector connections remain
**owner checks**, with exact procedures in the
[ledger](MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending).
The production modern-era check uses Inspector **2.9.0**, OAuth,
`protocolEra: "modern"`, `tools/list`, and a captured
`MCP-Protocol-Version: 2026-07-28` request header. A legacy-only connection
or an initialize response is not that proof.

Locally, the pinned Inspector passed modern and legacy `tools/list` with all
11 tools and passed schema portability on 2026-10-08.
[Black-box evidence](docs/evidence/2026-10-08-step4.md#both-era).

## Run the server yourself

From a checkout, these commands build the server and start explicit demo stdio:

```sh
bun install --frozen-lockfile
bun run build
QYL_DEMO=1 node server/dist/main.js --stdio
```

For live data, omit `QYL_DEMO` and configure `QYL_COLLECTOR_URL` and, when
needed, `QYL_API_KEY`. For local HTTP, run `bun server/dist/main.js`; the source
defaults to loopback port 3001. `QYL_API_KEY` is an outgoing Collector
credential, not an incoming MCP login.
[Configuration and serving source, 2026-10-08](docs/evidence/2026-10-08-step7.md#configuration-and-serving).

The release workflow publishes `qyl-mcp-server` with provenance and smokes
clean `npx` consumers in both protocol eras before a release counts; on
2026-10-11 it published `7.2.0`, `7.2.1`, `7.2.2` and `7.2.3` that way. The
source declares `7.6.0` (Contract 12.0.0: RFC 9457 problems with a type URI and
a stable `code`, one page limit of 1 to 1000; on top of 7.5.0's write tools
behind `qyl:write` and `qyl:delete` and 7.4.0's paging, filters, structured
metric matchers and the `fetch_telemetry` union);
`npm view qyl-mcp-server dist-tags` names the published `latest`.
[Release and consumer evidence](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#releases).

### Tools and viewers

The [generated manifest](server/tool-manifest.snapshot.json) is the tool
contract. It has 18 tools: 13 read tools annotated `readOnlyHint: true` and the
five [write tools](#write-tools); `fetch_telemetry` is app-only through
`_meta.ui.visibility: ["app"]`. The [tool matrix](QYL-MCP-MATRIX.md) maps each
tool to the user's question and its limits, with dated manifest evidence.

Start with sessions and traces, drill into one trace and its error logs,
then discover metric instruments and series before querying. `get_trace`
returns the complete span tree by default. Use `errors_only` to select error
spans, `max_spans` to cap the result after filtering, and
`include_attributes=false` to omit attribute collections. Original trace totals
are retained; the summary states how many matching spans were returned.
`display_traces` supplies the waterfall and `search_logs` supplies filtered
detail. `ci_log` accepts telemetry from any CI following its emitter convention;
`service_prefix` selects services in both run lists and phase breakdowns and
defaults to `qyl-ci`. The [shared skill](submission/qyl/skills/qyl-investigate/SKILL.md)
contains the full workflow. [Description evidence](MCP-V2-INTEROP-TODO.md#step-3--agent-skill).

### Write tools

Five tools change something, and only objects users create in qyl inside the
caller's Collector project: annotations (plain-text notes of at most 2000
characters on a trace, span or session) and saved queries (named filters for
traces, logs or metrics). No tool deletes or edits traces, logs or metrics;
retention alone removes telemetry. The hints follow the
[2026-10-11 decision](docs/decisions/2026-10-11-qyl-dev-audit.md#write-tools):

| Tool | Changes | Annotations | Scope |
| --- | --- | --- | --- |
| `create_annotation` | adds a note | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | `qyl:write` |
| `update_annotation` | replaces a note's text | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` | `qyl:write` |
| `create_saved_query` | adds a named filter | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | `qyl:write` |
| `update_saved_query` | renames it or replaces its description or filter | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` | `qyl:write` |
| `delete` | removes one annotation or saved query (`kind` is `annotation` or `saved_query`) | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` | `qyl:delete` |

`openWorldHint` is `false` on all of them. `list_saved_queries` and
`run_saved_query` read saved queries and keep `qyl:read`; `get_trace` and
`list_sessions` return the annotations on what they read, so there is no
annotation listing tool. Updates and deletes send the object's `etag` as
`If-Match`: a stale etag is refused with `precondition_failed`, a duplicate
saved-query name with `conflict`. Alert rules are not deletable yet: they
arrive with Contract 11.7.0. On the hosted server a write call without its
scope gets a `403` `insufficient_scope` challenge naming the scopes to request,
in both protocol eras, before any Collector request. Demo mode keeps no such
objects and refuses these tools.

The two viewers declare versioned resource URIs, a configured hosted origin
and empty external connection/resource CSP allowlists. Local tests cover
restoring the original query when refresh input is empty.
[Viewer source](docs/evidence/2026-10-08-step7.md#viewers) and
[local test output](docs/evidence/2026-10-08-step4.md#test), both 2026-10-08;
the viewer versions moved to v6/v4 with release 7.2.2 on 2026-10-11.

### MCP Events

The source supports opt-in `trace.error` subscriptions on authenticated
Auth0 deployments configured with `MCP_EVENTS_STORE`. The optional
`service_name` filter narrows delivery. The implementation verifies callbacks,
signs deliveries, checks ongoing authorization, expires subscriptions and
cancels delivery on unsubscribe or confirmed revocation. Subscription state
is bounded and excludes OAuth tokens and copied telemetry.
[Events source](docs/evidence/2026-10-08-step7.md#events) and
[local isolation tests](docs/evidence/2026-10-08-step4.md#projects), 2026-10-08.

These are implementation/local-test results. Production subscription,
matching/non-matching delivery, persistence, renewal, unsubscribe and
revocation remain separate [owner checks](MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending).

## The workbench

```sh
bun run build
bun run start:workbench
```

The default URL is `http://127.0.0.1:18888`; `QYL_MCP_WORKBENCH_PORT` changes
the port. Workbench can connect to HTTP and stdio servers, negotiate the
protocol automatically, inspect schemas, invoke tools and retain execution
evidence. It uses a loopback browser session and checks host/origin access.
Tool annotations guide confirmation; they do not grant permission.
[Workbench source](docs/evidence/2026-10-08-step7.md#workbench) and
[local tests](docs/evidence/2026-10-08-step4.md#test), 2026-10-08.

Review an external stdio command before launching it: it executes locally.
Use environment-variable references for credentials instead of embedding
secrets in URLs or saved headers. Workbench state defaults to
`~/.qyl/mcp-workbench.json`, overridden by `QYL_MCP_STATE_PATH`. Its execution
records are distinct from the server's minimized incoming-call records.

### Incoming-call records and telemetry

The server's strict native record schema contains its own ID, tool name,
status, timestamps, duration and error type. It contains no `arguments`,
`_meta`, result body or error-message field. It defaults to retaining 1,000
records at `~/.qyl/mcp-native-executions.json`; `QYL_MCP_NATIVE_STATE_PATH`
overrides the path. Hosted HTTP with `MCP_PUBLIC_URL` disables that local store.
Known version-1/2 data is projected into the minimized schema; unreadable
archives require operator review. [Native-record source](docs/evidence/2026-10-08-step7.md#native-records)
and [regression results](MCP-V2-INTEROP-TODO.md#step-1--rules-and-native-call-records), 2026-10-08.

OTLP exports include operation timing/status and trace correlation. Native
incoming calls do not supply argument/result bodies to that telemetry.
Workbench has a separate optional content-capture setting. Local OTLP tests
check redaction and matching trace/span IDs; they do not establish a production
retention policy. [OTLP evidence, 2026-10-08](docs/evidence/2026-10-08-step4.md#fresh-main-collector-otlp-rerun).

## Configuration

Source evidence for these settings was captured on 2026-10-08 in
[configuration and serving](docs/evidence/2026-10-08-step7.md#configuration-and-serving)
and [Workbench](docs/evidence/2026-10-08-step7.md#workbench).

| Variable | Purpose |
| --- | --- |
| `QYL_COLLECTOR_URL` | Collector base URL; local default `http://127.0.0.1:5100`. |
| `QYL_API_KEY` | Outgoing Collector credential; the write tools need a key with the Collector's `write` and `delete` roles. |
| `MCP_ALLOWED_HOSTS` | Comma-separated additional request hostnames, added to the public URL hostname for hosted HTTP. |
| `MCP_ALLOWED_ORIGIN_HOSTS` | Comma-separated additional browser-origin hostnames, added to the public URL hostname for hosted HTTP. |
| `QYL_PROJECT` | Server-configured Collector project scope; its default is stated in the [server README](server/README.md#configuration). |
| `MCP_COLLECTOR_PROJECTS` | Operator-controlled verified-subject-to-project mapping. |
| `QYL_MCP_TELEMETRY=0` | Disable MCP self-telemetry. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Optional Workbench capture; does not add incoming-call payloads to native records. |
| `QYL_OTLP_ENDPOINT` | Optional telemetry base; signal-specific OTel endpoints take precedence. |
| `QYL_MCP_STATE_PATH` | Workbench state location. |
| `QYL_MCP_NATIVE_STATE_PATH` | Native incoming-call record location. |
| `QYL_MCP_WORKBENCH_PORT` | Workbench port, default 18888. |
| `QYL_DEMO=1` | Explicit demo mode; no silent live-to-demo fallback. |

## Deploying your own

These are operator setup instructions, not a record that deployment or provider
configuration occurred. Source evidence is in
[deployment/authentication](docs/evidence/2026-10-08-step7.md#deployment-and-authentication).
The [threat model](docs/threat-model.md) describes the authorization boundary.

`.railway/railway.ts` declares build `bun run --cwd server build`, start
`bun server/dist/main.js`, healthcheck `/healthz` and an Events volume at
`/data`. This proves configuration in source, not that Railway applied it.
The [dated production observation](docs/evidence/2026-10-08-followup-06.md)
records Railway's running commit and main-branch trigger on 2026-10-08.

For a hosted bind, configure `MCP_PUBLIC_URL`, `MCP_BIND_HOST`, allowed hosts
and origins, and the intended Collector URL/credential. The public URL sets
the resource audience and canonical `/mcp` connector URL. For Claude, qyl sets
`ui.domain` to the first 32 hex characters of SHA-256 over that exact connector
URL plus `.claudemcpcontent.com`. Claude requires this format when the optional
field is supplied. ChatGPT receives qyl's configured HTTPS origin in `ui.domain`
and its `openai/widgetDomain` alias. OpenAI documents an origin-valued field
and requires a dedicated, unique origin for UI plugin submission; choosing
the MCP server's origin is qyl's configuration choice.

The SDK's per-request client name and `User-Agent` are both checked. A recognized
Claude or ChatGPT name wins conflicting hints. A missing or unrecognized name
can use a recognized UA, including `Claude-User`, `openai-mcp/1.0.0` or
`ChatGPT-User`. If neither hint is recognized, qyl omits both domain fields.
A host that supports MCP Apps can then use its default sandbox; omission alone
does not disable the viewer or reject the MCP client. Local viewers also omit
the domain. [Verified requirements and detection policy](docs/evidence/2026-10-08-point-10-ui-domain.md#clarification-and-current-behavior-2026-10-11)
separate documented formats from client hints. The hints and their precedence
are qyl's compatibility policy; actual client identifiers and authenticated
rendering on this deployment still need observation.

Keep Collector credentials on the server. With project mapping enabled, only
the verified subject selects the project; client hints, tool arguments and
metadata do not select credentials.

The default Auth0 mode accepts only the qyl production Auth0 issuer
`https://qyl-eu.eu.auth0.com/`; arbitrary issuer substitution is not an
available configuration. Non-loopback serving requires a public URL and
hosted authorization. For Events, configure persistent `MCP_EVENTS_STORE`
and the dedicated Auth0 authorization-check credentials described in
[Events source](docs/evidence/2026-10-08-step7.md#events).

### Authentication

The hosted profile is **CIMD or DCR + OAuth 2.1 Authorization Code with
PKCE S256 + issuer identification**. Public metadata fetched on 2026-10-08
shows ChatGPT advertising `none` and `private_key_jwt`, with the latter selected;
Claude's CIMD is a public client using `none`.
[Commands and metadata](docs/evidence/2026-10-08-step7.md#public-oauth-metadata).
This does not prove a provisioned client or successful token exchange.

Operator setup:

1. Register the resource audience `<public-url>/mcp`, RS256 access tokens and
   the permissions `qyl:read`, `qyl:write` and `qyl:delete`. Configure the
   provider capabilities required by startup.
2. Provision the intended client using its current CIMD document or DCR,
   preserving its actual callback and authentication method.
3. If DCR is needed, Enable **Dynamic Client Registration** and set
   `dynamic_client_registration_security_mode` to `strict`. The DCR endpoint
   is open to registration when enabled; keep third-party API default permissions empty.
4. `qyl:read` exposes traces, logs, metrics, sessions, and CI evidence;
   grant it only to intended clients and users. Verify a real authenticated
   read and project isolation after deployment; discovery alone is insufficient.
5. `qyl:write` lets a client create and update annotations and saved queries,
   and `qyl:delete` lets it delete them, in the caller's project only; neither
   reaches telemetry. Grant them only to users who should change those
   objects; a token without them keeps the read tools. The Collector key the
   server uses needs the Collector's `write` and `delete` roles as well.

These setup requirements are also enforced as documentation requirements by
`server/verify-deployment-guidance.mjs`; provider configuration is an owner action.
The verifier source/output is recorded in the evidence file. The provider
behavior and setting are also documented in the dated
[Auth0 reference check](docs/evidence/2026-10-08-step7.md#auth0-reference-check).

The source validates signatures, issuer, resource audience, expiry and scopes;
malformed credentials, invalid tokens and insufficient scopes have separate
error paths. A write tool called without `qyl:write` or `qyl:delete` is answered
`403` with `error="insufficient_scope"` and the scopes to request, so the client
can re-authorize for them. Both `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource` describe the same `/mcp` resource.
Auth0 is the OIDC issuer; qyl.mcp does not expose its own OIDC issuer discovery.
For workspace domain claiming, the owner must verify any `openid`/`email`
requirements and the provider's verified-email response separately; these do
not replace `qyl:read`. [Source and metadata evidence](docs/evidence/2026-10-08-step7.md#deployment-and-authentication).

### Optional authorization extensions

The source selects extensions explicitly through:

```sh
MCP_AUTH_EXTENSIONS=enterprise-managed-authorization@1.0.0,oauth-client-credentials@1.0.0
```

| Integration | Source-declared stability | Additional provider requirement |
| --- | --- | --- |
| `enterprise-managed-authorization@1.0.0` | Stable | JWT bearer grant and ID-JAG grant profile. |
| `oauth-client-credentials@1.0.0` | Draft; explicitly opt in | Client credentials and `private_key_jwt`. |

These are the installed integration definitions, not proof of a provider grant.
Unknown versions and conflicting provider requirements are rejected. They do
not issue tokens or replace the core verifier. [Source, 2026-10-08](docs/evidence/2026-10-08-step7.md#deployment-and-authentication).

### Cloudflare Access Managed OAuth

The alternative source configuration uses `MCP_AUTH_PROVIDER=cloudflare-access`,
`MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD`, plus `MCP_PUBLIC_URL`.
The origin checks `Cf-Access-Jwt-Assertion`: issuer, application audience, expiry and subject,
with RS256 signature validation. Configure and verify the Access application
before selecting this mode. It does not establish that the public endpoint
uses Access, and Auth0-backed Events cannot be enabled in this mode. Access
grants the read tools only: its assertion carries no qyl scopes, so the write
tools answer `insufficient_scope`.
[Source and local tests, 2026-10-08](docs/evidence/2026-10-08-step7.md#deployment-and-authentication).

### Directory preparation

Use [submission/README.md](submission/README.md) for the three separate records,
local package build and remaining owner fields. The owner handles identity,
public pages, reviewer accounts, recording, attestations, uploads, submission
and publication. The owner copies the portal's domain token into the hosted
environment variable `OPENAI_APPS_CHALLENGE`. Until a nonblank token is set,
`GET /.well-known/openai-apps-challenge` returns 404; with a token, it returns
the exact trimmed value as plain text. On 2026-10-08, the production GET
returned `404 Not Found`. [Dated curl output, source and test](docs/evidence/2026-10-08-followup-07.md)
support these statements. Setting the variable and completing the portal's
verification are pending owner actions.

## Verification and limits

```sh
bun run verify:sdk
bun run build
bun run test
bun run lint
bun run smoke
bun run smoke:otlp
bun run smoke:projects
```

The [2026-10-08 transcript](docs/evidence/2026-10-08-step4.md) records actual
results, including the initial OTLP failure against the adjacent Collector
feature branch and the successful rerun against a fresh Collector `main`.
Use `QYL_COLLECTOR_PROJECT` to select the intended fixture. Static `check_v2`
historically returned 31 error-severity findings; the [per-rule assessments](MCP-V2-INTEROP-TODO.md#static-findings--assessed-2026-10-08)
explain the installed paths without suppressing diagnostics. Both-era runtime
evidence is recorded separately. The revised point-3 run on 2026-10-08 reports
zero errors with an unchanged checker after explicit `zod/v4` imports and a
justified Events JSON-Schema marker; see [command and output](docs/evidence/2026-10-08-followup-03.md#static-checker-before-and-after).

Remote connections, production Events, deployed commit and a fresh npm
consumer remain owner observations. Local tests or CI cannot substitute for
them. Review cases and the demo are drafts until run in an owner client.

## Contracts

As of 2026-10-11, the source pins `@ancplua/qyl-api-schema` 11.5.0, official split MCP
SDK packages 2.3.1 and Zod 4.6.5. SDK major version and wire revision are
independent. Server HTTP/stdio use SDK factories and negotiation defaults;
Workbench uses automatic negotiation. [Contract 11.4.0 and 11.5.0 evidence](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md) and
[package/serving evidence, 2026-10-08](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory).
