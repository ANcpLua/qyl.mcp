# qyl.mcp `runner/src` — MCP 2026-07-28 living examples

These are the runnable MCP TypeScript SDK examples the runner relies on, kept for
protocol revision **2026-07-28**. The code blocks are the SDK's own — not paraphrased —
so the patterns below stay copy-accurate. Kept deliberately:

- **Stateless serving** — `serveStdio`, `createMcpHandler`, web-standard runtimes
- **`server/discover` negotiation** — protocol-version / era negotiation
- **`inputRequired` multi-round-trip** — elicitation / sampling / roots, in-band
- **`requestState`** — per-session-state replacement, HMAC-sealed
- **Per-request `logLevel`** — the modern log filter
- **The legacy shim** — serving `input_required` to 2025-era clients

Everything not kept here (Prompts, Completion, the Express/Hono/Fastify adapters, the
client tutorials, the v1 migration guides) is upstream at
<https://ts.sdk.modelcontextprotocol.io/v2/>; the full 8.7k-line mirror is also still
byte-identical in the other AGENTS.md copies in this repo. Engineering *rules* (not
examples) live in the single root contract: [`../../AGENTS.md`](../../AGENTS.md).

---

## Log to the client

::: warning Deprecated — SEP-2577
Log to `stderr` (stdio servers) or use OpenTelemetry instead. **MCP logging** is deprecated as of protocol version 2026-07-28 (SEP-2577) and stays functional through the deprecation window (at least twelve months) — see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated).
:::

Declare the `logging` capability when you construct the server.

```ts
const server = new McpServer({ name: 'file-processor', version: '1.0.0' }, { capabilities: { logging: {} } });
```

`ctx.mcpReq.log(level, data)` then sends a `notifications/message` from inside any handler — `data` is any JSON value.

```ts
server.registerTool(
    'validate-records',
    {
        description: 'Validate records before import',
        inputSchema: z.object({ records: z.array(z.string()) })
    },
    async ({ records }, ctx) => {
        await ctx.mcpReq.log('info', `Validating ${records.length} records`);
        const invalid = records.filter(record => !record.endsWith('.csv'));
        if (invalid.length > 0) {
            await ctx.mcpReq.log('warning', { invalid });
        }
        return { content: [{ type: 'text', text: `${records.length - invalid.length} of ${records.length} records are valid` }] };
    }
);
```

The connected client surfaces each one through its `notifications/message` handler.

```ts
client.setNotificationHandler('notifications/message', notification => {
    console.log(notification.params.level, notification.params.data);
});
```

Calling `validate-records` with one bad record delivers both log notifications before the result:

```
info Validating 2 records
warning { invalid: [ 'b.txt' ] }
[ { type: 'text', text: '1 of 2 records are valid' } ]
```

How the client's log level reaches `ctx.mcpReq.log` differs by protocol era — see [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).


---

# Sampling

::: warning Deprecated — SEP-2577
Call your LLM provider's API directly from your server instead. **Sampling** is deprecated as of protocol version 2026-07-28 (SEP-2577) and stays functional on 2025-era connections for at least twelve months — see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated).
:::

## Replace sampling with a direct provider call

Sampling routes an LLM call through the connected client: a tool handler sends a prompt, the host runs it through a model it controls, and the handler resumes with the completion. The 2026-07-28 revision removes the server-to-client request channel that carries it.

Migrate by importing your LLM provider's SDK into the server and calling it from the tool handler with your own API key. The handler keeps its shape; the `requestSampling` call is the only line that changes, and you stop depending on what the client supports.

## Request a completion from the client

`ctx.mcpReq.requestSampling` sends a `sampling/createMessage` request to the connected client from inside a tool handler. The client runs the messages through its model and resolves the call with the completion.

```ts
server.registerTool(
    'summarize',
    {
        description: 'Summarize text using the client LLM',
        inputSchema: z.object({ text: z.string() })
    },
    async ({ text }, ctx) => {
        const response = await ctx.mcpReq.requestSampling({
            messages: [{ role: 'user', content: { type: 'text', text: `Summarize in one sentence:\n\n${text}` } }],
            maxTokens: 500
        });
        return { content: [{ type: 'text', text: `Model (${response.model}): ${JSON.stringify(response.content)}` }] };
    }
);
```

The handler blocks until the client answers, so your server never holds the key for the model that does the work — the host does.

::: info
On a 2026-07-28 connection `requestSampling` throws. The replacement on that revision is returning an embedded `createMessage` request from the handler — [input_required](https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.md) owns that form. Era differences are listed in [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).
:::

## Read the model's reply

The response is a `CreateMessageResult`: the client decides which model fulfils the request and returns its name as `model`, plus the assistant `role` and one `content` block. The handler above folds it into its tool result, so calling `summarize` from a client whose model is named `host-model` returns:

```
[
  {
    type: 'text',
    text: 'Model (host-model): {"type":"text","text":"Sampling lets a tool ask the client for a completion."}'
  }
]
```

## Require the sampling capability

`requestSampling` only works against a client that declared the `sampling` capability and registered a `sampling/createMessage` handler — [Handle requests from the server](https://ts.sdk.modelcontextprotocol.io/v2/clients/server-requests.md) covers that side.

Pass `enforceStrictCapabilities: true` to the `McpServer` constructor and the SDK checks the client's declared capabilities before it sends any server-initiated request. Against a client that never declared `sampling`, `requestSampling` then throws inside your handler, and the call comes back as an ordinary `isError` tool result:

```
{
  content: [
    {
      type: 'text',
      text: 'Client does not support sampling (required for sampling/createMessage)'
    }
  ],
  isError: true
}
```

## Recap

- Sampling is deprecated (SEP-2577); the migration target is a direct LLM provider call from your server.
- `ctx.mcpReq.requestSampling({ messages, maxTokens })` asks the connected client's model for a completion mid-handler.
- The client picks the model; the result carries `model`, `role`, and `content`.
- On a 2026-07-28 connection `requestSampling` throws; the embedded-request form lives on the input_required page.
- The client must declare the `sampling` capability; `enforceStrictCapabilities: true` rejects the request before the wire when it did not.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.md
================================================================================

# input_required

An **`input_required`** result is how a `tools/call`, `prompts/get`, or `resources/read` handler asks the connected client for input mid-call: the handler returns the embedded requests, the client answers them and retries the call, and the handler runs again with the responses.

## Return `input_required` instead of pushing a request

The handler reads what already arrived with `acceptedContent`; while the answer is missing it returns `inputRequired(...)` instead of a tool result.

```ts
const confirmationSchema = z.object({
    confirm: z.boolean().meta({ title: 'Confirm deployment' })
});

server.registerTool(
    'deploy',
    {
        description: 'Deploy after the operator confirms',
        inputSchema: z.object({ env: z.string() })
    },
    async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmationSchema);
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Deploy to ${env}?`,
                        requestedSchema: confirmationSchema
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
    }
);
```

The first round converts `confirmationSchema` to MCP's restricted elicitation JSON Schema and returns it inside `resultType: 'input_required'`. The client fulfils the request and retries `deploy`; on re-entry `acceptedContent` validates the answer with that same schema and the handler finishes.

The restricted wire schema is a flat object of primitive properties, so only schemas that convert to that shape are accepted: strings (including the `email`, `uri`, `date`, and `date-time` formats — `z.email()`, `z.iso.date()`, and friends), numbers and their inclusive bounds (`.min()`/`.max()`; exclusive bounds like `.positive()` or `.gt()` do not convert), booleans, enums (`z.enum` or `z.literal(['a', 'b'])` — a union of literals does not convert), multi-select enum arrays, `.optional()`, and `.default()`. Anything the wire cannot express — nested objects, `.regex()` patterns, customized zod format patterns (`z.email({ pattern })`) — throws a `TypeError` when the request is built, before anything is sent. For non-zod libraries a pattern accompanying a supported format is treated as the library's own format regex and dropped from the wire. Constraints the wire cannot advertise at all (refinements, transforms) still hold on re-entry, because `acceptedContent` validates with the original schema.

Every call on this page comes from an in-memory `Client` with an `elicitation/create` handler — [Test a server](https://ts.sdk.modelcontextprotocol.io/v2/testing.md) shows that wiring. Calling `deploy` once produces both rounds:

```
[client] elicitation/create → Deploy to prod?
{ content: [ { type: 'text', text: 'Deployed to prod' } ] }
```

`inputRequired(spec)` throws a `TypeError` unless `spec` carries at least one of `inputRequests` or `requestState`. Each embedded request is checked against the capabilities the client declared; a missing capability rejects the call with `-32021` before anything reaches the wire.

::: info Coming from v1?
`ctx.mcpReq.elicitInput` and `ctx.mcpReq.requestSampling` are the 2025-era push channels — they throw on a 2026-07-28 request. See [Elicitation](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.md) and the [upgrade guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md).
:::

## Read the responses on re-entry

`ctx.mcpReq.inputResponses` comes from the client — treat it as untrusted. Pass a Zod schema as `acceptedContent`'s third argument and the value reaches your handler already validated and typed.

```ts
server.registerTool(
    'tag-release',
    {
        description: 'Tag a release after the operator confirms',
        inputSchema: z.object({ tag: z.string() })
    },
    async ({ tag }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        if (view.kind === 'elicit' && view.action !== 'accept') {
            return { content: [{ type: 'text', text: 'Tagging cancelled by the operator' }], isError: true };
        }
        const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ confirm: z.boolean() }));
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Tag ${tag}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Tagged ${tag}` }] };
    }
);
```

`acceptedContent` returns `undefined` for a missing, declined, or cancelled answer alike — re-issuing the request is the right move for all three only when the request is idempotent. `inputResponse` returns a discriminated view (`missing` / `elicit` / `sampling` / `roots`) when you need to tell a refusal from a first entry. A client that declines:

```
[client] elicitation/create → Tag v2.1.0?
{
  content: [ { type: 'text', text: 'Tagging cancelled by the operator' } ],
  isError: true
}
```

## Write the handler write-once

Write one handler that runs on every round: read each answer first, then request only the keys still missing. `inputRequests` is a map, so one round carries every outstanding request.

```ts
server.registerTool(
    'provision',
    { description: 'Provision a database', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const name = acceptedContent(ctx.mcpReq.inputResponses, 'name', z.object({ name: z.string() }));
        const region = acceptedContent(ctx.mcpReq.inputResponses, 'region', z.object({ region: z.string() }));
        if (name === undefined || region === undefined) {
            return inputRequired({
                inputRequests: {
                    ...(name === undefined && {
                        name: inputRequired.elicit({
                            message: 'Database name?',
                            requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
                        })
                    }),
                    ...(region === undefined && {
                        region: inputRequired.elicit({
                            message: 'Which region?',
                            requestedSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
                        })
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Provisioned ${name.name} in ${region.region}` }] };
    }
);
```

Round one finds neither key, so both requests go out together; round two finds both and the handler returns.

```
[client] elicitation/create → Database name?
[client] elicitation/create → Which region?
{
  content: [ { type: 'text', text: 'Provisioned analytics in eu-west-1' } ]
}
```

`inputResponses` holds only the latest round's answers, and nothing else on the server survives between rounds. A flow whose rounds must run in **sequence** carries what it has learned in `requestState`, below.

## Pick the embedded request kind

Each value in `inputRequests` is one embedded request, named by the builder that constructs it: `inputRequired.elicit` (form), `inputRequired.elicitUrl` (out-of-band URL), `inputRequired.createMessage` (sampling), and `inputRequired.listRoots()`.

```ts
const next = inputRequired({
    inputRequests: {
        confirm: inputRequired.elicit({
            message: 'Continue?',
            requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
        }),
        signin: inputRequired.elicitUrl({ message: 'Sign in to continue', url: 'https://example.com/auth' }),
        summary: inputRequired.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the diff' } }],
            maxTokens: 200
        }),
        roots: inputRequired.listRoots()
    }
});
```

`acceptedContent` only reads accepted form elicitations; read the sampling and roots responses through `inputResponse`, which discriminates all four kinds. [Elicitation](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.md) covers `requestedSchema` and URL mode in full.

::: warning
Sampling and roots are deprecated as of protocol revision 2026-07-28 (SEP-2577) — see [Sampling](https://ts.sdk.modelcontextprotocol.io/v2/servers/sampling.md). Reach for the elicitation builders first.
:::

## Carry state across rounds with `requestState`

To run rounds in sequence, return an opaque `requestState` string alongside the requests. The client echoes it back byte-for-byte on the retry, and `ctx.mcpReq.requestState<State>()` reads its decoded payload on re-entry. Mint it with the codec from the next section.

```ts
server.registerTool(
    'wipe-cache',
    { description: 'Confirm, then pick a scope, then wipe', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const state = ctx.mcpReq.requestState<{ step: string }>();

        if (state?.step !== 'confirmed') {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (confirmed?.confirm !== true) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Really wipe the cache?',
                            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                        })
                    }
                });
            }
            // Mint only what the response above already proved: the operator confirmed.
            return inputRequired({
                inputRequests: {
                    scope: inputRequired.elicit({
                        message: 'Which scope?',
                        requestedSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] }
                    })
                },
                requestState: await stateCodec.mint({ step: 'confirmed' })
            });
        }

        const scope = acceptedContent<{ scope: string }>(ctx.mcpReq.inputResponses, 'scope');
        return { content: [{ type: 'text', text: `Wiped ${scope?.scope ?? 'all'}` }] };
    }
);
```

Mint only what earlier rounds already proved. The token is bearer proof of whatever it claims: state minted as `{ step: 'confirmed' }` before the confirmation arrives grants that step to anyone who echoes it. One call drives all three entries:

```
[client] elicitation/create → Really wipe the cache?
[client] elicitation/create → Which scope?
{ content: [ { type: 'text', text: 'Wiped sessions' } ] }
```

## Protect `requestState` with the codec

`requestState` round-trips through the client and comes back as attacker-controlled input; the SDK applies no protection of its own. `createRequestStateCodec` returns an HMAC-SHA256 `{ mint, verify }` pair — pass `verify` as `ServerOptions.requestState.verify` and it runs before every handler entry that carries state.

```ts
const stateCodec = createRequestStateCodec<{ step: string }>({
    key: crypto.getRandomValues(new Uint8Array(32)), // >= 32 bytes; share it across instances in a fleet
    ttlSeconds: 600
});

