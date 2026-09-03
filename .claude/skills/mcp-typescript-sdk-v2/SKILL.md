---
name: mcp-typescript-sdk-v2
description: Authoritative reference for the MCP TypeScript SDK v2 (@modelcontextprotocol/core, server, client, node, express 2.x) as used by qyl.mcp. Use for any work touching McpServer, registerTool/registerResource/registerPrompt, ProtocolError and error channels, createMcpHandler, serveStdio, protocol eras (legacy 2025 vs modern 2026-07-28), input_required/MRTR, sessions, subscriptions, notifications, versionNegotiation, or Zod wire schemas. Always read the relevant reference file before asserting SDK behavior.
license: MIT
metadata:
  author: Alex + Claude
  version: "1.0.0"
  verified-against: |
    Installed packages in qyl.mcp: @modelcontextprotocol/{core,server,client,node,express} 2.0.0
    (server/package.json pins 2.0.0 exact). Upstream docs: modelcontextprotocol/typescript-sdk
    main @ 3924de9 (2026-08-18), which documents the v2 stable line.
    qyl.mcp usage surface grep-verified: registerTool (25 sites), isError (22), ProtocolError (9),
    setRequestHandler (3), ResourceNotFoundError (3), registerResource (2), registerPrompt (1).
---

# MCP TypeScript SDK v2 — Expert Reference

qyl.mcp is **already on v2**. This skill exists so no session regresses to v1 patterns
(`@modelcontextprotocol/sdk` deep imports, `tool()`, `McpError`/`ErrorCode`, `server.tool(...)`)
or asserts SDK behavior from memory. v1 is dead here: the monolithic `@modelcontextprotocol/sdk`
package is replaced by a split package family, and the v1 API names do not exist in it.

## Package map (what to import from where)

Nine published packages; qyl.mcp installs five:

| Package | Contains | qyl.mcp uses it for |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `McpServer`, `createMcpHandler`, `ProtocolError` + subclasses, `inputRequired`, OAuth server helpers (`requireBearerAuth`, `oauthMetadataResponse`) | the qyl MCP server |
| `@modelcontextprotocol/server/stdio` | `serveStdio`, `StdioServerTransport` (Node-only subpath) | stdio entry (`legacy: "reject"`) |
| `@modelcontextprotocol/client` | `Client`, `StreamableHTTPClientTransport`, `versionNegotiation` | dynamic foreign-server connections |
| `@modelcontextprotocol/core` | **Zod schema constants only** (`CallToolResultSchema`, `OAuthMetadataSchema`, …) | validating raw wire JSON (native-execution, oauth) |
| `@modelcontextprotocol/node` / `express` | Node/Express adapters over `createMcpHandler` | HTTP hosting |

Rules that follow from the split:

- **Package roots are runtime-neutral** (no Node builtins). Anything that spawns a process lives
  behind `./stdio` subpaths. Never import `StdioClientTransport` from the root — it doesn't exist there.
- **Types come from `server`/`client`; Zod schemas come from `core`.** Neither `server` nor `client`
  exports a Zod schema. If you need `.parse()` on wire JSON, import the `*Schema` constant from `core`.
- `server-legacy` and `codemod` are migration-only packages — never add them to qyl.mcp.

## The three contract rules (from AGENTS.md, upheld by the SDK docs)

1. **Registration boundary.** `registerTool` / `registerResource` / `registerPrompt` take a Zod
   schema; the SDK derives the advertised JSON Schema, validates arguments before the handler runs,
   and types the handler from that one schema. In qyl.mcp the schema at that boundary is the
   generated `@ancplua/qyl-api-schema` contract — never hand-write a second description of a shape
   a contract already publishes.
2. **Error channel matches handler kind.** A tool handler owns `isError` (return it, or throw and
   the SDK converts). A resource, prompt, or completion callback has no such channel — throw
   `ProtocolError` or a typed subclass. Details: `references/errors-and-input.md`.
3. **Seams before internals.** Registering a handler for a verb the SDK routes but leaves to the
   server is a seam; so is any exposed option. Reassigning a method the SDK owns binds you to
   registration order nothing enforces and fails silently. (qyl.mcp's `native-execution.ts` wraps
   `server.server.setRequestHandler` for telemetry — a delegating wrapper, deliberately accepted;
   do not add more of these without the same justification.)

