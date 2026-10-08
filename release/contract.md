# Cross-platform release contract: OpenAI + Anthropic, MCP 2026-07-28

> Reference document for acceptance. Work in this repository is governed by
> [goal-objective.md](../goal-objective.md) and [AGENTS.md](../AGENTS.md).
> This contract is the rubric the owner's review applies at the end; it is
> not an instruction to begin new work, and its `release/*.yaml` records are
> represented here by `goal-objective.md`, `MCP-V2-INTEROP-TODO.md` and
> `docs/evidence/`. The contract text is followed by the owner review's
> acceptance evidence and by the requirements-to-evidence map recorded with
> point 13.

Implement and release the product described in the current task and repository. Use this contract instead of earlier release checklists that accepted unspecified MCP initialization or unspecified protocol validation as proof of modern support.

Your identity as Claude, Codex, or another agent changes neither the deliverables nor the acceptance criteria. Verify both ecosystems independently. Never assume your native platform is already handled.

## 1. Load the actual v2 skill and record its identity

The required local skill directory is:
/Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2

The repository root /Users/alexandernachtmann/RiderProjects/mcp-builder-v2 is only the plugin wrapper (.claude-plugin/plugin.json, evals/, README.md). pins.json, reference/ and scripts/ live in the skill directory above.

Read, in the skill directory: SKILL.md, pins.json, reference/drift.md, reference/maintenance.md (including the Registry item in its Watch list), reference/protocol.md, reference/verify.md, and the language reference (reference/typescript.md for TypeScript, reference/python.md for Python). Read scripts/check_v2.mjs together with scripts/drift_rules.json (one checker for both languages; rules are data; `--rules`, `--self-test`, `--json`), scripts/verify_server.mjs (`[--cwd DIR] -- <stdio command>`, `--url <http://host/mcp>`, `--start`, `--skip-conformance`, `--with-caching`, `--json`; Node >= 22.19), scripts/conformance_scope.json and scripts/check_pins.mjs. Confirm filenames and command syntax against those files at run time; do not invent them.

Record in release/evidence/toolchain.json: the resolved skill path; SHA-256 of SKILL.md, pins.json, drift_rules.json, check_v2.mjs, verify_server.mjs and conformance_scope.json; version-control state (as of 2026-10-08 the directory is not a Git repository; if it is one at run time, record revision and dirty state); selected SDK packages, exact pinned ranges, installed versions and resolved import locations; lockfile hash; the pinned Inspector and conformance builds from pins.json `tools`.

Use the exact SDK and conformance pins from pins.json, including its alpha conformance build. Do not substitute an unpinned latest, a generic MCP-building skill, an older cached skill, or a remembered quickstart. Do not change the pins without explicit authorization.

Reject legacy `@modelcontextprotocol/sdk`, `@modelcontextprotocol/server-legacy` and `mcp.server.fastmcp` in production code (rules TS-SDK-V1-PACKAGE, M-PKG-SDK-V1, M-PKG-SERVER-LEGACY, PY-FASTMCP). Do not introduce unpinned third-party replacements. Inspect actual dependencies and APIs; a package or class name alone is not proof of its protocol era. Keep any legacy-only test fixture isolated from the shipped runtime.

If these inputs are inaccessible or contradictory, mark v2 implementation/verification BLOCKED and name the missing input. Continue independent release-planning work. Do not claim to have loaded the skill or fabricate its versions, rules, commands, or results.

The build skill stops at a verified server; it does not cover packaging, submission or publication. This contract separately owns those. Do not remove those obligations or rewrite the build skill merely to merge the responsibilities.

## 2. Separate protocol rules, project policy, and platform requirements

Use the fixed MCP specification revision 2026-07-28 for modern protocol semantics [P1, P10]. Use the pinned SDK implementation and its matching v2 documentation for APIs [P2, P3]. Use the local skill for project-specific implementation policy and validation. Use current OpenAI and Anthropic documentation for their client, packaging, review, and directory requirements [O1-O11, A1-A13].

A platform tutorial may illustrate an older protocol or SDK. Extract its platform requirements without copying incompatible server code. A v2 package version, Streamable HTTP, stateless mode, or a successful tool call alone does not prove modern-era support.

Keep these identities separate: MCP specification revision, SDK package/version, observed protocol era, client product/version, plugin manifest format, and distribution status.

Classify obligations as protocol requirements (MUST/SHOULD of the spec), SDK constraints, platform requirements, or project policy. Examples of project policy, not protocol law: supplying outputSchema and structuredContent on every tool; running the authorization server as an external identity provider; refusing the deprecated HTTP+SSE transport.

Record source URLs/sections, access dates, applicable revisions, and conflicts in release/requirements.yaml. Preserve exact pins rather than silently upgrading to a newer specification. Unresolved contradictions affecting correctness remain blockers, not exemptions.

## 3. Establish scope and durable release records

Read the existing product requirements and repository instructions. Record capabilities, remote/local deployment modes, UI and other components, intended client surfaces, public/private distribution routes, publisher organizations, repositories, endpoints, existing listings, and required finishing point in release/scope.yaml.

Distinguish submission-ready, submitted, approved, and published. Preserve an already requested finishing point. When none is specified, prepare everything to submission-ready and explicitly report all unperformed submission/publication actions; do not make unrequested public releases or accept legal terms on the user's behalf.

