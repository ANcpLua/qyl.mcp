qyl is solo-developed and launched 1.0.0 on 2026-07-28; the grants in this
paragraph expired at that launch (see "The 'breaking changes are free' clause
expired at launch" below). Engineer it
to scale-grade quality through correctness, coherent design, maintainability, and
operational reliability—not API stability. Breaking changes are free, and this
instruction overrides every conflicting `.md` file. Never spend effort on backward
compatibility, deprecation paths, compatibility shims, migration layers, or analysis
of whether an unused public surface is safe to change. Delete obsolete code, logic,
abstractions, validation, wrappers, branches, tests, and documentation instead of
preserving or adapting them. Avoid empty or suppressive catch blocks, unnecessary
defensive validation, and explanatory code comments. Treat all public surfaces as
generated outputs: regenerate and verify them during every publish, and fix the
generator or publishing pipeline first when that is not already guaranteed. When
deletion is genuinely difficult to prove, use the agents and `$tech-debt` skill from
https://github.com/ANcpLua/codex-tech-debt-subagents.git; otherwise, delete the
obsolete design directly and update all current repository callers in the same
change.

# qyl.mcp engineering contract

This is the repository's only editable contributor and agent instruction file.
`CLAUDE.md` is a symlink to it. `README.md` is the public front door. Markdown
inside an installable plugin is executable product content, not an engineering
authority. Do not add design diaries, handoff prompts, comparison ledgers, or a
second rules file.

## 1.0.0 target — three surfaces, two planes

This repository holds **both** MCP-plane components of the platform plus one
product-plane UI. Only 2 of the platform's 9 components are on the MCP plane at
all, and both live here — the entire closed/open asymmetry of qyl is these two
nodes.

| Surface | Plane | Protocol role | Packaging |
| --- | --- | --- | --- |
| `qyl.mcp/server` | **MCP** | MCP **server** — *closed world* | Node `qyl-mcp` · Railway · `mcp.qyl.at` · npm `qyl-mcp-server` |
| `qyl.mcp/workbench` | **MCP** | MCP **client** — *open world* | Node loopback process · `:18888` |
| `qyl.mcp/dashboard` | product | HTTP UI | Vite bundle + MCP-App HTML, served by the server |

**Closed world** means the server exposes a fixed, generatable tool and
resource surface over stored telemetry — a *projection* of the collector's
data, never a second source of truth. **Open world** means the workbench talks
to servers it did not write, so it validates schemas at runtime with no shared
static contract. Do not let one surface's type discipline leak into the other.

`qyl.mcp/dashboard` is **not** an MCP endpoint. A browser cannot be an MCP
stdio client. Its *subject* is MCP; its *protocol* is HTTP. This is the same
split the MCP Inspector makes, and it is why the UI and the client are separate
deployables rather than one.

The full ledger and the boundary law live in `qyl/ARCHITECTURE-1.0.0.md` — that
document is normative and this one does not restate it.

### The "breaking changes are free" clause expired at launch

The opening paragraph of this file granted free breaking changes, no
compatibility shims, and no migration layers. That was correct through the
beta and stopped being true on 2026-07-28, when 1.0.0 shipped. From launch onward, every
public-facing change needs backwards compatibility, a shim, or a PR, and force
pushes to `main` stop. Read that paragraph as scoped to the pre-launch window,
not as a standing property of the repo.

### TypeScript floor

`server/tsconfig.json` runs beyond `strict`: `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`. Keep them on and keep the
tree at zero errors. `noPropertyAccessFromIndexSignature` is deliberately off —
it flagged 48 purely stylistic sites and no defects.

Prefer narrowing on the **value** over narrowing on a length or count, because
the compiler can follow the former and not the latter:

```ts
const [first] = items;
if (!first) return empty;   // `first` is now narrowed; items[0] never is
```

## Serving-layer target — Bun web-standard handler, protocol 2026-07-28

`qyl.mcp/server` runs today as the hosted MCP endpoint on Railway
(`https://mcp.qyl.at/mcp`), Node + Express, with a hand-wired auth front. The
active migration target is the serving layer, not the tools: the same
functional surface, but as a web-standard handler on Bun that speaks protocol
revision `2026-07-28` and works for foreign MCP clients with no prior
knowledge of qyl. The surface table above describes the current deployment
until this lands.

**There is no Bun package in the SDK, and that is not a gap.**
`@modelcontextprotocol/express`, `/fastify`, `/hono`, and `/node` are adapters
for Node frameworks. `createMcpHandler` from `@modelcontextprotocol/server`
already returns `{ fetch, close, notify, bus }`, where `fetch` is a
web-standard `(Request) => Promise<Response>` — the shape Bun expects from a
default export. On Bun, `export default handler` is the entire mount. Anyone
searching for a Bun adapter is searching for something that by construction
does not exist.

Authoritative sources for this work, read in this order — where these pages
and the repo disagree, the pages win: the repo was written against an earlier
v2 alpha.

- <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md>
- <https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md>
- <https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md>
- <https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.md>
- <https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.md>

### Goal state

`server/src/main.ts` is a single default export of the shape `{ port, fetch }`.
Express, `@modelcontextprotocol/express`, and `@modelcontextprotocol/node` are
gone from the server dependencies — not encapsulated, not replaced, removed.
The endpoint serves `2026-07-28` and 2025-era clients from the same factory. A
foreign MCP client that knows nothing about us can connect, find the auth flow
on its own, and call tools.

### The request pipeline

One fetch function, four stages, in this order — the order is the thing that
otherwise goes wrong:

1. `oauthMetadataResponse(request, { oauthMetadata, resourceServerUrl })` —
   **before** the auth gate. These documents must be reachable
   unauthenticated, or the discovery path is circular. Returns `undefined`
   when the route does not match.
2. `hostHeaderValidationResponse` / `originValidationResponse` from
   `@modelcontextprotocol/server`. The handler checks neither Host nor Origin
   nor a token — that is deliberate, and it must happen before it. The
   existing `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGIN_HOSTS` are the values.
3. `requireBearerAuth({ verifier, requiredScopes })` from
   `@modelcontextprotocol/server` (not the Express variant). Resolves to
   `AuthInfo` **or** a finished challenge `Response` — `instanceof Response`
   is the branch.
4. `handler.fetch(request, { authInfo })`. `port` comes from
   `process.env.PORT` — Railway injects it; a hardcoded port binds into the
   void.

### What makes foreign clients work

Three things, and only these three, decide whether a foreign client gets
through without instructions:

- **The discovery path must be closed.** A client without a token gets 401
  with `WWW-Authenticate: Bearer …` whose `resource_metadata` points at
  `/.well-known/oauth-protected-resource/mcp`; that document names the
  authorization server; the client fetches a token there and retries. If the
  chain breaks anywhere, the user sees a bare 401 with no way forward.
  `resourceMetadataUrl` on `requireBearerAuth` and the mounted
  `oauthMetadataResponse` are the two halves of this.
- **The legacy posture stays the default.** `createMcpHandler(factory)` serves
  `2026-07-28` per request and, via `legacy: 'stateless'`, additionally serves
  2025-era traffic from the same factory. Do not set `legacy: 'reject'`: most
  clients shipping today are 2025-era and would get 400.
- **Populate `expiresAt` in the verifier**, from the JWT `exp`.
  `requireBearerAuth` answers 401 `invalid_token` for a token whose
  `expiresAt` is unset — even when everything else is valid.

### Known traps

These are in the docs and cost an hour each otherwise:

- On the modern path, `createMcpHandler` validates the SEP-2243 standard
  headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) against the body
  and answers 400 with `-32020` on mismatch. If Railway's edge rewrites or
  drops headers, it manifests exactly here — and looks like a client bug.
