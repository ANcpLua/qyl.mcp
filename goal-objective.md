# qyl.mcp objective

This file is the objective for the qyl MCP server and its public plugin
submissions. Later owner instructions take precedence over it. Working
agreements are in [AGENTS.md](AGENTS.md), evidence in
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md), state in
[MCP-CHECKPOINT.md](MCP-CHECKPOINT.md).

Repository: `/Users/alexandernachtmann/RiderProjects/qyl.mcp`
Remote: <https://github.com/ANcpLua/qyl.mcp>
Production endpoint: `https://mcp.qyl.at/mcp`

## Outcome

qyl becomes the Swiss army knife of connectors for AI agents: one MCP server
that lets a model measure, correlate and diagnose a running system, published
as an Anthropic connector plus plugin bundle and as an OpenAI plugin. The
listing story is "qyl measures and correlates; the agent reasons and acts."
qyl's tools stay inside qyl's own service. Actions in third-party systems
such as GitHub, Railway or cloud providers happen through the agent's own
connectors, never through qyl tools.

## What is true today

Checked in the repository on 8 October 2026.

- `main` uses the split TypeScript SDK v2 packages; `bun run verify:sdk` in
  CI rejects SDK v1 packages. `server/tool-manifest.snapshot.json` lists 11
  tools, all `readOnlyHint: true`. `fetch_telemetry` is app-only through
  `_meta.ui.visibility: ["app"]`. A `trace.error` Events implementation exists
  in `server/src/events.ts`; account and project scoping in
  `server/src/collector-access.ts`. Native tool-call records in
  `server/src/native-execution.ts` keep tool name, timing, status and error
  type only.
- `submission/qyl/` holds the OpenAI plugin draft (`plugin.json`,
  `mcp.json`, icon), the Anthropic bundle files (`.claude-plugin/plugin.json`,
  `.mcp.json`, `README.md`, `LICENSE`) and the shared agent skill
  `skills/qyl-investigate/SKILL.md`. Nothing in it is uploaded or submitted.
  `submission/public-pages-draft.md` holds draft text for the owner's public
  support, privacy and terms pages.
