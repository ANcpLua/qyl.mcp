# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 11.1.3

- Consume SemanticConventions 15.0.1 in the server and workbench, aligned with the corrected shared persistence policy.
- Reject stale server pins in the workspace lockfile even when manifests agree and Bun accepts a frozen install.

## 11.1.2

- Consume SemanticConventions 15.0.0 in the server and workbench, aligned with the Collector release wave.

## 11.1.1

- Consume SemanticConventions 14.1.0 and use its registry-generated captured-field classifier in MCP.
- Remove MCP's local captured-field roots and regex classifier while retaining string-array checks and attribute-record handling.
