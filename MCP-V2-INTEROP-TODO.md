# qyl.mcp ChatGPT and MCP v2 interoperability

Work toward one production endpoint, `https://mcp.qyl.at/mcp`, using TypeScript
SDK v2 and OAuth 2.1. Use the SDK's documented support for both `2026-07-28` and
2025-era tool clients. Events are configurable and may persist the subscription
state they need. The current requirements are in
[goal-objective.md](goal-objective.md), updated on 7 October 2026.

## Established starting point

- [x] Restore a local checkout of current GitHub `main` at
  `/Users/alexandernachtmann/RiderProjects/qyl.mcp`.
- [x] Replace the modern-only protocol requirement with SDK v2 compatibility
  and permit necessary Events subscription storage in the working objective.

The active branch `codex/mcp-client-events` now implements the SDK serving
defaults and ongoing Events authorization. The local results below are verified;
production and client checks remain separate.

## Execution sequence

### 1. Consolidate dependencies

- [x] Recheck current PRs and failing checks against main. Integrate applicable
  SDK v2 updates across server, client, core, and adapters as one tested set.
- [x] Align dashboard/workbench with the current qyl-mcp-server workspace
  package; use exact dependency versions and regenerate the affected lockfiles.
- [ ] Resolve the known test/OTLP failures and lockfile conflicts. Recheck their
  causes; the dated PR review below is a starting point.

### 2. Adopt SDK serving and negotiation

- [x] Use `createMcpHandler(factory)` and `serveStdio(factory)` with the SDK's
  compatibility defaults for HTTP and stdio. Remove blanket rejection from
  workbench serving paths as well.
- [x] Review client negotiation, handler identity access, fixtures, and
  assertions against v2 documentation. Use SDK metadata/error/input helpers;
  keep protocol pins in tests that intentionally exercise a single era.
- [x] Update README and `QYL-MCP-MATRIX.md` with the implemented behavior.
  Preserve authorization, schemas, annotations, and the same tool contract.

### 3. Make Events operational locally

- [ ] Verify `MCP_EVENTS_STORE` configuration, persistent storage, and Events
  discovery when enabled; ordinary tools must also work when Events is off.
- [x] Verify ownership, filter isolation, callback verification, signed
  delivery, refresh, key rotation, restart survival, expiration, revoked
  access, and unsubscribe. Persist only the permitted subscription state.
- [ ] Exercise Events on the modern protocol path and verify ordinary tool
  compatibility with clients that do not support Events.

### 4. Verify the combined build

- [x] Run the repository's build/test/smoke commands and collector contract
  checks required by CI, including cross-repository version agreement.
- [x] Verify successful and invalid tool calls through both protocol eras over
  HTTP and stdio. Check authenticated HTTP access and authorization failures.
- [x] Compare the runtime tool catalog to its snapshot; regenerate only for
  deliberate changes. Resolve failures without weakening valid requirements.

### 5. Prepare and verify production

The active goal authorizes the required production work. Inspect current
settings and apply only the changes needed for this objective.

- [ ] Recheck public endpoint reachability and diagnose any actual Cloudflare
  block. Inspect current deployment and Auth0 settings before applying changes.
- [ ] Apply the necessary authorized settings and deploy the verified build.
  Check both resource metadata URLs, challenge, canonical audience, and scope.
- [ ] Verify the persistent volume and `MCP_EVENTS_STORE`; complete required
  plugin domain verification and scan the deployed tools/events.

Auth0 settings to verify: API identifier `https://mcp.qyl.at/mcp`, RFC 9068
RS256 tokens, `qyl:read`, CIMD, Resource Parameter Compatibility Profile, issuer
identification, and PKCE S256. Verify strict DCR with explicit client grants
and empty third-party default permissions. Use the current client metadata
documents and their published callbacks/token methods:

- ChatGPT: `https://chatgpt.com/oauth/client.json`
- claude.ai: `https://claude.ai/oauth/mcp-oauth-client-metadata`
- Claude Code: `https://claude.ai/oauth/claude-code-client-metadata`

Use the exact ChatGPT connection page values if it selects callback-specific
identity. Set `OPENAI_APPS_CHALLENGE` from the portal when required. Verify OIDC
`openid`/`email` and verified UserInfo only if workspace domain claiming is used.

### 6. Verify real client connections

- [ ] Complete actual CIMD and DCR logins and verify token audience/scope.
- [ ] In ChatGPT web, claude.ai, Claude Code, Codex CLI, and MCP Inspector,
  authenticate, list tools, and complete one read-tool call.
- [ ] Record client version, negotiated protocol, registration path, scopes,
  result, and exact errors. Accept supported 2025-era connections through v2.

### 7. Verify Events in ChatGPT

- [ ] On a supported modern-protocol ChatGPT surface, subscribe to `trace.error`
  for one service and verify the callback and saved subscription.
- [ ] Produce a matching error trace and confirm its signed delivery reaches
  the chat. Verify filtering, refresh, and survival across restart.
- [ ] Stop monitoring; confirm `events/unsubscribe`, record removal, and no
  further delivery to that subscription.

