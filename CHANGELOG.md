# Changelog

qyl-mcp-server (`server/`). Each entry becomes the GitHub release notes of its tag. Older entries: [CHANGELOG.archive.md](CHANGELOG.archive.md).

## 12.0.0

- Remove every human-facing surface: the Workbench, its dashboard, the Trace Explorer and MCP Dashboard viewers (`display_traces`, `display_mcp_dashboard`, the app-only `fetch_telemetry` and their `ui://` resources) and the landing page. `/` answers 404; `/mcp`, `/healthz`, the OAuth discovery documents and the OpenAI domain challenge remain.
- Rename the `delete` tool to `delete_record`, without an alias.
- A completed or failed execution record that cannot be written no longer replaces the tool's outcome: the caller gets the tool's result or original error, a structured warning goes to stderr and the operation span carries `error.type=evidence_persistence_failed`.
- Remove the library exports only the Workbench used and its client-side telemetry, including `QYL_MCP_CAPTURE_CONTENT`; `qyl-mcp-server` and `qyl-mcp-server/auth` remain.
- The server instructions no longer advertise viewers or a tool count.

## 11.1.4

- Consume SemanticConventions 15.0.2 in the server and workbench, keeping the release wave on one verified registry version.

## 11.1.3

- Consume SemanticConventions 15.0.1 in the server and workbench, aligned with the corrected shared persistence policy.
- Reject stale server pins in the workspace lockfile even when manifests agree and Bun accepts a frozen install.
