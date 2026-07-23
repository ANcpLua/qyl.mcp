# qyl engineering contract

qyl is an ai-first telemetry platform, launching today.

Engineer it to scale-grade quality through
correctness, coherent design, maintainability, and operational reliability—not API stability. Breaking changes are free,
and this instruction overrides every conflicting .md file. Never spend effort on backward compatibility, deprecation
paths, migration layers, adapters, wrappers, or analysis of whether an unused public surface is safe to change.
Delete obsolete code, logic, abstractions, validation, wrappers, branches, tests, documentation, and callers that exist only to support them.
Treat all public surfaces as authorized to modify without compatibility constraints.
Publishing a changed library and updating downstream qyl consumers is normal engineering work, not a reason to preserve an inferior design.
Generated surfaces must remain generated: boundary changes begin in `qyl-api-schema`; defects in generators or publishing pipelines must be fixed at their source rather than patched in generated output.
Do not preserve architectural debt merely to keep every intermediate state compiling.
A structural refactor may temporarily break the build, but it must end in a complete, coherent design followed by relevant final verification.
Do not fill deletion-induced gaps with speculative abstractions, defensive fallbacks, compatibility code, suppressive catches, redundant validation, or explanatory comments.

## Project scope

This repository's engineering rules live in this one file; `CLAUDE.md` is a symlink to it
and `README.md` is the public front door. Markdown inside installable products is
executable content, not engineering authority. Do not add design diaries, handoff
prompts, comparison ledgers, or a second rules file. Folder-level `AGENTS.md` files hold
runnable examples or product prompts, never a competing set of rules — the rules are here.

## Role and ownership

qyl.mcp owns MCP runtime behavior, local orchestration, and presentation. It is
not a Qyl product-contract source.

- Qyl tool inputs, structured outputs, runner HTTP/SSE messages, dashboard
  payloads, and Qyl errors must originate in the sibling `qyl-api-schema`
  TypeSpec repository and be consumed through generated TypeScript contracts
  and runtime validators.
- The Model Context Protocol SDK owns JSON-RPC, transport, tool-result, and
  resource-result envelopes. Use its types directly.
- Official OpenTelemetry SDK and protobuf types own OTLP ingestion. Do not mirror
  or hand-build OTLP JSON messages.
- Process launch state, SDK clients, caches, and aggregation intermediates may
  remain local only while they do not cross an HTTP, SSE, MCP,
  generated-client, or telemetry wire boundary.

For a boundary change, change TypeSpec first, regenerate, and consume the generated
artifact, then map explicitly. Do not preserve multiple wire encodings
without a proven released consumer.

## Product evidence

A capability needs an executable product path or conformance application.
Demo mode is explicit (`QYL_DEMO=1`) and visibly labelled; collector failure must not
silently substitute generated demo telemetry. Fixtures use generated protocol
types, valid programmatic data, or sanitized captures. A fixture validated by a
schema authored only in this repository does not prove collector interoperability.

Read-API authentication follows the generated Qyl contract. Never invent a
second token or header convention. Runtime versions are derived from package
metadata rather than duplicated string constants.

## Deployment and operations

Existing production infrastructure, authentication boundaries, generated contract
names, deployment topology, and canonical endpoints are real constraints.
Hypothetical API consumers are not.

## Operational requirement

A clean repository state remains mandatory, and known local dirt must never be
normalized or rationalized as healthy.

## MCP server — protocol baseline

The MCP server (`server/`, `server/src/`) is built **fresh at protocol revision
2026-07-28** and is **stateless per request**. There is no 2025-era ("v1") lineage to
carry — no legacy clients, no era negotiation, no backport shim, no upgrade path, no
codemod. If code, config, dependency, or doc exists only to support a pre-2026-07-28
peer, delete it.

- Serve via `createMcpHandler` (HTTP, web-standard `{ fetch }`) or `serveStdio` (stdio).
  No `initialize` handshake, no `Mcp-Session-Id`.
- **Pin the era to modern** — `versionNegotiation: { mode: { pin: '2026-07-28' } }` on the
  client, `legacy: 'reject'` on the server. No legacy fallback, ever.
- Server→client input (sampling / elicitation / roots) via `inputRequired(...)`
  multi-round-trip; read with `acceptedContent` / `inputResponse`.
- `requestState` (HMAC-sealed via `createRequestStateCodec`, verified, untrusted) in place
  of any per-session state.
- `subscriptions/listen` for change notifications.
- Auth: RFC 9207 `iss` validation plus the SEP opt-ins against the Auth0 resource server —
  SDK-level, not era-gated.
- Track the `schema/draft/` artifact; there is no `schema/2026-07-28/` directory yet.

The SDK API surface is upstream documentation — link it, do not copy it. Runnable examples
for the runner live in `runner/src/AGENTS.md`; the reference itself is upstream:

- SDK docs: <https://ts.sdk.modelcontextprotocol.io/v2/>
- Protocol versions / era negotiation: <https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md>
- Supporting 2026-07-28: <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md>
- Deprecated features registry (SEP-2577): <https://modelcontextprotocol.io/specification/draft/deprecated>

