# Error channels and input_required

## The channel rule

A **tool error** is a successful JSON-RPC result with `isError: true` — the model reads it and
recovers. A **protocol error** is a JSON-RPC error response — the model never sees it; the host's
code handles it. **The handler kind decides which channel exists:**

| Handler | Channel | Mechanism |
| --- | --- | --- |
| tool (`tools/call`) | tool error only | return `isError: true`, or throw (SDK converts; message becomes `content` text) |
| resource / prompt / completion | protocol error only | throw `ProtocolError(code, message, data?)` or a typed subclass |

- A `ProtocolError` thrown **inside a tool handler** still becomes `isError: true`. The single
  exception, **on 2025-era connections only**: `UrlElicitationRequiredError` propagates as `-32042`
  so the host can open the URL. On a 2026-07-28 connection the SDK refuses that throw loudly (the
  `-32042` never reaches the wire) and steers to `inputRequired.elicitUrl(...)`.
- A non-`ProtocolError` thrown from a resource/prompt/completion callback surfaces as `-32603`
  Internal Error carrying the raw exception text — which loses the code and structured `data`
  and publishes whatever the exception happened to say. Never let that happen: throw typed.
- Put the recovery hint in the tool error's `text` — it is the only thing the model has.

## Typed subclasses

| Class | Code | Data |
| --- | --- | --- |
| `ResourceNotFoundError(uri)` | `-32602` | `{ uri }` — the code the spec mandates for a read miss; the SDK never emits `-32002` |
| `UrlElicitationRequiredError(elicitations)` | `-32042` | the elicitations; 2025 era only — the only error a tool handler can propagate there. On 2026-07-28 it is refused; use `inputRequired.elicitUrl` |
| `UnsupportedProtocolVersionError({supported, requested})` | `-32022` | lets the peer pick and retry |
| `MissingRequiredClientCapabilityError({requiredCapabilities})` | `-32021` | names what the client must declare |

Match by `code` + `data` shape when peers may run other SDK copies; `Class.isInstance(err)` is the
brand-aware static guard that narrows in TypeScript.

## ProtocolErrorCode table

`ParseError -32700`, `InvalidRequest -32600`, `MethodNotFound -32601`, `InvalidParams -32602`
(also the read-miss code), `InternalError -32603`, `ResourceNotFound -32002` (receive-tolerated
only), `MissingRequiredClientCapability -32021` and `UnsupportedProtocolVersion -32022` (both new in
`2026-07-28`), `UrlElicitationRequired -32042` (from `2025-11-25`; never sent on the `2026-07-28`
wire). The SDK's HTTP inbound checks also answer `-32020` HeaderMismatch (`MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` or `Mcp-Param-*` disagreeing with the body); it is not a
`ProtocolErrorCode` member.

v1 names `McpError` / `ErrorCode` do not exist in v2.

## input_required (server asks the client for input mid-call)

On modern connections the 2025-era push channels (`ctx.mcpReq.elicitInput`,
`ctx.mcpReq.requestSampling`) **throw**. The v2 way: the handler returns
`inputRequired(...)`; the client answers the embedded requests and **retries the call**; the
handler runs again with the responses. Works for `tools/call`, `prompts/get`, `resources/read`.

```ts
import { inputRequired, acceptedContent, createRequestStateCodec } from '@modelcontextprotocol/server';

type Confirmation = { op: 'deploy'; env: string };

// One codec per server. `verify` runs before every round that echoes state, so tampered, expired
// or rebound state never reaches the handler (-32602 "Invalid or expired requestState").
// `bind` ties state to the method and the verified caller; `principalOf` is your own lookup of the
// subject your bearer verification stored in `ctx.http?.authInfo`.
const stateCodec = createRequestStateCodec<Confirmation>({
  key: stateKey,
  ttlSeconds: 600,
  bind: ctx => `${ctx.mcpReq.method}\0${principalOf(ctx)}`
});
const server = new McpServer(info, { requestState: { verify: stateCodec.verify } });

async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
  // Honor a confirmation only on a round this handler opened, for this env and this caller.
  const state = ctx.mcpReq.requestState<Confirmation>();
  if (state?.op !== 'deploy' || state.env !== env) {
    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: confirmationSchema })
      },
      requestState: await stateCodec.mint({ op: 'deploy', env }, ctx)
    });
  }
  const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmationSchema);
  if (confirmed?.confirm !== true) {
    return { content: [{ type: 'text', text: 'Deployment cancelled; no changes made.' }], isError: true };
  }
  // Perform the authorized deployment here; return success only after it succeeds.
  await deploy(env);
  return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
}
```