const server = new McpServer({ name: 'releases', version: '1.0.0' }, { requestState: { verify: stateCodec.verify } });
```

With the hook in place, the accessor hands the handler `verify`'s decoded payload, and tampered or expired state never reaches the handler at all. Retrying `wipe-cache` with `requestState: 'tampered'` answers a wire-level protocol error:

```
-32602 Invalid or expired requestState
```

::: warning
The codec is signed, not encrypted — the client can base64url-decode the payload. Keep secrets out of it.
:::

## Let the shim serve older clients

The handlers above already serve every connection. On a connection that predates 2026-07-28, the SDK's legacy shim — on by default — fulfils an `input_required` return by pushing real `elicitation/create`, `sampling/createMessage`, and `roots/list` requests over the session, then re-enters the handler with the collected responses and the byte-exact `requestState` echo. Every result quoted on this page came from such a connection.

Set `ServerOptions.inputRequired.legacyShim: false` to fail loudly instead. Which revision a connection negotiates is covered in [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).

## Recap

- A handler asks for input by returning `inputRequired(...)`; the client answers the embedded requests and retries the call.
- `inputRequired(spec)` needs at least one of `inputRequests` or `requestState`, and throws a `TypeError` without one.
- `acceptedContent(ctx.mcpReq.inputResponses, key, schema)` validates the untrusted client answer before it reaches your code; `inputResponse` discriminates declines and the non-elicitation kinds.
- A write-once handler re-derives its position on every entry and requests only what is still missing.
- `requestState` is the only cross-round memory; protect it with `createRequestStateCodec` and mint only what earlier rounds proved.
- The legacy shim serves the same handlers to pre-2026-07-28 clients.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications.md
================================================================================


---

# Serve over stdio

A host that launches your server as a local child process talks to it over **stdio**: JSON-RPC requests arrive on stdin, responses leave on stdout. To host one endpoint that many clients connect to, serve the same factory over [HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md) instead.

## Serve a factory over stdio

`serveStdio` takes a factory; it owns the transport and calls the factory to build the instance that serves the connection.

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    // server.registerTool(...) — one factory builds the instance that serves the connection
    return server;
});
```

The process is now an MCP server. A host that spawns it lists and calls whatever the factory registered; until one does, the process waits on stdin.

::: info Coming from v1?
`serveStdio` replaces the `new StdioServerTransport()` + `server.connect(transport)` wiring — run the codemod, then see the [upgrade guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md).
:::

::: info
`serveStdio` serves older clients from the same factory by default; the `legacy` option and the full story are on [Legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.md). The entry also owns which protocol revision each connection negotiates — see [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).
:::

## Log to stderr, never stdout

Announce readiness with `console.error`, which writes to stderr.

```ts
console.error('notes server is listening on stdio');
```

stdout is the JSON-RPC channel: the host parses every line of it as a protocol message. Add one `console.log('debug: starting the notes server')` to the program above and send it an `initialize` request. Its two output streams now carry:

```
[stdout] debug: starting the notes server
[stdout] {"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"notes","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
[stderr] notes server is listening on stdio
```

The protocol channel opens with a line no JSON-RPC parser accepts, ahead of the `initialize` response. The `console.error` banner went to stderr, which the host keeps out of the channel and shows in its server log.

## Test it with the Inspector

The **MCP Inspector** launches your server command itself and connects to it over stdio.

```sh
npx @modelcontextprotocol/inspector node ./build/server.js
```

In the browser tab it opens, click **Connect**; the **Tools** tab lists and calls everything the factory registered, without configuring the server in a host.

## Shut down cleanly

`serveStdio` returns a **`StdioServerHandle`**; its `close()` tears down the pinned server instance and the transport.

```ts
process.on('SIGINT', () => {
    void handle.close();
});
```

`close()` resolves once the instance the factory built and the underlying transport are both shut down.

## Recap

- `serveStdio(factory)` is the stdio entry point: it owns the transport and calls your factory to build the instance that serves the connection.
- stdout is the protocol channel; log with `console.error`.
- One `console.log` puts a line no JSON-RPC parser accepts into the stream the host parses.
- `npx @modelcontextprotocol/inspector <command>` exercises a stdio server without configuring it in a host.
- The returned `StdioServerHandle`'s `close()` tears down the pinned instance and the transport.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md
================================================================================

# Serve over HTTP

To host one MCP endpoint that many clients connect to, serve your factory over **Streamable HTTP**. A host that launches the server as a local child process speaks [stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.md) instead.

## Create a handler

`createMcpHandler` takes a **factory** — a function that builds and returns a fresh `McpServer` — and returns the handler that serves it.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
        'add-note',
        {
            description: 'Save a note',
            inputSchema: z.object({ text: z.string() })
        },
        async ({ text }) => ({ content: [{ type: 'text', text: `Saved: ${text}` }] })
    );
    return server;
});
```

`handler.fetch` is a web-standard `(Request) => Promise<Response>` — nothing is listening yet. The tool calls on this page come from a real `Client` driving the handler's `fetch` in process; [Test a server](https://ts.sdk.modelcontextprotocol.io/v2/testing.md) shows that wiring.

Calling `add-note` through it returns the tool result:

```
[ { type: 'text', text: 'Saved: ship the release notes' } ]
```

The handler also carries `close` for shutdown and the `notify`/`bus` pair that publishes change events to subscribed clients — see [Notifications](https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications.md).

::: info Coming from v1?
`createMcpHandler` replaces the per-request `StreamableHTTPServerTransport` + `connect()` wiring — run the codemod, then see the [upgrade guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md).
:::

## Understand the per-request factory

The factory runs once per HTTP request: a fresh instance serves every request, and the handler holds nothing between requests. Register tools, resources, and prompts inside the factory, never on a shared instance outside it.

The factory receives the **request context** — `era`, `authInfo`, and the inbound `Request` as `requestInfo`. Destructure `authInfo` to build the instance around one caller; [Pass authentication through](#pass-authentication-through) shows where the value comes from.

```ts
const perCaller = createMcpHandler(({ authInfo }) => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Name the authenticated caller' }, async () => ({
        content: [{ type: 'text', text: authInfo?.clientId ?? 'anonymous' }]
    }));
    return server;
});
```

Every request now gets an instance built for its own caller. Keep the factory cheap and side-effect-free: create connection pools and caches once at module scope and close over them.

`era` names the protocol revision the request speaks — see [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).

Because no state lives on the instance, the endpoint is stateless and scales horizontally as-is; sessions, resumability, and multi-node fan-out are their own page, [Sessions, state, and scaling](https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.md).

## Mount it on your runtime

On a web-standard runtime — Cloudflare Workers, Deno, Bun — `export default handler` is the entire mount. Node frameworks wrap the handler once with `toNodeHandler` from `@modelcontextprotocol/node`; on plain `node:http`, bind loopback explicitly and compose the `localhostHostValidation` / `localhostOriginValidation` guards (also from `@modelcontextprotocol/node`) in front of it, matching the framework factories' defaults:

```ts
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
}).listen(3000, '127.0.0.1');
```

`POST http://127.0.0.1:3000/mcp` now reaches the factory; the guards answer anything else with `403` before the handler sees it — [the next section](#validate-host-and-origin-in-front-of-it) explains why they belong in front. The same wrapped handler mounts under [Express](https://ts.sdk.modelcontextprotocol.io/v2/serving/express.md), [Fastify](https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.md), and [Hono](https://ts.sdk.modelcontextprotocol.io/v2/serving/hono.md); [Serve on web-standard runtimes](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.md) covers the `export default` side.

## Validate Host and Origin in front of it

The handler trusts its caller: it validates no `Host` header, no `Origin` header, and no token. Mount those checks in front of it — on a localhost bind, the `Host` check is what stops **DNS rebinding**, a malicious page resolving its own domain to `127.0.0.1` so the browser treats your local server as same-origin.

Under a framework you never wire either check by hand: `createMcpExpressApp`, `createMcpHonoApp`, and `createMcpFastifyApp` all arm both by default on localhost binds — the [Express](https://ts.sdk.modelcontextprotocol.io/v2/serving/express.md), [Hono](https://ts.sdk.modelcontextprotocol.io/v2/serving/hono.md), and [Fastify](https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.md) recipes start there. On plain `node:http`, compose `localhostHostValidation` and `localhostOriginValidation` (from `@modelcontextprotocol/node`) in front of the wrapped handler, as [the mount above](#mount-it-on-your-runtime) does. On a bare fetch runtime, put `hostHeaderValidationResponse` and `originValidationResponse` (from `@modelcontextprotocol/server`) in front of `handler.fetch` — [Serve on web-standard runtimes](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.md#protect-against-dns-rebinding) builds that wrapper.

## Pass authentication through

`authInfo` is pass-through: the handler never reads it from headers and never verifies a token. Verify the bearer token in front of the handler and hand it the result as `fetch`'s second argument, `handler.fetch(request, { authInfo })`; the factory reads it back as `authInfo`, and tool handlers as `ctx.http.authInfo`.

Under a Node framework the verifying middleware runs first and `toNodeHandler` forwards what it sets — each recipe shows its own mount, and [Require authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md) builds the verifier with `requireBearerAuth`.

With an `AuthInfo` whose `clientId` is `alice`, `whoami` from [the factory above](#understand-the-per-request-factory) answers:

```
[ { type: 'text', text: 'alice' } ]
```

## Shape the response stream

The handler answers a request with a single JSON body and upgrades to an SSE stream only when a tool handler emits a notification — progress, logging — before its result. `responseMode` pins one shape instead.

```ts
const jsonOnly = createMcpHandler(factory, { responseMode: 'json' });
```

`'json'` never streams: the SDK drops mid-call notifications and delivers only the terminal result. `'sse'` always streams. `subscriptions/listen` streams stay on SSE whichever you pick.

::: info
The handler serves 2025-era clients statelessly from the same factory by default. The `legacy` option — and where the SSE transport went — is on [Support legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.md).
:::

## Shut down

`handler.close()` aborts in-flight exchanges and closes their per-request instances; the handler holds nothing else.

```ts
process.on('SIGINT', async () => {
    await handler.close();
    process.exit(0);
});
```

`close()` resolves once every in-flight instance has closed; `fetch` then throws on any further request.

## Recap

- `createMcpHandler(factory)` returns `{ fetch, close, notify, bus }`; `fetch` is a web-standard `(Request) => Promise<Response>`.
- The factory builds one fresh instance per request and receives `era`, `authInfo`, and `requestInfo`.
- `export default handler` mounts it on web-standard runtimes; `toNodeHandler(handler)` mounts it once under Node frameworks.
- The handler validates no `Host` or `Origin` header and verifies no token — mount both checks in front of it; the framework app factories arm the header checks for you.
- `authInfo` flows from `fetch(request, { authInfo })` into the factory and tool handlers; each framework recipe shows its own mount.
- `responseMode` pins the response shape; `'json'` drops mid-call notifications.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/serving/express.md
================================================================================


---

# Serve on web-standard runtimes

```sh
npm install @modelcontextprotocol/server
```

## Mount the handler

`createMcpHandler` returns a `{ fetch }` object — the shape Cloudflare Workers, Deno, and Bun expect from a module's default export — so `export default handler` mounts it.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('add-note', { description: 'Append a note', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: `Saved: ${text}` }]
    }));
    return server;
});

export default handler;
```

The deployed worker answers MCP requests on every path, with no Node adapter and no body middleware. The factory runs once per request, so a fresh `McpServer` serves every call: [Serve over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md#understand-the-per-request-factory) covers that model.

## Protect against DNS rebinding

The handler performs no `Host` or `Origin` validation, and on a bare fetch-native runtime there is no app factory to arm it for you. Put the framework-agnostic response helpers in front of `fetch`.

```ts
import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';

const guarded = {
    async fetch(request: Request): Promise<Response> {
        const rejected =
            hostHeaderValidationResponse(request, ['api.example.com']) ?? originValidationResponse(request, ['app.example.com']);
        return rejected ?? handler.fetch(request);
    }
};
```

A request whose `Host` is not on the list gets `403` before `handler.fetch` runs; both helpers take hostnames, port-agnostic, and a request without an `Origin` header always passes. For a localhost-only process, `localhostAllowedHostnames()` and `localhostAllowedOrigins()` (same package) replace the explicit lists.

## Forward auth and the parsed body

There is no body middleware on a fetch-native runtime — `fetch` reads the `Request` itself, so there is no `parsedBody` to forward. The handler never derives auth from request headers either: verify the token yourself and pass the result as `fetch`'s second argument, and handlers read it as `ctx.http.authInfo`.

```ts
const secured = {
    async fetch(request: Request): Promise<Response> {
        const authInfo = await verifyToken(request);
        return handler.fetch(request, { authInfo });
    }
};
```

`verifyToken` is your token verification. [Authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md) covers verifying bearer tokens and serving the OAuth metadata documents.

## Run it and verify

Deploy the default export on your runtime — `wrangler dev server.ts` puts it on `http://127.0.0.1:8787`; `deno serve server.ts` and `bun run server.ts` serve the same `{ fetch }` shape. POST a `tools/list` request to it.

```sh
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response is a single SSE `message` event carrying the `tools/list` result:

```
event: message
data: {"result":{"tools":[{"name":"add-note","description":"Append a note","inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"text":{"type":"string"}},"required":["text"]}}]},"jsonrpc":"2.0","id":1}
```

## Recap

- One install line, one file: the handler `createMcpHandler` returns is already the `{ fetch }` default export web-standard runtimes serve.
- No Node adapter and no body middleware are involved.
- A fresh server instance from your factory serves every request.
- The handler does no `Host`/`Origin` validation; on a bare runtime, put `hostHeaderValidationResponse` and `originValidationResponse` in front of it.
- Auth is pass-through via `handler.fetch`'s second argument; handlers read it as `ctx.http.authInfo`.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.md
================================================================================

# Sessions, state, and scaling

`createMcpHandler` builds a fresh server instance from your factory for every HTTP request and holds nothing between requests, so a v2 server is stateless and scales horizontally by default — [Serve over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md) is the whole setup. Read on if you run a sessionful 2025-era deployment, need a dropped stream to resume, or push change notifications across nodes.

## Pin a client to a session

A **session** pins a client to one long-lived transport instance; sessions belong to the hand-wired 2025-era transport — the 2026-07-28 revision is per-request and has no `Mcp-Session-Id` ([Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md)). On `NodeStreamableHTTPServerTransport`, `sessionIdGenerator` turns sessions on; leaving it `undefined` is stateless mode.

```ts
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { randomUUID } from 'node:crypto';

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});
```

The transport answers `initialize` with the generated id in an `Mcp-Session-Id` response header and rejects later requests that arrive without it. The SDK's `StreamableHTTPClientTransport` sends the header back on every request with no configuration.

One transport instance is one session, so a sessionful deployment keeps a map: build a transport when `initialize` arrives, store it in `onsessioninitialized`, and route every later request to the transport that owns its `Mcp-Session-Id`. This Express route handles all three verbs — `POST`, the `GET` notification stream, and `DELETE` ([Serve with Express](https://ts.sdk.modelcontextprotocol.io/v2/serving/express.md) covers the app itself).

```ts
const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

const route = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res, req.body);
        return;
    }
    if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                sessions.set(id, transport);
            }
        });
        transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
    }
    if (sessionId) {
        // Unknown session id: the client should start a new session.
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
    }
    // No session header on a non-initialize request: the request is malformed.
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' }, id: null });
};

