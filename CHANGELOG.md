# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 9.0.0

- Align server and workbench SemanticConventions dependencies on 12.0.0.

- Export hosted tool traces, metrics and logs even when local execution storage is disabled. Verified callers select their configured collector project; producer setup failures are logged without interrupting tools or exposing credentials.
- Use API schema 14.0.0 for canonical resource/scope metadata, metric descriptor conflicts and original point pages. Re-query oversized point pages with points_limit; a single point over the MCP budget returns response_too_large and its HTTP points route without truncating numeric values, buckets or exemplars.
- Display log observation time when event time is absent, and unknown when both are absent.
- Verify hosted project routing, errors and correlation using decoded official OTLP 1.11.1 protobuf payloads.

## 8.2.0

- Pin SemanticConventions 10.1.0 (`@ancplua/qyl-semantic-conventions`, server and workbench), including the generator compatibility fix and inspection cleanup. The telemetry attribute contract is unchanged.
- Allow a release whose version and workspace pins were committed before the gate, so publication uses the exact checked inputs.

## 8.1.4

- Pin SemanticConventions 10.0.1 (`@ancplua/qyl-semantic-conventions`, server and workbench): a `qyl.app.` key now follows the registry's denied keys and prefixes, plain token counts are token-exempt, four vendor keys are not persisted. No server code change.