- Under the stateless legacy posture, legacy GET (the standalone SSE stream)
  and DELETE (session termination) answer 405. That is correct behavior, not
  a regression finding.
- Also under stateless legacy: there is no back-channel for server→client
  requests, so the `input_required` shim for 2025-era clients degrades to a
  clean capability refusal. A tool that needs elicitation or sampling hits
  that boundary — know it, do not rebuild around it.
- `resultType` is gone from every public result type; the 2026 error codes
  were renumbered relative to the alphas (`-32020` HeaderMismatch, `-32021`
  MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion). Any
  place in the repo that hardcodes one of those values or reads
  `result.resultType` is alpha-era and wrong today.
- The stdio entry (`serveStdio`, the published `bin`) is its own deliverable
  and stays untouched. It pulls no `@modelcontextprotocol/node`, so it
  survives the removal without change.

### Verification for this migration

Claims do not count here; outputs count. For every item, the actual output
belongs in the report, not a summary of it.

Test foreign clients without a network: drive `handler.fetch` directly, as the
migration page shows under "In-process testing" — a
`StreamableHTTPClientTransport` whose `fetch` points at
`handler.fetch(new Request(url, init))`. The URL is never dialed. That makes
both checkable:

- a client with `versionNegotiation: { mode: 'auto' }` connects and reports
  `getProtocolEra() === 'modern'`