app.post('/mcp', route);
app.get('/mcp', route);
app.delete('/mcp', route);
```

The map cleans itself up: `transport.onclose` fires when the session ends, whether the client sent `DELETE` or you called `transport.close()`. A request with an unknown `Mcp-Session-Id` gets the `404` above, which tells the client to start a new session; a request with no session header at all gets the `400`, which tells it to re-send the id it already has instead of re-initializing.

::: tip
On shutdown, close every stored transport — `for (const [, transport] of sessions) await transport.close()` — before exiting; `close()` ends the session's SSE streams and rejects its pending requests.
:::

## Resume a dropped stream

A sessionful client holds a `GET` SSE stream open for server notifications, and anything sent while that connection is down is lost. An **event store** closes the gap: with one configured, the transport stamps every SSE message with an event id from the store before sending it.

`EventStore` is a two-method contract — `storeEvent(streamId, message)` persists a message and returns its event id; `replayEventsAfter(lastEventId, { send })` re-sends every later message on that stream. Implement it over storage every node can reach (`databaseEventStore` here) and pass it next to `sessionIdGenerator`.

```ts
const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: databaseEventStore
});
```

When the connection drops, the client reconnects with the last event id it received as a `Last-Event-ID` header and the transport replays everything stored after it. The SDK's `StreamableHTTPClientTransport` reconnects and sends that header on its own.

::: tip
`examples/shared/src/inMemoryEventStore.ts` in the SDK repository is a complete `EventStore` reference implementation — in memory, so single-process only.
:::

## Scale across nodes

The stateless default is the scaling story: every node builds a fresh instance from the same factory and holds nothing between requests, so put the nodes behind any load balancer — no session affinity, nothing to share, nothing to configure.

Sessionful 2025-era nodes hold their sessions in process memory, so they scale two ways. **Persistent storage**: keep `sessionIdGenerator` and point every node at the same `eventStore`, so a dropped stream is resumable from any node that shares the store. **Local state with message routing**: keep per-node sessions and send each session's traffic to the node that owns it — load-balancer affinity, or pub/sub routing between nodes.

One thing still crosses nodes on a stateless deployment: `subscriptions/listen`. Its streams deliver the change events published on the handler's **`ServerEventBus`** ([Notifications](https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications.md)), and the default bus is in-process — `handler.notify.toolsChanged()` on node A never reaches a subscriber whose stream node B holds. Implement `ServerEventBus` over your pub/sub (`publish(event)` forwards to the broker; `subscribe(listener)` registers for events arriving from it) and hand one to every node's `createMcpHandler`.

```ts
const handler = createMcpHandler(buildServer, { bus: redisBus });
```

Now `handler.notify.resourceUpdated(uri)` on any node publishes through the shared bus, and every node delivers the notification to its own open subscription streams.

## Recap

- `createMcpHandler` builds a fresh server per request and holds nothing between requests, so stateless nodes scale behind any load balancer with no session affinity.
- Sessions belong to the hand-wired 2025-era transport: `sessionIdGenerator` turns them on, and responses carry `Mcp-Session-Id`.
- A sessionful deployment keeps one transport per session and routes every request to it by that header; unknown ids get a `404`.
- An `eventStore` makes a dropped SSE stream resumable: the client reconnects with `Last-Event-ID` and the transport replays what it missed.
- `subscriptions/listen` scales across nodes by handing every node's `createMcpHandler` the same `ServerEventBus`.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md
================================================================================


---

# Support legacy clients

A **legacy client** speaks a 2025-era protocol revision: it opens with `initialize` and sends no per-request `_meta` envelope. Both serving entry points answer those clients from the same factory that serves modern ones; the `legacy` option decides whether they keep doing it. [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md) covers the era model itself.

## Choose a legacy posture

[`createMcpHandler`](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md) has two postures. The default, `legacy: 'stateless'`, serves each legacy request from a fresh instance out of your factory, with no sessions. `legacy: 'reject'` makes the endpoint modern-only.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const buildServer = () => new McpServer({ name: 'notes', version: '1.0.0' });

const strict = createMcpHandler(buildServer, { legacy: 'reject' });
```

A 2025-era `initialize` POST to the strict handler gets HTTP `400` and the unsupported-protocol-version error naming the one revision the endpoint serves:

```
400
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version: 2025-06-18",
    "data": {
      "supported": [
        "2026-07-28"
      ],
      "requested": "2025-06-18"
    }
  },
  "id": 1
}
```

Drop the option and the same request gets a normal 2025 `InitializeResult` from a fresh instance, torn down when the exchange ends. Per request means no sessions: under the default posture a legacy `GET` (the standalone SSE stream) and `DELETE` (session termination) answer `405 Method not allowed.` — a client that needs those needs the routing below.

::: tip
A strict endpoint still acknowledges legacy-classified notification POSTs with `202` — and then drops them. Legacy `GET` and `DELETE` answer `405` there too.
:::

## Choose the same posture on stdio

[`serveStdio`](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.md) takes the same option with a different default — `'serve'` — and applies it once per connection, not per request.

```ts
serveStdio(buildServer, { legacy: 'reject' });
```

Under `'serve'` a 2025-era opening pins the connection to a legacy instance from your factory and serves it exactly as a hand-wired stdio server would. Under `'reject'` the entry answers the opening with the same unsupported-protocol-version error and keeps the connection open for a modern opening.

## Keep a sessionful 2025 deployment running

Neither entry point accepts a handler as the `legacy` value. To keep an existing sessionful deployment serving the 2025 clients it already has, route in front of a strict handler with `isLegacyRequest` — the entry's own classification step exported as a predicate, so the branch never disagrees with `createMcpHandler`.

```ts
import { isLegacyRequest, legacyStatelessFallback } from '@modelcontextprotocol/server';

const legacy = legacyStatelessFallback(buildServer);

async function serve(request: Request): Promise<Response> {
    if (await isLegacyRequest(request)) {
        return legacy(request);
    }
    return strict.fetch(request);
}
```

`legacyStatelessFallback(factory)` is the entry's default legacy serving as a standalone handler — it holds the legacy leg's place here. Put your existing wiring there instead and it keeps its sessions, its event store, and its clients: [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts) runs a sessionful `StreamableHTTPServerTransport` deployment behind this exact branch. Route every `false` to the strict handler — the modern path owns the error answers for malformed modern requests.

The `initialize` the strict handler rejected above now completes the 2025 handshake on the legacy leg:

```
200
{
  protocolVersion: '2025-06-18',
  capabilities: {},
  serverInfo: { name: 'notes', version: '1.0.0' }
}
```

::: tip
Behind an Express body parser the Node stream is already drained: build the `Request` the predicate takes with `toWebRequest(req, req.body)` from `@modelcontextprotocol/node`.
:::

## Know where SSE went

The v2 server never serves the HTTP+SSE transport. An SSE server moving to v2 moves to Streamable HTTP — `createMcpHandler` above — as part of the [v2 upgrade](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md).

The client side keeps `SSEClientTransport`, so a v2 `Client` still reaches old SSE servers. For a server deployment that cannot move yet, a frozen v1 copy of the transport ships as `@modelcontextprotocol/server-legacy/sse` (deprecated).

## Recap

- Both entry points serve 2025-era clients from the same factory by default; `legacy: 'reject'` makes an endpoint modern-only.
- The default HTTP posture is per request and stateless: legacy `GET` and `DELETE` session operations answer `405`.
- `serveStdio` decides the era once per connection; its default is `'serve'`.
- `isLegacyRequest` in front of a strict handler keeps an existing sessionful 2025 deployment serving its clients.
- The v2 server never serves SSE; the frozen v1 transport is `@modelcontextprotocol/server-legacy/sse`, and the client keeps `SSEClientTransport`.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.md
================================================================================


---

# Protocol versions

## Name the two eras

An **era** is a behavior family, not a version string. Every protocol revision from `2024-10-07` through `2025-11-25` opens with the `initialize` handshake and shares one wire behavior — the SDK calls that family `legacy`. The `2026-07-28` revision starts the `modern` era: no `initialize`, a `server/discover` advertisement instead, and a `_meta` envelope on every request.

The SDK speaks both eras from the same `Client` and serves both from the same entry points. A connection's era is decided once, at connect time, and every difference it implies is in [the matrix below](#compare-the-eras).

## Negotiate the era from the client

`versionNegotiation` picks which handshake `connect()` performs. `mode: 'auto'` probes the server with `server/discover` and connects on whichever era it finds.

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

console.log(client.getProtocolEra());
```

`http://localhost:3000/mcp` is a `createMcpHandler` server — [built below](#serve-both-eras-from-one-entry-point) — so the probe finds the 2026-07-28 era:

```
modern
```

