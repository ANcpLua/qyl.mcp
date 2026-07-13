# qyl.mcp engineering contract

This is the repository's only editable contributor and agent instruction file.
`CLAUDE.md` is a symlink to it. `README.md` is the public front door. Markdown
inside an installable plugin is executable product content, not an engineering
authority. Do not add design diaries, handoff prompts, comparison ledgers, or a
second rules file.

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

## Repository shape

Keep the root README current and concise. Git preserves completed architecture
work and comparisons; do not retain them as active specifications. Retain plugin
prompts or skills only when they have an installable manifest, a real
distribution path, and executable tests, and keep their API claims generated or
linked rather than copied.

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