Rules:

- **Ask once, on a round you opened**: `inputResponses` is client-supplied, so a first call can
  arrive carrying an accepted `confirm: true`. Honor an answer only when the verified
  `requestState` shows this handler asked, for this `env`, under the same `bind` value (method and
  verified caller, so another account or handler cannot reuse it); otherwise ask. On that round, decline,
  cancellation, accepted `false`, invalid content or a missing answer ends the call with
  `isError: true` and no write, and none reopens the prompt. Without the `verify` hook,
  `requestState()` returns the raw wire string, so the check fails closed and the handler keeps
  asking. The deployment above is illustrative third-party application code, not a capability of
  the qyl telemetry tools.
- **Write-once handlers**: one handler runs on every round — read each answer first, request only
  the keys still missing. `inputRequests` is a map; one round carries every outstanding request.
  `inputResponses` holds only the latest round; nothing else survives between rounds.
- **Builders**: `inputRequired.elicit` (form), `.elicitUrl` (out-of-band URL), `.createMessage`
  (sampling — deprecated), `.listRoots()` (deprecated). Each embedded request is checked against
  declared client capabilities; a missing one rejects with `-32021` before anything hits the wire.
- **Restricted elicitation schema**: flat object of primitives only — strings (incl. `z.email()`,
  `z.iso.date()` formats), numbers with inclusive bounds (`.min()`/`.max()`; `.positive()`/`.gt()`
  do NOT convert), booleans, enums (`z.enum` / `z.literal([...])`; a union of literals does not
  convert), multi-select enum arrays, `.optional()`, `.default()`. Nested objects and `.regex()`
  throw `TypeError` at build time. Refinements/transforms the wire can't advertise still hold on
  re-entry because `acceptedContent` validates with the original schema.
- **Reading answers**: `acceptedContent(responses, key, schema)` — validated, typed, `undefined`
  for missing/declined/cancelled alike. `inputResponse(responses, key)` returns the discriminated
  view (`missing`/`elicit`/`sampling`/`roots`) when a refusal must be told apart from first entry.
- **`requestState`** is the only cross-round memory, echoed byte-for-byte by the client —
  **attacker-controlled bearer proof**. Protect with `createRequestStateCodec({ key, ttlSeconds })`
  (HMAC-SHA256 `{ mint, verify }`; pass `verify` as `ServerOptions.requestState.verify`). The key
  must be at least 32 bytes (`RangeError` otherwise) and shared by every instance that may receive
  the echo; `ttlSeconds` defaults to 600. Signed, not encrypted — no secrets in the payload. Mint
  only what earlier rounds already proved.
- **Legacy shim** (on by default): on pre-2026 connections the SDK fulfils an `input_required`
  return by pushing real `elicitation/create`/`sampling/createMessage`/`roots/list` requests over
  the session and re-entering the handler. `ServerOptions.inputRequired.legacyShim: false` fails
  loudly instead.
- `inputRequired(spec)` throws `TypeError` unless spec has at least one of `inputRequests` /
  `requestState`.

## Elicitation modes

Form (in-band, `requestedSchema`) and URL (out-of-band: OAuth, payments, secrets — the
interaction happens outside the MCP client).

- **2026-07-28:** URL mode is an embedded request: return
  `inputRequired({ inputRequests: { key: inputRequired.elicitUrl({...}) } })`. There is no
  `elicitationId`; the client completes the out-of-band step and retries the call. The spec
  removed `notifications/elicitation/complete` and `elicitationId`.
- **2025 era only:** a tool that can't proceed without a URL visit may throw
  `UrlElicitationRequiredError` (`-32042`); the host opens the URL and the caller retries, and the
  server may send `notifications/elicitation/complete` when the step is done.