## Protocol eras — the one fact to hold

An **era** is a behavior family decided once at connect time:

- **legacy** = `2024-10-07` … `2025-11-25`: `initialize` handshake, `Mcp-Session-Id` sessions,
  server-push `elicitInput`/`createMessage`, unsolicited `list_changed`.
- **modern** = `2026-07-28`: no `initialize` — `server/discover`; per-request stateless HTTP;
  server→client input via `return inputRequired(...)`; change notifications only over a
  client-opened `subscriptions/listen` stream; `_meta` envelope on every request.

qyl.mcp serves **both** eras over HTTP from one `createMcpHandler` factory (the factory receives
`{ era }`), and **rejects legacy on stdio** (`serveStdio(factory, { legacy: "reject" })`).
Sampling, roots, and the `logging/setLevel` capability are deprecated as of `2026-07-28`
(SEP-2577) — reach for elicitation via `input_required` first.

Full era matrix, serving patterns, sessions, notifications: `references/serving-and-eras.md`.

## Routing table

| Working on | Read first |
| --- | --- |
| Tools, resources, prompts, structured output, annotations, schema conversion | `references/server-api.md` |
| Error handling, `isError` vs `ProtocolError`, typed subclasses, error-code table | `references/errors-and-input.md` |
| `input_required` / MRTR, `requestState`, elicitation, legacy shim | `references/errors-and-input.md` |
| HTTP serving, stdio, sessions, resumability, notifications, `ServerEventBus`, scaling | `references/serving-and-eras.md` |
| Era negotiation, `versionNegotiation`, probe semantics, client transports | `references/serving-and-eras.md` |
| Raw wire validation with Zod | import `*Schema` from `@modelcontextprotocol/core`; that package is schemas-only |

## Sharp edges (each one verified, not guessed)

- **Zod v4 only** in qyl.mcp: `import * as z from "zod/v4"` — matches the SDK's own docs.
- The SDK **skips `outputSchema` validation** on any `isError: true` result.
- Schema-rejected tool arguments come back as an `isError: true` result — the handler never runs.
- A thrown `ProtocolError` **inside a tool handler** still becomes `isError: true` — it does not
  escape as a JSON-RPC error. The only tool-handler exception that propagates is
  `UrlElicitationRequiredError` (`-32042`).
- `ResourceNotFoundError` answers a `resources/read` miss with `-32602` (the SDK never emits
  `-32002`; that code is receive-tolerated only).
- `ctx.mcpReq.inputResponses` is **attacker-controlled**; validate through
  `acceptedContent(responses, key, schema)`, and protect `requestState` with
  `createRequestStateCodec` (HMAC-signed, not encrypted — no secrets in the payload).
- `registerTool` returns a **handle**; `update()`/`enable()`/`disable()`/`remove()` on it send the
  matching `list_changed` automatically — don't also call `sendToolListChanged()`.
- Behind `createMcpHandler` the `McpServer` instance is per-request: publish change notifications
  through **`handler.notify.*`**, never through the instance.
- TypeScript ≥6.0 does not auto-include `@types/*`: `"types": ["node"]` must stay in tsconfig
  (the published `.d.mts` references `Buffer`).
- Do not default a spawn-per-invocation CLI to `versionNegotiation: 'auto'` — on stdio the probe
  spawns a sibling process and can stall the full timeout against silent legacy servers.

## Verification protocol

Before asserting any SDK behavior not covered here: read the installed package's `.d.mts` under
`node_modules/@modelcontextprotocol/<pkg>/dist/`, or the upstream docs
(`ts.sdk.modelcontextprotocol.io/v2/`, source: `modelcontextprotocol/typescript-sdk` `docs/`).
The upstream repo pins wire-visible behavior in dedicated test files
(`docs/behavior-surface-pins.md`) — a claim that contradicts a pin is wrong.
When the pinned `2.0.0` is bumped, re-verify this skill's claims against the release notes before
trusting it, and update `metadata.verified-against`.