- a default client (2025 handshake, no `versionNegotiation`) also connects and
  lists the same tools

Plus, with curl against the locally started Bun process:

- `POST /mcp` without a token → 401, and the `WWW-Authenticate` header
  contains `resource_metadata`
- `GET /.well-known/oauth-protected-resource/mcp` without a token → 200, JSON
  names the authorization server
- `POST /mcp` with a valid token → `tools/list` returns the tools

And the dependency claim as fact rather than intent:

- `bun pm ls` or `npm ls @modelcontextprotocol/node` in the server workspace
  finds nothing
- `npm audit` at the workspace root: GHSA-frvp-7c67-39w9 no longer appears,
  because `@hono/node-server` lost its only source

### Constraints on this migration

No `git push`, no `npm publish`, no Railway deploy, no change to Railway
variables. Local commits are fine. Those operations are irreversible and
human-gated — the run ends in `needs_verification`, never in `done`.

If something about the web-standard conversion does not work out, the right
move is to report it and leave it standing — not to build an adapter or
wrapper to bridge the gap. A reported blocker costs five minutes; a bridged
one also costs them, just later and more expensively.

If the test files on `node:test` do not run under Bun: report the result
(which APIs are missing), do not rewrite the suite.

The report at the end: what changed, the verification outputs raw, and the
list of what did not work out. An empty third section is a credible result; a
third section that describes problems as solved without an output showing it
is not.

## Role and ownership

qyl.mcp owns MCP runtime behavior, local orchestration, and presentation. It is
not a Qyl product-contract source.

- Qyl tool inputs, structured outputs, runner HTTP/SSE messages, dashboard
  payloads, and Qyl errors must originate in the sibling `qyl-api-schema`
  TypeSpec repository and be consumed through generated TypeScript contracts
  and runtime validators.
- The Model Context Protocol SDK owns JSON-RPC, transport, tool-result, and
  resource-result envelopes. Use its types directly.
- Official OpenTelemetry SDK and protobuf types own OTLP ingestion. Do not
  mirror or hand-build OTLP JSON messages.
- Process launch state, SDK clients, caches, and aggregation intermediates may
  remain local only while they do not cross an HTTP, SSE, MCP,
  generated-client, or telemetry wire boundary.

For a boundary change, change TypeSpec first, regenerate, consume the generated
artifact, and then map explicitly. Do not preserve multiple wire encodings
without a proven released consumer.

## Product evidence

A capability needs an executable product path or conformance application. Demo
mode is explicit (`QYL_DEMO=1`) and visibly labelled; collector failure must not
silently substitute generated demo telemetry. Fixtures use generated protocol
types, valid programmatic data, or sanitized captures. A fixture validated by a
schema authored in this repository does not prove collector interoperability.

Read-API authentication follows the generated Qyl contract. Never invent a
second token or header convention. Runtime versions are derived from package
metadata rather than duplicated string constants.

