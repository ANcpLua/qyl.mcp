# qyl.mcp

MCP tools over a live [qyl](https://qyl.at) collector — traces, logs, sessions, and
a graph view of agent runs you can watch while they execute.

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

Bun 1.3 is the runtime and the only package manager: `bun install`, `bun run
build`, `bun run test`, one `bun.lock`. The HTTP entry is a web-standard fetch
handler served by its default export, so serving it needs Bun; the published
`--stdio` binary is the one thing that also runs under plain Node 24, because
that is how `npx` clients launch it. Architecture and the component ledger live in
[`qyl/ARCHITECTURE-1.0.0.md`](https://github.com/ANcpLua/qyl); this file does not
restate them.

---

## Use the hosted server

Nothing to install. Point an MCP client at:

```
https://mcp.qyl.at/mcp
```

It is an OAuth 2.1 resource server, so an unauthenticated request answers `401`
with an [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)
protected-resource document. A stock MCP client reads that document, discovers
the issuer, registers itself, and completes the flow without you configuring
anything.

`https://mcp.qyl.at/` is a product page and `/healthz` is the platform
healthcheck. Neither is a protocol endpoint — `/mcp` is the only one.

## Run the server yourself

```bash
npx qyl-mcp-server --stdio
```

Without `--stdio` it serves Streamable HTTP (revision `2026-07-28` only) on
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

Telemetry: `list_traces`, `get_trace`, `list_sessions`, `search_logs`, `ci_log`,
`display_traces`, `display_mcp_dashboard`. Workflow graph: see below.

## Observe Graph

Watch an agent run as a graph while it executes, and steer it.

| Tool | Role |
| --- | --- |
| `list_workflow_runs` | Bounded historical run selection |
| `get_workflow_graph` | Deterministic graph projection at one journal cursor |
| `inspect_workflow_events` | Bounded journal read of one run's events, protected content by `content_ref` |
| `display_workflow_graph` | Opens the fullscreen MCP App |
| `fetch_workflow_graph_updates` | App-only journal polling, gap recovery, paging, lazy content |
| `control_workflow_run` | Steer, interrupt, resume — approval-gated, needs `qyl:control` |

`plugins/observe-graph` packages the `$observe-graph` skill together with the
remote `mcp.qyl.at` connection and the local `qyl observer-bridge`. When Codex is
running under `qyl codex`, the bridge identifies the one active run and the live
controls are available; otherwise the skill opens a durable run and labels it
historical.

Failed attempts stay visible after an interrupt or resume, because controls
append journal events rather than rewriting history. The graph is a projection
of that journal and nothing else — the same events always produce the same
graph. The layered DAG is authoritative; the radial layout only suits small
fan-out runs. The app keeps a bounded node and event window and fetches captured
content only when you open its reference.

Project identity is server-owned. No tool input accepts a project ID:
`QYL_PROJECT` selects it at deployment and the collector scopes every run,
event, command, projection, and content lookup to it.

### Extending it

Boundary changes start in [`qyl-api-schema`](https://github.com/ANcpLua/qyl-api-schema),
then flow through the collector and this repository at the same published schema
version. Projection behavior goes in the collector; tool behavior in
`server/src/workflow-*.ts`; replay and layout in `server/ui/observe-graph-*.ts`;
skill routing in `plugins/observe-graph/skills/observe-graph/SKILL.md`.
Regenerate the tool manifest whenever a tool or resource changes:

```bash
bun run --cwd server snapshot:tools
```

Read that diff rather than regenerating to make a red test green. The plugin has
its own gate:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/observe-graph
```

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

**Protocol.** Every user-configured connection pins revision `2026-07-28` and
fails when a peer cannot negotiate it. There is no fallback and no setting.

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

The built-in `qyl-telemetry` server reads real traces, logs, and sessions from
`QYL_COLLECTOR_URL`. Those reads run under async self-export suppression, so
inspecting qyl evidence does not generate recursive MCP telemetry.

Signal-specific `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` take
precedence; otherwise the base order is `QYL_OTLP_ENDPOINT`,
`QYL_COLLECTOR_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `http://127.0.0.1:4318`.

## Deploying your own

`railway.toml` is included. Use `/` as the root directory:

```text
Build:  bun run --cwd server build
Start:  bun server/dist/main.js
Health: /healthz
```

The start command is Bun, not Node: the HTTP entry exports a fetch handler and
refuses to serve under Node. `railway.toml` carries both commands already.

Do not set `PORT`; Railway injects it. The server is stateless and needs no
volume. Railway's 15-minute streaming limit applies to unusually long synchronous
operations.

```bash
NODE_ENV=production \
MCP_BIND_HOST=0.0.0.0 \
MCP_PUBLIC_URL=https://mcp.example.com \
MCP_ALLOWED_HOSTS=mcp.example.com,<service>.up.railway.app,healthcheck.railway.app \
MCP_ALLOWED_ORIGIN_HOSTS=mcp.example.com,<service>.up.railway.app \
MCP_OAUTH_ISSUER=https://qyl-eu.eu.auth0.com/ \
QYL_COLLECTOR_URL=http://qyl-collector.railway.internal:8080 \
QYL_API_KEY='<collector-api-key>' \
bun run start
```

`MCP_PUBLIC_URL` adds its hostname to the Host and Origin allowlists, and
`<public-url>/mcp` is the fixed resource identifier tokens are audience-bound to.
A non-loopback bind requires it.

This release accepts only the qyl production Auth0 issuer shown above; any other
`MCP_OAUTH_ISSUER` fails startup. Configure the API audience for your public URL
in that tenant rather than substituting an arbitrary OAuth issuer.

### Authentication

The server is a resource server only. It never mints tokens, hosts no
authorization server, holds no client registration, and keeps no static operator
credential. Startup fails closed when `MCP_OAUTH_ISSUER` is unset or unreachable.
It verifies RFC 9068 bearer tokens against the issuer's JWKS, requires the exact
resource audience and the `qyl:read` scope, and publishes only the RFC 9728
protected-resource document.

Configure an authorization server with an API whose identifier is your
`<public-url>/mcp`, RS256, the RFC 9068 access-token profile, and permissions
`qyl:read` and `qyl:control`. On Auth0 that means enabling **Dynamic Client
Registration**, **Client ID Metadata Document Registration**, and the **Resource
Parameter Compatibility Profile**, then promoting the login connection to domain
level.

**How the two scopes actually reach a client:**

- **`qyl:read`** — make only this scope available in the API's default
  third-party client grant. A self-registering client can request read access
  within that grant; the server's initial authorization challenge requests only
  `qyl:read`.
- **`qyl:control`** — leave this out of the defaults. The server requires this
  exact scope before it forwards a steer, interrupt, or resume command; approval
  annotations alone are not an authorization boundary.

A client that needs workflow control must be registered deliberately through
CIMD or as a named first-party application and receive an explicit client grant
containing both `qyl:read` and `qyl:control`, because a per-client grant replaces
rather than extends the default. That client must then explicitly request and
reauthorize with `qyl:control`; a denied tool call does not trigger automatic
scope step-up. Self-registering clients remain read-only by default.

Auth0 Dynamic Client Registration is open: anyone can register a client without
a token. Combined with default `qyl:read`, that permits anyone who completes
authorization to read the deployment's traces, logs, sessions, and CI evidence.
Set the tenant's `dynamic_client_registration_security_mode` to `strict` before
relying on the default-grant boundary. Make read exposure deliberate or restrict
DCR with the Auth0 Tenant ACL (`dcr` scope), which can filter by IP, CIDR, or
geography; `/oidc/register` is also rate-limited to five requests per second per
tenant.

## Verification

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run smoke
bun run smoke:otlp
```

`smoke` exercises explicit demo behavior. `smoke:otlp` needs the sibling qyl
collector checkout (or `QYL_COLLECTOR_PROJECT` pointing at it), starts an
API-key-protected collector, and drives its real OTLP/protobuf and read surfaces
— a fixture validated by a schema from this repository would prove nothing about
interoperability.

`bun run test` in `server` begins with `verify:shapes`, which fails on any hand-rolled
`z.object(` outside two documented exemptions and on any module registering a tool
without importing the generated validators. The exemption list is self-policing:
an entry whose file no longer declares a shape fails as stale, so the list shrinks
on its own.

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
