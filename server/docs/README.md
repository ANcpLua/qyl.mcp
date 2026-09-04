# Vendored MCP TypeScript SDK server docs

Verbatim copies of the SDK v2 server guides, fetched 2026-08-29 from
`https://ts.sdk.modelcontextprotocol.io/v2/servers/<name>.md` (and
`/v2/protocol-versions.md`), so the SDK contract rules in
[`.claude/skills/mcp-typescript-sdk-v2/SKILL.md`](../../.claude/skills/mcp-typescript-sdk-v2/SKILL.md)
can be checked against the documented behaviour offline. Documentation in the
MCP project is licensed CC-BY-4.0 (see the `LICENSE` shipped in `@modelcontextprotocol/server`).

Refresh, never edit: `for n in tools resources prompts completion errors
notifications input-required; do curl -sf
https://ts.sdk.modelcontextprotocol.io/v2/servers/$n.md > $n.md; done` and
`curl -sf https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md >
protocol-versions.md`.
