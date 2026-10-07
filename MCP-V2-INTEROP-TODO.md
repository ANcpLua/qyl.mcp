# qyl.mcp ChatGPT and MCP v2 interoperability

Work toward one production endpoint, `https://mcp.qyl.at/mcp`, using TypeScript
SDK v2 and OAuth 2.1. Use the SDK's documented support for both `2026-07-28` and
2025-era tool clients. Events are configurable and may persist the subscription
state they need. The current requirements are in
[goal-objective.md](goal-objective.md), updated on 7 October 2026.

## Current checkpoint

[MCP-CHECKPOINT.md](MCP-CHECKPOINT.md) is the current resume summary. SDK and
dependency integration, local Events tests and all five real client logins/read
calls are complete. Collector/MCP corrections are deployed and all eight
owner-account review cases pass. The dedicated public UI-origin deployment is
also verified. Production Events delivery, service filtering and restart
survival now pass. The remaining order is: verify automatic renewal and
unsubscribe; finish public plugin preparation and portal verification.

Collector PR #640 (`d07c45ad`) and MCP PR #80 (`a82e1786`) passed main CI and
Railway deployment. ChatGPT rechecks verify the service/ERROR filter, ten-trace
viewer refresh and deletion-only routing. PR #81 (`3ae30b52`) is merged and
deployed with green main CI; both viewers render at the dedicated origin.
Individual publisher identity now
shows **Identity in review** after the owner's phone flow; do not restart it.
These results do not replace the remaining Events and public-review evidence.

## Established starting point

- [x] Restore a local checkout of current GitHub `main` at
  `/Users/alexandernachtmann/RiderProjects/qyl.mcp`.
- [x] Replace the modern-only protocol requirement with SDK v2 compatibility
  and permit necessary Events subscription storage in the working objective.

PR #75 merged the SDK serving defaults and ongoing Events authorization into
`main`. Production runs that implementation with the collector credential
configured. ChatGPT web, claude.ai, Claude Code, Codex CLI and Inspector have
completed personal OAuth and a read-tool call. ChatGPT Events delivery and
public plugin verification remain open; verified results are recorded below.

## Execution sequence

### 1. Consolidate dependencies

- [x] Recheck current PRs and failing checks against main. Integrate applicable
  SDK v2 updates across server, client, core, and adapters as one tested set.
- [x] Align dashboard/workbench with the current qyl-mcp-server workspace
  package; use exact dependency versions and regenerate the affected lockfiles.
- [x] Resolve the combined test/OTLP checks and lockfile conflicts. Current
  local and CI verification passes; superseded dependency PRs are closed.

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

- [x] Verify `MCP_EVENTS_STORE` configuration, persistent storage, and Events
  discovery when enabled; ordinary tools must also work when Events is off.
- [x] Verify ownership, filter isolation, callback verification, signed
  delivery, refresh, key rotation, restart survival, expiration, revoked
  access, and unsubscribe. Persist only the permitted subscription state.
- [x] Exercise Events on the modern protocol path and verify ordinary tool
  compatibility with clients that do not support Events.

### 4. Verify the combined build

- [x] Run the repository's build/test/smoke commands and collector contract
  checks required by CI, including cross-repository version agreement.
- [x] Verify successful and invalid tool calls through both protocol eras over
  HTTP and stdio. Check authenticated HTTP access and authorization failures.
- [x] Compare the runtime tool catalog to its snapshot; regenerate only for
  deliberate changes. Resolve failures without weakening valid requirements.
