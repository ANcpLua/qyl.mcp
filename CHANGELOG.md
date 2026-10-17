# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 11.0.0

- Preserve explicitly captured HTTP-header and RPC-metadata string arrays unchanged, including credential-like names and values. Retain normal redaction for unrelated fields and malformed capture shapes.
- Remove duplicated captured-field deny lists and verify raw values through the MCP tool result boundary. Consume SemanticConventions 14.0.0.

## 10.1.2

- Consume SemanticConventions 13.2.0, aligned with the Collector captured-field retention policy.
- Recognize credential suffixes within captured HTTP-header and RPC-metadata keys. Redact each element of supported string arrays while preserving attribute names and array shape; keep generic credential and value protections.

## 10.1.1

- Align server, workbench and dashboard on API schema 14.0.1, which retains the existing Collector contract revision.
- Consume SemanticConventions 13.1.2 in server and workbench.
- Refresh the workspace install during a version bump so frozen installs see matching server self-pins.
