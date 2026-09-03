# Server API — tools, resources, prompts

## registerTool

```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

server.registerTool(
  'search',
  {
    description: 'Search the product catalog',
    inputSchema: z.object({
      query: z.string().describe('Substring to match'),   // .describe() becomes the JSON Schema description
      limit: z.number().int().max(50).optional()
    })
  },
  async ({ query, limit }) => ({ content: [{ type: 'text', text: '…' }] })
);
```

One Zod schema yields three things: the advertised JSON Schema in `tools/list`, argument
validation **before** the handler runs (failures return `isError: true`; the handler never sees
them), and the handler's inferred argument types. In qyl.mcp, that schema is the generated
contract schema from `@ancplua/qyl-api-schema` wherever a contract type crosses this boundary.

A tool with no arguments omits `inputSchema` entirely.

### Structured output

```ts
{
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ name: z.string(), price: z.number() })
}
// handler returns both renderings:
return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
```

`structuredContent` is validated against `outputSchema` before the result leaves the server —
except on `isError: true` results, where validation is skipped. Wire encoding of structured
results differs by era.

### Content blocks

`content` is an array mixing: `text`, `image` (base64 `data` + `mimeType`), `audio`, `resource`
(embedded contents, no `resources/read` round-trip), `resource_link` (URI only, no bytes).

### Title and annotations

`title` is the display name. `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
are client-side hints — they never change how the SDK executes the tool; hosts use them for
auto-approve / confirm decisions. qyl.mcp imports `ToolAnnotations` from the server package.

### Registration handles

`registerTool` returns a handle. `handle.update({...})`, `.enable()`, `.disable()`, `.remove()`
each send `notifications/tools/list_changed` automatically. `registerResource` and
`registerPrompt` handles do the same for their list types. Explicit `sendToolListChanged()` is
only for changes the registration API cannot see.

## registerResource

```ts
import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';

// Direct resource — fixed URI, appears in resources/list
server.registerResource('settings', 'config://app/settings',
  { description: '…', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, text: '…' }] }));

// Template resource — RFC 6570, appears in resources/templates/list
server.registerResource('note', new ResourceTemplate('note://{id}', { list: undefined }),
  { description: 'A note by its id' },
  async (uri, { id }) => {
    const note = notes.get(String(id));
    if (!note) throw new ResourceNotFoundError(uri.href);   // -32602 + data.uri
    return { contents: [{ uri: uri.href, text: note }] };
  });
```

Text contents carry `text`; binary contents carry base64 `blob`. Resource callbacks have **no
`isError` channel** — failures are thrown `ProtocolError`s (see errors-and-input.md).

## registerPrompt

Same shape: name, config (`description`, `argsSchema` as Zod), callback returning
`{ messages: [{ role, content }] }`. Prompt callbacks are protocol-error-channel, like resources.

## Completions

`registerPrompt`/`ResourceTemplate` arguments can carry completion callbacks; the completion
callback is also protocol-error-channel.

## Low-level Server and the seam rule

`McpServer` wraps the low-level `Server` (reachable as `server.server`). Registering a handler
for a verb the SDK routes but leaves to the server (`server.server.setRequestHandler(...)` for
`resources/subscribe` bookkeeping in a 2025-era sessionful deployment) is a **seam** — documented
and supported. Reassigning a method the SDK owns is not; it binds to registration order and fails
silently when that order changes. The low-level `Server` also requires capabilities declared up
front (`{ capabilities: { tools: { listChanged: true } } }`) and refuses to send notifications
its capabilities do not cover — `McpServer` advertises them automatically as you register.