`Mcp-Param-*` HTTP headers are MCP tool arguments, not generic transport
metadata. Generic HTTP instrumentation must never capture that reserved
namespace, even when an operator allowlists a matching header name. Any future
argument-content capture belongs at an MCP-owned boundary, is disabled by
default, and requires its own explicit policy and sanitization.

## Untrusted execution and release integrity

This hardening contract is reconciled through
[`maf-doctor` v1.14.0](https://github.com/joslat/maf-doctor/releases/tag/v1.14.0).
That upstream checkout is design evidence only; qyl.mcp never consumes it at
build time or runtime.

- A configured stdio MCP server is an untrusted child process. Launch an
  executable with an argument vector and no shell; keep the SDK's minimal
  default environment plus only the environment references explicitly declared
  for that server. Never spread the qyl host's `process.env` into the child.
  Bound connection and shutdown time, drain stdout and stderr concurrently,
  cap retained output, and never persist raw stderr.
- Any future subprocess path follows the same boundary. If qyl ever invokes
  `git` inside a user-selected repository, disable repository-controlled hooks,
  fsmonitor, pagers, and external protocols, ignore system git configuration,
  and remove host credentials from the child environment.
- CI that checks fork-controlled code has read-only permissions and no
  credentials capable of comments, pushes, deployments, or publication.
  Effectful follow-up belongs in a separate trusted-context job that consumes a
  bounded, validated result rather than executing the fork checkout.
- GitHub event text and manual inputs reach shell steps through explicit
  environment variables and strict shape validation, never direct expression
  interpolation into `run:`. A scanner or smoke gate must prove it inspected
  the expected non-zero tool/protocol surface; an empty scan is a failure, not
  a clean result.
- A release must match the committed package version, identify reviewed
  `main` history, publish through OIDC trusted publishing with provenance, and
  pass the immutable-version commit check plus a clean external-consumer
  handshake. Local publication and arbitrary-ref manual publication are not
  release paths.

## Telemetry and protocol discipline

qyl.mcp is modern-only and pins the final `2026-07-28` wire from the stable MCP
TypeScript SDK 2.0.0. These rules bind the emit path to that wire.

- Protocol revision comes from `getNegotiatedProtocolVersion()`, never from
  payload-shape guesses or a local fallback.
- Client and server identity is per-request and self-reported. Read
  `ctx.mcpReq.envelope`, not `getClientCapabilities()` / `getClientVersion()`
  (`undefined` on a 2026 connection). `clientInfo` / `serverInfo` are display,
  logging, and debugging values only — never a telemetry resource attribute, a
  span dimension, or a behavior or security input.
- A multi-round tool call is N linked requests, not a nested exchange. Correlate
  rounds with linked spans, never a parent-child tree, and mint the link only
  after the `requestState.verify` hook succeeds: `requestState` round-trips
  through the client, is signed rather than encrypted, and is untrusted until
  then.
- Span and RPC status come from the JSON-RPC and tool outcome, never the HTTP
  status: on the modern path a well-formed JSON-RPC error rides HTTP 400, and a
  committed 200 can still carry an in-stream error. Map from `isError` tool
  results and the `ProtocolError` code family.
- Wire concepts OpenTelemetry semconv has not defined — `requestState`, round
  index, `resultType`, `subscriptions/listen` lifetime, cache hints — emit under
  an experimental `qyl.mcp.*` staging namespace, deletion-targeted on every
  semconv bump that lands an upstream equivalent. Never mint an `mcp.*` alias for
  an unratified concept.

## Repository shape

Keep the root README current and concise. Do not retain architecture diaries or
comparison ledgers as active specifications. Retain plugin prompts or skills
only when they have an installable manifest, a real distribution path, and
executable tests, and keep their API claims generated or linked rather than
copied.

## Cloudflare skills

`mcp.qyl.at` is Cloudflare-proxied and `mcp-dev.qyl.at` is a named Cloudflare
tunnel to a local origin, so the edge is part of this server's request path in
both environments. Load `/cloudflare:cloudflare` before changing or diagnosing
anything at that layer — tunnel ingress and `originRequest.httpHostHeader`,
zone and proxy settings, and Access in front of the dev hostname. It retrieves
from current Cloudflare docs rather than from memory.

Two edge behaviors matter enough to name. The modern path validates the
SEP-2243 standard headers against the body and answers 400 with `-32020` on
mismatch, so an edge that rewrites or drops headers manifests as what looks
like a client bug. And an `Origin` allowlist at the edge or in the server
applies to the OAuth metadata documents too unless the pipeline answers them
first — which is why `oauthMetadataResponse` is stage 1 and the rebinding
guards are stage 2, never the reverse.

`/cloudflare:wrangler` does not apply here: this repo deploys no Worker. That
belongs to `qyl.at`.

## Verification

```bash
npm ci
npm run verify:pins
npm run build
npm test
npm run smoke
npm run smoke:otlp
```

`verify:pins` is the cross-repo contract check CI runs first, and it belongs at
the top here for the same reason: a skew against `ANcpLua/qyl` fails `smoke:otlp`
at the spawned server's startup handshake, minutes later and pointing at the
wrong thing. It needs an `ANcpLua/qyl` checkout — `$QYL_REPO`, `./qyl`, or
`../qyl` — and fails rather than skips when it finds none, because a pin check
that passes when it cannot see the other side reports green for exactly the
condition it exists to catch.

The explicit-demo smoke test is a local behavior check. `smoke:otlp` uses the
real sibling collector as an official protocol receiver. Other contract changes
also require live collector and runner integration proving the generated wire
contract before completion.

`npm test` in `server` starts with `verify:shapes`, the G10a verifier: no
`z.object(` outside its two documented exemptions, and no module registering a
tool without importing the generated validators. Its exemption list is
self-policing — an entry whose file no longer declares a shape fails as a stale
exemption, so the list shrinks by itself rather than outliving its reason.

`server/tool-manifest.snapshot.json` is the G10b artifact: the full tool surface
an agent sees, plus the contract revision it was generated from. Regenerate it
deliberately with `npm run snapshot:tools` and read the diff — never to make a
red test green.

## Publishing

`qyl-mcp-server` publishes to npmjs.org from `publish.yml` by OIDC trusted
publishing, on a published GitHub release or a manual dispatch. Never publish
locally and never add a registry credential to CI: the workflow gates on build,
every workspace test, the server smoke, and a clean `npx` consumer handshake
against the indexed package before a release is complete.

**The release's pre-release flag chooses the npm dist-tag** — `prerelease: true → next`,
otherwise `→ latest` — and npm never moves `latest` onto a prerelease on its own. So the
question at every release is what a bare `npm install qyl-mcp-server` should return, and
that flag is the whole answer. Getting it wrong is silent: `latest` sat on the pre-beta
`0.1.1` until 2026-07-26 across three beta releases, each correctly marked a prerelease,
with nothing left to advance `latest` — so every plain install served code from before the
beta line existed.

Like the "breaking changes are free" clause above, the tactic that follows expires at
launch. While the beta line *is* the product, ship releases unmarked so `latest` tracks
them, despite the `-beta.N` in the version. Once 1.0.0 is out and previews sit genuinely
ahead of a stable line, the ordinary meaning returns: mark previews as prereleases and let
them land on `next`. Decide from what `latest` should serve, never from the habit of the
previous phase.

A dist-tag is a promise to keep it current. The package carries only `latest` today because
`next` had no consumer and no release that advanced it, so it quietly aged into pointing at
older code than `latest`. Add a second tag when a line genuinely needs one, together with
whatever moves it; adding one as decoration recreates the same trap.

If a release-triggered publish fails within seconds having run no steps, read the `release`
environment's deployment policy before suspecting the workflow. Release events run on the
tag ref, so a policy limited to `main` rejects the deployment before any step starts; a
`tag: v*` entry alongside `main` is what permits it.

Registry writes that trusted publishing cannot perform — moving or deleting a
dist-tag, deprecating a version — have no OIDC path, since npm authorizes only
`npm publish`. Use `~/.claude/bin/npm-authed <npm args...>`, which injects a
keychain-held granular token for one command. It is for repairing already-published
state, never for publishing, and the release path must never depend on it.