Maintain:

- release/requirements.yaml: sourced obligations, applicability, artifacts, checks, evidence, blockers.
- release/capabilities.yaml: capability-by-client support and observed protocol era.
- release/status.yaml: every distribution record and its actual external status.
- release/evidence/: redacted execution results and release identities.

Save this contract as release/contract.md. Preserve existing AGENTS.md and CLAUDE.md instructions; add concise references where appropriate rather than overwriting them. Explicitly load the contract at the beginning of subsequent work. Do not assume a reference was automatically read.

Keep shared business rules pure where practical, with external effects, protocol handling, and platform packaging separated. Do not create parallel TypeScript and Python implementations unless the product requires both.

## 4. Enumerate the distribution obligations before implementation

For one product containing workflow skills and an owned remote MCP server, verify and track these three public-directory records independently [O2, O4, A1]:

OPENAI_PLUGIN: the plugin package, including its MCP configuration and applicable skills.
ANTHROPIC_CONNECTOR: the owned remote MCP server's connector listing.
ANTHROPIC_PLUGIN: the plugin bundle containing skills and the server reference.

Portals: https://platform.openai.com/plugins for OpenAI, https://claude.ai/directory/manage for Anthropic. Both answer unauthenticated requests with HTTP 403 and need a signed-in browser session.

OpenAI: a package may declare several MCP servers, but only one MCP server can be connected per plugin, plugin-level review test cases require exactly one server, and the MCP server must be in the initial ZIP; adding a server to an existing skills-only plugin is not supported [O2, O7].

Anthropic: use the submission kind that matches each record (MCP connector, Plugin bundle). Always submit an owned remote server as a connector, even when a bundle already references it. Anthropic recommends submitting the connector first, then the bundle. Pairing of the two listings is available when both are submitted from the same organization and the bundle's MCP configuration points at the connector's URL [A1, A7].

Derive the actual inventory from the product. Account explicitly for skills-only products, MCP-only products, local servers, multiple servers or plugin folders, existing listings, and requested private distribution. Do not manufacture duplicate listings or treat a third-party server as one the publisher owns.

Distinguish MCP Registry publication and custom marketplaces from vendor directory submissions. Include them when requested or genuinely required; otherwise record their exclusion and reason. Registry publication is not evidence of either vendor's approval.

Each excluded candidate route needs an applicability reason. An absent record is unresolved, not implicitly inapplicable. Re-derive the inventory independently during the final audit.

## 5. Implement modern MCP and deliberate legacy compatibility

Use the pinned v2 implementation to serve modern traffic and the explicitly required legacy compatibility path. Legacy client support does not authorize replacing the runtime with a v1-only implementation.

Modern protocol gate [P1, P4, P5, P11]:

