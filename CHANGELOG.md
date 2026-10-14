# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 8.1.2

- Pin SemanticConventions 9.9.2 (no attribute changes over 9.9.1).
- The plugin bundle README says the write tools also record failure status. The mcp.qyl.at landing page lists all 32 tools, `update_failure_status` among the writes, and numbers them 01 to 32. No server code change since 8.1.1.

## 8.1.1

- Package the corrected qyl-investigate skill: `verify_fix` needs `since` or `release` beside the `failure_id`.
- Documentation only otherwise: the plugin bundle README, the Anthropic listing draft and both plugin manifests describe the 32-tool surface; the release contract records the OpenAI plugin draft and the verified domain; the threat model states the single scope check. No code change since 8.1.0.

## 8.1.0

- Serve the qyl-investigate skill from the server through the MCP skills extension (`io.modelcontextprotocol/skills`: `skills/list`, `skills/get` and `resources/read` under `skill://qyl/`), so the OpenAI plugin portal imports it at Scan Tools and the npm package carries it in `dist/skills`. The skill now names the tool to start with for each question, the defaults every tool applies, the accepted `aggregate_telemetry` measures, and the one-call connection rule: no fan-out before one call has returned telemetry, one retry after sign-in, then stop.
- Advertise output schemas inlined rather than hoisted into `$defs`: ChatGPT does not resolve `$ref`, so `verify_fix.verdict` and most of `get_failure_context` reached the model as `unknown`. The redundant date-time regex is dropped from advertised schemas.
- Use collector contract 12.1.2, whose tool descriptions state the default window, baseline, page sizes, span selection and the accepted measure and ordering values.