Point the same options at a 2025-only server and `connect()` falls back to the `initialize` handshake — one extra round trip, no error (on the SDK's stdio transport the probe rides a disposable sibling process; see below).

```ts
const fallback = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await fallback.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp')));

console.log(fallback.getProtocolEra());
```

`getProtocolEra()` reports the era the connection landed on; it returns `undefined` before `connect()` resolves and never changes after it.

```
legacy
```

## Pin an era

`mode` takes three values; the first is the default.

- Absent, or `mode: 'legacy'` — the 2025 `initialize` handshake, byte for byte. No probe.
- `mode: 'auto'` — probe with `server/discover`; fall back to `initialize` against a 2025-only server.
- `mode: { pin: '2026-07-28' }` — that revision or nothing. A pin never falls back.

Pin against the same 2025-only server and `connect()` rejects instead of falling back.

```ts
import { SdkError } from '@modelcontextprotocol/client';

const pinned = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

try {
    await pinned.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp')));
} catch (error) {
    if (error instanceof SdkError) console.log(`${error.code}: ${error.message}`);
}
```

The rejection is a typed, local `SdkError` — nothing reaches the server beyond the probe:

```
ERA_NEGOTIATION_FAILED: Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)
```

## Skip the probe with a cached verdict

`mode: 'auto'` pays the probe on every fresh connect. A host that already knows the server's era — from a registry entry, or an earlier connection's outcome — skips it by supplying `ConnectOptions.prior`, the exported `PriorDiscovery` type: `{ kind: 'modern', discover }` adopts a previously obtained `DiscoverResult` with zero round trips, and `{ kind: 'legacy' }` goes straight to the `initialize` handshake.

Freshness is the host's job, not the SDK's: a stale modern verdict fails loudly at the first request, but a stale legacy verdict succeeds silently against an upgraded server — so date cached legacy verdicts in your own storage and stop supplying them past your policy horizon. [Caching discovery verdicts](https://ts.sdk.modelcontextprotocol.io/v2/advanced/gateway.md#caching-discovery-verdicts) shows the full loop, including the re-probe that re-populates the cache.

## Understand the probe

`probe` bounds the `server/discover` round trip that `'auto'` and a pin run before anything else.

```ts
const cli = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        versionNegotiation: {
            mode: 'auto',
            probe: {
                timeoutMs: 10_000, // default: the connection's request timeout
                maxRetries: 0 // default: no probe re-sends after a timeout
            }
        }
    }
);
```

A probe timeout is transport-aware. On stdio a silent server is a legacy server, so `connect()` falls back to `initialize`; on HTTP silence is an outage, so `connect()` rejects with `SdkError(RequestTimeout)` instead of misreporting a dead server as legacy. One browser exception: an opaque CORS `TypeError` during the probe falls back to the legacy era, because deployed 2025 servers commonly have allow-lists that predate the 2026 headers.

On the SDK's own stdio transport (exactly `StdioClientTransport` — subclasses, like custom stdio-shaped transports, probe in place) the probe runs on a short-lived **sibling process** spawned from the same parameters — some stdio servers exit on any pre-`initialize` request (servers built on the official Rust SDK, rmcp, behave this way), so the probe must not spend the caller's one child process. The sibling is invisible infrastructure: its stderr is discarded and it is reaped once the era is known; the caller's transport spawns exactly once, afterwards, and its wire never carries `server/discover`. A child that exits on the probe is simply a legacy server (its exit must close the child's stdio pipes to register — an exit hidden behind a helper process holding them open falls to the probe-timeout path). Closing the caller's transport during the probe aborts `connect()` with a typed `SdkError(EraNegotiationFailed)` and the session child is never spawned. On HTTP — and on custom stdio-shaped transports, which probe in place — a mid-probe connection close rejects with the same typed error as any probe transport failure.

The client's `supportedProtocolVersions` option shapes the probe: its 2026+ entries are the versions the probe offers, and the legacy fallback stays available only while the list keeps a pre-2026 entry. A list with no pre-2026 entry removes the fallback — against a 2025-only server, `connect()` rejects with `SdkError(EraNegotiationFailed)`.

::: warning
Do not default a spawn-per-invocation CLI tool to `'auto'`. On stdio, a legacy server that never answers unknown pre-`initialize` requests stalls `connect()` for the full probe timeout before falling back, and the probe spawns an extra short-lived server process per connect. Keep the default and expose `'auto'` (or a pin) as a flag.
:::

## Serve both eras from one entry point

`createMcpHandler` is the HTTP entry that answered both clients above: it builds a fresh server per request and passes the factory the `era` that request belongs to.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(({ era }) => {
    const server = new McpServer({ name: 'forecast', version: '1.0.0' });
    server.registerTool(
        'forecast',
        {
            description: 'Forecast for a city',
            inputSchema: z.object({ city: z.string() })
        },
        async ({ city }) => ({ content: [{ type: 'text', text: `${city}: sunny (${era} era)` }] })
    );
    return server;
});
```

By default the handler also serves 2025-era traffic per request (`legacy: 'stateless'`); pass `legacy: 'reject'` to refuse it. Connect one more client with the default mode to the same URL — no probe, the 2025 handshake — and call the tool from both.

```ts
const defaultClient = new Client({ name: 'my-client', version: '1.0.0' });

await defaultClient.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

for (const caller of [client, defaultClient]) {
    const result = await caller.callTool({ name: 'forecast', arguments: { city: 'Berlin' } });
    console.log(caller.getProtocolEra(), JSON.stringify(result.content));
}
```

One endpoint, one factory, two eras — and the era reached the handler:

```
modern [{"type":"text","text":"Berlin: sunny (modern era)"}]
legacy [{"type":"text","text":"Berlin: sunny (legacy era)"}]
```

On stdio, `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` is the same shape per connection: the opening exchange pins the connection's era, and `legacy: 'reject'` refuses 2025 openings. [Serve legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.md) owns the `legacy` option and the hosting recipes for both entries.

## Compare the eras

This table is the only copy of the era differences in these docs. `getProtocolEra()` on the client and the factory's `era` on the server tell you which column you are in.

| Axis                                  | 2025 era (`'legacy'`, `2024-10-07` … `2025-11-25`)                       | 2026 era (`'modern'`, `2026-07-28`)                                |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Server HTTP entry                     | `*StreamableHTTPServerTransport`                                         | `createMcpHandler` (`legacy: 'stateless'` also serves 2025)        |
| Server stdio entry                    | `server.connect(new StdioServerTransport())`                             | `serveStdio(factory)` (also serves 2025 unless `legacy: 'reject'`) |
| Client connect                        | `initialize` handshake                                                   | `server/discover` probe (`versionNegotiation`)                     |
| Client identity on the server         | `getClientCapabilities()` / `getClientVersion()` (initialize-scoped)     | `ctx.mcpReq.envelope` (per request)                                |
| Server→client requests                | `ctx.mcpReq.elicitInput` / `requestSampling`, instance `createMessage()` | `return inputRequired(...)` from the handler                       |
| Change notifications                  | unsolicited `list_changed` / `resources/updated`                         | `subscriptions/listen` stream                                      |
| Client cancellation (Streamable HTTP) | POST `notifications/cancelled`                                           | close the request's SSE response stream                            |
| `ctx.mcpReq.log()` level filter       | session-scoped `logging/setLevel`                                        | per-request `logLevel` `_meta` envelope key (absent = no logs)     |
| HTTP `400` with a JSON-RPC error body | `SdkHttpError`                                                           | `ProtocolError`, delivered in-band                                 |
| Era-mismatched spec method (outbound) | n/a                                                                      | `SdkError(MethodNotSupportedByProtocolVersion)`                    |

## Separate deprecation from era

Deprecation is not an era difference. `sampling`, `roots`, and the `logging` capability behind `ctx.mcpReq.log()` are deprecated as of `2026-07-28` (SEP-2577) but stay in the specification for at least twelve months; which API carries each one on a given connection is an era difference, and already has its row in the matrix above. Each deprecated surface opens its own page with a sunset banner naming the migration target; nothing in the matrix moves when a deprecation lands.

## Link here instead of explaining inline

Era differences live on this page and nowhere else. Every other page in these docs spends at most one sentence on an era and links here; do the same in your own server's documentation.

> The wire encoding of structured results differs by protocol era — see [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).

## Recap

- An era is a behavior family: `legacy` covers `2024-10-07` through `2025-11-25`, `modern` starts at `2026-07-28`.
- `versionNegotiation` picks the client handshake; the default is the unchanged 2025 `initialize`, no probe.
- `mode: 'auto'` probes with `server/discover` and falls back to `initialize`; a pin never falls back and rejects with `SdkError(EraNegotiationFailed)`.
- `getProtocolEra()` reports the negotiated era on the client; the `createMcpHandler` / `serveStdio` factory receives the `era` it is about to serve.
- The behavior matrix on this page is the only copy; every other page links here in one line.
- Deprecation (SEP-2577) is not an era difference.

================================================================================
Source: https://ts.sdk.modelcontextprotocol.io/v2/advanced/low-level-server.md
================================================================================


---

# Supporting protocol revision 2026-07-28

This guide is for code **already on the v2 packages** that wants to speak the 2026-07-28
protocol revision — and for code written against an earlier **v2 alpha** that read
wire-only members directly. If you are on `@modelcontextprotocol/sdk` (v1.x), start with
[upgrade-to-v2.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md) instead.

> **Schema artifact:** until the revision is finalized, the spec repository publishes
> the 2026-07-28 schema under `schema/draft/` — there is no `schema/2026-07-28/`
> directory yet. Tooling that vendors per-revision schema artifacts should track
> `draft/` and note the divergence.

Nothing in v2 puts a 2026-07-28 byte on the wire by default: a hand-constructed
`Client` / `Server` / `McpServer` keeps speaking the 2025-era protocol it was written
for. Serving or speaking 2026-07-28 is always an explicit opt-in via one of the entries
below.

## Contents

- [Serving the 2026-07-28 revision](#serving-the-2026-07-28-revision)
- [Replacing per-session state: `requestState`](#replacing-per-session-state-requeststate)
- [Auth on 2026-07-28](#auth-on-2026-07-28)
- [Per-era wire codecs](#per-era-wire-codecs)
- [Wire-only members hidden from public types](#wire-only-members-hidden-from-public-types)
- [Server identity in result `_meta`; `clientInfo` demoted to SHOULD](#server-identity-in-result-_meta-clientinfo-demoted-to-should)
- [Multi-round-trip requests](#multi-round-trip-requests)
- [Legacy shim for `input_required`](#legacy-shim-for-input_required)
- [`subscriptions/listen`](#subscriptionslisten)
- [`Mcp-Param-*` and standard headers (SEP-2243)](#mcp-param--and-standard-headers-sep-2243)
- [Cache fields and cache hints](#cache-fields-and-cache-hints)
- [Tasks: deprecated wire vocabulary](#tasks-deprecated-wire-vocabulary)
- [Appendix: 2025-era vs 2026-era behavior matrix](#appendix-2025-era-vs-2026-era-behavior-matrix)

---

## Serving the 2026-07-28 revision

These entry points are documented in full in [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md);
this section contextualizes them as the migration path.

### Client side: `versionNegotiation`

By default `Client.connect()` performs the same 2025 `initialize` handshake as v1.x,
byte for byte. To negotiate the 2026-07-28 era, opt in via `ClientOptions.versionNegotiation` —
see [Negotiate the era from the client](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md#negotiate-the-era-from-the-client).

```typescript
const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);
client.getProtocolEra(); // 'modern' | 'legacy'
```

- **absent / `mode: 'legacy'`** (default) — today's behavior, no probe.
- **`mode: 'auto'`** — probe with `server/discover`; fall back to the 2025 handshake
  against a 2025-only server (one extra round trip; on the SDK's stdio transport the
  probe rides a disposable sibling process — see below).
- **`mode: { pin: '2026-07-28' }`** — modern only; no fallback, `connect()` rejects with
  `SdkError(EraNegotiationFailed)` against a 2025-only server.

`ProtocolOptions.supportedProtocolVersions` — the same option that pins what the legacy
`initialize` handshake offers (see
[upgrade-to-v2.md › Client connection & dispatch](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md#client-connection--dispatch))
— shapes `'auto'`: the modern candidates are the option's modern entries (when it lists
any; otherwise the SDK's default modern set), and legacy fallback is available only if
the list has a pre-2026 entry. A `{ pin }` is honored as given — it must name a modern
revision but is not checked against the list.

#### Probe policy

Failure semantics under `'auto'` are deliberately conservative but never silent about
infrastructure problems. Anything the probe does not positively recognize as modern
falls back to the legacy era — provided the supported-versions list still contains a
2025-era revision; with a modern-only list `connect()` rejects with
`SdkError(EraNegotiationFailed)` instead. A network outage rejects with a typed connect
error. Probe timeouts are **transport-aware**: on **stdio** a server that does not
answer within `timeoutMs` is treated as legacy and the client falls back to `initialize`
(some legacy servers never respond to unknown pre-`initialize`
requests at all); on **HTTP** a probe timeout rejects with `SdkError(RequestTimeout)` —
a dead HTTP server is never misreported as legacy. One browser-specific exception: an
opaque CORS/preflight `TypeError` during the probe falls back to the legacy era, because
deployed 2025 servers commonly have CORS allow-lists that predate the 2026 headers.

On the SDK's own stdio transport (exactly `StdioClientTransport` — subclasses probe
in place, like custom stdio-shaped transports) the probe runs on a short-lived
**sibling process** spawned from the same parameters (its stderr is discarded, and it is reaped once the
era is known): some stdio servers exit on any pre-`initialize` request — servers built
on the official Rust SDK, rmcp, behave this way — so the probe must not spend the
caller's one child process. A child that exits on the probe is simply a legacy server;
the caller's transport spawns exactly once, after the era is known, and its wire never
carries `server/discover`. Closing the caller's transport during the probe aborts
`connect()` with a typed `SdkError(EraNegotiationFailed)` and the session child is
never spawned. On HTTP — and on custom stdio-shaped transports, which probe in
place — a mid-probe connection close rejects with the same typed error as any probe
transport failure.

```typescript
versionNegotiation: {
    mode: 'auto',
    probe: {
        timeoutMs: 10_000, // default: the standard request timeout
        maxRetries: 0 // default: no retries — governs timeout re-sends only
    }
}
```

`maxRetries` governs timeout re-sends only (the spec-mandated `-32022` corrective
continuation — select-and-continue with a mutual version — is a separate negotiation step
and is never counted against it).

**Who should not default to `'auto'`:** spawn-per-invocation CLI and debugging tools.
On stdio, a legacy server that never answers unknown pre-`initialize` requests stalls
`connect()` for the full probe timeout before falling back; and the probe round trip
changes recorded transcripts/raw logs, which matters for tools whose value is
byte-stable observation. Such tools should keep the default and expose `'auto'` /
a pin as an explicit flag.

The probe request itself already carries the per-request `_meta` envelope
(`io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`) —
**before** the era is known. Once a modern era is negotiated the client auto-attaches
the envelope to every outgoing request and notification. Tooling that classifies
traffic must not treat "saw an envelope" as "modern era negotiated": the legacy-fallback
path also begins with one enveloped probe. A gateway/worker fleet can skip the
probe entirely with `client.connect(transport, { prior: { kind: 'modern', discover } })`
(wrapping a persisted `DiscoverResult`) — or, for a server known out-of-band to be
legacy, with `{ prior: { kind: 'legacy' } }`, which goes straight to `initialize`.
Freshness of a cached legacy verdict is the host's responsibility (a stale one succeeds
silently against an upgraded server); stop supplying it and the configured
mode decides again (an `'auto'` client re-probes).

### Server over HTTP: `createMcpHandler`

`createMcpHandler(factory)` from `@modelcontextprotocol/server` is the v2 HTTP entry
that serves 2026-07-28 per request — and, by default (`legacy: 'stateless'`), also
serves 2025-era traffic per request through the established stateless idiom. One
factory, one endpoint, both eras.

```typescript
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    // register tools/resources/prompts once — the same factory backs both eras
    return server;
});
// Web-standard runtimes: export default handler;
// Node frameworks: app.all('/mcp', toNodeHandler(handler)) from @modelcontextprotocol/node
```

A v1 stateless `StreamableHTTPServerTransport` hosting (`sessionIdGenerator: undefined`,
fresh transport per request) maps directly onto the default entry. An existing
**sessionful** v1 Streamable HTTP setup keeps serving 2025 clients by routing it in
front of a strict (`legacy: 'reject'`) entry with `isLegacyRequest(request)`:

```typescript
const modern = createMcpHandler(factory, { legacy: 'reject' });
export default {
    async fetch(request: Request) {
        if (await isLegacyRequest(request)) return myExistingLegacyHandler(request);
        return modern.fetch(request);
    }
};
```

`isLegacyRequest` returns `true` only for requests with no per-request `_meta` envelope
claim; route `false` traffic to the modern handler (a malformed modern claim is `false`
and answered `-32602` / `-32020` by the modern path). The handler is web-standards-only
(`{ fetch, close, notify, bus }`); on Node frameworks wrap once with
`toNodeHandler(handler, { onerror? })` from `@modelcontextprotocol/node`. The exported
`legacyStatelessFallback(factory)` is the same stateless 2025 serving as a standalone
fetch-shaped handler.

> **If you were on a v2 alpha:** `handler.node(req, res, body)` is gone — replace with
> `toNodeHandler(handler)` and add the `@modelcontextprotocol/node` import.
> `NodeIncomingMessageLike` / `NodeServerResponseLike` are now exported from
> `@modelcontextprotocol/node`, not `@modelcontextprotocol/server`.
>
> Also: a `MissingRequiredClientCapabilityError` (`-32021`) produced **after** dispatch
> — the `input_required` gate refusing an embedded request whose capability the caller
> did not declare — now answers HTTP **400** (earlier alphas surfaced it in-band on
> 200). The spec mandates 400 for this error wherever it arises; the JSON-RPC body is
> unchanged. This applies to a handler-thrown `-32021` too: a proxy relaying a
> downstream server's `-32021` should translate it (its `requiredCapabilities`
> describes the downstream hop's envelope) rather than rethrow the bare error. Every
> other handler-produced code (including a relayed `-32020`/`-32022`)
> keeps the in-band 200, and an exchange whose response stream is already open — the
> handler streamed first, or `responseMode: 'sse'` — keeps its committed 200 and
> carries the error in-stream.

### Server over stdio / long-lived connections: `serveStdio`

A hand-constructed `Server`/`McpServer` connected directly to a `StdioServerTransport`
serves only the 2025-era protocol — upgrading the SDK changes nothing about what it puts
on the wire. Serving 2026-07-28 (or both eras) on stdio goes through the
connection-pinned `serveStdio(() => buildServer())` entry from
`@modelcontextprotocol/server/stdio`; the opening exchange selects the connection's era,
and one factory instance is pinned per connection. See
[Serve over stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.md).

To migrate an existing stdio server, replace
`await server.connect(new StdioServerTransport())` with
`serveStdio(() => buildServer())`. Pass `{ legacy: 'reject' }` to refuse 2025-era
openings. On 2026-pinned connections, `getClientCapabilities()` / `getClientVersion()`
return `undefined` (no `initialize` ever runs there) and handlers read per-request
identity from `ctx.mcpReq.envelope`; `getNegotiatedProtocolVersion()` reports the pinned
revision.

A client whose connection negotiated a modern era drops inbound server→client JSON-RPC
requests (the 2026 era has no such channel) instead of answering them; legacy-era
connections are unchanged.

### In-process testing

There is no in-memory serving entry — `InMemoryTransport.createLinkedPair()` connects
2025-era instances only. To exercise 2026-07-28 behavior in tests without sockets,
drive `createMcpHandler` directly through its fetch function:

```typescript
const handler = createMcpHandler(buildServer);
const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
});
```

The URL is never dialed — `handler.fetch` serves the request in-process. For stdio-era
coverage, spawn `serveStdio` as a child process.

### Client cancellation on Streamable HTTP

On a 2026-07-28 Streamable HTTP connection, aborting an in-flight client request
(`signal` / timeout) closes that request's SSE response stream — the spec cancellation
signal — instead of POSTing `notifications/cancelled`. Nothing to change in calling
code. 2025-era connections and stdio at any era still send `notifications/cancelled`.
Custom `Transport` implementations that open one underlying request per outbound message
and honor `TransportSendOptions.requestSignal` may opt in by declaring
`readonly hasPerRequestStream = true`.

### `ctx.mcpReq.log()` and the per-request `logLevel`

On a 2026-07-28 request, `ctx.mcpReq.log()` reads its level filter from the
`io.modelcontextprotocol/logLevel` `_meta` envelope key (the modern replacement for the
`logging/setLevel` RPC). When the key is **absent** the server emits no
`notifications/message` for that request — absence is opt-out, not "no filter". The SDK
`Client` does not auto-attach `logLevel`, so handler logs on a default 2026-era exchange
are silently suppressed until the client opts in.

---

## Replacing per-session state: `requestState`

The 2026-07-28 revision is **per request** — `createMcpHandler` builds a fresh server per
request and there is no `Mcp-Session-Id`. If your v1 server kept state keyed on the
session id (`ctx.sessionId` / `extra.sessionId`), the 2026 answer is `requestState`: an
opaque string the server returns with `inputRequired(...)` and the client echoes
byte-for-byte on the retry. Read it back with the typed accessor
`ctx.mcpReq.requestState<T>()` — it returns the payload your configured verify hook
decoded (see below), the raw wire string when no hook is configured, or `undefined`
when the round carried no state.

`requestState` round-trips through the client and is therefore **untrusted input** —
integrity-protect it (HMAC / AEAD over the payload, bound to principal, originating
method/parameters, and an expiry) and reject failed verification on re-entry. Configure
`ServerOptions.requestState.verify` and the seam runs it before the handler whenever
`requestState` is present (a thrown rejection answers `-32602` above the tool funnel).
The `createRequestStateCodec({ key, ttlSeconds?, bind? })` helper returns
`{ mint, verify }` — `mint` HMAC-SHA256-seals a JSON-serializable payload and `verify`
is exactly the function you assign to the hook. The codec is **signed, not encrypted**
(the client can base64url-decode the payload). `mint<T>` and
`ctx.mcpReq.requestState<T>()` are the typed encode/read pair: the seam captures what
`verify` returns and the accessor hands it to the handler already decoded — no second
`verify` call. See `examples/mrtr/server.ts` and
[Multi-round-trip requests](#multi-round-trip-requests) for the full handler shape.

**Multi-step flows: the phase switch.** `inputResponses` are **per round** — each retry
carries only that round's responses, never earlier rounds' (the modern client driver
and the [legacy shim](#legacy-shim-for-input_required) both guarantee replace, not
accumulate). A flow with more than one input round therefore threads everything it has
learned through `requestState`, as a discriminated union of phases, and switches on the
phase rather than probing which response keys arrived:

```typescript
type BrainstormState =
    | { step: 'awaiting-count' }
    | { step: 'awaiting-custom-count'; topic: string }
    | { step: 'awaiting-ideas'; topic: string; count: number };