- Implement `server/discover` (servers MUST) and a successful modern `tools/list`.
- Also test direct modern `tools/list` without prior discover or initialize. Discovery is optional for clients; it is not a replacement mandatory handshake.
- Verify the per-request `_meta` envelope: `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (required; a request missing them gets -32602 and HTTP 400), `io.modelcontextprotocol/clientInfo` and `io.modelcontextprotocol/logLevel` (optional). Verify the required HTTP headers `MCP-Protocol-Version` (must match the `_meta` version; mismatch is HTTP 400 with -32020), `Mcp-Method` on every request and `Mcp-Name` on tools/call, resources/read and prompts/get. Verify `resultType` on every result (absent means "complete") and `io.modelcontextprotocol/serverInfo` in result `_meta`.
- Do not require initialize/initialized on the modern path. Ignore an incoming `Mcp-Session-Id`; never mint or echo one.

State and transport gate:

- Use Streamable HTTP remotely. Do not introduce the deprecated HTTP+SSE transport (project policy; the spec deprecates it, and Claude still accepts it). Do not confuse that with the per-request SSE response streams Streamable HTTP uses.
- Keep cross-call application state behind explicit, server-issued handles, not protocol sessions or sticky routing. Validate handle ownership, authorization, lifetime, and replay behavior.
- Apply this project's stateless HTTP policy to the compatibility path too. In Python, pass `stateless_http=True` to `run(...)` or `streamable_http_app(...)`, never to the `MCPServer` constructor; verify runtime behavior rather than a config string.
- Test independent requests without session continuity. Application persistence and application-level login sessions are not themselves prohibited.
- Keep process diagnostics on stderr and secrets out of logs. For stdio, reserve stdout exclusively for protocol messages [P14].

Tool contract gate [P4, P6, P7]:

- Validate inputs, declared outputSchema, and matching structuredContent for successful project tool outputs (house rule; the spec makes both optional). Test any compatibility representation required by legacy clients.
- Return `isError: true` tool results for tool execution failures, including input validation failures such as wrong format or out-of-range values. Reserve JSON-RPC errors for protocol failures: unknown tool and malformed CallToolRequest (-32602), unknown method (-32601), header mismatch (-32020), missing required client capability (-32021), unsupported protocol version (-32022).
- Never emit -32002 or -32042; both are removed in 2026-07-28 (resource not found is -32602; URL elicitation is an embedded request inside input_required). Do not allocate application codes inside -32768…-32000; -32000…-32019 is legacy and -32020…-32099 is reserved for the spec.
- Verify deterministic tool ordering (spec SHOULD) for the same authorization context and catalog state.
- Emit and test top-level `ttlMs` (integer >= 0) and `cacheScope` ("public" or "private") on every `complete` result of server/discover, tools/list, prompts/list, resources/list, resources/templates/list and resources/read. input_required results carry no caching hints. Test that private or permission-dependent data stays `private` and cannot leak through shared caches.
- Describe tools and effects accurately. Keep read and write capabilities in separate tools with explicit boolean `readOnlyHint`, `destructiveHint` and `openWorldHint`; do not hide destructive behavior in a catch-all or generic-executor tool [O3, A6].

Interaction gate [P12]:

- For modern input/confirmation flows, return `resultType: "input_required"` with `inputRequests` and/or `requestState` (only tools/call, prompts/get and resources/read may do so). Verify the client's retry with `inputResponses`, the echoed `requestState`, and a different JSON-RPC id. Do not push a server-initiated request; servers MUST NOT initiate JSON-RPC requests on the modern path.
- Test refusal, cancellation, invalid input, repeated retries, and the absence of side effects before valid authorization/confirmation.
- For stateless legacy clients that cannot complete the interaction, verify the safe isError refusal the pinned SDK returns. Never hang, silently proceed, or weaken consent.
- A safe refusal passes the safety test; it does not prove the requested feature works on that client. Record the capability limitation separately.
- Do not adopt Sampling, Roots or Logging as new product dependencies; all three are deprecated (SEP-2577). `ping`, `logging/setLevel` and `notifications/roots/list_changed` are removed; log level is per request via `io.modelcontextprotocol/logLevel` [P16]. When subscriptions are needed, use and test `subscriptions/listen` and actual client support; the server MUST NOT send notification types the client did not request [P13].
- Distinguish an embedded elicitation request inside input_required from a pushed JSON-RPC request. Do not reject valid modern behavior through a naive string search.

## 6. Verify authorization separately from protocol discovery

For protected servers, implement the resource-server responsibilities [P8]. The spec allows the authorization server to be co-hosted or separate; this project's external identity-provider architecture is project policy, and the v2 SDKs ship no authorization server. Do not recreate an embedded authorization server from legacy SDK examples.

Verify Protected Resource Metadata under RFC 9728 (MUST), authorization-server metadata and issuer consistency, audience validation of the RFC 8707 `resource` indicator both vendors send, expiration, per-user/per-tenant permissions, and `scope` in WWW-Authenticate (SHOULD) with 403 `insufficient_scope` for operation-appropriate challenges. Test wrong-audience tokens, insufficient scope, expired credentials, and cross-user handle access.

Do not pass through tokens intended for other resources, collect credentials through model-visible forms, or put secrets in packages, review recordings, transcripts, or tool results.

Client identification follows the spec's priority: pre-registered client information first, then Client ID Metadata Documents (SHOULD), then Dynamic Client Registration as a deprecated fallback (MAY) [P15]. Record which mechanism each actual client uses:

- ChatGPT prefers CIMD, still supports DCR and predefined clients, requires PKCE S256, sends `resource=` on authorization and token requests, and uses the redirect URI `https://chatgpt.com/connector_platform_oauth_redirect` (or a callback-ID-specific one when issuer identification is unmet). No client-credentials grant [O5].
- Claude uses DCR by default and selects CIMD only when the authorization-server metadata advertises `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`; pre-registered credentials require Anthropic involvement. Hosted apps use `https://claude.ai/api/mcp/auth_callback`; Claude Code uses `http://localhost/callback` and `http://127.0.0.1/callback` with the port ignored. Sign-in starts only from a 401 with `resource_metadata`; PKCE S256 on every request; no client-credentials grant [A5, A12].
  Neither pre-registration nor DCR may silently become the only supported path. Keep such compatibility work in the appropriate external identity system.

Test discovery, initial authorization, callbacks, granted scopes, refresh behavior where supported, revocation/expiry, and useful failure handling independently in each promised client. Read the current platform authentication documents rather than copying another client's callback configuration [O5, A5].

For intentionally unauthenticated public functionality, explain why protected-resource authorization checks are inapplicable. Do not expose private data or user actions to avoid implementing authentication.

## 7. Require evidence that cannot pass on legacy traffic alone

Run `node <skill>/scripts/check_v2.mjs <project>` and require zero error-severity findings. It runs every rule; findings of TS-PUSH-REQUEST or PY-PUSH-REQUEST, TS-SESSIONS, TS-STDIO-CONNECT, TS-HTTP-TRANSPORT, TS-NO-MODERN-ENTRY, PY-STATELESS and ANY-LEGACY-ERROR-CODES are release blockers. Record the full output.

Run `scripts/verify_server.mjs` with its actual arguments against the release artifact: `--cwd <project> -- <stdio command>` for stdio, and `--url http://127.0.0.1:<port>/mcp --cwd <project> --start -- <http command>` for HTTP. It must report GREEN for modern-era tools/list, legacy-era tools/list, tool-schema portability and, on HTTP, the conformance scenarios from conformance_scope.json run with the alpha build pinned in pins.json (`npx @modelcontextprotocol/conformance` at `latest` has no 2026-07-28 scenarios). Run the both-era contract tests: TypeScript with `versionNegotiation: { mode: { pin: '2026-07-28' } }` plus a default (legacy) Client; Python with `Client(server, mode="2026-07-28")` and `mode="legacy"`.

