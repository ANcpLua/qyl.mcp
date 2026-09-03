# Serving, sessions, and protocol eras

## Era matrix (the only copy — link here, don't re-explain)

| Axis | legacy (`2024-10-07`…`2025-11-25`) | modern (`2026-07-28`) |
| --- | --- | --- |
| Server HTTP entry | `*StreamableHTTPServerTransport` | `createMcpHandler` (`legacy: 'stateless'` default also serves 2025) |
| Server stdio entry | `server.connect(new StdioServerTransport())` | `serveStdio(factory)` (serves 2025 too unless `legacy: 'reject'`) |
| Client connect | `initialize` handshake | `server/discover` probe (`versionNegotiation`) |
| Client identity on server | `getClientCapabilities()` / `getClientVersion()` | `ctx.mcpReq.envelope` (per request) |
| Server→client requests | `ctx.mcpReq.elicitInput` / `requestSampling` | `return inputRequired(...)` |
| Change notifications | unsolicited `list_changed` / `resources/updated` | `subscriptions/listen` stream (client-opened) |
| Client cancel (HTTP) | POST `notifications/cancelled` | close the request's SSE response stream |
| `ctx.mcpReq.log()` filter | session `logging/setLevel` | per-request `logLevel` `_meta` key (absent = no logs) |
| HTTP 400 w/ JSON-RPC body | `SdkHttpError` | `ProtocolError`, in-band |
| Liveness | `client.ping()` | not defined |

Sessions and `Mcp-Session-Id` exist **only** in the legacy era. Deprecation ≠ era: sampling,
roots, and the `logging` capability are deprecated as of `2026-07-28` (SEP-2577) but stay in the
spec ≥12 months.

## HTTP serving — createMcpHandler (what qyl.mcp does)

```ts
const handler = createMcpHandler(({ era }) => {
  const server = new McpServer({ name: 'qyl', version: '…' });
  // register everything
  return server;
}, { onerror: reportError });
```

- Builds a **fresh server per request**, holds nothing between requests → stateless, scales
  horizontally with no session affinity. The factory receives the request's `era`.
- Default `legacy: 'stateless'` also serves 2025-era clients per request; `legacy: 'reject'`
  refuses them. qyl.mcp keeps the default on HTTP because most shipping clients are still 2025-era.
- Web-standard `Request`/`Response`; adapters (`@modelcontextprotocol/node` /`express`/`hono`/
  `fastify`) wire it into runtimes and add DNS-rebinding `Host`/`Origin` guards
  (`localhostHostValidation()` etc.). The guards answer rejected requests with `403` themselves —
  handler must not touch the request after a guard returns false.
- OAuth: `requireBearerAuth` (validates `Authorization: Bearer` via `OAuthTokenVerifier`),
  `mcpAuthMetadataRouter` / `oauthMetadataResponse` (RFC 9728 metadata),
  `getOAuthProtectedResourceMetadataUrl`.

## stdio serving

```ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
const handle = serveStdio(serverFactory, { legacy: 'reject', onerror: reportError });
// handle.close() on shutdown
```

qyl.mcp rejects legacy on stdio. `serveStdio` routes the instance's own `send*ListChanged()` /
`sendResourceUpdated()` onto its open subscription stream — no `notify` facade needed on stdio.

## Notifications on modern connections

Behind `createMcpHandler` the `McpServer` is per-request, so publish through the handler:

```ts
handler.notify.resourceUpdated('config://app');   // requires resources: { subscribe: true }
handler.notify.toolsChanged(); // promptsChanged(), resourcesChanged()
```

Delivery reaches every open `subscriptions/listen` stream that opted in. Multi-process: the
default `InMemoryServerEventBus` never leaves the process — implement the two-method
`ServerEventBus` (`publish`, `subscribe`) over shared pub/sub and pass `{ bus }` to every node's
`createMcpHandler`.

## Sessions (legacy era only — qyl.mcp does not use them)

`NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })` turns sessions on
(`undefined` = stateless). One transport instance = one session; keep a `Map<sessionId, transport>`,
build on `initialize`, store in `onsessioninitialized`, clean up in `transport.onclose`. Unknown
session id → 404 (client re-initializes); missing header on non-initialize → 400. Resumability:
pass an `eventStore` (`storeEvent` / `replayEventsAfter`); client reconnects with `Last-Event-ID`.

## Client — era negotiation

```ts
const client = new Client({ name, version }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
client.getProtocolEra(); // 'modern' | 'legacy'; undefined before connect, never changes after
```

- Default (no `versionNegotiation`) = the 2025 `initialize` handshake byte-for-byte, **no probe**.
- `mode: 'auto'` probes `server/discover`, falls back to `initialize` on 2025-only servers.
- `mode: { pin: '2026-07-28' }` never falls back — rejects with `SdkError(ERA_NEGOTIATION_FAILED)`.
- Skip the probe with a cached verdict: `ConnectOptions.prior` (`{ kind: 'modern', discover }` or
  `{ kind: 'legacy' }`). Freshness is the host's job — a stale legacy verdict succeeds silently
  against an upgraded server.
- Probe semantics: on stdio, silence = legacy (fallback); on HTTP, silence = outage
  (`SdkError(RequestTimeout)`). 401/403 are auth evidence, never era evidence. 5xx rejects with
  `SdkHttpError(EraNegotiationFailed)`. On `StdioClientTransport` exactly, the probe runs on a
  short-lived **sibling process** (some servers exit on pre-`initialize` requests); custom
  stdio-shaped transports probe in place.
- `supportedProtocolVersions` shapes the probe; a list with no pre-2026 entry removes the
  legacy fallback entirely.
- **Do not default a spawn-per-invocation CLI to `'auto'`** — probe cost per connect.

qyl.mcp imports `Client`, `StreamableHTTPClientTransport`, `FetchLike` from
`@modelcontextprotocol/client` for dynamic foreign-server connections (open-world MCP negotiation).
