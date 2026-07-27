qyl is a solo-developed beta launching today with no external dependents. Engineer it
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

### The "breaking changes are free" clause expires at launch

The opening paragraph of this file grants free breaking changes, no
compatibility shims, and no migration layers. That is correct **today** and
becomes wrong the moment qyl leaves beta. From launch onward, every
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

## Telemetry and protocol-era discipline

qyl.mcp emits MCP telemetry, and the 2026-07-28 revision changes what several
recorded fields mean. `doc/support-2026-07-28.md` is the per-era authority; these
rules bind the emit path to it.

- Protocol era is the negotiated version (`getProtocolEra()` /
  `getNegotiatedProtocolVersion()`), never the presence of a `_meta` envelope: the
  legacy-fallback probe also carries one.
- Client and server identity is per-request and self-reported. Read
  `ctx.mcpReq.envelope`, not `getClientCapabilities()` / `getClientVersion()`
  (`undefined` on a 2026 connection). `clientInfo` / `serverInfo` are display,
  logging, and debugging values only — never a telemetry resource attribute, a
  span dimension, or a behavior or security input.
- A multi-round tool call is N linked requests, not a nested exchange. Correlate
  rounds with linked spans, never a parent-child tree, and mint the link only
  after the `requestState.verify` hook succeeds: `requestState` round-trips
  through the client, is signed rather than encrypted, and is untrusted until
  then. The 2025 legacy shim reaches the same handler over real server→client
  requests, so never hard-code one topology.
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

## Verification

```bash
npm ci
npm run build
npm test
npm run smoke
npm run smoke:otlp
```

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