const stateCodec = createRequestStateCodec<BrainstormState>({ key: SECRET });
// ServerOptions: { requestState: { verify: stateCodec.verify } }

async (args, ctx) => {
    const state = ctx.mcpReq.requestState<BrainstormState>();
    switch (state?.step) {
        case undefined: // first call — ask for the count
            return inputRequired({
                inputRequests: { count: inputRequired.elicit({ … }) },
                requestState: await stateCodec.mint({ step: 'awaiting-count' })
            });
        case 'awaiting-count': {
            const accepted = acceptedContent(ctx.mcpReq.inputResponses, 'count', COUNT_SCHEMA);
            // …decide: follow-up question or the sampling round, carrying
            // everything learned so far inside the next minted state…
        }
        case 'awaiting-ideas': {
            const ideas = inputResponse(ctx.mcpReq.inputResponses, 'ideas');
            return finish(ideas.kind === 'sampling' ? ideas.result : undefined, state.count, state.topic);
        }
    }
};
```

Each `case` knows exactly which answer to read and which data is in scope — the state
machine is explicit, and the same handler runs unchanged on 2025-era connections
through the legacy shim.

---

## Auth on 2026-07-28

The 2026-07-28 specification's authorization requirements (RFC 9207 `iss` validation,
SEP-2352 credential isolation, SEP-2350 scope step-up, SEP-837/SEP-2207 DCR + TLS) are
implemented in v2 as **SDK-level opt-ins, not protocol-era gates** — they apply on every
era once enabled. The migration steps live in
[upgrade-to-v2.md › Auth](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md#auth). To be **2026-07-28-conformant**,
enable the spec-2026 opt-ins listed there: pass `iss` (or the callback `URLSearchParams`)
to `finishAuth`; round-trip the `issuer` stamp on stored credentials; implement
`discoveryState()`; and either keep `onInsufficientScope: 'reauthorize'` or handle
`InsufficientScopeError` yourself. Nothing in this section is era-switched at the wire
layer.

---

## Per-era wire codecs

The wire layer is split into per-revision codecs inside the (private, bundled) core: one
codec serves every 2025-era protocol version (2024-10-07 … 2025-11-25) and one serves
2026-07-28. The codec is selected by the negotiated protocol version, which is
**connection state** on the `Client`/`Server` instance (instances with no negotiated
version default to the 2025 era). An edge classification (`MessageExtraInfo.classification`)
no longer switches the era per message — it is validated against the instance era, and a
mismatch is rejected as an entry/routing error (`-32022 Unsupported protocol version`
for requests; drop + `onerror` for notifications).

Methods deleted by a protocol revision are **physically absent** from that era's
registry: an inbound `tasks/get` on a 2026-era connection gets `-32601` even if a
handler is registered, and sending an era-mismatched spec method (e.g. `server/discover`
toward a 2025-era peer, or any `tasks/*` method toward a 2026-era peer) throws
`SdkError(MethodNotSupportedByProtocolVersion)` before anything reaches the transport.

If you were on a v2 alpha and consumed wire schemas directly:

| v2-alpha pattern                                                                             | Mechanical fix                                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| parsing wire bytes with `EmptyResultSchema` that may carry `resultType`                      | strip `resultType` first (the schema now rejects it as an unknown key)                                     |
| `specTypeSchemas` / `SpecTypeName` references to task message types or `RequestMetaEnvelope` | remove — these validators left the public set (the **types** remain importable)                            |
| `ClientRequest` / `ServerResult` / … aggregate types expected to include task members        | use the individual deprecated `Task*` types — role aggregates are now the neutral (task-free) sets         |
| relying on `isCallToolResult` to reject wire-only members                                    | guards validate neutral shapes (loose passthrough); validate raw wire traffic with a transport-level parse |

The `resultType` / `EmptyResultSchema` / `specTypeSchemas` rules above have **no v1.x
impact** — these members did not exist before 2026-07-28. The neutral-model wire
tightening that **does** affect v1 code (custom-handler `_meta` passthrough,
`specTypeSchemas` narrowing) is in
[upgrade-to-v2.md › Wire tightening](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md#wire-tightening-every-era);
`CallToolResult.content` keeps its v1 default on the legacy era (2026-07-28
connections require it explicitly).

> **If you were on a v2 alpha:** the 2026-07-28 draft error codes were renumbered:
> `HeaderMismatch` `-32001`→`-32020`, `MissingRequiredClientCapability` `-32003`→`-32021`,
> `UnsupportedProtocolVersion` `-32004`→`-32022`. No v1.x impact (these codes never
> existed in v1); v2-alpha code that hard-coded the old literals must update — prefer
> `ProtocolErrorCode.*` / `HEADER_MISMATCH_ERROR_CODE`.

---

## Wire-only members hidden from public types

The 2026-07-28 wire-level bookkeeping is handled internally and never reaches
application code: the `resultType` discrimination field, the reserved per-request
`_meta` envelope keys (`io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities,logLevel}`),
and the multi-round-trip retry fields (`inputResponses`, `requestState`).

- **`resultType` is gone from every public result type** (`Result`, `CallToolResult`,
  `GetPromptResult`, …). The wire schemas keep parsing it, and the protocol layer
  consumes it before results reach your code.
- **`DiscoverResult` hides its cache fields at the type level only.** `ttlMs` /
  `cacheScope` on `server/discover` are read by the client's response-cache layer and
  are absent from the public `DiscoverResult` type returned by `getDiscoverResult()` —
  but they are not removed at runtime: the returned object still carries both, readable
  via a cast. The wire parse defaults absent or malformed hints to `0` / `'private'`,
  so only tooling that must distinguish an omitted hint from an advertised default
  needs raw frames.
- **High-level methods return the named public types** (`client.callTool()` →
  `Promise<CallToolResult>`, etc.). Handler return positions are unaffected.
- **Reserved envelope keys and retry fields appear in no public params/result type.**
  The `RequestMetaEnvelope` type and the four envelope `*_META_KEY` constants stay exported.

The protocol layer enforces the same boundary at runtime:

- **Envelope lift.** On inbound requests and notifications, the reserved
  `io.modelcontextprotocol/*` keys are lifted out of `params._meta` before handlers run.
  For requests the envelope is readable at `ctx.mcpReq.envelope`
  (typed `Partial<RequestMetaEnvelope>`); for notifications there is no per-message
  context, so lifted envelope keys are dropped. On requests only, `inputResponses` /
  `requestState` are lifted from top-level params to `ctx.mcpReq.inputResponses` /
  the `ctx.mcpReq.requestState()` accessor; notification params are never touched.
- **Collision note for 2025-era peers.** The `_meta` lift is invisible to conforming
  2025 traffic (the `io.modelcontextprotocol/` prefix is reserved in 2025-11-25 too).
  The retry-field lift is the one collision: 2025-11-25 does not reserve the bare names
  `inputResponses`/`requestState`, so a 2025 peer's **custom-method request** that uses
  them as ordinary top-level params has them lifted out of `request.params` (still
  readable at `ctx.mcpReq.inputResponses` / `ctx.mcpReq.requestState()`).
- **Raw-first result discrimination.** On a 2026-era exchange, `'complete'` is consumed
  and stripped; `'input_required'` is fulfilled by the client's auto-fulfilment driver;
  any other kind rejects with `SdkError(UnsupportedResultType)` (kind in
  `error.data.resultType`). On a 2025-era connection a foreign `resultType` is stripped
  before validation. On a 2026-era exchange `resultType` is REQUIRED; an absent value is
  a spec violation surfaced as a typed error.

**If you were on a v2 alpha** and read the wire shape directly:

| Pattern                                | Mechanical fix                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `result.resultType` (typed read)       | delete the read — the SDK consumes the field; results are complete when delivered |
| `Result['resultType']` type reference  | remove; the member is no longer declared                                          |
| return-type capture of `callTool` etc. | use the named public types (`CallToolResult`, `ListToolsResult`, …)               |

`MessageExtraInfo.classification` is an optional carrier (`{ era, revision?, envelope? }`)
for transports that classify inbound messages at the edge; dispatch validates it against
the instance's negotiated era.

---

## Server identity in result `_meta`; `clientInfo` demoted to SHOULD

The final 2026-07-28 revision (spec PR #3002) moved server identity out of the
`DiscoverResult` body: servers identify themselves via
`_meta['io.modelcontextprotocol/serverInfo']` (constant `SERVER_INFO_META_KEY`) on
every response, and the per-request envelope's `clientInfo` is a SHOULD instead of a
requirement.

What the SDK does:

- **Server.** Every 2026-era response gets the `_meta` serverInfo stamp (a
  handler-authored value wins; 2025-era responses are untouched) — including the
  entry-built `subscriptions/listen` graceful-close results, whose `_meta` carries
  the identity next to the subscription id. Requests without `clientInfo` are
  served; a present-but-malformed value is still rejected.
- **Client.** `clientInfo` is still sent on every request (the spec SHOULD).
  `getServerVersion()` reads the discover result's `_meta`. A server that stamps no
  identity is simply anonymous: the connection works, `getServerVersion()` is
  `undefined`, and the response cache partitions under a per-connection surrogate.
- **Types.** `DiscoverResult` has no `serverInfo` member, and `RequestMetaEnvelope`'s
  `clientInfo` is optional. Code that read `discover.serverInfo` moves to
  `client.getServerVersion()` (or the `_meta` key directly).

`serverInfo`/`clientInfo` are self-reported and intended for display, logging, and
debugging — do not use them for behavior or security decisions. A malformed `_meta`
serverInfo value is treated as absent on receive, per the same clause.

---

## Multi-round-trip requests

The 2026-07-28 revision removes the server→client JSON-RPC request channel. Servers
obtain client input (elicitation, sampling, roots) **in-band** by returning
`inputRequired(...)` from a `tools/call` / `prompts/get` / `resources/read` handler; the
client retries the original call with the responses.

| Handler serving 2026-07-28 requests                          | Mechanical fix                                                                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await ctx.mcpReq.elicitInput({…})` / `requestSampling({…})` | `return inputRequired({ inputRequests: { id: inputRequired.elicit({…}) } })`; read `acceptedContent(ctx.mcpReq.inputResponses, 'id')` on re-entry                                            |
| `throw new UrlElicitationRequiredError([…])`                 | `return inputRequired({ inputRequests: { id: inputRequired.elicitUrl({…}) } })`                                                                                                              |
| handler shared across both eras                              | **no branch needed** — write the `inputRequired(...)` form once; the [legacy shim](#legacy-shim-for-input_required) serves it to 2025-era connections by issuing real server→client requests |

`inputRequired` / `acceptedContent` / `InputRequiredSpec` are exported from
`@modelcontextprotocol/server`. On 2026-era requests the push-style APIs
(`ctx.mcpReq.send` of server→client requests, `ctx.mcpReq.elicitInput`,
`ctx.mcpReq.requestSampling`, instance-level `createMessage()`/`elicitInput()`/`listRoots()`/`ping()`)
fail with a typed local error before anything reaches the wire; their behavior toward
2025-era requests is unchanged. The same split applies to
`throw new UrlElicitationRequiredError(...)`: on 2025-era connections it is unchanged —
the throw still produces the `-32042` protocol error, not an `isError` result; on
2026-07-28 requests it fails with a clear error steering to
`inputRequired.elicitUrl(...)` rather than being converted silently.

`requestState` round-trips as an opaque, **untrusted** string — see
[Replacing per-session state: `requestState`](#replacing-per-session-state-requeststate)
for the sealing helper and verification hook.

**Client side — auto-fulfilment by default.** When a 2026-07-28 call answers
`input_required`, the client fulfils the embedded requests through the same handlers
registered with `setRequestHandler('elicitation/create' | 'sampling/createMessage' |
'roots/list', …)` and retries (fresh request id, `inputResponses`, byte-exact
`requestState` echo) up to `inputRequired.maxRounds` rounds (default 10). Configure or
opt out via `ClientOptions.inputRequired` (`{ autoFulfill: false }`); drive manually per
call with `allowInputRequired: true` plus `withInputRequired()`. Expect
`SdkError(InputRequiredRoundsExceeded)` when the cap is exhausted.

**Typed readers for `inputResponses`.** Beyond `acceptedContent(responses, key)` (a
structural read with an unvalidated cast), two typed readers ship from
`@modelcontextprotocol/server`:

- `acceptedContent(responses, key, schema)` — schema-aware overload (any synchronous
  Standard Schema, e.g. a zod object): validates the untrusted accepted content and
  returns it typed, or `undefined` on mismatch/decline/missing.
- `inputResponse(responses, key)` — discriminated view
  (`{kind:'missing'} | {kind:'elicit', action, content?} | {kind:'sampling', result} | {kind:'roots', roots}`)
  for decline/cancel detection and the non-elicitation kinds.

Content conveniences stay in your code — e.g. the text of a sampling response is a
one-liner over the discriminated view:

```typescript
const ideas = inputResponse(ctx.mcpReq.inputResponses, 'ideas');
const block = ideas.kind === 'sampling' && !Array.isArray(ideas.result.content) ? ideas.result.content : undefined;
const text = block?.type === 'text' ? block.text : undefined;
```

---

## Legacy shim for `input_required`

An `input_required` return on a **2025-era** connection is served by the SDK's legacy
shim, on by default: each embedded request is sent as a real server→client request
(`elicitation/create`, `sampling/createMessage`, `roots/list`) over the live session —
stamped with the originating request's id, so on sessionful Streamable HTTP the
requests ride the originating POST's stream — and the handler is re-entered with the
collected `inputResponses` until it returns a final result. Handlers are **written
once** in the 2026 `inputRequired(...)` style and serve both eras; the push-style APIs
remain available for code that still calls them directly.

The handler cannot tell which era fulfilled it — the shim mirrors the modern client
driver's semantics exactly:

- `inputResponses` are **per round** (replaced on every re-entry, never accumulated);
  multi-step flows thread earlier answers through `requestState`.
- `requestState` is echoed byte-exact, and the configured
  `ServerOptions.requestState.verify` hook runs on **every** round, exactly as it would
  on a modern wire retry (so TTL expiry behaves identically; a rejection answers the
  frozen `-32602`).
- Responses arrive as the bare result objects, era-wire-shape-validated only:
  elicitation accepted content is NOT re-checked against `requestedSchema` —
  exactly as on the modern era — so the handler validates with the
  schema-aware `acceptedContent(responses, key, schema)` overload and can
  re-issue the request instead of the call dying on a mistyped form field.
- Rounds with no embedded requests (requestState-only) are paced at 250ms.
- URL-mode elicitation legs are sent with a synthesized `elicitationId` (the
  2025-11-25 wire requires one; the 2026 in-band shape has none).

Knobs live at `ServerOptions.inputRequired`:

| Member           | Default   | Meaning                                                                                                                                                                  |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxRounds`      | `8`       | Handler re-entries per originating request before failing — deliberately tighter than the client driver's 10: the shim holds a live wire request open for the whole flow |
| `roundTimeoutMs` | `600_000` | Per-leg timeout (with `resetTimeoutOnProgress`) — embedded requests are human-paced, so the 60s protocol default does not apply                                          |
| `legacyShim`     | `true`    | `false` restores the pre-shim loud failure (`-32603`) and the branch-on-era pattern                                                                                      |

Failures surface **per family**: `tools/call` failures (capability refusal, a failed
leg, round-cap exhaustion) become `isError` tool results — the 2025-era idiom hosts
already render — while `prompts/get` / `resources/read` failures surface as JSON-RPC
errors. Server bugs (malformed input-required results) fail loudly on both eras.

The shim emits no progress of its own. The originating request's `progressToken`
identifies a single must-increase stream that belongs to the handler — injecting
synthetic ticks into it cannot compose with handler-emitted progress (one stream,
one author), so the shim never writes to it: a 2025 client watching a multi-round
flow sees exactly what a hand-written 2025 push-style handler would have produced.
A handler that reports progress across rounds should derive its values from its
phase state so they increase across re-entries — the token spans the whole flow.

**Inherited limits** (the same ones hand-written push-style handlers have today):

- The shim pre-checks each embedded request kind against the client capabilities
  declared at the 2025 `initialize` handshake (a bare `elicitation: {}` declaration
  counts as form support — the pre-mode meaning, same as the modern `-32021` gate).
  Capability-less clients get a clean refusal, never a hang.
- **Stateless legacy HTTP** (`createMcpHandler` with `legacy: 'stateless'`) builds a
  fresh instance per request: no initialize handshake, no return path for
  server→client requests. The shim degrades to the clean capability refusal there —
  full shim behavior needs stdio (`serveStdio`) or a sessionful legacy wiring.
- JSON-mode legacy hosting (`enableJsonResponse`) cannot deliver server→client
  requests mid-call: the transport drops them, so a shim leg waits out
  `roundTimeoutMs` before failing per family — the same undeliverable class as
  today's `elicitInput` in that configuration, which waits out its own 60s
  default. Interactive tools need a streaming-capable session.
- The 2025-era `notifications/elicitation/complete` channel for URL-mode elicitation
  is not bridged: URL-mode legs complete like any other elicitation
  response. The sender API for that channel,
  `Server.createElicitationCompletionNotifier()`, is itself unchanged from v1 for
  2025-era URL-mode elicitation — only the shim does not bridge it.

---

## `subscriptions/listen`

The 2026-07-28 revision delivers `tools/prompts/resources` `list_changed` and
`resources/updated` only on a `subscriptions/listen` stream the client opened — the
server never sends an un-requested notification type.

**Server side.** Nothing to register: the serving entries handle `subscriptions/listen`
themselves. `createMcpHandler` returns
`.notify.{toolsChanged, promptsChanged, resourcesChanged, resourceUpdated(uri)}` typed
publish sugar over an in-process bus (supply your own `ServerEventBus` for multi-process
deployments). On stdio, `serveStdio` routes the pinned instance's existing
`send*ListChanged()` calls onto the active subscriptions automatically. The 2025-era
unsolicited delivery model is unchanged on legacy connections.

**Client side.** `ClientOptions.listChanged` keeps working: on a 2026-07-28 connection
the SDK auto-opens a `subscriptions/listen` stream whose filter is the intersection of
the configured sub-options and the server-advertised `listChanged` capabilities, so the
same handlers fire on every published change. `client.listen(filter)` opens a stream
explicitly. `resources/subscribe` is 2025-only — on a 2026-07-28 connection, request
`notifications/resources/updated` via the `resourceSubscriptions` field of the listen
filter instead.

**Graceful close.** When the server closes the listen stream deliberately (entry
`close()`/shutdown), it sends the empty `subscriptions/listen` JSON-RPC result before
closing the stream; `McpSubscription.closed` resolves `'graceful'`. A stream close
without a result resolves `'remote'` and indicates an unexpected disconnect — re-listen
if you still want events.

---

## `Mcp-Param-*` and standard headers (SEP-2243)

On a 2026-07-28 connection over Streamable HTTP, `Client.callTool()` mirrors tool
arguments designated with `x-mcp-header` in the tool's `inputSchema` into
`Mcp-Param-{Name}` HTTP request headers (Base64-sentinel-encoded where needed), and
`createMcpHandler` rejects a `tools/call` whose `Mcp-Param-*` headers are missing for a
present body value, malformed, or disagree with the body — `400 Bad Request` with
JSON-RPC `-32020` (`HeaderMismatch`). The Streamable HTTP transport also emits the
`Mcp-Name` standard header on every modern-enveloped request, and `createMcpHandler`
validates the SEP-2243 standard headers (`MCP-Protocol-Version`, `Mcp-Method`,
`Mcp-Name`) against the body on the modern path with the same rejection.

**Modern-era exception** to the `SdkHttpError` mapping: on a modern-enveloped request,
an HTTP `400` whose body is a well-formed JSON-RPC error response addressed to the
pending request id is delivered in-band as a `ProtocolError` (so the `-32020` recovery
retry can fire). Legacy-era exchanges and generic HTTP failures still surface as
`SdkHttpError`.

Additive options: `CallToolRequestOptions.toolDefinition` (pass the tool definition
directly so mirroring and output-schema validation run without a prior `tools/list`),
`TransportSendOptions.headers` (per-request HTTP headers; reserved standard/auth header
names are skipped). Browser clients skip mirroring (dynamically named headers cannot be
statically allow-listed for credentialed CORS).

---

## Cache fields and cache hints

The 2026-07-28 revision requires `ttlMs` and `cacheScope` on the cacheable results.
When serving that revision, the SDK always emits both fields, defaulting to `ttlMs: 0`
and `cacheScope: 'private'` (the most conservative policy). To advertise a real cache
policy, set `ServerOptions.cacheHints` (per-operation) or `cacheHint` on a
`registerResource` metadata object; resolution is per field, most-specific author first.
2025-era responses never carry these fields.

---

## Tasks: deprecated wire vocabulary

The task **wire surface** defined by the 2025-11-25 protocol revision is still exported
for interoperability with peers on that revision: the task Zod schemas and inferred
types (`Task`, `TaskStatus`, `TaskMetadata`, `RelatedTaskMetadata`, `CreateTaskResult`,
`GetTask*`, `ListTasks*`, `CancelTask*`, `TaskStatusNotification*`,
`TaskAugmentedRequestParams`), the task members of the request/result/notification union
types, the `tasks` capability key, `isTaskAugmentedRequestParams`, and
`RELATED_TASK_META_KEY`. All are now `@deprecated` (importable wire vocabulary only;
removable at the major version that drops 2025-era support).

Task methods are excluded from the typed method maps: `RequestMethod` / `RequestTypeMap`
/ `ResultTypeMap` / `NotificationTypeMap` have no `tasks/*` or
`notifications/tasks/status` entries, so the method-keyed overloads of `request()`,
`ctx.mcpReq.send()`, `setRequestHandler()`, `setNotificationHandler()` reject task
methods at compile time. `ResultTypeMap['tools/call']` is plain `CallToolResult` (no
`| CreateTaskResult`); same for `sampling/createMessage` and `elicitation/create`.
(Typings published before `2.0.0-alpha.4` predate this exclusion: there the typed
maps still carry the `tasks/*` entries and the `CreateTaskResult` unions; narrow with
the `isCallToolResult` guard if you are pinned to one of those alphas. `2.0.0-alpha.4`
and later include the exclusion.) Where
task interop is genuinely required, use the explicit-schema custom-method form
(`request({ method: 'tasks/get', params }, GetTaskResultSchema)`). Inbound `tasks/*`
requests → `-32601`.

The experimental tasks **interception** layer is removed entirely — see
[upgrade-to-v2.md › Experimental tasks interception removed](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md#experimental-tasks-interception-removed).

---

## Appendix: 2025-era vs 2026-era behavior matrix

| Axis                                  | 2025-era (2024-10-07 … 2025-11-25)                                            | 2026-07-28                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Server HTTP entry                     | `*StreamableHTTPServerTransport`                                              | `createMcpHandler` (`legacy: 'stateless'` also serves 2025)        |
| Server stdio entry                    | `server.connect(new StdioServerTransport())`                                  | `serveStdio(factory)` (also serves 2025 unless `legacy: 'reject'`) |
| Client connect                        | `initialize` handshake                                                        | `server/discover` probe (`versionNegotiation`)                     |
| Client identity                       | `getClientCapabilities()` / `getClientVersion()` (initialize-scoped)          | `ctx.mcpReq.envelope` (per request)                                |
| Server→client requests                | `ctx.mcpReq.elicitInput` / `requestSampling`, instance `createMessage()` etc. | `return inputRequired(...)` from handler                           |
| Change notifications                  | unsolicited `list_changed` / `resources/updated`                              | `subscriptions/listen` stream                                      |
| Client cancellation (Streamable HTTP) | POST `notifications/cancelled`                                                | close the request's SSE response stream                            |
| `ctx.mcpReq.log()` level filter       | session-scoped `logging/setLevel`                                             | per-request `_meta.logLevel` envelope key (absent = opt-out)       |
| `400` JSON-RPC error body             | `SdkHttpError`                                                                | `ProtocolError` (in-band)                                          |
| Era-mismatched spec method (outbound) | n/a                                                                           | `SdkError(MethodNotSupportedByProtocolVersion)`                    |


<mission>

Rebuild the qyl documentation and marketing surface. The UI layer is React Bits Pro (Ultimate license, already purchased). The delivery layer must beat supabase.com/docs on every measured metric.

That comparison is adjudicated in Layer 2 of `<targets>`, on the deployed URL, against a PageSpeed Insights run and a Catchpoint run using the benchmark's own mobile profile. The headline of the original benchmark was the Lighthouse composite — Supabase 73 desktop and 68 mobile against Auth0 31 and 44 — and Layer 2 is the only place that number is produced, since Lighthouse deliberately does not run in CI. A release that has not cleared Layer 2 has not beaten Supabase; it has only passed its own build gates.

Scope is the public reading surface: docs routes, landing page, pricing, FAQ, auth entry, 404. The qyl dashboard and collector UI are out of scope. Do not touch them.

</mission>

<evidence>

We benchmarked supabase.com/docs against auth0.com/docs on the same runs. This is the reasoning behind every constraint in this prompt. Read it before you make a stack decision, because the constraints will look arbitrary otherwise.

Desktop, PageSpeed Insights:

| Metric      | Supabase               | Auth0                     |
|-------------|------------------------|---------------------------|
| Performance | 73 (CWV pass)          | 31 (CWV fail)             |
| TTFB        | 0.1 s (edge cache HIT) | 0.6 s (dynamic, uncached) |
| FCP         | 0.5 s                  | 1.2 s                     |
| LCP         | 1.4 s                  | 4.8 s                     |
| Speed Index | 1.3 s                  | 4.0 s                     |
| TBT         | 500 ms                 | 920 ms                    |
| CLS         | ~0.001                 | 0.161                     |

Mobile, Catchpoint, iPhone 14 Pro, Chrome 145, 4G at 9 Mbps / 170 ms RTT, London, 3 runs:

| Metric         | Supabase | Auth0   |
|----------------|----------|---------|
| Performance    | 68       | 44      |
| Speed Index    | 3.01 s   | 10.97 s |
| TBT            | 0.92 s   | 4.24 s  |
| CLS            | 0        | 0.079   |
| Page weight    | ~995 KB  | ~4 MB   |
| Requests       | 85       | 141     |
| Best Practices | 96       | 74      |

Flagged "Needs Improvement" on mobile:

- Auth0 — "Is It Usable?" section header (long time to interactive, 1 critical accessibility issue, HTML generated after delivery); FCP 2,109 ms; field INP 0.38 s at p75.
- Auth0 rated "Poor" — LCP 5,746 ms, Speed Index 25,217 ms, TBT 1,001 ms, TTI 16,611 ms.
- Supabase — FCP 1,958 ms; TBT 302 ms; field INP 0.21 s at p75.
- Supabase rated "Poor" — LCP 7,703 ms, TTI 7,655 ms.

The conclusion that drives this build: the gap was not typography and not color. It was delivery and JavaScript weight. Supabase won with static HTML on an edge cache HIT and a lean bundle. Auth0 lost with dynamic uncached HTML, ~2.5 s of JS execution, a ~1.44 MB poorly-cached payload, and a cookie modal that reflowed content.

Supabase still left points on the table, and these four gaps are the attack surface. Three are build-time: 500 ms TBT, ~270 ms of render-blocking resources, and ~31 KiB of legacy transpiled JS it never needed to ship. Those close through the payload budgets, inlined critical CSS, and the modern build target, and CI verifies them. The fourth is a field INP of 0.21 s at p75, which no build gate can confirm — it closes by keeping hydration minimal, and only Layer 3 verifies it. We beat the winner by closing all four.

React Bits sits on the losing axis. Its components pull `three.js`, `@react-three/fiber`, drei, GSAP, `motion/react`, matter-js, lenis, and d3, and many run a continuous requestAnimationFrame loop. That is the Auth0 pattern. React Bits earns its place as visual design, not as a runtime. The policy below exists to keep the design and delete the runtime.

</evidence>

<targets>

Three measurement layers. Each gates something different, and only two run in CI.

**Layer 1 — CI harness.** Playwright, `Emulation.setCPUThrottlingRate(4)`, fixed 4G profile, median of 3 runs. These fail the build.

- LCP at most 1.8 s
- Long-task total after FCP at most 150 ms. This is the TBT proxy: sum `(duration − 50 ms)` across every `longtask` entry.
- Longest single task during any interaction at most 50 ms
- INP p75 at most 150 ms over at least 20 scripted interactions per route
- CLS exactly 0. Not 0.01 — under fixed emulation with space reserved, layout shift is deterministic, so any nonzero value is a real bug rather than noise.

**Layer 2 — out-of-band, against the deployed URL, not in CI.** Run PageSpeed Insights and one Catchpoint mobile run (iPhone 14 Pro, 4G at 9 Mbps / 170 ms RTT, London — the benchmark profile) before each release. These are release criteria, not build gates, because their variance on shared runners is high enough to produce false failures.

Mobile: Performance at least 95, FCP at most 1.4 s, LCP at most 1.8 s, Speed Index at most 2.0 s, TBT at most 150 ms, CLS at most 0.01, TTFB at most 0.1 s on a warm edge cache, Accessibility at least 98, Best Practices at least 96, SEO at least 95.

Desktop: Performance at least 98, LCP at most 0.9 s, Speed Index at most 1.0 s, TBT at most 100 ms, CLS at most 0.01.

These numbers are calibrated to beat the benchmark, not to look impressive. Supabase posted FCP 1,958 ms and TBT 302 ms on its mobile Lighthouse run and Speed Index 3.01 s on the Catchpoint 4G run, so the bar above clears it on every axis. Sub-second FCP is not reachable on a throttled slow-CPU profile no matter how perfect the payload — network round-trips forbid it. Hit these and stop optimising.

**Layer 3 — field, post-launch, rolling 28-day p75.** This is the real scoreboard.

- INP at most 150 ms
- LCP at most 2.0 s
- CLS at most 0.02

Field INP is the single metric where both benchmarked sites were flagged and where the winner still lost points — Supabase 0.21 s, Auth0 0.38 s. Scripted lab interactions are a proxy; they do not cover real input variety or the real device spread. Layer 3 is how we learn whether Layer 1 was telling the truth.

**Payload, per route, gzipped, initial load.** Deterministic, so these gate the build directly.

- Docs reading routes: JS at most 30 KB, CSS at most 15 KB, total at most 350 KB
- Marketing routes: JS at most 120 KB, CSS at most 20 KB, total at most 600 KB
- Zero legacy transpilation output in any bundle
- Zero axe violations at serious or critical severity, and zero `incomplete` results for `color-contrast`

</targets>

<stack>

Use exactly this. Each choice is tied to a measured failure above.

- **Astro 5, `output: 'static'`.** Every route is pre-rendered HTML on disk. This is the Supabase TTFB lever, made structural — there is no dynamic render path to accidentally reintroduce. Astro runs Vite underneath, so build-target and budget tooling behave the way you already expect.
- **`@astrojs/react` with React 19, islands only.** Astro ships zero JS unless a component carries a `client:` directive. That directive is the enforcement mechanism for the React Bits policy below: an un-directived React Bits component compiles to static HTML and costs nothing at runtime.
- **Tailwind CSS 4 via `@tailwindcss/vite`.** React Bits Pro ships a Tailwind variant of every component, so use the `-tw` suffix throughout and never mix in the `-css` variant.
- **shadcn/ui initialised** (`npx shadcn@latest init`), because React Bits Pro is distributed through the shadcn registry protocol and needs `components.json`.
- **TypeScript strict**, plus `astro check` in CI.
- **Vite `build.target: ['chrome111', 'edge111', 'firefox128', 'safari16.4']`.** That is exactly Tailwind 4's own browser floor, so it costs no compatibility. It is also the fix for the ~31 KiB of legacy JS Supabase was still dinged for. Do not lower it.
- **Astro content collections + MDX for docs. Shiki highlighting at build time.** Code blocks become static HTML. No client-side highlighter ships.
- **Pagefind for docs search.** It builds a static index at build time and loads its WASM only when the user opens search. An always-loaded client index would spend the entire docs JS budget on search alone.
- **Native cross-document view transitions via CSS `@view-transition { navigation: auto; }`.** Zero JavaScript. Do not install Astro's client-router for this.
- **Speculation Rules API** with `eagerness: "moderate"` for same-origin docs links, so navigation feels instant without a client router.
- **Cloudflare Workers Static Assets** for hosting, with Early Hints enabled.
- **`web-vitals` RUM beacon**, roughly 2 KB gzipped, reporting `onLCP`, `onINP`, and `onCLS` through `navigator.sendBeacon`. It posts to a **same-origin** path on the Worker, which forwards to the qyl collector. The browser never makes a cross-origin request — the CSP forbids it, and a third-party beacon is the payload pattern that cost Auth0. Emit OTLP/HTTP JSON gauges named `web.vitals.lcp`, `web.vitals.inp`, `web.vitals.cls` with `browser.*` resource attributes. Those metric names are a local namespace: OpenTelemetry has no ratified semantic convention for Core Web Vitals, so do not label them as standard. Load the beacon from a `defer` script behind `requestIdleCallback`, never as a React island. Without it, every performance claim we make is a lab claim.

Do not add a state library, a data-fetching library, a smooth-scroll library, or a component library other than React Bits Pro and shadcn primitives.

</stack>

<react_bits_policy>

This is the part that decides whether we win or repeat Auth0.

**Install.** Put the license key in `.env.local` and add the `registries` block to `components.json`. Read the React Bits Pro installation docs at pro.reactbits.dev/docs/installation for the exact environment-variable name and registry entries; do not guess them. `@reactbits-starter` serves components on all plans, `@reactbits-pro` serves blocks on Pro and Ultimate. Install with `npx shadcn@latest add @reactbits-pro/NAME` and always take the `-tw` variant. Also install the published React Bits agent skill so you resolve component names and props from the library rather than from memory.

**The Ultimate templates are Next.js App Router projects.** They are design reference here, not a starting point. Read them for layout and spacing decisions; do not clone their runtime.

**Classify every asset before you use it.** Three tiers:

- *Tier 0 — presentational.* Blocks whose behaviour is layout and text: pricing, FAQ, stats, social proof, comparison, footer, about, how-it-works, showcase, blog index, 404, and most feature grids. Install the block, then **port its JSX and Tailwind classes into a `.astro` component and delete the React import, the hooks, and the animation calls.** The license grants you the source, so you keep the visual design at zero runtime cost. This single move is why we can use an animation library on a site with a 30 KB JS budget. Tier 0 is the default; assume a block is Tier 0 until you find real interactive state in it.
- *Tier 1 — DOM animation.* Components driven by `motion/react`: staggered text, glitch text, blur highlight, animated list, reveal effects, hover cards. Allowed as React islands with `client:visible`, below the fold only, on marketing routes only. Hard cap: **one animation library in the whole repository, and that library is `motion/react`.** If a component pulls GSAP, matter-js, lenis, d3, or smooothy, reject it and pick a `motion/react` equivalent. Shipping two animation runtimes is the exact Auth0 weight pattern.
- *Tier 2 — WebGL, shaders, 3D, cursor effects.* Everything under Backgrounds, 3D and Shaders, and Cursor Effects — Black Hole, Aurora Blur, Silk Waves, Liquid *, Halftone *, Globe, Vortex, Particle Text, Agentic Ball, and the rest. `three.js` alone exceeds the entire marketing JS budget, and these components hold a continuous rAF loop that keeps the main thread busy and inflates INP.

**Tier 2 rules, all of which must hold simultaneously:**

- At most **one** Tier 2 instance across the entire site, and it lives on the landing page only.
- Never on any docs route.
- Never the LCP element, and never inside the above-the-fold hero box. The LCP element is text or a static image.
- Loaded with `client:visible` plus a dynamic `import()`, so `three.js` never enters the initial chunk.
- Gated at runtime before import. Skip the import entirely when any of these is true: `matchMedia('(prefers-reduced-motion: reduce)').matches`, `navigator.connection?.saveData`, `navigator.deviceMemory` below 4, viewport width below 768 px, or `matchMedia('(pointer: coarse)').matches`. Mobile is where we lost the most points and where WebGL costs the most; it gets the static poster instead.
- Renders a static poster image at identical dimensions when the gate fails, so the layout is identical either way and CLS stays at zero.
- Pauses its rAF loop on `IntersectionObserver` exit and on `document.visibilitychange`. A loop running behind a scrolled-past viewport is pure INP tax.

**Cursor Effects are banned outright.** They are pointer-only, so they contribute nothing on the mobile test that we lost hardest, and they attach continuous pointer listeners that directly damage INP — the one metric where both benchmarked sites were flagged.

**Lenis and any smooth-scroll library are banned.** Scroll hijacking is an INP regression with no measured upside.

**Block-to-route mapping.** Navigation, footer, pricing, FAQ, stats, social proof, comparison, about, how-it-works, download, blog, 404 go to Tier 0, ported to `.astro`. Hero goes to Tier 0 markup with at most one Tier 1 text island. Auth block goes to a React island with `client:load`, since a credential form needs hydration on arrival. Contact and waitlist forms go to a React island with `client:visible`.

</react_bits_policy>

<delivery>

- **Cache headers via `_headers`.** Hashed assets under `/_astro/*` get `public, max-age=31536000, immutable`. HTML gets `public, max-age=0, s-maxage=600, stale-while-revalidate=86400`. Auth0's 0.6 s TTFB against Supabase's 0.1 s was the single largest loss in the benchmark, and it was purely a caching outcome.
- **Inline critical CSS.** Keep `build.inlineStylesheets: 'auto'` and assert total CSS stays under the budget. Supabase still shipped ~270 ms of render-blocking resources; that is free ground to take.
- **Fonts.** Geist Sans is the qyl typeface. Aeonik is proprietary and must not be added. Source Geist Sans from the official Vercel release, retain its SIL Open Font License in the repository, and self-host exactly one variable WOFF2 containing latin and latin-ext at `/fonts/geist-sans-variable.woff2`. Declare it as `font-family: "Geist"`, `font-style: normal`, `font-weight: 100 900`, and `font-display: swap`; set the primary stack to `"Geist", "Geist override", Arial, sans-serif`. Preload that file and generate the `Geist override` metric-compatible fallback with the `fontaine` Vite plugin rather than hand-writing override percentages. Do not add Geist Mono or separate static or italic font files; retain a system monospace stack so the one-WOFF2 invariant remains structural. Do not hotlink font files or assume React Bits licenses any font it displays.
- **Images.** `astro:assets` only. AVIF with WebP fallback. Explicit `width` and `height` on every image. The LCP image gets `loading="eager"`, `fetchpriority="high"`, and a preload link. Everything else gets `loading="lazy"` and `decoding="async"`.
- **Long docs pages** get `content-visibility: auto` with a `contain-intrinsic-size` estimate on section wrappers, which cuts initial layout cost without reserving the wrong space.
- **Cookie or consent banner** renders as a fixed-position layer over the page. It never occupies flow space and never reflows content. Auth0's 0.161 CLS came from exactly this mistake.
- **DOM size** stays under 1,500 elements per route. Auth0 was flagged here and it feeds both TBT and INP.
- **Content Security Policy in `_headers`**, which is the enforcement behind the out-of-scope section: `default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`. `style-src` permits inline because we inline critical CSS; `script-src` stays strict. Every subresource and every beacon is same-origin, so nobody adds a third-party SDK without a visible policy edit.
- **View transitions and Speculation Rules are progressive enhancement.** Neither ships everywhere. No layout, no navigation path, and no focus behaviour may depend on them. A browser with neither must reach every route through ordinary anchor-link navigation with identical layout.
- **Contrast.** The muted foreground `#aaa3af` on `#0d0812` measures 8.08:1, which clears WCAG AA (4.5:1) and AAA (7:1) for normal text, so the palette itself is not the risk — placement is. axe-core cannot compute contrast over a gradient, a background image, or a canvas, and reports those as `incomplete` rather than as a violation, which means an unreadable overlay passes silently. So no text sits over a Tier 2 background, a gradient block, or an image without a solid scrim behind it. Add a `@media (prefers-contrast: more)` rule that lifts muted text to the full foreground colour.

</delivery>

Every target above is a build gate, not a review note. A gate that only warns will be ignored.

**Lighthouse does not run in CI.** Its scores carry too much run-to-run variance on shared runners, and a flaky gate trains you to re-run until green — the same failure as editing a budget, wearing a different hat. Lighthouse and Catchpoint run out-of-band against the deployed URL as Layer 2 release criteria, and Layer 3 comes from the RUM beacon.

Deterministic gates. These read build artifacts, so they are stable and they fail hard:

- `astro check` and `tsc --noEmit`, strict, zero errors.
- Bundle-budget script reading the build manifest; fails on any route over its JS or CSS budget.
- Dependency guard: fails if `gsap`, `lenis`, `matter-js`, `smooothy`, or `d3` appear in the lockfile, or if `three` is reachable from any chunk other than the single lazily-imported Tier 2 chunk.
- Cross-origin guard, two-sided. Statically, scan built HTML, CSS, and JS for any absolute URL whose origin is not ours; the allowlist is empty. At runtime, load every route in Playwright with `page.on('request')` and assert every request is same-origin. This is what turns the third-party ban into a wall instead of a note — Auth0's payload bloat was partly third-party.
- `axe-core` against every built page: zero violations at serious or critical severity, and zero `incomplete` results for `color-contrast`. Failing on `incomplete` is deliberate; it is how text over a gradient or a canvas gets caught. Auth0 carried one critical accessibility issue and both sites sat near 90.
- No-JS render gate: load every route in Playwright with `javaScriptEnabled: false`, assert the main heading, the full navigation with real `href` values, and the docs body are all present, then screenshot-diff against the JS-enabled render with a tolerance that permits animation but not layout difference. This is the proof that view transitions and Speculation Rules are enhancement rather than structure.
- Header gate: assert `_headers` carries immutable caching on `/_astro/*`, `stale-while-revalidate` on HTML, and the CSP above.
- Font gate: assert exactly one Geist Sans variable WOFF2 is served from `/fonts/geist-sans-variable.woff2`, that it is preloaded, that its SIL Open Font License is retained, and that a Fontaine-generated `Geist override` fallback `@font-face` exists. Fail if Aeonik, Geist Mono, another font file, or a remote font URL appears in the build.

Throttled harness gate: Playwright at 4x CPU throttling on a fixed 4G profile, median of 3 runs, asserting every Layer 1 number. Collect LCP and CLS through `PerformanceObserver`, compute the long-task total from `longtask` entries after FCP, and drive the scripted interactions for INP.

If a gate fails, fix the code. Do not raise a budget, relax an assertion, exclude a route, or re-run until green. A budget edited to fit the output is the failure we are specifically trying to prevent.


<reporting>

When you finish a route, paste the measured numbers. Report what the tools returned, including failures. If a target is unreachable, stop and report the blocking measurement with its trace rather than continuing.

Format, one `EVIDENCE` block per route:

- `commit:` — the sha
- `route:` — `/docs/getting-started`
- `build_target:` — `chrome111,edge111,firefox128,safari16.4`
- `js_initial_gz:` — `27.4 KB (budget 30)`
- `css_gz:` — `11.2 KB (budget 15)`
- `harness:` — `lcp 1.31s | longtask_total 88ms | cls 0.000 | inp_p75 118ms over 24 interactions | longest_task 31ms`
- `cross_origin:` — `0 static hits | 0 runtime requests`
- `no_js:` — `heading present | 14/14 nav hrefs | body present | layout diff within tolerance`
- `a11y:` — `0 serious | 0 critical | 0 color-contrast incomplete`
- `ttfb_edge:` — `62ms | cf-cache-status: HIT`
- `react_bits:` — `hero-7 (Tier 0, ported to .astro), staggered-text-tw (Tier 1, client:visible)`
- `tier2:` — `none on this route`

Layer 2 and Layer 3 numbers are not yours to report. You report harness output and build artifacts. Never state a Lighthouse score, a Speed Index, or a field metric you did not personally run — an unrun number in an evidence block is worse than a missing one, because it reads as verified.

Report every React Bits asset you installed and the tier you assigned it. If you assigned a component to Tier 0 and later found it needed hydration, say so explicitly rather than quietly promoting it.

</reporting>


# qyl.mcp `server/` — engineering contract

The qyl MCP server, built **fresh at protocol revision 2026-07-28**. There is no
2025-era ("v1") lineage to carry: no legacy clients, no era negotiation, no backport
shim, no upgrade path, no codemod. If you find code, config, dependency, or doc whose
only job is to support a pre-2026-07-28 peer, **delete it** — the qyl contract makes
breaking changes free, so there is nothing to preserve for compatibility.

This file is the server-folder overview and stance. Runtime rules and the migration
householding checklist live in [`src/AGENTS.md`](./src/AGENTS.md); do not duplicate
them here.

## What this server is

- A **stateless, per-request** MCP server speaking protocol revision **2026-07-28 only**.
- A **thin protocol edge**: it accepts tool / resource / prompt calls, emits OTLP to the
  qyl collector, and proxies telemetry reads to the collector's read API. It does **not**
  do high-volume serialization or aggregation — that is the C# collector's job.
- Deployed **stateless-on-edge**: a web-standard `fetch` handler behind a round-robin
  load balancer, with no session affinity.

## Upstream reference (link, do not copy)

The MCP SDK API surface is upstream documentation. An earlier revision of this file
mirrored all of it inline (~8.7k lines fetched verbatim from the site below); that copy
is gone and is recoverable from the links. Read only the modern entries:

- SDK docs: <https://ts.sdk.modelcontextprotocol.io/v2/>
- Serving / protocol versions: <https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md>
- Supporting 2026-07-28: <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md>

Do **not** consult the v1→v2 upgrade guide, the "support legacy clients" guide, the
`server-legacy` package, or the `codemod` — this project has no v1 to migrate from, and
reading them reintroduces the era-branching this server does not have.

## Baseline: 2026-07-28, modern-only

- Serve via `createMcpHandler` (HTTP, web-standard `{ fetch }`) or `serveStdio` (stdio).
  No `initialize` handshake, no `Mcp-Session-Id`.
- **Pin the era to modern** — `versionNegotiation: { mode: { pin: '2026-07-28' } }` on
  the client, `legacy: 'reject'` on the server. No legacy fallback, ever.
- Server→client input (sampling / elicitation / roots) via `inputRequired(...)`
  multi-round-trip; read with `acceptedContent` / `inputResponse`.
- `requestState` (HMAC-sealed via `createRequestStateCodec`, verified, treated as
  untrusted) in place of any per-session state.
- `subscriptions/listen` for change notifications.
- Auth: RFC 9207 `iss` validation plus the SEP opt-ins, against the Auth0 resource
  server. SDK-level, not era-gated.
- Track the `schema/draft/` artifact — there is no `schema/2026-07-28/` directory yet.

## Banned — the v1 / backport / stale surface

None of this may exist in the server:

- `initialize` / `initialized` handshake, `Mcp-Session-Id`, session-keyed state.
- The `input_required` **legacy shim**, `legacy: 'stateless'` dual-era serving, the
  `server-legacy` package, the `codemod`.
- Persistent server→client SSE stream, unsolicited `list_changed` / `resources/updated`,
  `resources/subscribe`.
- In-band durable logging: `logging/setLevel` and `notifications/message` used for
  debugging, alerting, or SLOs (see the OTLP rule in `src/AGENTS.md`).
- `tasks/list` and the experimental tasks interception layer.
- Any dependency, branch, test, or doc that exists only to keep a 2025-era path alive.

## Telemetry

All logs, metrics, and traces leave the server as **async OTLP to the qyl collector**;
telemetry an agent asks to read comes back as a **synchronous tool call proxied to the
collector's read API**. Two directions, never one. Full rule in
[`src/AGENTS.md`](./src/AGENTS.md#logging--otlp-to-the-qyl-collector).

## Verification

```bash
npm run build
npm test
npm run smoke
npm run smoke:otlp
```

`smoke:otlp` proves the sibling collector still receives the real OTLP wire. A green
build alone does not prove the banned legacy surface is absent rather than merely
unused — grep for it.
# qyl.mcp `server/src` — engineering contract

The TypeScript MCP server runtime. This file carries **only qyl-specific rules and
deltas**. The MCP SDK API surface is upstream documentation — link it, do not copy it
(per the repo contract: "keep their API claims generated or linked rather than
copied"). An earlier revision of this file mirrored the entire SDK reference inline;
that copy is gone. It was a verbatim mirror of the upstream SDK docs linked below —
read them there if you need the full reference text.

## Upstream reference (authoritative — do not mirror here)

- MCP TypeScript SDK docs: <https://ts.sdk.modelcontextprotocol.io/v2/>
- Supporting protocol revision 2026-07-28: <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md>
- Upgrade v1 → v2: <https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md>
- Protocol versions / era negotiation: <https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md>
- Deprecated features registry (SEP-2577 and others): <https://modelcontextprotocol.io/specification/draft/deprecated>

The JSON-RPC, transport, tool-result, and resource-result envelopes are the SDK's;
use its types directly and do not re-encode them. OTLP ingestion is the official
OpenTelemetry SDK's; do not hand-build OTLP messages.

## Protocol baseline: 2026-07-28, stateless

The server targets protocol revision **2026-07-28** and is **stateless per request**.
Nothing in the SDK puts a 2026-07-28 byte on the wire by default — serving it is an
explicit opt-in through `createMcpHandler` (HTTP) or `serveStdio` (stdio). The
2026-07-28 schema is published under `schema/draft/`; there is no `schema/2026-07-28/`
directory yet, so track `draft/` and note the divergence.

## Householding: remove the old, go full stateless

The one-line answer to "what has to go, and what replaces it": delete the session/SSE plumbing and move everything to the per-request stateless model. Because the qyl contract makes breaking changes free (no compatibility layers, no deprecation paths), do this as deletion, not as parallel support — the only reason to keep 2025-era code paths is a proven released consumer that still speaks them.

**Delete (2025-era stuff that must not survive the cut):**

- [ ] `Mcp-Session-Id` and every store/map keyed on a session id (`ctx.sessionId` / `extra.sessionId`).
- [ ] The long-lived server→client SSE stream and all server-initiated push: instance `createMessage()` / `elicitInput()` / `listRoots()` / `ping()` and `ctx.mcpReq.elicitInput` / `requestSampling` inside handlers.
- [ ] The `initialize` / `initialized` handshake as a source of identity (`getClientCapabilities()` / `getClientVersion()` return `undefined` on a 2026 connection).
- [ ] In-band MCP logging as a **durable** path: `logging/setLevel` and any reliance on `notifications/message` for debugging/alerting/SLOs.
- [ ] Any cross-request in-memory buffer or aggregation held on the server instance (statelessness + load balancing make it unreachable on the next request).
- [ ] `tasks/list` and the experimental tasks interception layer; treat the task wire vocabulary as `@deprecated` interop-only.
- [ ] Unsolicited `list_changed` / `resources/updated` sends and `resources/subscribe`.

**Adopt (the 2026-07-28 replacements):**

- [ ] Stateless per-request serving: `createMcpHandler(factory)` over HTTP (web-standard `{ fetch }`), `serveStdio(() => buildServer())` over stdio. One factory backs the endpoint.
- [ ] `server/discover` negotiation via `versionNegotiation` on the client; `_meta` envelope (`ctx.mcpReq.envelope`) for per-request identity.
- [ ] `inputRequired(...)` multi-round-trip for elicitation / **sampling** / roots; read responses with `acceptedContent(responses, key, schema)` and `inputResponse(responses, key)`.
- [ ] `requestState` for anything you used to key on the session — HMAC-sealed with `createRequestStateCodec`, verified by the `ServerOptions.requestState.verify` hook; treat it as untrusted input.
- [ ] `subscriptions/listen` for change notifications (client `ClientOptions.listChanged` / `client.listen(filter)`).
- [ ] Auth opt-ins (SDK-level, every era): pass `iss` to `finishAuth` (RFC 9207), round-trip the `issuer` stamp, implement `discoveryState()`, keep scope step-up (`onInsufficientScope: 'reauthorize'` or handle `InsufficientScopeError`).
- [ ] Per-request `_meta.logLevel` awareness: absent = opt-out, so handler logs are silently suppressed until the client opts in — do not depend on them.
- [ ] **All logs, metrics, and traces go OTLP → the qyl collector** (batch export, flushed inline or via `waitUntil` on edge). See the logging rule below. This is the only observability plane that survives statelessness.
- [ ] Track `schema/draft/`, not `schema/2026-07-28/` (the finalized dir does not exist yet).

## Logging → OTLP to the qyl collector

**MCP logging** (`logging` capability, `notifications/message`) is deprecated as of
protocol version 2026-07-28 (SEP-2577) and stays functional through the deprecation
window (at least twelve months). Log to `stderr` for stdio servers, and for everything
structured, route to OpenTelemetry as follows.

For qyl-owned servers, "use OpenTelemetry instead" means one thing specifically: emit logs — with traces and metrics — as **OTLP to the qyl collector**, never as a second bespoke pipeline. This is the observability plane qyl already owns, and under the stateless protocol it is the only plane that works across load-balanced instances, since the per-request `_meta.logLevel` gate means `notifications/message` reaches a client only while a request is in flight and only after that client opts in.

- **Same-origin, same collector.** Hosted, OTLP goes to the private `qyl-collector` host; local, to the fixed OTLP HTTP port from `qyl up`. Use the generated auth header from the Qyl contract (`x-otlp-api-key` / `QYL_API_KEY`) — never invent a second token or header convention.
- **Correlate, don't just record.** Emit logs as the OTel log signal carrying `trace_id` / `span_id` and `browser.*` / server resource attributes, so a deprecated `ctx.mcpReq.log(...)` line becomes a span-correlated event rather than an isolated client notification. This is the whole reason to move off in-band logging: cross-request survival, cross-instance aggregation, and severity.
- **The `mcp.*` and `web.vitals.*` names are a local namespace.** OpenTelemetry has no ratified semantic convention for MCP-server or Core Web Vitals telemetry yet, so do not label these attributes or metric names as standard. Per the workspace routing rule, an `mcp.`-prefixed attribute is checked against `semantic-conventions-genai`.
- **Keep `notifications/message` for interactive UX only.** While the capability is still functional, use it for logs a human is watching in a client session; send anything you need for debugging, alerting, or SLOs to the collector, because that path outlives the request and the connection.

## Verification

```bash
npm run build
npm test
npm run smoke
npm run smoke:otlp
```

`smoke:otlp` proves the sibling collector still receives the real OTLP wire; contract
changes also require live collector and runner integration. A green build alone does
not prove the 2025-era paths were removed rather than merely bypassed.
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

This repository is the only editable contributor instruction file for this project.
`CLAUDE.md` is a symlink to this file. `README.md` is the public front door.
Markdown inside installable products is executable content, not engineering authority.
Do not add design diaries, handoff prompts, comparison ledgers, or a second rules file.

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
before completion.