The modern test client must explicitly pin 2026-07-28 with fallback disabled. In the Inspector that is the `protocolEra: "modern"` field in the server config (values: legacy, the default; auto; modern); there is no CLI flag [P9]. Do not put Inspector-specific settings into vendor manifests. Never infer modern coverage from an Inspector default (legacy), the TypeScript SDK's default Client (legacy), the Python SDK's default `auto` mode (modern with fallback), a generic conformance run, or a successful initialize.

Record actual traffic and the observed revision: the `MCP-Protocol-Version: 2026-07-28` request header, `_meta["io.modelcontextprotocol/protocolVersion"]`, `_meta["io.modelcontextprotocol/serverInfo"]` on results, and the absence of initialize. A test configured as modern but observed using initialize is a failure, not a pass with a warning.

Add these negative controls:

- Run the same modern verifier against an isolated, known legacy-only fixture (the repository ships two under evals/review-legacy-wiring/fixture and evals/ts-migrate-v1/fixture). It must reject it; the negative-control test passes only when that rejection is observed.
- Remove required modern evidence in a temporary test copy; aggregate release validation must fail.
- Remove a required submission record in a temporary test copy; completeness validation must fail.

Keep legacy-only fixtures and dependencies isolated from the production runtime. Test names containing "v2" are not evidence.

For every result, retain the exact command, working directory, runtime/tool versions, selected and observed era, exit code, assertions executed, redacted output/transcript, timestamp, and tested artifact identity. Skipped, empty, unavailable, or stale required tests do not count as GREEN.

Do not alter pins, weaken assertions, add exclusions, or relabel requirements to force a pass. Report proposed validator fixes separately. Prefer checks executed by CI independently of the implementation agent's narrative.

## 8. Preserve each platform's package and client conventions

Build OpenAI and Anthropic artifacts separately from the shared product definition [O1, O4, A2, A3].

OpenAI baseline [O1, O2, O8]: root `plugin.json` with `$schema` `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, `name` (lowercase, digits, single hyphens, <= 64 chars) and an explicit semantic `version`; OpenAI-specific settings under `extensions.com.openai` (`interface`, `review`, `publication`, `onboardingSkill`); root `mcp.json` with its `$schema` and a transport `type` (`streamable-http`) per server; `skills/<name>/SKILL.md`; `assets/`; a complete submission ZIP. When `extensions.com.openai` is present it replaces a `.codex-plugin/plugin.json` overlay entirely; the two are never merged. The submission ZIP must not contain `apps`/`.app.json`, lifecycle hooks, or `test_credentials`/`reviewer_instructions` metadata; limits are 100 MB compressed, 512 MiB extracted, 5,000 entries. Listing fields: displayName (30), shortDescription (30), longDescription (4000), developerName (80), category; websiteURL, supportURL, privacyPolicyURL and termsOfServiceURL are required for MCP review; screenshots are no longer shown, provide example prompts.

Claude-plugin conversion for OpenAI [O4]: the portal converts `.claude-plugin/plugin.json`; commands and agents become skills; lifecycle hooks must be removed for the public directory; `.mcp.json`, `mcpServers`, `.app.json` and `marketplace.json` are not honored, so the MCP server is entered in the portal as a public Streamable HTTP endpoint; `.mcpb` is not accepted; `userConfig`, output styles, LSP servers and channels are unsupported.

Anthropic baseline [A2, A4, A7, A13]: `.claude-plugin/plugin.json` (only `name` is mandatory; the directory reads displayName, version, description, author, license, icon, documentationUrl, supportUrl, privacyPolicyUrl, termsOfServiceUrl); a README of at least 40 words outside code blocks (blocking); a `LICENSE` file or `license` field (blocking); the remote server in root `.mcp.json` or `mcpServers`; skills and required resources inside the plugin folder; a GitHub repository with the Claude GitHub App installed, which may stay private through validation and submission but must be public to go live; the portal fields Repository, Plugin path (when not at the repository root) and tracked Branch or tag (no commit pin; a tag stays on its commit until moved).

Validate current schemas, transport identifiers, referenced files, and public-submission restrictions. Translate workflow behavior rather than blindly renaming manifests. Track adaptations for commands, agents, hooks, configuration prompts, executables, UI, and persistent artifacts. Per Anthropic's matrix, Chat ignores agents, hooks and local MCP servers and runs commands as skills; Cowork loads hooks and agents; only Claude Code loads `bin/`, LSP servers, output styles and settings [A3]. No conversion may silently discard a promised capability.

For every promised ChatGPT/Codex and Claude Chat/Cowork/Claude Code surface, record the actual product/version or test date, installation path, authentication result, observed era, and capability results. Do not infer one surface's support from another.

Documented vendor client behavior as of 2026-10-08: Anthropic documents the `initialize` handshake, Streamable HTTP plus legacy HTTP+SSE, the 2025-03-26/2025-06-18/2025-11-25 authorization specifications, and no support for resource subscriptions or sampling [A10, A11]. OpenAI documents 2026-07-28 only for MCP Events and otherwise describes initialize-based connections [O9, O10]. Treat both as legacy-era until modern traffic is observed. Record legacy compatibility honestly while proving modern support with the dedicated verifier. If the product requires modern-only behavior that a client cannot perform, retain an explicit blocker or approved scope change. Do not downgrade the server to conceal it.

## 9. Complete review preparation and authorized publication

Derive current listing fields, policy checks, images, prompts, reviewer access, recordings, and test counts from the official submission sources. Resolve blockers and classify nonblocking findings accurately [O2, O3, O7, A4, A6-A9].

For OpenAI [O2, O7, O8]: individual or business identity verification; `api.apps.write` (Apps Management Write); the domain challenge token served as plain text at `https://<host>/.well-known/openai-apps-challenge`; the portal's Scan Tools step; exactly five positive and three negative test cases run with the test account; `review.demo_recording_url` (required for MCP review) and `publication.release_notes`; a test account usable without MFA, one-time codes, magic links or private networks, with credentials kept out of the ZIP; one published version and one version in review per MCP server integration; EU-data-residency projects cannot submit MCP plugins; MCP URL changes go through support and a new origin needs a new plugin. Approval and the Publish plugin action are separate; after publication OpenAI rescans tools continuously.

