# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 11.1.1

- Consume SemanticConventions 14.1.0 and use its registry-generated captured-field classifier in MCP.
- Remove MCP's local captured-field roots and regex classifier while retaining string-array checks and attribute-record handling.

## 11.1.0

- Release the current MCP server as 11.1.0 with unchanged runtime behavior from 11.0.0.

## 11.0.0

- Preserve explicitly captured HTTP-header and RPC-metadata string arrays unchanged, including credential-like names and values. Retain normal redaction for unrelated fields and malformed capture shapes.
- Remove duplicated captured-field deny lists and verify raw values through the MCP tool result boundary. Consume SemanticConventions 14.0.0.