**Banned surface** — none of this may exist in the server: the `initialize` /
`initialized` handshake, `Mcp-Session-Id`, session-keyed state; the `input_required`
legacy shim, `legacy: 'stateless'` dual-era serving, the `server-legacy` package, the
`codemod`; the persistent server→client SSE stream, unsolicited `list_changed` /
`resources/updated`, `resources/subscribe`; in-band durable logging (`logging/setLevel`,
`notifications/message` for debugging / alerting / SLOs); `tasks/list` and the
experimental tasks interception layer.

## MCP server — householding (remove the old, go full stateless)

Do this as deletion, not parallel support — the only reason to keep a 2025-era code path
is a proven released consumer that still speaks it.

**Delete:**

- [ ] `Mcp-Session-Id` and every store/map keyed on a session id (`ctx.sessionId` / `extra.sessionId`).
- [ ] The long-lived server→client SSE stream and all server-initiated push: instance `createMessage()` / `elicitInput()` / `listRoots()` / `ping()` and `ctx.mcpReq.elicitInput` / `requestSampling` inside handlers.
- [ ] The `initialize` / `initialized` handshake as a source of identity (`getClientCapabilities()` / `getClientVersion()` return `undefined` on a 2026 connection).
- [ ] In-band MCP logging as a durable path: `logging/setLevel` and reliance on `notifications/message` for debugging/alerting/SLOs.
- [ ] Any cross-request in-memory buffer or aggregation held on the server instance.
- [ ] `tasks/list` and the experimental tasks interception layer; task wire vocabulary is `@deprecated` interop-only.
- [ ] Unsolicited `list_changed` / `resources/updated` sends and `resources/subscribe`.

**Adopt:**

- [ ] Stateless per-request serving: `createMcpHandler(factory)` (HTTP), `serveStdio(() => buildServer())` (stdio).
- [ ] `server/discover` negotiation via `versionNegotiation`; `_meta` envelope (`ctx.mcpReq.envelope`) for per-request identity.
- [ ] `inputRequired(...)` multi-round-trip for elicitation / sampling / roots; read with `acceptedContent(responses, key, schema)` / `inputResponse(responses, key)`.
- [ ] `requestState` for anything previously keyed on the session — HMAC-sealed with `createRequestStateCodec`, verified by `ServerOptions.requestState.verify`.
- [ ] `subscriptions/listen` for change notifications.
- [ ] Auth opt-ins (every era): `iss` to `finishAuth` (RFC 9207), round-trip the `issuer` stamp, `discoveryState()`, scope step-up.
- [ ] Per-request `_meta.logLevel` awareness: absent = opt-out, so handler logs are silently suppressed until the client opts in.
- [ ] All logs, metrics, and traces go OTLP → the qyl collector (batch export, flushed inline or via `waitUntil` on edge).
- [ ] Track `schema/draft/`, not `schema/2026-07-28/`.

## MCP server — logging → OTLP to the qyl collector

**MCP logging** (`logging` capability, `notifications/message`) is deprecated as of
2026-07-28 (SEP-2577) and stays functional through the deprecation window (at least twelve
months). Log to `stderr` for stdio servers; route everything structured to OpenTelemetry.

For qyl-owned servers, "use OpenTelemetry instead" means: emit logs — with traces and
metrics — as **OTLP to the qyl collector**, never a second bespoke pipeline. Under the
stateless protocol it is the only plane that works across load-balanced instances, since
the per-request `_meta.logLevel` gate means `notifications/message` reaches a client only
while a request is in flight and only after that client opts in.

- **Same-origin, same collector.** Hosted, OTLP goes to the private `qyl-collector` host; local, to the fixed OTLP HTTP port from `qyl up`. Use the generated auth header from the Qyl contract (`x-otlp-api-key` / `QYL_API_KEY`) — never invent a second token or header convention.
- **Correlate, don't just record.** Emit logs as the OTel log signal carrying `trace_id` / `span_id` and `browser.*` / server resource attributes, so a deprecated `ctx.mcpReq.log(...)` line becomes a span-correlated event: cross-request survival, cross-instance aggregation, severity.
- **The `mcp.*` and `web.vitals.*` names are a local namespace.** OpenTelemetry has no ratified semantic convention for MCP-server or Core Web Vitals telemetry yet, so do not label these attributes or metric names as standard. Per the workspace routing rule, an `mcp.`-prefixed attribute is checked against `semantic-conventions-genai`.
- **Keep `notifications/message` for interactive UX only.** Use it for logs a human is watching in a client session; send anything needed for debugging, alerting, or SLOs to the collector, because that path outlives the request and the connection.

Telemetry has exactly two directions: it leaves the server as async OTLP to the collector,
and telemetry an agent asks to read comes back as a synchronous tool call proxied to the
collector's read API. Never one for the other.

## Verification

```bash
npm ci
npm run build
npm test
npm run smoke
npm run smoke:otlp
```

The explicit-demo smoke test is a local behavior check. `smoke:otlp` uses the
real sibling collector as an official protocol receiver. Contract changes also
require live collector and runner integration proving the generated wire contract
before completion. A green build alone does not prove the banned legacy surface is
absent rather than merely unused — grep for it.
