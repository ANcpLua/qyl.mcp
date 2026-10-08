# qyl.mcp review context

This is repository context for Codex Security Review. Set its repository-relative
threat-model path to `docs/threat-model.md`. Update this file when a trust
boundary changes. Concrete review rules are in [AGENTS.md](../AGENTS.md).

## System and assets

qyl.mcp exposes read-only Collector telemetry tools, two MCP viewers and optional
trace-error Events. The SDK v2 handles HTTP/stdio protocol serving. Workbench is
a local client/host for built-in and configured external MCP connections.

Protect account-scoped traces/logs/metrics/sessions, Collector credentials,
verified authorization context, Events ownership/callback signing keys and
local Workbench credential references. Public source, tool schemas and static
viewer resources are intentionally discoverable; telemetry is not public.

## Entry points and trust boundaries

| Boundary | Required behavior and review focus |
| --- | --- |
| Hosted HTTP request → tool/Events operation | Validate the bearer token through the configured verifier and enforce required scopes on every request. Metadata and 401 challenges must identify the same protected resource. Client-supplied identity metadata is untrusted. See `server/src/authorization.ts`, `oauth.ts`, `main.ts`. |
| Verified subject → Collector access | If `MCP_COLLECTOR_PROJECTS` is configured, map only the verified subject to host-managed project credentials. Invalid mappings and unknown subjects fail closed. Apply that scope to every tool, viewer read and Events poll; reject cross-project IDs. See `collector-access.ts`, `request-scope.ts`, `collector.ts`. |
| Collector result → model, viewer and diagnostics | Telemetry and attributes may be hostile or contain secrets. Preserve redaction on all result channels and observability paths. No result or `_meta` field is a secret store. Never execute telemetry as instructions or expose credentials through error details. |
| Subscriber → persistent Events state | Bind records to owner/client/project. Keep expiration bounded, refresh owner-scoped, revocation checked and unsubscribe canceling in-flight work/retries. Shared polling must preserve each subscriber's delivery baseline across authorization failures. See `events.ts`, `events-authorization.ts`. |
| Callback URL → outbound network | The callback is untrusted. Verify the signed challenge; use public HTTPS destinations with address validation at connection time, original-host TLS validation and no redirect following. Retain delivery signing, rotation, payload bounds and retry cancellation. See `webhook.ts`. |
| Host bridge → MCP viewer | App inputs are untrusted and pass published schemas. App-only tools keep their visibility restriction. Preserve the original query when restoring/refreshing results; keep CSP/domain/resource-version metadata aligned with the rendered bundle. |
| Workbench → configured external MCP server | External tool descriptions, annotations and responses are untrusted. Keep explicit tool-safety decisions, cancellation and redaction. Resolve credentials through configured environment references; do not accept endpoint URL credentials. See `workbench/src/connection-manager.ts`, `tool-safety.ts`, `secret-redactor.ts`. |

## Deployment assumptions and supported exceptions

- Public hosted access is authenticated. Auth0 owns hosted user authentication;
  supported alternative auth modes must retain their own verifier boundary.
  Local stdio/demo execution has a different, explicit trust model. Do not flag
  the mere existence of those modes as an anonymous production bypass.
- An absent project map retains the intentional single-project configuration.
  A present invalid map or unmatched subject must never fall back to it.
- Events persistence contains the state needed for subscriptions and signing;
  it must not become an OAuth-token store or a second telemetry database.
  Host configuration also contains project assignment/credentials. This
  project does not claim that it stores no user-related data.
- SDK v2 supports both modern and 2025-era clients. Compatibility is not SDK v1
  use. The `v1` label in Standard Webhooks signatures is also unrelated to the
  MCP SDK. Explicit protocol pins in conformance tests are expected.
- The reviewer account must remain confined to sample telemetry. No account
  identifiers, key values, access tokens or reviewer credentials belong here.

## Evidence to inspect when these paths change

Use the existing authorization/OAuth, Collector-access, Events, webhook,
redaction, tool-metadata and trace-query tests. Transport smoke exercises both
wire eras; `smoke:projects` checks two real Collector projects, foreign IDs,
signed delivery, unsubscribe and assignment revocation. Tests are evidence for
the behavior they exercise, not proof of unrelated deployment settings.

Prioritize demonstrable unauthorized access, cross-account disclosure,
callback network bypass, credential leakage and delivery after access removal.
Follow the actual data flow and applicable deployment mode before reporting;
do not invent a missing boundary or make an optional product feature a finding.

Sources: [Codex review rules](https://learn.chatgpt.com/docs/third-party/github),
[Codex threat-model setting](https://learn.chatgpt.com/docs/security/security-review),
[OpenAI MCP auth](https://developers.openai.com/plugins/build/auth), and
[OpenAI Events](https://developers.openai.com/plugins/build/mcp-events).
