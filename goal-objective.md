# qyl.mcp interoperability and Events objective

Updated from the user's requirements on 7 October 2026. This is the working
objective for the active goal. It supersedes the older attachment's
modern-protocol-only and no-user-data requirements. Later user instructions
take precedence over this document.

## Outcome

Make `https://mcp.qyl.at/mcp` work with ChatGPT web and Codex plugins, claude.ai,
Claude Code, Codex CLI, and MCP Inspector. Each client must authenticate, list
tools, and complete a real read-tool call. Make the existing `trace.error`
Events feature configurable and verify its lifecycle in a supported ChatGPT
surface.

Repository: `/Users/alexandernachtmann/RiderProjects/qyl.mcp`
Remote: <https://github.com/ANcpLua/qyl.mcp>

## Current checkpoint and resume point — 7 October 2026

Use [MCP-CHECKPOINT.md](MCP-CHECKPOINT.md) for the current working copies,
verified progress, pending owner actions and remaining sequence. The original
eight steps below are acceptance criteria; execution no longer starts at step 1.

SDK/dependency integration, local Events coverage and the five personal client
connections are complete. Collector PR #640 and MCP PR #80 are merged, their
main CI and Railway deployments succeeded, and all eight owner-account review
rehearsals now pass. Production rechecks confirm service/severity filtering,
the ten-trace limit after viewer refresh, and direct refusal of deletion-only
requests without a qyl call. PR #81 adds the dedicated public UI origin and
versions both viewer resources; it is merged and deployed with successful main
CI. Inspector reads both new resource versions, and ChatGPT renders both
viewers at the dedicated sandbox origin. The production Events store and
matching ChatGPT delivery are now verified, including service filtering,
survival across deployment, automatic renewal and unsubscribe. The task is
paused, the Events store is empty, and a subsequent matching error produced
no notification during more than three polling intervals. Evidence PR #83 is
merged and deployed with successful main CI. A registry-artifact check found
that npm 7.1.0 still rejects 2025 clients; publish the prepared 7.1.1 correction,
then finish qyl.at PR #16 and public plugin preparation.

The public plugin remains an incomplete local draft. Free use and all eligible
countries are confirmed. Individual publisher identity is **in review** after
the owner completed the phone flow; do not restart the identity check. Verified
identity, listing/reviewer/demo evidence and the portal challenge/scan remain
open. Do not equate successful private client
connections with completed public submission.

## SDK and protocol requirements

Use the official TypeScript SDK v2 packages. SDK version and MCP protocol
revision are separate requirements: using SDK v2 permits its built-in support
for both `2026-07-28` and 2025-era clients.

- Use `createMcpHandler(factory)` with its documented stateless compatibility
  default for HTTP. Register the tools once through the shared factory. Use
  `toNodeHandler` only where a Node HTTP adapter is needed.
- Use `serveStdio(factory)` with its documented compatibility behavior for
  stdio. Remove the current blanket `legacy: "reject"` policy from serving
  entry points as part of implementation.
- Let SDK clients negotiate when connecting to general-purpose MCP servers.
  Keep explicit protocol pins in tests that need to exercise a particular era.
- Use the SDK's identity metadata, error handling, and `inputRequired` support
  where applicable. Check the v2 documentation before adding local protocol
  detection, fallback routing, identity stamping, or compatibility shims.
- Review existing era-specific assumptions in handlers and tests. Preserve the
  same authorization and tool behavior through both supported protocol paths.
- Keep package versions exact for reproducible builds. Dependency version pins
  do not imply a requirement to reject another supported wire protocol.

The earlier instruction to stop when a client requests the 2025 protocol is
replaced by these requirements. Adding the v1 `@modelcontextprotocol/sdk`
dependency is outside this objective; compatibility is supplied by SDK v2.

