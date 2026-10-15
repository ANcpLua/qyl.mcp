# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 8.2.0

- Pin SemanticConventions 10.1.0 (`@ancplua/qyl-semantic-conventions`, server and workbench), including the generator compatibility fix and inspection cleanup. The telemetry attribute contract is unchanged.
- Allow a release whose version and workspace pins were committed before the gate, so publication uses the exact checked inputs.

## 8.1.4

- Pin SemanticConventions 10.0.1 (`@ancplua/qyl-semantic-conventions`, server and workbench): a `qyl.app.` key now follows the registry's denied keys and prefixes, plain token counts are token-exempt, four vendor keys are not persisted. No server code change.

## 8.1.3

- Pin SemanticConventions 10.0.0 (`@ancplua/qyl-semantic-conventions`, server and workbench): the `qyl.app` key and the `qyl.instrumentation.domain` values `app`, `messaging.process`, `gen_ai.invoke_agent`, `gen_ai.execute_tool`. Pairs with qyl 13.0.0. No server code change.
