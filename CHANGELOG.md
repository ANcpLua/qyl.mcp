# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 10.1.2

- Consume SemanticConventions 13.2.0, aligned with the Collector captured-field retention policy.
- Recognize credential suffixes within captured HTTP-header and RPC-metadata keys. Redact each element of supported string arrays while preserving attribute names and array shape; keep generic credential and value protections.

## 10.1.1

- Align server, workbench and dashboard on API schema 14.0.1, which retains the existing Collector contract revision.
- Consume SemanticConventions 13.1.2 in server and workbench.
- Refresh the workspace install during a version bump so frozen installs see matching server self-pins.

## 10.1.0

- Align server and workbench on SemanticConventions 13.1.1 while retaining API schema 14.0.0.
- Separate hosted evaluation login profiles and requested scopes, retain owner and reviewer credentials independently, and pass the selected token file to the evaluator. Verify profile/output selection through the real CLI.
- Keep hosted read/scope/validation checks distinct from successful owner operations across all 32 tools.