For Anthropic [A1, A4, A6, A7, A8, A9]: connectors are scanned automatically and listed as Community by default, with possible escalation to Verified review; plugin bundles get automated validation, a security scan and human review of new listings. Connector submission needs the listing (name <= 100, one-liner <= 200, description <= 2,000, one to five categories, documentation and privacy-policy URLs, support contact, icon, permanent slug), test credentials for a fully populated account, seven policy acknowledgements, company details and, for MCP Apps, three to five PNG screenshots at least 1000 px wide. Plugin submission needs the data-handling answers, the contact email and four acknowledgements. Statuses: plugins move Draft, Scanning, Needs changes, In review, Approved, Published (also Not live yet, Delisted, Withdrawn); connectors Draft, In review, Changes requested, Not approved, Approved, Published. Approved is not installable; Published is. Plugin Publish is by default a request that an Anthropic reviewer executes. `claude plugin validate` and the portal's Validate button are not directory approval.

Prepare secure reviewer access without committing credentials. Do not fabricate publisher facts, privacy practices, production endpoints, screenshots, or successful review results.

For each authorized external action, record the existing/new listing identity, actual portal status, submitted artifact/version, observation time, evidence, and next actor. If access or authorization is missing, leave the action visibly outstanding and complete independent work.

Do not infer submitted from uploaded, approved from validated, or published from approved. For a published goal, verify the live listing and a clean-user install/connect/authenticate/representative-task flow.

## 10. Bind evidence to releases and audit completeness

Track server deployment commit/image digest, tool-schema identity, production endpoint, auth-configuration identity without secrets, SDK lockfile, plugin versions/package hashes, and vendor listing records separately.

Re-run affected checks after changes. Determine separately whether server changes require scans or other review actions and whether plugin changes require new packages or repository versions. Previously passing evidence does not automatically apply to a changed deployment.

Independently re-read the product specification and relevant official requirements. Compare the expected capabilities, client surfaces, and submission inventory with the actual records, not only with the implementation agent's checklist.

Aggregate completion requires every applicable obligation to reach the requested finishing point with matching evidence. Missing, failed, blocked, or unverified required obligations keep completion false. Inapplicability needs a reason and supporting product fact; it cannot be used to erase a promised feature.

Do not claim that locally generated JSON proves an external portal action. Submission/publication evidence must come from the actual external record or an explicitly identified independent verification.

## 11. Return one evidence-backed handoff

Report the implementation and artifacts, actual skill/pins identity, static-check results, modern verification, legacy compatibility, negative controls, conformance coverage, capability-by-client results, all distribution statuses, and exact remaining actions with responsible parties.

Include reproducible commands and evidence paths. Separate safety passes from functionality passes. State unresolved uncertainty plainly.

The final report must answer:
Which exact skill and dependencies were used?
What proves modern behavior without legacy fallback?
What proves the checker rejects a legacy-only server?
Which clients actually work, and in which era?
Which submission/publication records exist, and what remains outstanding?

Proceed with the task. Do not replace execution with another plan or report "done" from package validity alone.

## Source map

All URLs verified reachable (HTTP 200) on 2026-10-08.

Protocol and SDK sources:
[P1] https://modelcontextprotocol.io/specification/2026-07-28
[P2] https://ts.sdk.modelcontextprotocol.io/v2/
[P3] https://py.sdk.modelcontextprotocol.io/v2/ — the v2 line; the site root mixes v1 and v2 content.
[P4] https://modelcontextprotocol.io/specification/2026-07-28/basic — `_meta` envelope, error-code ranges, resultType.
[P5] https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
[P6] https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[P7] https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
[P8] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
[P9] https://modelcontextprotocol.io/docs/draft/tools/inspector/protocol-eras — draft tooling page; the pinned published spec governs protocol semantics.
[P10] https://modelcontextprotocol.io/specification/2026-07-28/changelog
[P11] https://modelcontextprotocol.io/specification/2026-07-28/server/discover
[P12] https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
[P13] https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
[P14] https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
[P15] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
[P16] https://modelcontextprotocol.io/specification/2026-07-28/deprecated

