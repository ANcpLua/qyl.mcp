# qyl.mcp repository contract

Owns the finite qyl MCP server, Workbench host, dynamic MCP connections, and
Workbench UI. The server is closed-world and its tool manifest is generated;
foreign servers are open-world and discovered through MCP negotiation.

Use generated qyl-api-schema contracts for qyl transport and tool data. Use MCP
SDK types for protocol envelopes. Browser code must not import deployable server
implementation. Keep secrets and process control in the host, never the browser.
Do not patch SDK internals when an owned registration boundary exists.

Validate with `npm ci`, `npm run verify:pins`, `npm run build`, `npm test`,
`npm run smoke`, and `npm run smoke:otlp`. Regenerate the tool snapshot only
deliberately and inspect its diff. Publishing is CI OIDC only.
