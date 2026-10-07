# qyl.mcp

MCP tools over a live [qyl](https://qyl.at) collector — traces, logs, metrics,
sessions, and a graph view of agent runs you can watch while they execute.

The repository ships three things:

| | What it is | How you get it |
| --- | --- | --- |
| **server** | An MCP server exposing qyl telemetry as tools | Hosted at `mcp.qyl.at`, or npm [`qyl-mcp-server`](https://www.npmjs.com/package/qyl-mcp-server) |
| **workbench** | A local MCP client for inspecting *other* people's servers | Run from a checkout on `127.0.0.1:18888` |
| **dashboard** | The HTTP UI the server serves | Bundled into the server |

The server is a *closed world* — a fixed, generated tool surface projecting the
collector's data. The workbench is an *open world* — it talks to servers it did
not write and validates their schemas at runtime. They are separate deployables
because a browser cannot be an MCP stdio client, which is the same split the MCP
Inspector makes.

Bun 1.4 is the runtime and the only package manager: `bun install`, `bun run
build`, `bun run test`, one `bun.lock`. The HTTP entry is a web-standard fetch
handler served by its default export, so serving it needs Bun; the published
`--stdio` binary is the one thing that also runs under plain Node 24, because
that is how `npx` clients launch it. Architecture lives in the
[qyl README](https://github.com/ANcpLua/qyl#readme), which states the shape and
names the gates that enforce it; this file does not restate it.

---

## Use the hosted server

Nothing to install. Point an MCP client at:

```
https://mcp.qyl.at/mcp
```

It is an OAuth 2.1 resource server, so an unauthenticated request answers `401`
with an [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)
protected-resource document. The document identifies the Auth0 issuer and
`qyl:read` scope. Authentication also requires the client to be registered and
granted access in Auth0; discovery alone does not establish a login.

`https://mcp.qyl.at/` is a product page and `/healthz` is the platform
healthcheck. Neither is a protocol endpoint — `/mcp` is the only one.

### Connect

Use `https://mcp.qyl.at/mcp` in every client. These are the settings to use
after the Auth0 client and `qyl:read` grant are provisioned. The SDK v2 runtime
is deployed. Personal OAuth and client-specific tool-call checks are tracked in
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md).

| Client | Connection setting | OAuth client path |
| --- | --- | --- |
| ChatGPT web | Enable Developer mode in Settings → Security and login; in ChatGPT Plugins add an MCP connection to `https://mcp.qyl.at/mcp`, select OAuth, and include `qyl:read` in Base scopes. | CIMD at `https://chatgpt.com/oauth/client.json`, with redirect `https://chatgpt.com/connector_platform_oauth_redirect`, when the connection page shows stable callbacks. The document supports `none` and `private_key_jwt` (currently preferred). DCR is also supported when explicitly selected in the connection form. |
| claude.ai | Customize → Connectors → Add custom connector; enter `https://mcp.qyl.at/mcp` and leave optional client ID and secret empty. | CIMD at `https://claude.ai/oauth/mcp-oauth-client-metadata`, a public client (`none`) with redirect `https://claude.ai/api/mcp/auth_callback`; DCR is the fallback. |
| Claude Code | `claude mcp add --transport http qyl https://mcp.qyl.at/mcp`; then open `/mcp` in Claude Code to authorize. | CIMD at `https://claude.ai/oauth/claude-code-client-metadata`, a public client (`none`) with port-independent `http://localhost/callback` and `http://127.0.0.1/callback` redirects; DCR is the fallback. |
| Codex CLI | Configure `[mcp_servers.qyl]` with `url = "https://mcp.qyl.at/mcp"` and `scopes = ["qyl:read"]`; then `codex mcp login qyl --enable mcp_2026_07_28 --scopes qyl:read`. Start Codex with `codex --enable mcp_2026_07_28` for the modern path. | CIMD or DCR as selected by the client and Auth0; `codex mcp add` supports `--oauth-client-registration cimd` or `dcr` for a targeted registration test. For CLI 0.158.0-alpha.2.1, leave `oauth_resource` unset: discovery supplies it, and the explicit override produced duplicate resource parameters. Ordinary tools also support the CLI's 2025-era protocol. |
| MCP Inspector | In Inspector 2.8.0, add an HTTP server at `https://mcp.qyl.at/mcp`, set protocol era to **modern**, configure `qyl:read` and the provisioned OAuth client, then connect. OAuth opens automatically when required; the web callback is `http://127.0.0.1:6274/oauth/callback` on the default port. For CLI checks use `npx @modelcontextprotocol/inspector@2.8.0 --cli https://mcp.qyl.at/mcp --transport http --protocol-era modern --method tools/list`. | The production test reused an existing authorized DCR evaluation client. Fresh registrations need an explicit Auth0 `qyl:read` grant; registration alone grants no access. |

Local `QYL_DEMO=1` v2 checks on 30 September 2026: Claude Code 2.1.285,
Codex CLI 0.158.0-alpha.2.1 with `--enable mcp_2026_07_28`, and MCP Inspector
2.8.0 each called `list_metrics` and received 3 instruments with
`has_more: false`. Inspector listed all 11 tools, each with `qyl:read` in
`_meta.securitySchemes` and `readOnlyHint: true`. These local calls did not use
OAuth.

Production verification on 7 October 2026 used the existing Auth0 machine test
application: both `2026-07-28` and `2025-11-25` listed all 11 tools and
successfully called `list_metrics` and `list_traces`. Modern `events/list`
returned `trace.error`. The collector's required project key is configured in
Railway; the prior upstream 401 is resolved.

Separate real authorization-code tests on the same day passed in ChatGPT web,
claude.ai, Codex CLI 0.158.0-alpha.2.1 and MCP Inspector 2.8.0: each completed
OAuth and a successful `list_metrics({})` call with zero live metrics. ChatGPT and claude.ai used their
published CIMD identities; Codex used a fresh strict DCR registration and the
modern protocol. Inspector used the existing DCR evaluation client, confirmed
MCP `2026-07-28` and listed all 11 tools. Claude Code completed qyl OAuth and tool
discovery, but its own Claude login expired before the model could call a tool. That read call
and signed ChatGPT Events delivery remain open in the checklist.

The TypeScript SDK v2 serves MCP revision `2026-07-28` and its supported
2025-era protocols through one tool factory. HTTP uses the SDK's stateless
compatibility default; stdio selects the era on connection. Events require
`2026-07-28`. No SDK v1 dependency is used.

## Run the server yourself

```bash
npx qyl-mcp-server --stdio
```

Without `--stdio` it serves Streamable HTTP on
`http://127.0.0.1:3001/mcp`; set `PORT` to change it. The local default binds to
loopback only and accepts local or absent browser origins.

Point it at a collector:

```bash
export QYL_COLLECTOR_URL=http://127.0.0.1:5100
export QYL_API_KEY='your-collector-key'   # omit for an unsecured local collector
npx qyl-mcp-server --stdio
```

`QYL_API_KEY` is an *outgoing* collector credential. It does not authenticate
incoming MCP clients — the local server has no inbound auth, which is why it
binds to loopback.

### Tools

The authoritative surface is
[`server/tool-manifest.snapshot.json`](server/tool-manifest.snapshot.json),
generated from the contract and checked in. Tools marked
`meta.ui.visibility: ["app"]` are called by the bundled MCP Apps, not by a model.

Traces, logs, and sessions have readers and an explorer; CI runs have `ci_log`;
metrics have `list_metrics`, `get_metric_series`, and `query_metric`.

Telemetry: `list_traces`, `get_trace`, `list_sessions`, `search_logs`, `ci_log`,
`list_metrics`, `get_metric_series`, `query_metric`, `display_traces`,
`display_mcp_dashboard`. Every one is read-only.

In ChatGPT the two apps are also [plugin extension](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
entry points: **Trace Explorer** (`display_traces`) opens from the sidebar and
as a thread tab, and **MCP Dashboard** (`display_mcp_dashboard`) from the
sidebar. Both open with `{}` (recent traces, the last 24 hours) and render in
`inline` or `fullscreen`. Other clients ignore the `openai/ui` metadata.

### MCP Events

A hosted server with `MCP_EVENTS_STORE` set advertises `events` in
`server/discover` and answers `events/list`, `events/subscribe` and
`events/unsubscribe` behind the same OAuth gate as the tools, following
[ChatGPT's MCP Events](https://developers.openai.com/plugins/build/mcp-events)
and the draft
[design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md).

- One event, `trace.error`: a trace with at least one error span reached the
  collector. The optional `service_name` argument narrows it to one service. The
  payload carries `trace_id`, `root_span`, `services`, `span_count`,
  `duration_ms` and `start_time`, so the model can follow up with `get_trace`
  or `display_traces`.
- Webhook delivery only. The callback must be `https` to a public address; it
  is resolved and checked on every connection, and redirects are not followed.
  Before storing a subscription the server sends a signed, single-use challenge
  and requires it echoed; a failure is `-32015` with a `data.reason`.
- Each event is one POST signed with
  [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)
  (`webhook-id` = `eventId` = `evt_<trace_id>`, plus `X-MCP-Subscription-Id`),
  retried with backoff on network errors, `429` and `5xx`; `410` ends the
  subscription.
- Subscriptions are keyed by caller, callback URL, event and arguments, last one
  hour by default and one day at most, and survive restarts in the store file.
  A caller holds at most 20 live subscriptions; a refresh always passes.
  Delivery starts from the first collector poll after subscribing (every 30 s,
  `MCP_EVENTS_POLL_MS` to change it) and carries `cursor: null`: there is no
  replay, so traces that arrive while the server is down are not delivered.
- Configure `MCP_EVENTS_AUTH0_CLIENT_ID` and `MCP_EVENTS_AUTH0_CLIENT_SECRET`
  through Railway's secret variables for a dedicated Auth0 machine application
  with Management API `read:users`, `read:clients`, `read:client_grants` and
  `read:grants`. CIMD URLs are resolved to Auth0 application IDs before checking
  grants; only the two identity fields are requested from the clients API.
  Events check the current account status, explicit application grant,
  `qyl:read` user permission and consent. Enable RBAC for this API and assign
  that permission to the intended users. The check caches results for at most
  five seconds; it runs during polling and before each delivery attempt.
  A revoked grant removes the subscription. An Auth0 outage suspends delivery.
  Subscriber access/refresh tokens are never stored.
- Unsubscribe cancels outstanding callback requests and retries. Expired
  subscription records and old signing keys are removed on startup and polling.
  The Events checker supports the Auth0 provider; Cloudflare Access deployments
  can serve ordinary tools with Events disabled.

## The workbench

A local client for connecting to MCP servers you did not write, inspecting their
negotiated surface, invoking tools safely, and keeping the evidence.

```bash
bun install --frozen-lockfile
bun run build
bun run start:workbench
```

Open <http://127.0.0.1:18888>. Set `QYL_MCP_WORKBENCH_PORT` for another port.

The dashboard bootstraps an opaque `HttpOnly`, `SameSite=Strict` loopback
session. Tokens are hashed in memory, never returned in API payloads, and do not
survive a restart. Host and browser-origin checks protect the loopback API from
DNS rebinding and cross-origin requests.

**Connecting a server.** Choose *Add server*. Streamable HTTP takes a
credential-free endpoint plus header references like
`Authorization=MCP_TOKEN|bearer`. stdio takes a command, one argument per line,
an optional working directory, and environment mappings like
`SERVER_TOKEN=MCP_SERVER_TOKEN`. Only variable *names* are sent by the browser or
persisted; values resolve in the runner at connection time and register with the
shared redactor. Endpoints cannot embed credentials, query values, or fragments,
and persistent `Cookie` headers are rejected.

Starting a stdio server launches code with your permissions, so review the exact
executable, arguments, working directory, and environment references first.

**Protocol.** The workbench uses SDK v2 automatic negotiation with external
servers. Its built-in servers accept modern and 2025-era tool clients through
the SDK serving defaults. Events require `2026-07-28`.

**Safety.** Tool annotations are hints, not permissions. Only a tool explicitly
marked read-only, non-destructive, and closed-world runs without confirmation.
Missing, contradictory, mutating, destructive, or open-world hints require you to
approve the exact call. The runner never synthesizes a confirmation. Arguments,
results, protocol payloads, persisted evidence, diagnostics, and telemetry all
pass through credential and URI redaction.

**What persists.** State defaults to `~/.qyl/mcp-workbench.json`
(`QYL_MCP_STATE_PATH` overrides). Workspaces, server definitions, executions,
protocol evidence, tests, suites, evaluation runs, and exports are written by
atomic replacement with mode `0600`; a directory the app creates gets `0700`,
while an existing parent you supply is left alone. Work interrupted by a restart
is restored as explicit failure evidence, not silently dropped.

The invocation composer keeps a generated form and a raw JSON view in sync,
validates input in a deadline-bounded worker, applies an execution timeout, and
sends an idempotency key. JSON Schema and pattern assertions run on that same
isolated path — the browser never compiles a server-supplied regular expression.

Each execution retains its request, result or typed error, lifecycle, duration,
attempts, cancellation state, redacted JSON-RPC timeline, and trace correlation.
Live protocol and execution streams use resumable event identifiers, and
cancelling aborts the in-flight SDK request.
The tests workspace persists real invocations with status, exact, partial, JSON
Schema, pattern, and latency assertions; suites run with bounded concurrency and
export as contract-validated JSON or Markdown with SHA-256 artifact evidence.

The server also records inbound `tools/call` requests natively — including over
plain stdio, with no workbench involved — to
`~/.qyl/mcp-native-executions.json` (`QYL_MCP_NATIVE_STATE_PATH` overrides),
newest 1,000 retained. Results under two million serialized characters are kept
in full after redaction; larger ones are replaced by an explicit truncation
result rather than silently trimmed. Token usage and cost are kept only when a tool reports
explicit structured evidence; qyl.mcp never infers them from prose, latency, or
payload size.

## Configuration

| Variable | Purpose |
| --- | --- |
| `QYL_COLLECTOR_URL` | Collector read API base; default `http://127.0.0.1:5100`. Also the OTLP base when set. |
| `QYL_API_KEY` | Collector read and OTLP credential. Outgoing only. |
| `QYL_PROJECT` | Server-owned collector project scope; defaults to `default`. |
| `QYL_OTLP_ENDPOINT` | Optional OTLP base for workbench self-telemetry. |
| `QYL_MCP_TELEMETRY=0` | Disable MCP spans, metrics, and operation logs. Enabled otherwise. |
| `QYL_MCP_CAPTURE_CONTENT=1` | Include redacted, size-bounded request and response bodies in operation logs. Off by default. |
| `QYL_MCP_STATE_PATH` | Override the durable workbench JSON path. |
| `QYL_MCP_NATIVE_STATE_PATH` | Override the native-execution evidence path. |
| `QYL_MCP_WORKBENCH_PORT` | Workbench listener port; default `18888`. |
| `QYL_DEMO=1` | Explicit offline demo mode. |

Demo mode is deliberate and labelled — results carry `mode: "demo"`. A collector
error stays an error; live mode never silently falls back to generated data.

## Telemetry

qyl.mcp exports correlated MCP spans, duration histograms, and metadata-only
operation logs over OTLP, targeting OpenTelemetry semantic conventions v1.43.0
and its development MCP conventions.

`mcp.client` and `mcp.server` spans are named `{mcp.method.name} {target}` when a
low-cardinality target exists, and never carry argument or result content.
Failures use `error.type` on the same operation histogram rather than a second
counter. The `qyl.mcp.operation` log event carries matching trace context; its
body is metadata-only unless you opt in with `QYL_MCP_CAPTURE_CONTENT=1`.

Trace context and baggage travel in the unprefixed MCP `params._meta` bag on
every supported transport. An inbound server span parents off that remote context
and links any ambient transport span. HTTP propagation stays a separate concern
and is never replaced by the MCP carrier.

The built-in `qyl-telemetry` server reads real traces, logs, metrics, and sessions from
`QYL_COLLECTOR_URL`. Those reads run under async self-export suppression, so
inspecting qyl evidence does not generate recursive MCP telemetry.

Signal-specific `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` take
precedence; otherwise the base order is `QYL_OTLP_ENDPOINT`,
`QYL_COLLECTOR_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `http://127.0.0.1:4318`.

## Deploying your own

Railway settings live in `.railway/railway.ts` (Railway Infrastructure as Code).
The file is not read at deploy time: preview with `railway config plan` and
push it to your project with `railway config apply`. Use `/` as the root
directory:

```text
Build:  bun run --cwd server build
Start:  bun server/dist/main.js
Health: /healthz
```

The start command is Bun, not Node: the HTTP entry exports a fetch handler and
refuses to serve under Node. Both commands and the `/healthz` check are declared in
`.railway/railway.ts` and applied to Railway with `railway config apply`; nothing is read
from the repository at deploy time.

Do not set `PORT`; Railway injects it. The MCP endpoint is stateless; the one
piece of state is the MCP Events subscription file named by `MCP_EVENTS_STORE`,
which `.railway/railway.ts` keeps on the volume mounted at `/data`. Leave the
variable unset to run without events and without a volume. Railway's 15-minute
streaming limit applies to unusually long synchronous operations.

For public plugin submission, declare `https://mcp.qyl.at/mcp` in the plugin
package and upload its ZIP in [Plugins](https://platform.openai.com/plugins).
Open the package's **MCPs** section to connect and scan the server. When the
portal shows its domain-verification token, set `OPENAI_APPS_CHALLENGE` to it;
the server then answers `/.well-known/openai-apps-challenge` with exactly that
token as plain text. Follow the current
[submission flow](https://developers.openai.com/plugins/deploy/submission).

When the collector uses API-key authentication, configure `QYL_API_KEY` with a
key from its intended project. `/healthz` and OAuth discovery can succeed even
when this downstream credential is missing; verify a real authenticated read
tool after each deployment. Do not place the collector key in client settings.

```bash
NODE_ENV=production \
MCP_BIND_HOST=0.0.0.0 \
MCP_PUBLIC_URL=https://mcp.example.com \
MCP_ALLOWED_HOSTS=mcp.example.com,<service>.up.railway.app,healthcheck.railway.app \
MCP_ALLOWED_ORIGIN_HOSTS=mcp.example.com,<service>.up.railway.app \
QYL_COLLECTOR_URL=http://qyl-collector.railway.internal:8080 \
QYL_API_KEY='<collector-api-key>' \
bun run start
```

`MCP_PUBLIC_URL` adds its hostname to the Host and Origin allowlists, and
`<public-url>/mcp` is the fixed resource identifier tokens are audience-bound to.
A non-loopback bind requires it.

The default Auth0 mode accepts only the qyl production Auth0 issuer
`https://qyl-eu.eu.auth0.com/`, which is pinned in the build and is not
configurable: there is no environment variable that substitutes an arbitrary
OAuth issuer. Configure the API audience for your public URL in that tenant
instead.

### Authentication

The hosted Auth0 profile uses **CIMD or DCR + OAuth 2.1 Authorization Code with
PKCE S256 + issuer identification**. ChatGPT's current stable CIMD supports
`none` and `private_key_jwt` (its published preference); Claude's CIMD is a
public client using `none`. The server is an OAuth
resource server: Auth0 registers clients, authenticates users and clients,
performs grant exchanges, and issues tokens. qyl.mcp never hosts a token endpoint,
accepts a client assertion as an access token, or forwards a caller's token to
the collector. Its outgoing collector credential remains separate.

A public URL always builds the authentication gate. A non-loopback bind without
`MCP_PUBLIC_URL` is refused. Startup discovers the pinned Auth0 issuer and verifies
CIMD, DCR, S256, authorization-code, both client authentication methods and
response issuer-identification capabilities. Missing advertised capabilities
stop startup. Discovery does not prove that DCR is enabled, an individual client
has been provisioned, or that an Auth0 plan permits `private_key_jwt`.

Configure Auth0 as follows:

1. Register the API with identifier `<public-url>/mcp`, RS256, the RFC 9068
   access-token profile, and the permission `qyl:read`.
2. Enable **Client ID Metadata Document Registration**, the **Resource
   Parameter Compatibility Profile**, and authorization response issuer
   identification so every authorization response includes the exact `iss`.
3. Import each CIMD URL through **Applications → Create Application → Import
   from URL**: `https://chatgpt.com/oauth/client.json`,
   `https://claude.ai/oauth/mcp-oauth-client-metadata`, and
   `https://claude.ai/oauth/claude-code-client-metadata`. Use the exact ChatGPT
   client ID and callback shown in its connection page if it selects a
   callback-specific identity. Preserve each document's redirect URIs and
   token method. ChatGPT publishes `private_key_jwt` as its preference and a
   JWKS; Auth0 documents that method as Enterprise-only. Its metadata also
   supports `none`, so verify the selected method with a real token exchange.
   Claude uses `none`, and Claude Code needs both loopback hostnames with any port.
4. Enable **Dynamic Client Registration** in Settings → Advanced and set
   `dynamic_client_registration_security_mode` to `strict`. Auth0's DCR endpoint
   is open to registration when enabled. Restrict it with a Tenant ACL where
   practical, and keep third-party API default permissions empty. A new DCR
   client then needs its own explicit `qyl:read` client grant before login can
   receive that scope; use a test client ID to verify this path. Do not set a
   tenant-wide default `qyl:read` grant.
5. Grant each intended CIMD or DCR client `qyl:read` for the API and permit only
   the intended users to log in. Refresh imported CIMD metadata when client
   keys or callbacks change.

`qyl:read` permits access to the deployment's traces, logs, metrics, sessions,
and CI evidence. Every current tool is read-only, so no write permission is
advertised. Client registration does not itself authorize API access: grant it
only to intended clients and users. An open default `qyl:read` grant would
expose the same evidence to anyone who completes authorization.

Every MCP request passes the same verifier: RS256 signature, exact issuer,
resource audience, expiry, not-before, RFC 9068 token type, subject, client ID,
issued-at and token ID. ID tokens, ID-JAGs and client assertions are rejected.
Credentials must use `Authorization: Bearer`; query tokens and malformed or
multiple credentials receive 400. Missing/invalid/expired tokens receive 401;
insufficient scopes receive 403 with `insufficient_scope`. Challenges contain
`resource_metadata` and the complete required scope set. `offline_access` is
never a resource requirement. The resource publishes RFC 9728 metadata and
mirrors the validated provider's OAuth metadata, preserving its extension
fields. Both `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource` describe the same `/mcp` resource.
Auth0 itself publishes OIDC discovery at
`https://qyl-eu.eu.auth0.com/.well-known/openid-configuration`. This resource
server does not publish OIDC discovery on `mcp.qyl.at`: it is not the issuer.
If ChatGPT workspace domain claiming is needed, enable `openid` and `email` in
Auth0 and its verified-email UserInfo response; the resource scope remains
`qyl:read`.

### Optional authorization extensions

Extensions are **off by default** and enabled with exact integration versions:

```sh
MCP_AUTH_EXTENSIONS=enterprise-managed-authorization@1.0.0,oauth-client-credentials@1.0.0
```

| Integration | Upstream status | Additional provider requirement |
| --- | --- | --- |
| `enterprise-managed-authorization@1.0.0` | Stable | JWT bearer grant and `authorization_grant_profiles_supported` containing `urn:ietf:params:oauth:grant-profile:id-jag` |
| `oauth-client-credentials@1.0.0` | Draft; explicitly opt in | Client credentials grant with `private_key_jwt` and advertised asymmetric signing algorithms |

The version after `@` is qyl.mcp's integration version, independent of the MCP
wire revision `2026-07-28` and the upstream specification's status. There is no
`latest` alias. Each module records its source specification. Unknown versions,
duplicate IDs, conflicting requirements and unsupported provider capabilities
stop startup. These integrations apply only to hosted Auth0 mode; selecting
them in loopback-only or Cloudflare Access mode is a configuration error.

These are resource-server integrations of the
[MCP authorization extensions](https://github.com/modelcontextprotocol/ext-auth).
For enterprise authorization, the client exchanges its enterprise identity for
an ID-JAG at its IdP, then exchanges that ID-JAG for an access token at Auth0.
Configure the IdP trust, resource policy and client grants in those providers.
For client credentials, provision the machine client and its keys at Auth0 and
grant only the required API permissions. ChatGPT's interactive connection uses
the core authorization-code flow; enabling an extension does not add a client
flow that ChatGPT does not support.

Both flows finish with an Auth0 access token for this resource, which passes
exactly the same core verifier and scope gate. qyl.mcp does not consume the
intermediate identity assertions, issue tokens, or implement an enterprise IdP.
Extensions do not change the core MCP envelope, claim extra protocol
capabilities, or synthesize provider discovery fields. They compose by uniting
provider requirements; disabling every extension preserves core authorization.
Selecting a module checks the resource server's provider contract; granting or
revoking a client flow remains an Auth0 administrative policy, not a claim the
resource server can infer from arbitrary token claims.

Embedders can import `qyl-mcp-server/auth` and register new declarative
`AuthorizationExtension` modules through `resolveAuthorizationExtensions` and
`loadHostedOAuth`'s options (see the example below). Extensions cannot
replace the core verifier or grant scopes. `createResourceAuthorization` supports
explicit `scopeImplications` for deployments with scope hierarchies. Implications
are transitive and cycle-safe; wildcard-looking scope names have no implicit
meaning, and verified token claims remain unchanged. The standalone server has
only `qyl:read`, so it does not invent a broader scope or a hierarchy.

```ts
import { authorizationExtensions, resolveAuthorizationExtensions, loadHostedOAuth }
  from "qyl-mcp-server/auth";

const extensions = resolveAuthorizationExtensions(
  ["enterprise-managed-authorization@1.0.0"],
  authorizationExtensions,
);
const oauth = await loadHostedOAuth(new URL("https://mcp.example.com/mcp"), { extensions });
```

Client refresh-token storage and step-up retry limits belong to the connecting
MCP client. This server neither stores refresh tokens nor runs authorization
retries. Clients should accumulate previously requested and newly challenged
scopes and bound retries as specified by MCP. The server returns all scopes
required for the current operation together (`qyl:read` for its current surface).

References: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[Auth0 CIMD](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd),
[ChatGPT authentication](https://developers.openai.com/plugins/build/auth).

### Cloudflare Access Managed OAuth

To switch an existing hosted server to Cloudflare Access, set all three values:

```sh
MCP_AUTH_PROVIDER=cloudflare-access
MCP_ACCESS_TEAM_DOMAIN=https://YOUR-TEAM.cloudflareaccess.com
MCP_ACCESS_AUD=YOUR-ACCESS-APPLICATION-AUD
```

`MCP_PUBLIC_URL` remains required. Configure a self-hosted Access application
for that public hostname in the same Cloudflare account, enable Managed OAuth,
and allow only the intended identities. Use its actual team domain and AUD tag.
Do not turn on this mode until the Access application is configured.

Access performs the client OAuth flow and owns its discovery endpoints. The
server validates `Cf-Access-Jwt-Assertion` with the team's signing keys, RS256,
issuer, application audience, expiry and subject before serving `/mcp`. A direct
request to the Railway origin without a valid assertion is rejected. Opaque
`oauth:` bearer tokens alone are not accepted by the origin. Access membership
grants this server's existing read-only `qyl:read` tool surface; the assertion
itself does not carry qyl scopes or identify the originating OAuth client.

The default `MCP_AUTH_PROVIDER=auth0` retains the pinned Auth0 behavior above.
Unknown modes, partial Access settings and non-Cloudflare team URLs fail closed.
This mode is an available deployment configuration, not a claim that the public
service has already switched providers. Verify the public discovery response
and an authenticated tool call after the actual cutover.

[Cloudflare Managed OAuth documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

## Verification

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run smoke
bun run smoke:otlp
bun run smoke:live
```

`smoke` exercises explicit demo behavior. `smoke:otlp` needs the sibling qyl
collector checkout (or `QYL_COLLECTOR_PROJECT` pointing at it), starts an
API-key-protected collector, and drives its real OTLP/protobuf and read surfaces
— a fixture validated by a schema from this repository would prove nothing about
interoperability. `smoke:live` needs the published `qyl` dotnet tool on `PATH`
(`dotnet tool install -g qyl`): it starts `qyl up` under a timeout, sends
OTLP/JSON traces, logs and metrics, then calls every one of the eleven tools in
live mode over stdio, reads both MCP App resources, and repeats `tools/list`
and one call over Streamable HTTP against a second process. It is the only gate
that proves the metrics, session, CI and display tools against real data.

Every tool shape in `server` is `contractSchema("<definition>")` from `@ancplua/qyl-api-schema/zod`: the contract package binds each published definition name to its TypeScript type, so a shape cannot be paired with the wrong type and a hand-rolled `z.object(` has nothing to stand in for. The textual gate that used to guard this (`verify:shapes`) is gone with the reason for it.

## Limits

- Usage and cost appear only when execution evidence records them. qyl.mcp does
  not estimate.
- Downstream spans from an external or stdio peer correlate only when that peer
  honors MCP propagation metadata. qyl.mcp cannot retrofit instrumentation into
  an uninstrumented server.
- The live connection journal is process-local. Execution, test, and evaluation
  evidence is durable, but protocol traffic not attached to retained evidence is
  not reconstructed after a restart.
- Conformance coverage is local stdio and Streamable HTTP. External remote
  services cannot be verified without their endpoints and credentials.

## Contracts

Request, response, event, and error models come from
[`qyl-api-schema`](https://github.com/ANcpLua/qyl-api-schema). MCP envelopes come
from the official MCP TypeScript SDK 2.0.0. OTLP payloads come from the official
OpenTelemetry SDK. None of the three is mirrored or hand-built here.
