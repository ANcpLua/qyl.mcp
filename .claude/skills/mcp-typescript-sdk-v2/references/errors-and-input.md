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
  exception: `UrlElicitationRequiredError` propagates as `-32042` so the host can open the URL.
- A non-`ProtocolError` thrown from a resource/prompt/completion callback surfaces as `-32603`
  Internal Error carrying the raw exception text — which loses the code and structured `data`
  and publishes whatever the exception happened to say. Never let that happen: throw typed.
- Put the recovery hint in the tool error's `text` — it is the only thing the model has.

## Typed subclasses

| Class | Code | Data |
| --- | --- | --- |
| `ResourceNotFoundError(uri)` | `-32602` | `{ uri }` — the code the spec mandates for a read miss; the SDK never emits `-32002` |
| `UrlElicitationRequiredError(elicitations)` | `-32042` | the elicitations; only error a tool handler can propagate |
| `UnsupportedProtocolVersionError({supported, requested})` | `-32022` | lets the peer pick and retry |
| `MissingRequiredClientCapabilityError({requiredCapabilities})` | `-32021` | names what the client must declare |

Match by `code` + `data` shape when peers may run other SDK copies; `Class.isInstance(err)` is the
brand-aware static guard that narrows in TypeScript.

## ProtocolErrorCode table

`ParseError -32700`, `InvalidRequest -32600`, `MethodNotFound -32601`, `InvalidParams -32602`
(also the read-miss code), `InternalError -32603`, `ResourceNotFound -32002` (receive-tolerated
only), `MissingRequiredClientCapability -32021`, `UnsupportedProtocolVersion -32022`,
`UrlElicitationRequired -32042`. The last three are new in `2026-07-28`.

v1 names `McpError` / `ErrorCode` do not exist in v2.

## input_required (server asks the client for input mid-call)

On modern connections the 2025-era push channels (`ctx.mcpReq.elicitInput`,
`ctx.mcpReq.requestSampling`) **throw**. The v2 way: the handler returns
`inputRequired(...)`; the client answers the embedded requests and **retries the call**; the
handler runs again with the responses. Works for `tools/call`, `prompts/get`, `resources/read`.

```ts
import { inputRequired, acceptedContent, inputResponse } from '@modelcontextprotocol/server';

async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
  const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmationSchema);
  if (confirmed?.confirm !== true) {
    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: confirmationSchema })
      }
    });
  }
  return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
}
```

Rules:

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
  (HMAC-SHA256 `{ mint, verify }`; pass `verify` as `ServerOptions.requestState.verify`). Signed,
  not encrypted — no secrets in the payload. Mint only what earlier rounds already proved.
- **Legacy shim** (on by default): on pre-2026 connections the SDK fulfils an `input_required`
  return by pushing real `elicitation/create`/`sampling/createMessage`/`roots/list` requests over
  the session and re-entering the handler. `ServerOptions.inputRequired.legacyShim: false` fails
  loudly instead.
- `inputRequired(spec)` throws `TypeError` unless spec has at least one of `inputRequests` /
  `requestState`.

## Elicitation modes

Form (in-band, `requestedSchema`) and URL (out-of-band: OAuth, payments, secrets — the
interaction happens outside the MCP client). When a tool can't proceed without a URL visit and
can't elicit, throw `UrlElicitationRequiredError` — the host opens the URL, then the caller
retries. Servers may send `notifications/elicitation/complete` when the out-of-band step is done.