OpenAI sources (append `.md` to any URL for a Markdown twin):
[O1] https://developers.openai.com/plugins/build/plugins
[O2] https://developers.openai.com/plugins/deploy/submission
[O3] https://developers.openai.com/plugins/plugin-guidelines
[O4] https://developers.openai.com/plugins/guides/submit-claude-plugin
[O5] https://developers.openai.com/plugins/build/auth
[O6] https://developers.openai.com/plugins/deploy/connect-chatgpt
[O7] https://developers.openai.com/plugins/deploy/app-review
[O8] https://developers.openai.com/plugins/deploy/submission-errors
[O9] https://developers.openai.com/plugins/build/mcp-server
[O10] https://developers.openai.com/plugins/build/mcp-events
[O11] https://developers.openai.com/plugins/concepts/plugins

Anthropic sources:
[A1] https://claude.com/docs/directory/publish
[A2] https://claude.com/docs/plugins/build
[A3] https://claude.com/docs/plugins/platform-support
[A4] https://claude.com/docs/plugins/pre-submission-checklist
[A5] https://claude.com/docs/connectors/building/authentication
[A6] https://claude.com/docs/connectors/building/review-criteria — titled "Connector pre-submission checklist"; holds the connector review criteria.
[A7] https://claude.com/docs/plugins/submit
[A8] https://claude.com/docs/connectors/building/submission
[A9] https://claude.com/docs/directory/submission-status
[A10] https://claude.com/docs/connectors/building/index
[A11] https://claude.com/docs/connectors/building/testing
[A12] https://claude.com/docs/connectors/building/troubleshooting
[A13] https://code.claude.com/docs/en/plugins/manifest-reference

Follow current source links to all additional requirements applicable to this product. If a source is unavailable, identify the gap and use a verified official replacement when possible; do not silently omit its obligations.

## Acceptance evidence from the owner review, 2026-10-08