- Earlier preparation steps merged as PRs #93–#98; the dated `gh` output
  in [step-7 evidence](docs/evidence/2026-10-08-step7.md#merged-steps) records
  #93–#97, and [PR #98](https://github.com/ANcpLua/qyl.mcp/pull/98) holds
  the final document reconciliation. This is historical, not an open-PR count.

## What is not established

Earlier documents claimed the following as verified: five real client
connections (ChatGPT, claude.ai, Claude Code, Codex CLI, MCP Inspector); the
production ChatGPT Events lifecycle; eight review rehearsals; npm
`qyl-mcp-server@7.1.1` published and consumer-checked; qyl.at PR #16 and a
live protocol guide; an approved Individual publisher identity; Collector
PR #640; production rechecks of filters and viewer refresh.

The owner does not accept these claims. Treat each one as not done until it is
re-established with fresh, reproducible evidence: the command or client, the
date, and the actual output. Do not copy any of these claims into README,
checkpoint, matrix, listing or review text. A successful private connection is
not a completed public submission.

## Owner decisions

- Read-only is not a requirement. Neither the Anthropic connector checklist,
  the Software Directory Policy nor the OpenAI plugin guidelines demand it.
  They demand separate read and write tools, accurate `title`,
  `readOnlyHint` and `destructiveHint` on every tool, and descriptions that
  match behavior. Write tools are welcome under those conditions.
- First-party boundary. Every tool calls qyl's own APIs or APIs qyl
  legitimately proxies (Anthropic "API ownership"; OpenAI rejects unofficial
  third-party connectors). Directory-safe write tools are, for example:
  annotate a trace or session, mark an incident, saved queries or dashboards,
  alert rules in the Collector project, Event subscriptions, deleting own
  telemetry as a separate delete tool with `destructiveHint: true`. Not qyl
  tools: opening PRs, triggering deploys or rollbacks.
- Rules for reviewing and contributing are collaborative, not a list of
  prohibitions. Concrete regressions with trigger, path and consequence.
  No invented extra requirements. Codex review plus required CI is enough;
  CodeRabbit is optional. Version bumps and deliberate requirement changes
  are normal work.
- Tool descriptions state what the tool does and when to use it, phrased as
  the user's need. They never address the model and never restrict other
  tools. App-only tools are hidden through `_meta.ui.visibility`.
- qyl's own telemetry about incoming tool calls records only tool name,
  timing, status and error type. It must not persist argument values,
  `_meta` or conversation text.
- qyl is free to use, with no purchases.

### Listing story

> "Once an AI can measure a system, it can reason about it. So we gave it the
> instrumentation to measure everything."
>
> qyl is an observability platform built for AI agents. Agents fail quietly:
> deep call stacks, bloated contexts, slow tools. qyl gives frontier models a
> Model Context Protocol server (TypeScript SDK v2) that acts as a semantic
> gateway to your telemetry: traces, logs, metrics and MCP runtime sessions
> from your own collector.
>
> Instead of reading raw log dumps, the model asks compact, intent-driven
> questions: which sessions are failing, what happened inside this trace,
> which logs belong to it, how did this metric move. qyl returns the
> collector's real answers, including empty results and upstream errors, and
> renders them in an interactive Trace Explorer and MCP Dashboard. In clients
> that support MCP Events, qyl notifies the model about new trace errors.
>
> qyl measures and correlates; the agent reasons and acts. Every telemetry
> tool is read-only, so the model can investigate without side effects and
> hand the fix to the agent that owns the code.

Do not promise remediation, fixing or continuous monitoring until a tool
actually does it.

## Work, in order

Revised owner instructions, 2026-10-08. These are requirements, not completion
claims. The earlier seven preparation steps and their results remain in the
[dated ledger](MCP-V2-INTEROP-TODO.md). This new sequence starts at point 1.
Each point is one branch from the owning repository's `origin/main` and one
PR to `main`. Start the next point only after the preceding PR is merged.
Merge requires a clean own review and green `lint`, `verify`,
`owner-review/content`, and `owner-review/evidence` on the reviewed head.
Never set the owner checks or bypass them; read owner comments and fix them.

### A. Code before submission

1. Remove `ctx.mcpReq.log(...)` from `server/src/request-scope.ts` or restrict
   it to the legacy path. Remove the modern deprecated logging path.
2. Send the HTTP-start banner in `server/src/main.ts` to stderr.
3. Resolve the `events.ts` JSON-Schema and Zod-root findings with justified
   `mcp-v2-allow` markers or `zod/v4` imports. `check_v2.mjs` must report zero
   errors without changing the checker.
4. Add contract tests through `createMcpHandler().fetch`: a protocol-version
   mismatch returns HTTP 400 with `-32020`; missing
   `io.modelcontextprotocol/clientCapabilities` returns HTTP 400 with `-32602`.
   `tools/list` carries `ttlMs` and `cacheScope` and has stable order across two calls.
5. Record dated ledger rows with exact test names for wrong audience, missing
   scope, expired token and cross-subject project access. Add missing tests;
   they must run and pass in CI.

### B. Production before reviewer access

6. Inspect whether Railway automatically deploys `main`, including
   `railway-config.yml`. Record deployment ID and source commit with dated
   output. If the deployed build predates PR #91, record the argument-storage
   risk and ask the owner to deploy; deployment is an owner action.
7. Observe the production OpenAI challenge route's 404 until the portal token
   is set. Document its environment-variable name in README. Setting it is an
   owner action.

### C. Contract repository

8. In a separate PR in `ANcpLua/qyl-api-schema`, extend
   `Mcp.Tools.GetTraceInput` with `errors_only`, `max_spans`,
   `include_attributes`, and `Mcp.Tools.CiLogInput` with `service_prefix`.
   After its release, bump the dependency here and implement the options in
   `tools.ts` and `ci.ts`. Do not publish a release in this goal. If a required
   release or other prerequisite is unavailable, document the precise blocker
   instead of claiming the bump or runtime implementation is complete.

### D. Submission files

9. Add `submission/anthropic-connector-listing.md`: name ≤100 characters,
   one-liner ≤200, description ≤2000, one to five categories, documentation
   URL, privacy URL, support contact, icon and slug. Seven acknowledgements
   and test credentials remain owner fields.
10. Add the icon to `.claude-plugin/plugin.json`. After owner publication of
    the pages, set `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` and
    matching OpenAI interface URLs; `developerName` and `countries` also need
    owner values. Unavailable values remain explicit owner fields. Rebuild
    the ZIP and record its SHA-256 in the ledger.
11. Record why MCP Registry and Custom Marketplaces are excluded.
12. Record fresh HTTP both-era verification with conformance using
    `verify_server.mjs --url … --start -- … bun dist/main.js`: 24 checks pass,
    HTTP entry runs under Bun. Record a negative control proving the verifier
    rejects a legacy-only fixture.
13. Add `release/contract.md` and `release/README.md` mapping requirements to
    `goal-objective.md`, `MCP-V2-INTEROP-TODO.md` and `docs/evidence/`.
14. Turn the audit snippet in `docs/evidence/2026-10-08-step7.md` into a CI
    script in the `verify` job. Check required `submission/qyl` files, both
    root manifests against `submission/schemas`, README word count, all eleven
    descriptions (user need, no model instruction), native record schema without
    `arguments`/`_meta`, ledger without "not recorded" rows, and local links.
    `server/docs/completion.md` is not the source. Keep `check_v2` outside CI
    because its skill is external to this repository.

15. Rebuild `submission/public-pages-draft.md` from its version at commit
    `93d8dbf`, restoring the sections "Data processed and purposes",
    "Destinations", "Notifications" and "Retention and controls". Mark every
    number and deployment statement as an owner-supplied field, not an
    established fact.

### E. Owner actions, not agent actions

List exact pending actions for publisher identity, public qyl.at pages from
`submission/public-pages-draft.md`, a reviewer account with an isolated
project, demo recording, five client connections including the Inspector
2.9.0 modern proof and request header, the Events lifecycle, challenge-token
configuration, attestations, submission and publication. Do not perform them.

## Done when

Verify each item on the owning repository's `origin/main`, with dated commands
and actual output. Owner actions are listed, not executed.

1. `check_v2.mjs` reports zero errors without checker changes.
2. The protocol/catalog tests from point 4 and authorization/isolation tests
   from point 5 pass in CI.
3. Points 6, 7, 11 and 12 have dated ledger rows with the required actual
   observations, including HTTP conformance and the legacy-only negative control.
4. Files and fields from points 9, 10, 13, 14 and 15 exist, with unresolved owner
   values explicitly listed; the rebuilt ZIP has a recorded SHA-256.
5. Point 8 is a merged schema PR plus the dependency bump and implementation
   here, or a documented blocker with its concrete reason.
6. No documentation claim lacks evidence. Preserve the original SDK boundary,
   minimized records, user-need descriptions, shared skill and valid bundles.
7. All owner-only work is listed with exact next actions and was not executed.

## Standing constraints

Continuation authorized by the owner on 2026-10-08: complete point 8 via
Option A. First branch `ANcpLua/qyl` from `origin/main`, move its Collector
contract pin to 11.3.0, merge the PR after green CI and update the local
`../qyl` checkout to merged `main`. Then bump qyl.mcp's schema dependency,
implement the four input options, record the actual `verify:pins` output in
the dated ledger, and pass the owner-review gate. Record a production
handshake only after the Collector has deployed on Railway. The owner supplies
the Inspector evidence.

The next point in this continuation, point 9, addresses the owner's Inspector
2.9.0 schema-portability report. After point 8 merges, normalize only the JSON
Schema emitted by `compactOutputSchema`: empty `additionalProperties: {}`
becomes `true`, and type arrays become `anyOf` with one `type` per branch.
Keep validation and the published contract unchanged. Regenerate the manifest,
test both cases, record dated ledger evidence, and pass the owner-review gate
in a separate PR. This follows point 8 without renumbering the earlier listing
work recorded above.

- Official split SDK v2 packages only. SDK version and wire revision are
  independent; v2's built-in 2025-era support is required compatibility.
  HTTP serves through `createMcpHandler(factory)` and stdio through
  `serveStdio(factory)` with their documented defaults. Protocol pins and era
  rejection belong in focused tests and fixtures, not in production entry
  points. Clients negotiate; the workbench keeps
  `versionNegotiation: { mode: "auto" }`.
- Every hosted operation authorizes from validated credentials. Canonical
  resource `https://mcp.qyl.at/mcp`, issuer `https://qyl-eu.eu.auth0.com/`,
  scope `qyl:read`, consistent with discovery and challenges. Tool arguments,
  UI inputs and request metadata never select credentials or another project.
- Events may run through `MCP_EVENTS_STORE` on an authenticated deployment
  with persistent storage. Store only owner subject and client identifiers,
  event and filter identity, callback URL, signing keys with rotation window,
  expiration, and delivery or cursor state, isolated by owner and kept out of
  tool results and logs. Remove expired or unsubscribed records; stop delivery
  on revocation. OAuth tokens and copied telemetry are never stored. Enabling
  the capability subscribes nobody automatically.
- Never weaken a gate or regenerate an expected result to get green. Fix the
  gate and say so.
