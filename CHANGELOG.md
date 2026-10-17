# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 10.1.0

- Align server and workbench on SemanticConventions 13.1.1 while retaining API schema 14.0.0.
- Separate hosted evaluation login profiles and requested scopes, retain owner and reviewer credentials independently, and pass the selected token file to the evaluator. Verify profile/output selection through the real CLI.
- Keep hosted read/scope/validation checks distinct from successful owner operations across all 32 tools.

## 10.0.0

- Adopt SemanticConventions 13.0.0 across server and workbench while retaining API schema 14.0.0. Application attributes use their native names and types without the obsolete string-only `qyl.app` template.
- Remove the workbench's duplicate SemanticConventions development dependency; its runtime dependency supplies the same package for compilation.
- Check the workbench's runtime conventions pin rather than its development pin. Real CLI tests reject stale or missing runtime pins and preserve the Collector contract check.

## 9.0.0

- Align server and workbench SemanticConventions dependencies on 12.0.0.

- Export hosted tool traces, metrics and logs even when local execution storage is disabled. Verified callers select their configured collector project; producer setup failures are logged without interrupting tools or exposing credentials.
- Use API schema 14.0.0 for canonical resource/scope metadata, metric descriptor conflicts and original point pages. Re-query oversized point pages with points_limit; a single point over the MCP budget returns response_too_large and its HTTP points route without truncating numeric values, buckets or exemplars.
- Display log observation time when event time is absent, and unknown when both are absent.
- Verify hosted project routing, errors and correlation using decoded official OTLP 1.11.1 protobuf payloads.