### 8. Record completion

- [ ] Update README, contract matrix, and this checklist with tested settings
  and evidence. Separate local, CI, and production results.
- [ ] Report completed client connections, Events results, and any exact
  remaining failure. A source implementation alone does not complete the goal.

## Local verification on 7 October 2026

- Exact SDK pins: core/client/server 2.3.1, Node adapter 2.1.1, Express adapter
  2.0.2. Dashboard and workbench resolve `qyl-mcp-server` to workspace 7.1.0;
  the old published 6.2.1 copy and its older contract are gone from `bun.lock`.
- Current PRs #71/#72/#73/#62/#74 were inspected through their current diffs and
  CI step results. The combined local build passes with the versions above.
  The separate historical CI failures are not attributed to a guessed cause.
- `bun run build`, `bun run lint`, `bun run test`: passed, 317 tests.
- `bun run smoke`: passed, including real modern and 2025-era stdio clients
  and the built workbench/dashboard. Hosted HTTP tests cover both eras,
  authenticated tool calls, invalid calls and 401/403 failures.
- `bun run verify:pins`: both repositories use API contract 11.2.0.
- Collector Release build: zero warnings/errors. Source-control metadata
  queries were disabled to honor the user's prohibition on Git-history access.
- `bun run smoke:otlp`: passed against the real local collector, including
  protobuf ingestion, storage, redaction, metrics and trace/log correlation.
- 27 focused Events/authorization tests pass. Added ongoing Auth0 access checks,
  cancellation during unsubscribe, retry-time expiry/key refresh, removal of
  stale keys/expired records on restart and late error-span detection.

Initial test attempts found two local test-setup issues: sandboxed test ports
were denied (`EPERM`), and the dashboard had not yet been built for its smoke
test. Both passed with allowed loopback ports and the complete build. The new
legacy metric assertion was corrected to the published `items` result field.

Production inspection: Railway's qyl-mcp service is running with a `/data`
volume. Auth0 login was renewed by the user. Auth0 currently uses RFC 9068,
resource compatibility, CIMD and issuer identification, but RBAC is disabled
and the third-party default grant includes both `qyl:read` and `qyl:control`.
The necessary corrections and a dedicated read-only Events access checker are
being prepared. No production change is claimed here yet.

## Existing implementation on main

These items describe source present in the restored checkout. They are not
proof of deployment or fresh test results.

- [x] Validate the Auth0 issuer metadata for CIMD, DCR, authorization code,
  PKCE S256, issuer identification, and supported client authentication.
- [x] Serve both RFC 9728 protected-resource metadata paths with canonical
  resource `https://mcp.qyl.at/mcp`; retain `qyl:read` in the 401 challenge.
- [x] Verify RFC 9068 RS256 access tokens for issuer, audience, expiry, subject,
  client ID, token ID, and scope.
- [x] Declare `qyl:read` in `_meta.securitySchemes` on all 11 tools and preserve
  read-only annotations in the regenerated tool snapshot.
- [x] Document the Auth0 setup, exact client metadata URLs, callbacks, and local
  v2 client commands in `README.md`.
- [x] Record the 30 September local modern-protocol checks with Claude Code,
  Codex CLI, and MCP Inspector in `README.md`; rerun after implementation.

- [x] Mark `display_traces` (global and thread) and `display_mcp_dashboard`
  (global) as ChatGPT plugin-extension entry points, with a monochrome
  entry-point icon and `inline`/`fullscreen` display modes on both viewers.
- [x] Serve MCP Events (`trace.error`, webhook delivery with callback
  verification and Standard Webhooks signatures) when `MCP_EVENTS_STORE` is set;
  declare the `/data` volume and the store path in `.railway/railway.ts`.
- [x] Answer `/.well-known/openai-apps-challenge` with `OPENAI_APPS_CHALLENGE`.

## Dependency review recorded on 6 October 2026

Recheck PR state and checks when execution resumes; this is a dated review.

- `#71` (client 2.3.0), `#72` (core 2.3.0), and `#62` (qyl-mcp-server v7
  consumers): open with passing lint/verification. `#62` still uses ranges.
- `#73` (Node adapter 2.1.1): open; `bun run test` failed.
- `#74` (lockfile maintenance): conflicted; live OTLP verification failed.
- `#56`, `#57`, and `#58`: closed; main already declares their target versions
  or newer ones. They are not outstanding merges for this objective.
- The PRs above leave the SDK server package at 2.0.0. Review the complete
  dependency set and test the combined result rather than inferring compatibility
  from individual PR results.

## Auth0 discovery decision

Auth0 is the authorization server and already serves OIDC discovery at
`https://qyl-eu.eu.auth0.com/.well-known/openid-configuration`. qyl.mcp does not
serve `/.well-known/openid-configuration` on `mcp.qyl.at`, because qyl.mcp is a
resource server rather than the token issuer. If ChatGPT workspace domain
claiming is needed, enable `openid` and `email` for the OAuth client and verify
that Auth0 UserInfo returns a verified email; this does not replace the
resource permission `qyl:read`.