- [x] Correct the Collector filter defect found in the later natural ChatGPT
  review; [PR #640](https://github.com/ANcpLua/qyl/pull/640) passed PR CI and merged.
- [x] Verify the Collector deployment and repeat the filtered production
  request. The earlier broad smoke only checked
  an unfiltered `search_logs` call and did not detect this defect. The expanded
  MCP-to-Collector filter regression now passes locally against the correction.
- [x] Deploy and recheck the Trace Explorer refresh correction in ChatGPT.
  Local browser checks confirm that the original limit, trace ID and session
  ID survive refresh; the new `mcp-app-v2.html` resource and snapshot are built.
- [x] Complete MCP PR #80's remaining merge/review and deployment gates, then
  refresh ChatGPT's connection and repeat the deletion-only routing check.
  Its lint/verify/security checks passed at `acb0872`; the CodeRabbit success
  status reported a rate limit and is not evidence of a completed review.
- [x] Verify PR #81's production deployment and both viewers after refreshing
  ChatGPT metadata. Hosted resources use the validated public origin and new
  `mcp-app-v3.html` / `mcp-dashboard-v2.html` URIs. Local build, four focused
  tests, lint and the full server smoke pass; PR CI passed before merge.

### 5. Prepare and verify production

The active goal authorizes the required production work. Inspect current
settings and apply only the changes needed for this objective.

- [x] Recheck public endpoint reachability and diagnose any actual Cloudflare
  block. Inspect current deployment and Auth0 settings before applying changes.
- [x] Apply the necessary authorized settings and deploy the verified build.
  Check both resource metadata URLs, challenge, canonical audience, and scope.
- [x] Verify the persistent volume and `MCP_EVENTS_STORE`; discover the deployed
  tools and Events through an authenticated SDK client.
- [ ] Complete required plugin domain verification and the client/portal scan.

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

- [x] Complete actual CIMD and DCR logins and verify token audience/scope.
- [x] In ChatGPT web, claude.ai, Claude Code, Codex CLI, and MCP Inspector,
  authenticate, list tools, and complete one read-tool call.
- [x] Record client version, negotiated protocol, registration path, scopes,
  result, and exact errors. Accept supported 2025-era connections through v2.

### 7. Verify Events in ChatGPT

- [x] On a supported modern-protocol ChatGPT surface, subscribe to `trace.error`
  for one service and verify the callback and saved subscription.
- [x] Produce a matching error trace and confirm its signed delivery reaches
  the chat. Verify filtering and survival across deployment/restart.
- [ ] Verify renewal of the existing subscription and its new expiration.
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
- `bun run build`, `bun run lint`, `bun run test`: passed, 317 tests in the
  combined run; the subsequent legacy HTTP test and two CIMD authorization
  regressions bring the verified local total to 320.
- `bun run smoke`: passed, including real modern and 2025-era stdio clients
  and the built workbench/dashboard. Hosted HTTP tests cover both eras,
  authenticated tool calls, invalid calls and 401/403 failures.
- `bun run verify:pins`: both repositories use API contract 11.2.0.
- Collector Release build: zero warnings/errors. Source-control metadata
  queries were disabled to honor the user's prohibition on Git-history access.
- `bun run smoke:otlp`: passed against the real local collector, including
  protobuf ingestion, storage, redaction, metrics and trace/log correlation.
- 29 focused Events/authorization tests pass. Added ongoing Auth0 access checks,
  cancellation during unsubscribe, retry-time expiry/key refresh, removal of
  stale keys/expired records on restart and late error-span detection.

Initial test attempts found two local test-setup issues: sandboxed test ports
were denied (`EPERM`), and the dashboard had not yet been built for its smoke
test. Both passed with allowed loopback ports and the complete build. The new
legacy metric assertion was corrected to the published `items` result field.

## Production progress on 7 October 2026

- [PR #75](https://github.com/ANcpLua/qyl.mcp/pull/75) was created as a regular
  PR and merged as `b47221547acf851ad55104139e474eb3619dafe3`. Its final lint,
  verify, Railway plan and preflight checks passed; main lint/verify passed too.
  The initial Railway plan failure came from its action running npm, which
  rejects `workspace:7.1.0`. Both consumers now use exact `7.1.0`; Bun resolves
  them to the local server workspace.
- Renovate closed #62/#71/#72/#73 after integration. Closed obsolete #74 after
  comparing its current patch: the merged locks already contain tsx 4.23.15,
  proxy-addr 2.0.8, rolldown 1.2.12 and @oxc-project/types 0.152.0, meeting or
  exceeding all of its updates. No older lockfile was applied.
- The user renewed Auth0 and Cloudflare logins and explicitly approved removal
  of two unused `qyl-auth0-probe` applications. Both were deleted to free the
  tenant capacity required for the dedicated Events checker.
- Applied and verified Auth0 RBAC, required first-party consent, the existing
  intended user's `qyl:read` permission, an explicit grant for the already
  consented client, and an empty third-party default grant. RFC 9068, resource
  compatibility, CIMD, and issuer identification remain configured.
- Requested strict DCR through the documented tenant setting. Auth0 omits this
  setting from its GET response. Codex CLI's fresh DCR application reports
  strict mode and completed authorization after its explicit `qyl:read` grant
  was provisioned; automatic third-party permissions remain empty.
- Created the dedicated Events Management API application and stored its
  credentials in Railway without printing them. It has `read:users`,
  `read:clients`, `read:client_grants`, and `read:grants`. The live checker
  permits the existing authorized profile and rejects missing users/clients.
  CIMD identity resolution has regression coverage. ChatGPT completed a real
  CIMD login and created the native `trace.error` monitoring task below.
- Railway's `/data` volume and `MCP_EVENTS_STORE=/data/mcp-events.json` are
  present. Deployment `2327f29e-590a-4821-aac7-00af5f17e767` successfully deployed
  the merged runtime. The first authenticated read probe then found a real
  upstream failure: `collector request failed (401 Unauthorized)` because
  `QYL_API_KEY` was absent from the MCP service. Configured the existing key
  for the collector's sole `default` project through Railway stdin, without
  printing it or changing collector permissions. The resulting deployment
  `7eddf1c3-5601-4b60-800c-5efbf6b15777` succeeded with the same source commit.
  The subsequent main deployment `c4cd34d4-ba86-4277-b6b4-f9f0364fa299`, source
  `50b1e7de5314319a7a1f953af73cf409a0a5fd2f`, also succeeded and includes the
  separate Hono 4.13.12 update.
- A production SDK probe authenticated with the existing Auth0 machine test
  application and verified audience `https://mcp.qyl.at/mcp`. Its existing
  machine grant returns `qyl:read qyl:control`; only read tools were called.
  Both `2026-07-28` and `2025-11-25` listed 11 tools and successfully called
  `list_metrics` and `list_traces`. Modern `events/list` returned `trace.error`.
  Requests used the default user agent. This verifies production transport,
  token validation and collector access, not personal OAuth or Event delivery.
- Registered ChatGPT's published CIMD with its stable callback and
  `private_key_jwt`; assigned only `qyl:read`. The user completed login and
  consent. ChatGPT displayed live traces and successfully called `list_metrics`.
- The user approved a Cloudflare configuration rule limited to
  `http.host eq "mcp.qyl.at"` that disables Browser Integrity Check. The rule
  is active; OAuth, WAF, and DDoS configuration are unchanged. Fresh public
  checks now return 200 for health and both protected-resource metadata paths,
  and 401 with the expected `qyl:read` challenge for unauthenticated `/mcp`.
  Removed the obsolete curl user-agent override from the hosted evaluator.

### Real clients and remaining interactive checks

| Client | Registration and authorization | Observed result |
| --- | --- | --- |
| ChatGPT web | Published CIMD, stable redirect, `private_key_jwt`, `qyl:read` | Connected; live trace viewer; `list_metrics({})` succeeded with 0 metrics. Native Events monitoring is active. Its Events path requires `2026-07-28`; the web client does not display a build version. |
| claude.ai | Published web CIMD, public client, `qyl:read` and `offline_access` | Connected; 11 tools shown (2 interactive, 8 read-only, 1 app-only). A real `list_metrics({})` call returned `items: []`, `has_more: false`. Web build and negotiated revision are not exposed by this UI. |
| Codex CLI 0.158.0-alpha.2.1 | Fresh strict DCR, PKCE S256, canonical resource, `qyl:read` | Modern feature enabled; 10 model-visible tools; `list_metrics({})` returned `items: []`, `has_more: false` with modern server identity metadata (`qyl.mcp`, 7.1.0). |
| Claude Code 2.1.292 | Published Claude Code CIMD; qyl OAuth completed | After the user renewed the Claude login in their own terminal, the client connected with 10 model-visible tools. Exactly one `list_metrics({})` call succeeded at `2026-10-07T00:28:41Z`, returning `items: []`, `has_more: false` and modern server identity metadata (`qyl.mcp`, 7.1.0). The run exited successfully with no permission denials or other tool calls. |
| MCP Inspector 2.8.0 | Existing authorized hosted-eval DCR client; PKCE S256, canonical resource, `qyl:read offline_access` | OAuth completed after user consent. UI confirms MCP `2026-07-28`, lists all 11 tools and returns “No metrics recorded (live mode).” for `list_metrics({})`. Added the actual `http://127.0.0.1:6274/oauth/callback` alongside the existing evaluator callback. |

- With explicit user approval, deleted three additional obsolete hosted-eval
  duplicate applications ending in `5ryBna`, `iY9cDn` and `zmQxHq`. Retained the
  functional `qyl:read` evaluation client. The freed slots were used for the
  two Claude CIMD clients and Codex's DCR registration.
- Codex's automatic add/login initially requested unwanted OIDC scopes. The
  working configuration specifies `scopes = ["qyl:read"]`. Removed the explicit
  `oauth_resource` override because this CLI also adds the discovered resource;
  the successful authorization URL contains one canonical `resource` value.
- ChatGPT's task `qyl-Testfehler melden` is native Events monitoring for
  `trace.error`, filtered by `service_name = qyl-mcp-interop-oct7`. Its UI shows
  an active event trigger. The existing authenticated Railway browser console
  allowed a redacted store inspection without creating an SSH key. The store
  has one subscription with this filter, owner/client binding and a configured
  signing key. Its `updatedAt` is `2026-10-07T01:15:12.041Z`, with expiration
  `2026-10-07T02:15:12.041Z`.
- The stored subscription survived deployment
  `de261a52-aba4-4899-8e0a-94044e088d1e` (created at `01:41:15.189Z`) and
  subsequently delivered the matching error. At `01:51:33.649Z`, the configured
  internal Collector accepted nonmatching-service trace
  `0299b2592ecb7a6122e7da3adee62083`. At `01:52:32.694Z`, it accepted matching
  trace `e70ecd31c3bbf6ac02a07919e3c4d558`, named
  `qyl-matching-error-20261007`, for `qyl-mcp-interop-oct7`.
  Both OTLP requests returned 200; the same `fetchTraces(100)` path used by
  the Events poller returned both with `has_error: true`.
- [The subscribed ChatGPT chat](https://chatgpt.com/c/6ac5880a-bea8-8333-9632-7cdff64601e4)
  reported the exact matching trace ID, service, error text, timestamp and
  one-millisecond duration. It did not report the nonmatching-service error.
  This is observed production delivery through the signed webhook path;
  the callback response status itself was not separately logged. Renewal and
  final unsubscribe verification are still in progress.
- The first attempt to ingest the marked test trace at `api.qyl.at/v1/traces`
  received Cloudflare 403 / error 1010. No test trace was stored by that attempt.
  The approved Browser Integrity Check exception covers only `mcp.qyl.at`.
  Automatic approval rejected registration of a temporary Railway SSH key,
  and the CLI volume reader also required a key. The already-authenticated
  browser console resolved access without registering one. No edge-security
  setting was changed: injection used the service's configured internal
  Collector URL and existing credential.
- OpenAI portal authentication is complete. The Plugins pages in both
  `ancplua` and Personal organizations have no public package/draft, so no
  domain-verification token is available. No
  `OPENAI_APPS_CHALLENGE` is configured. The private ChatGPT connection works;
  public submission verification is not claimed.
- [The public package draft](submission/README.md) now contains portable
  manifests, listing copy, release notes and five positive/three negative
  review cases. The owner confirmed all eligible countries, free use and no
  purchases or planned buy-ins. The verified publisher identity is still
  unconfirmed; after the owner's phone flow, the `ancplua` portal shows
  **Identity in review** for Individual. Do not start the flow again while
  review is pending. The draft manifests pass schema/field checks and contain a verified
  square PNG for the logo and composer. Listing policy/support pages, a
  recorded demo and dedicated reviewer access/case execution remain open before a
  complete package can enter the portal verification flow.
- The user-linked Railway job `112557449308` is attempt 2 of run `37544569134`
  at the old `50ea32b` source containing `workspace:7.1.0`. Rerunning that job
  still uses that source. The corrected PR's lint, verify and Railway apply
  checks succeeded; this old rerun is not a failure of the deployed manifest.

### Natural-language review follow-up

- In the existing owner's ChatGPT connection, the revised text-only trace
  prompt listed ten traces and inspected the newest returned ID, with recorded
  service, duration and error status. This is an owner-account rehearsal; the
  dedicated reviewer/sample-data run remains open.
- The filtered error-log case exposed a real defect: a service/ERROR query
  returned unrelated INFO records from `qyl.at`. ChatGPT flagged the mismatch;
  its later empty literal search does not prove that the requested filter is
  correct. The Collector read camelCase parameters while contract 11.2 and MCP
  use snake_case.
- The correction is present in `/private/tmp/qyl-filter-contract`, branch
  `codex/collector-query-filters`, pushed as
  `889244faf211b6bf7b2ebbcb96476bbb11df51c0`. Twenty-one targeted parser and real
  HTTP tests passed in the implementation run. Existing analyzer warnings and
  a RouteHandlerAnalyzer AD0001 warning were emitted; the run was not warning
  free. Regular [PR #640](https://github.com/ANcpLua/qyl/pull/640) passed PR CI
  and merged as `d07c45ad` at 01:04 UTC. Main CI `37555254964` and deployment
  `8f3afed5-52c2-415e-92d4-0fc1262cb63b` succeeded. A real ChatGPT request for
  service `qyl-mcp-interop-oct7`, minimum ERROR and limit 20 returned 0 matching
  records, with no unrelated INFO logs. Direct authenticated service/limit
  probes returned the requested service and count; the controlled matching
  production ERROR fixture remains part of the pending Events demonstration.
- The expanded `smoke:otlp` passes against the corrected real Collector. It
  persists five log fixtures differing by service, severity, trace or body;
  the actual MCP tool must return exactly the matching record, an empty result
  for an absent service and the requested maximum count. The initial fixture
  wait timed out; isolating its marker from earlier smoke telemetry resolved
  that test setup issue.
- Natural metric and session prompts were rehearsed in ChatGPT: metric
  discovery returned zero instruments and no more pages; session discovery
  listed five actual sessions and their recorded status. Raw tool argument
  JSON is not exposed in the inspected UI, so the UI summary is the evidence.
- The Trace Explorer initially rendered ten live traces. Clicking its own
  Refresh button broadened the result to twenty. Its source used a hard-coded
  refresh query. The correction keeps the last successful display query and
  reuses `display_traces` through the app bridge; cancelled inputs do not
  replace it. Local browser checks with the built app and real MCP demo server
  preserve limit 10, one exact trace ID and a session filter with limit 2.
  The UI resource is versioned to `ui://qyl-explorer/mcp-app-v2.html`; deliberate
  snapshot regeneration changes only that URI/name. Build, lint and all 14
  affected schema/resource/catalog tests pass. PR #80 merged as `a82e1786`;
  main CI `37556048053` and deployment
  `726f1c53-4612-4616-b711-f612599e623f` succeeded. After refreshing qyl metadata,
  a fresh ChatGPT chat opened ten live traces, and its viewer's own Refresh
  completed with ten traces again.
- The deletion-only negative case was not a pass: ChatGPT correctly reported
  that deletion is unavailable, but queried traces/sessions and opened a viewer
  first. Shared server instructions now explicitly scope qyl to telemetry
  investigation and direct unsupported action-only requests to a concise
  limitation response without qyl calls. After PR #80 deployed, the fresh-chat
  retest passed: direct refusal with no visible qyl activity or viewer. This
  guidance is not authorization.
  Both `2026-07-28` and `2025-11-25` local SDK clients received the full
  368-character instruction text; build and lint pass.
- The rollback-only and public-price-search negative rehearsals passed in the
  owner's ChatGPT connection: the visible responses explain the missing
  capability without a qyl invocation or fabricated result. The public-search
  response was confirmed complete during the 01:09 UTC checkpoint. These UI
  observations do not replace the dedicated reviewer/sample-data run.
- All eight owner-account rehearsals now pass. The three formerly failing
  cases were rechecked against deployed corrections; this does not establish
  public-review readiness or the Events delivery lifecycle.
- [PR #81](https://github.com/ANcpLua/qyl.mcp/pull/81) sets `_meta.ui.domain`
  from the validated `MCP_PUBLIC_URL` origin for both hosted resources. Local
  and stdio resources omit it; their empty self-contained CSP is preserved.
  Resource URIs are versioned to `mcp-app-v3.html` and
  `mcp-dashboard-v2.html`. Build, lint, four resource/annotation/manifest tests
  and the full server smoke passed. PR lint, verify and security checks passed
  before merging as `3ae30b52`. Main CI `37557011340` and deployment
  `cf19d6da-2feb-491a-95d3-9809ad461575` succeeded. A reconnected Inspector
  lists and reads both new resource versions. After refreshing qyl metadata,
  ChatGPT renders both viewers at `mcp-qyl-at.web-sandbox.oaiusercontent.com`.
  Trace Refresh again retains ten results; the dashboard shows the valid
  empty state for its 24-hour window. The exact resource payload metadata
  was verified locally; production origin behavior is observed in the browser.

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
