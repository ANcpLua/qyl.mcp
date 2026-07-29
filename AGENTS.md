# qyl.mcp engineering contract

This is the repository's only editable contributor and agent instruction file.
`CLAUDE.md` is a symlink to it. `README.md` is the public front door. Markdown
inside an installable plugin is executable product content, not an engineering
authority. Do not add design diaries, handoff prompts, comparison ledgers, or a
second rules file.

Repository policy is direct convergence: replace obsolete designs and update
current callers in the same change. Do not add compatibility ceremony for
superseded paths. Published registry artifacts remain immutable, so a changed
artifact is released as a new version.

## 1.0.0 target — three surfaces, two planes

This repository holds **both** MCP-plane components of the platform plus one
product-plane UI. Only 2 of the platform's 9 components are on the MCP plane at
all, and both live here — the entire closed/open asymmetry of qyl is these two
nodes.

| Surface | Plane | Protocol role | Packaging |
| --- | --- | --- | --- |
| `qyl.mcp/server` | **MCP** | MCP **server** — *closed world* | Bun · Railway · `mcp.qyl.at` · npm `qyl-mcp-server` |
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

Hosted HTTP is a Bun-only web-standard `fetch` handler. Keep
`server/src/main.ts`, `railway.toml`, and root scripts aligned with that runtime;
Node remains only for explicitly Node-based stdio/workbench deliverables. Do not
reintroduce Express or a framework adapter around the SDK handler.

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

qyl.mcp pins the stable MCP TypeScript SDK 2.0.0. Hosted HTTP uses the SDK
default that supports current `2026-07-28` and compatible 2025-era clients;
stdio is modern-only and rejects legacy. These rules bind the emit path to the
negotiated protocol.

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
deliberately with `npm run snapshot:tools --workspace server` and read the
diff — never to make a red test green.

## Publishing

`qyl-mcp-server` publishes to npmjs.org from `publish.yml` by OIDC trusted
publishing, on a published GitHub release or a manual dispatch. Never publish
locally and never add a registry credential to CI: the workflow gates on build,
every workspace test, the server smoke, and a clean `npx` consumer handshake
against the indexed package before a release is complete.

If a release-triggered publish fails within seconds having run no steps, read the `release`
environment's deployment policy before suspecting the workflow. Release events run on the
tag ref, so a policy limited to `main` rejects the deployment before any step starts; a
`tag: v*` entry alongside `main` is what permits it.

Registry writes that trusted publishing cannot perform — moving or deleting a
dist-tag, deprecating a version — have no OIDC path, since npm authorizes only
`npm publish`. Use `~/.claude/bin/npm-authed <npm args...>`, which injects a
keychain-held granular token for one command. It is for repairing already-published
state, never for publishing, and the release path must never depend on it.
