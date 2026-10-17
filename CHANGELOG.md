# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 10.1.1

- Align server, workbench and dashboard on API schema 14.0.1, which retains the existing Collector contract revision.
- Consume SemanticConventions 13.1.2 in server and workbench.
- Refresh the workspace install during a version bump so frozen installs see matching server self-pins.

## 10.1.0

- Align server and workbench on SemanticConventions 13.1.1 while retaining API schema 14.0.0.
- Separate hosted evaluation login profiles and requested scopes, retain owner and reviewer credentials independently, and pass the selected token file to the evaluator. Verify profile/output selection through the real CLI.
- Keep hosted read/scope/validation checks distinct from successful owner operations across all 32 tools.

## 10.0.0

- Adopt SemanticConventions 13.0.0 across server and workbench while retaining API schema 14.0.0. Application attributes use their native names and types without the obsolete string-only `qyl.app` template.
- Remove the workbench's duplicate SemanticConventions development dependency; its runtime dependency supplies the same package for compilation.
- Check the workbench's runtime conventions pin rather than its development pin. Real CLI tests reject stale or missing runtime pins and preserve the Collector contract check.
