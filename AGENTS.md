# qyl.mcp repository contract

Owns the finite qyl MCP server, Workbench host, dynamic MCP connections, and
Workbench UI. The server is closed-world and its tool manifest is generated;
foreign servers are open-world and discovered through MCP negotiation.

Generated qyl-api-schema contracts own the qyl data shapes that cross the wire;
the MCP SDK owns everything the protocol defines. The two meet at registration:
`registerTool`, `registerResource`, and `registerPrompt` take a contract schema
as their Zod schema, and the SDK derives the advertised JSON Schema, validates
arguments, and types the handler from that one schema. Do not hand-write a
second description of a shape a contract already publishes.

Match the error channel to the handler kind. A tool handler owns `isError`:
return it, or throw and let the SDK convert the message for the model. A
resource, prompt, or completion callback has no such channel — throw
`ProtocolError` or one of its typed subclasses (`ResourceNotFoundError` for a
read that cannot produce contents). Anything else leaves as `-32603` Internal
Error carrying the raw exception text, which loses the code and the structured
`data`, and publishes whatever the exception happened to say.

Reach for the SDK's seams before its internals. Registering a handler for a verb
the SDK routes but deliberately leaves to the server — `resources/subscribe` is
the documented example — is a seam, and so is any option the SDK exposes.
Reassigning a method the SDK owns is not: it binds the code to a registration
order nothing enforces, and it fails silently when that order changes.

Browser code must not import deployable server implementation. Keep secrets and
process control in the host, never the browser.

Bun owns dependency management: `bun.lock` is the only lockfile and
`packageManager` pins the Bun version. npm appears exactly once, as the publish
client trusted publishing requires. Validate with `bun install --frozen-lockfile`,
`bun run verify:pins`, `bun run build`, `bun run test`,
`bun run smoke`, and `bun run smoke:otlp`. Regenerate the tool snapshot only
deliberately and inspect its diff. Publishing is CI OIDC only; a registry write
that is not a publish (dist-tag move, deprecate) goes through
`~/.claude/bin/npm-authed` — the script header is the runbook.
