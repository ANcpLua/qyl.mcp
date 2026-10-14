# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 8.1.3

- Pin SemanticConventions 10.0.0 (`@ancplua/qyl-semantic-conventions`, server and workbench): the `qyl.app` key and the `qyl.instrumentation.domain` values `app`, `messaging.process`, `gen_ai.invoke_agent`, `gen_ai.execute_tool`. Pairs with qyl 13.0.0. No server code change.

## 8.1.2

- Pin SemanticConventions 9.9.2 (no attribute changes over 9.9.1).
- The plugin bundle README says the write tools also record failure status. The mcp.qyl.at landing page lists all 32 tools, `update_failure_status` among the writes, and numbers them 01 to 32. No server code change since 8.1.1.

## 8.1.1

- Package the corrected qyl-investigate skill: `verify_fix` needs `since` or `release` beside the `failure_id`.
- Documentation only otherwise: the plugin bundle README, the Anthropic listing draft and both plugin manifests describe the 32-tool surface; the release contract records the OpenAI plugin draft and the verified domain; the threat model states the single scope check. No code change since 8.1.0.
