# MCP conformance fixture

This fixture is a deterministic, official-SDK MCP server used to verify the
qyl.mcp workbench against real protocol behavior. It exposes paginated tools,
resources, resource templates, and prompts; read-only and destructive tool
annotations; structured, image, embedded-resource, and resource-link content;
tool errors; and cancellable delayed execution. HTML-shaped fixture content is
deliberately untrusted data and must never be executed by a client.

Build the workbench before starting either transport:

```bash
bun run --cwd workbench build
node workbench/fixtures/mcp-conformance-stdio.mjs
```

The HTTP fixture requires an environment-sourced bearer credential and exposes
one Streamable HTTP endpoint:

```bash
export QYL_MCP_FIXTURE_BEARER="replace-with-a-test-secret"
export QYL_MCP_FIXTURE_PORT=3334
node workbench/fixtures/mcp-conformance-http.mjs
```

- Streamable HTTP: `http://127.0.0.1:3334/mcp`
- Header: `Authorization: Bearer $QYL_MCP_FIXTURE_BEARER`

The credential is compared without logging or returning it. The HTTP server is
loopback-bound by default and uses the SDK's MCP Express host-header protection.