Independent reproductions on `origin/main` (`9779ced` unless stated), run from
the owner's machine outside the agent working checkout. Each entry carries the
UTC time, the exact command and the actual output. Owner actions (clients,
Events lifecycle, portals) are listed in [release/README.md](README.md#owner-handoff)
and remain open; nothing below claims them.

### Contract §11 answers

1. **Skill and dependencies.** `mcp-builder-v2` at
   `/Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2`
   (not a Git repository; `pins.json` `verified_on` 2026-10-07): Inspector
   `@modelcontextprotocol/inspector@2.9.0`, conformance
   `@modelcontextprotocol/conformance@0.2.0-alpha.12`, spec `2026-07-28`.
   Repository: `@modelcontextprotocol/server` 2.3.1 exact (enforced by
   `bun run verify:sdk`), `zod` 4.6.5, contract package 11.2.0 (lockstep with
   the Collector; 11.3.0 published, bump pending), server source version 7.2.0,
   npm `qyl-mcp-server` 7.1.1.
2. **Modern behavior without legacy fallback.** Both-era black box over stdio
   ([point 4](../docs/evidence/2026-10-08-step4.md#both-era)) and over HTTP with
   the pinned conformance suite ([point 12](../docs/evidence/2026-10-08-followup-12.md)
   and the owner review's own run below), Inspector pinned to `2026-07-28`
   with no fallback. The production modern-era proof needs OAuth and remains
   an owner action.
3. **The verifier rejects a legacy-only server.** Negative control below:
   modern RED with "did not offer pinned protocol version 2026-07-28",
   legacy GREEN.
4. **Clients and eras.** No hosted client connection was observed in this
   goal; all five are owner actions with exact steps in the ledger. Documented
   vendor behavior: Claude clients negotiate the 2025 handshake; ChatGPT
   documents `2026-07-28` only for MCP Events.
5. **Records.** OPENAI_PLUGIN: local draft, ZIP reproducible
   (SHA-256 `16a6ffb523f90674572efc99dca430cf661d26aaa08f54d6680f7da0261fab5c`),
   both manifests schema-valid, owner fields open. ANTHROPIC_CONNECTOR: listing
   draft present, portal record not created. ANTHROPIC_PLUGIN: bundle files
   present and validated, portal record not created. Nothing submitted or
   published. Finishing point "submission-ready" is not reached while the owner
   fields in [submission/README.md](../submission/README.md#owner-fields-still-required)
   are open.

### HTTP both-era verification with conformance (§7)

2026-10-08T03:44:41Z, `dist/main.js` built from `cc7160f`, Bun 1.4.2
(the HTTP entry refuses Node by design):

```sh
node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/verify_server.mjs \
  --url http://127.0.0.1:3101/mcp --cwd /Users/alexandernachtmann/RiderProjects/qyl.mcp/server --start \
  -- sh -c "PORT=3101 QYL_DEMO=1 QYL_MCP_TELEMETRY=0 QYL_MCP_NATIVE_STATE_PATH=/tmp/native-http.json exec bun dist/main.js"
```

```text
GREEN  modern-era tools/list        11 tool(s): display_traces, display_mcp_dashboard, list_traces, get_trace, list_sessions, search_logs, ci_log, list_metrics, get_metric_series, query_metric, fetch_telemetry
GREEN  legacy-era tools/list        11 tool(s): display_traces, display_mcp_dashboard, list_traces, get_trace, list_sessions, search_logs, ci_log, list_metrics, get_metric_series, query_metric, fetch_telemetry
GREEN  tool-schema portability      no error-severity issues
GREEN  conformance server-stateless 24 passed; 4 n/a (need SDK fixtures); 1 SHOULD-warning(s): sep-2575-server-sends-tools-list-changed-on-subscription
GREEN  conformance tools-list       4 passed
GREEN  conformance dns-rebinding-protection 2 passed

verify_server: GREEN — the server answers in both eras.
```

### Negative control: legacy-only fixture (§7)

2026-10-08T07:15Z, unchanged copy of the skill's
`evals/review-legacy-wiring/fixture` (SDK v2 packages, legacy-era wiring):

```sh
node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/verify_server.mjs \
  --cwd <copy of the fixture> -- npx -y tsx src/index.ts
```

```text
RED    modern-era tools/list        Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)
GREEN  legacy-era tools/list        1 tool(s): notes_get
RED    tool-schema portability      skipped: the modern era did not connect (see drift.md, "the wiring")

verify_server: RED — 2 check(s) failed.
```

### npm fresh consumer, both eras (owner-action row "npm fresh consumer")

2026-10-08T06:54:14Z–06:54:23Z, empty directory, `npm 11.19.0`, `node v24.21.0`,
`npm install qyl-mcp-server@7.1.1`:

```sh
node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/verify_server.mjs \
  --cwd <fresh directory> -- sh -c 'QYL_DEMO=1 QYL_MCP_TELEMETRY=0 exec node node_modules/qyl-mcp-server/dist/main.js --stdio'
```

```text
GREEN  modern-era tools/list        11 tool(s): display_traces, display_mcp_dashboard, list_traces, get_trace, list_sessions, search_logs, ci_log, list_metrics, get_metric_series, query_metric, fetch_telemetry
GREEN  legacy-era tools/list        11 tool(s): display_traces, display_mcp_dashboard, list_traces, get_trace, list_sessions, search_logs, ci_log, list_metrics, get_metric_series, query_metric, fetch_telemetry
GREEN  tool-schema portability      no error-severity issues

verify_server: GREEN — the server answers in both eras.
```

### Done-when reproductions on `9779ced`, 2026-10-08T07:15:23Z

`check_v2.mjs <repo>/server` (unchanged external checker):

```text
check_v2: 0 error(s), 0 warning(s) in 82 file(s)
GREEN: no v1 fingerprints at error severity.
```

`python scripts/verify-completion.py` in a fresh virtual environment from
`scripts/completion-audit-requirements.txt`:

```text
PASS: 8 bundle files and 5 handoff files
PASS: plugin.json and mcp.json validate against submission/schemas (Draft 2020-12)
PASS: README 263 words outside code blocks (minimum 40)
PASS: all 11 tool descriptions state user need without model instructions
PASS: strict native record contains only reviewed metadata; no arguments/_meta
PASS: ledger has no not-recorded table rows
PASS: 238 local documentation/evidence links and heading anchors resolve
Completion audit passed; production, owner actions and prose evidence still require review.
```

Done-when 2 is read from the `verify` CI job of each merged point, not from a
local run. At that observation, Done-when 5 held through the documented
Collector-lockstep blocker. The [later Option-A continuation](../docs/evidence/2026-10-08-point-8-options.md)
supersedes that blocker with the merged Collector pin and consumer implementation.

### Production observations repeated by the owner review

2026-10-08: `POST https://mcp.qyl.at/mcp` without a token returns `401` with
`www-authenticate: Bearer scope="qyl:read", resource_metadata="https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp"`;
the resource metadata names resource `https://mcp.qyl.at/mcp`, issuer
`https://qyl-eu.eu.auth0.com/` and scope `qyl:read`;
`GET /.well-known/openai-apps-challenge` returns `404` until the owner sets
`OPENAI_APPS_CHALLENGE`. Railway deploys every `main` merge automatically;
the running build has contained PR #91 since the first observation.

Open prerequisite found 2026-10-08T06:57Z: Auth0 dynamic client registration
at `https://qyl-eu.eu.auth0.com/oidc/register` answers `403`
`too_many_entities` (tenant application limit). Clients that register
dynamically (MCP Inspector 2.9.0, possibly Codex) cannot connect until the
owner frees or raises the limit; the tenant metadata advertises
`client_id_metadata_document_supported: true`, so Claude and ChatGPT are
expected to use Client ID Metadata Documents instead.

## Requirements and evidence map (recorded with point 13)

Requirements and evidence map, 2026-10-08. The controlling requirements are
[goal-objective.md](../goal-objective.md#work-in-order), including its
[Done when](../goal-objective.md#done-when) criteria and owner boundary.
[AGENTS.md](../AGENTS.md) governs implementation and review. This map is not a
release, submission, publication or approval claim. Each observed result below
links to dated commands and actual output; pending items are requirements.
The [ledger](../MCP-V2-INTEROP-TODO.md) retains historical and superseding rows.

## Work-item mapping

| Point | Required result / observed boundary | Dated evidence or pending requirement |
| --- | --- | --- |
| 1 | Modern tool calls emit no deprecated logging; progress/cancellation retained. | [Point 1](../docs/evidence/2026-10-08-followup-01.md): server tests, frame negative control and transport output. |
| 2 | qyl's HTTP banner goes to stderr. | [Point 2](../docs/evidence/2026-10-08-followup-02.md): real Bun process; its own stdout banner is distinguished. |
| 3 | Unchanged external `check_v2` reports zero errors. | [Point 3](../docs/evidence/2026-10-08-followup-03.md): explicit Zod imports, justified JSON-Schema allowance, checker hashes. |
| 4 | HTTP mismatch/missing-capabilities codes, cache hints and stable catalog order. | [Point 4](../docs/evidence/2026-10-08-followup-04.md): three direct factory-fetch tests. |
| 5 | Wrong audience, missing scope, expiry and cross-subject isolation pass CI. | [Point 5](../docs/evidence/2026-10-08-followup-05.md): exact test names, timestamps and successful CI run, including point 4. |
| 6 | Railway trigger, active deployment ID and commit recorded; compare with PR #91. | [Point 6](../docs/evidence/2026-10-08-followup-06.md): read-only live snapshot; running commit contains #91. It is not a perpetual production-state guarantee. |
| 7 | Challenge route observed as 404; environment name documented. | [Point 7](../docs/evidence/2026-10-08-followup-07.md): production response and token-present/absent fixture; setting `OPENAI_APPS_CHALLENGE` remains an owner action. |
| 8 | Collector 11.3.0 prerequisite merged; consumer dependency and four input options implemented. | [Option-A continuation](../docs/evidence/2026-10-08-point-8-options.md) records qyl PR #642, actual `verify:pins` output, tests and manifest comparison. The consumer PR must pass its own four gates; a production handshake requires a successful Collector deploy first. |
| 9 | Separate Anthropic connector listing with acknowledgement/access owner fields. | [Point 9](../docs/evidence/2026-10-08-followup-09.md); [listing draft](../submission/anthropic-connector-listing.md). |
| 10 | Anthropic icon and rebuilt, validated OpenAI ZIP; unresolved manifest fields named. | [Point 10](../docs/evidence/2026-10-08-followup-10.md); [owner field mapping](../submission/README.md#owner-fields-still-required). |
| 11 | MCP Registry and Custom Marketplaces excluded with reason. | [Point 11](../docs/evidence/2026-10-08-followup-11.md): owner-defined distribution scope. |
| 12 | Bun HTTP both-era conformance and working legacy-only negative control. | [Point 12](../docs/evidence/2026-10-08-followup-12.md): 24 stateless checks, additional scenario results, fixture exclusions and warning, negative-control exit 1. |
| 13 | These release documents map requirements, ledger and evidence. | [Point 13](../docs/evidence/2026-10-08-followup-13.md): file/mapping/link checks. |
| 14 | Repository completion audit wired into the verify CI job. | [Point 14](../docs/evidence/2026-10-08-followup-14.md): local audit and negative controls; [script](../scripts/verify-completion.py) derives from [the original audit snippet](../docs/evidence/2026-10-08-step7.md). External `check_v2` stays outside CI. |
| 15 | Public-page sections restored from `93d8dbf`; numbers and live deployment statements are owner fields. | [Point 15](../docs/evidence/2026-10-08-followup-15.md); [restored draft](../submission/public-pages-draft.md). Publication and operational confirmation remain owner actions. |

## Done-when mapping

| Criterion | Evidence to assess on `origin/main` |
| --- | --- |
| 1 | Point 3, rerun the unchanged external checker for final source state. |
| 2 | Points 4–5, successful verify CI on the reviewed source; do not substitute a local run for CI. |
| 3 | Dated ledger rows and actual output for points 6, 7, 11 and 12. |
| 4 | Files/fields from points 9, 10, 13, 14 and 15, explicit owner gaps and rebuilt ZIP SHA-256. The [point-15 check](../docs/evidence/2026-10-08-followup-15.md) records the final draft restoration; verify the merged state and CI before declaring completion. |
| 5 | [Point 8 Option A](../docs/evidence/2026-10-08-point-8-options.md) implements the consumer options after the Collector pin merge. Assess the consumer PR's required gates separately from the recorded local checks. |
| 6 | All source, test, public-response and historical claims trace to the ledger/evidence; retain the SDK boundary, minimized records, user-need descriptions, shared skill and valid bundles. CI automation cannot establish the truth of arbitrary prose. |
| 7 | [Owner handoff](README.md#owner-handoff), [client/Events procedures](../MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending) and [submission fields](../submission/README.md#owner-fields-still-required). Owner work remains pending. |

For point 8, [qyl PR #642](https://github.com/ANcpLua/qyl/pull/642) merged
the Collector and dashboard contract pins to 11.3.0 before this consumer branch
was created. qyl.mcp now implements `errors_only`, `max_spans`,
`include_attributes` and `service_prefix` with the matching dependency.
The [dated continuation](../docs/evidence/2026-10-08-point-8-options.md) contains
the actual pin check and local test evidence. Keep production handshake proof
separate and only record it after the Collector deploy succeeds; Inspector
proof comes from the owner.