Sources: [v2 server API](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/)
and [protocol migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

## Events and permitted storage

Events may be enabled through `MCP_EVENTS_STORE` on an authenticated deployment
with persistent storage. Permit only the subscription data needed to operate
them: owner subject/client identifiers, event/filter identity, callback URL,
signing keys and their rotation window, expiration, and delivery/cursor state.
Keep this state isolated by authenticated owner and out of tool results/logs.
Remove expired or unsubscribed records and stop delivery when access is revoked.
OAuth access/refresh tokens and a copy of the collector's telemetry are not
part of this storage allowance.

ChatGPT Events require protocol `2026-07-28`. Verify Events on that path while
retaining ordinary tool access for 2025-era clients. Enabling event capability
does not subscribe users automatically. This replaces the blanket statement
that the server stores no user data.

Source: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events).

## Execution sequence and completion criteria

The checkout and revised requirements are established. These are the original
completion criteria. Follow the current checkpoint's resume order and use
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md) for the detailed checks.

1. **Consolidate dependencies.** Review current PRs against main, select exact
   compatible SDK v2 and workspace dependency versions, investigate failing
   checks, and regenerate lockfiles from the chosen manifests. Include the
   server package in the review; individual passing PRs do not verify the
   combined dependency set.
2. **Adopt SDK serving and negotiation.** Remove blanket protocol rejection
   from HTTP, stdio, and workbench paths. Review shared handlers, identity
   access, fixtures, and client negotiation against the documented SDK behavior.
   Keep authorization, stable tool contracts, and accurate annotations across
   both eras. Replace obsolete assertions and update protocol documentation.
3. **Make Events operational locally.** Verify configuration with Events enabled
   and disabled. Exercise owner-scoped subscription storage, callback
   verification, filtered signed delivery, refresh/key rotation, restart
   survival, expiration, revoked access, and unsubscribe. Tool access must
   remain usable for clients without Events support.
4. **Verify the combined build.** Run the repository build, test, and smoke
   commands plus the collector contract checks required by CI. Exercise both
   eras on HTTP and stdio; verify authorization failures as well as successful
   calls. Compare the tool catalog with the committed snapshot and regenerate
   deliberately for intended changes. Do not weaken valid requirements to
   make a check pass.
5. **Prepare and verify production.** Inspect current endpoint access and Auth0
   settings, resolve any actual access failure, then apply the necessary
   authorized configuration and deploy the verified build. Both resource
   metadata URLs and the challenge must identify `https://mcp.qyl.at/mcp`,
   `https://qyl-eu.eu.auth0.com/`, and `qyl:read`. Verify audience/scope with a real
   token. Complete required plugin domain verification, storage configuration,
   and tools/events scanning. Auth0 remains the issuer and OIDC discovery host;
   enable `openid`/`email` only where workspace domain claiming needs them.
6. **Verify real client connections.** Complete CIMD and DCR authorization-code
   flows with PKCE S256, issuer identification, and explicit permissions. In
   ChatGPT, claude.ai, Claude Code, Codex CLI, and MCP Inspector, log in, list
   tools, and call a read tool. Record the actual client version, negotiated
   protocol, registration path, scopes, result, and exact errors. Accept
   supported 2025-era tool connections.
7. **Verify Events in ChatGPT.** On a supported `2026-07-28` ChatGPT surface,
   subscribe to `trace.error`, produce a matching event, confirm verified signed
   delivery in the chat, and check filtering and refresh/restart behavior.
   Stop monitoring and confirm unsubscribe removes the subscription and stops
   delivery.
8. **Record completion.** Update the README, contract matrix, and checklist with
   actual results and remaining failures. Distinguish source presence, local
   tests, CI results, and production evidence. Completion requires the client
   and Events demonstrations above.

## Execution scope

The user started the active goal on 7 October with all eight steps, including
production configuration, deployment, and client/Events verification. That
instruction authorizes the necessary scoped implementation, pushes, deployment,
and Auth0 changes and supersedes the earlier preparation-only approval gate.
Track completion from evidence in the checklist.
