# qyl.mcp objective

Rewritten on 8 October 2026 on the owner's instruction. This file replaces
every earlier version of itself, the goal widget text, and the progress claims
in MCP-CHECKPOINT.md, MCP-V2-INTEROP-TODO.md and QYL-MCP-MATRIX.md. Later owner
instructions take precedence over this document.

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

Everything in this section was checked in the repository on 8 October 2026.

- `origin/main` is at `00a0aa9`. All `codex/*` branches are merged through
  PRs #75, #78, #80 and #87 to #90; the local branch names are stale copies.
  PRs #81 to #86 are merged as well. No PR is open.
- The server uses the split TypeScript SDK v2 packages. The committed manifest
  `server/tool-manifest.snapshot.json` lists 11 tools, all annotated
  `readOnlyHint: true`. `fetch_telemetry` is app-only through
  `_meta.ui.visibility: ["app"]`. A `trace.error` Events implementation exists
  in `server/src/events.ts`; account and project scoping exists in
  `server/src/collector-access.ts`.
- `submission/qyl/` holds the OpenAI plugin draft (`plugin.json`,
  `mcp.json`, icon), the Anthropic bundle files (`.claude-plugin/plugin.json`,
  `.mcp.json`, `README.md`, `LICENSE`) and the shared agent skill
  `skills/qyl-investigate/SKILL.md`. Nothing in it is uploaded or submitted.
- The main checkout carries uncommitted documentation and two new submission
  drafts (`submission/demo-runbook.md`, `submission/public-pages-draft.md`).
  Preserve them; do not commit them onto `main` unrebased, because that tree
  lacks `server/src/trace-query.ts` and its test.
- The working agreements for agents are `AGENTS.md` on `main`, with review
  context in `docs/threat-model.md`. The Codex worktree
  `/Users/alexandernachtmann/.codex/worktrees/reviewer-project-isolation/qyl.mcp`
  is on branch `codex/review-invariants` at `00a0aa9` and carries uncommitted
  `scripts/verify-mcp-sdk.mjs`, `scripts/verify-mcp-sdk.test.mjs`, the
  `verify:sdk` script in `package.json`, `.oxlintrc.json` and
  `.github/workflows/ci.yml` changes, plus untracked copies of `AGENTS.md`
  and `docs/threat-model.md` that are identical to `main`.

## What is not established

Earlier versions of this file and MCP-CHECKPOINT.md claimed the following as
verified: five real client connections (ChatGPT, claude.ai, Claude Code, Codex
CLI, MCP Inspector); the production ChatGPT Events lifecycle; eight review
rehearsals; npm `qyl-mcp-server@7.1.1` published and consumer-checked; qyl.at
PR #16 and a live protocol guide; an approved Individual publisher identity;
Collector PR #640; production rechecks of filters and viewer refresh.

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
- Tool descriptions describe the tool, never the model's behavior. App-only
  tools are hidden through `_meta.ui.visibility`, not through a sentence.
- qyl's own telemetry about incoming tool calls records only tool name,
  timing, status and error type. It must not persist argument values,
  `_meta` or conversation text. `main` still does in
  `server/src/native-execution.ts`; the fix lands with the rules PR.
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

1. **Rules PR** from branch `codex/review-invariants`, rebased on current
   `main`: `scripts/verify-mcp-sdk.mjs`, `scripts/verify-mcp-sdk.test.mjs`,
   the `verify:sdk` script in `package.json`, `.oxlintrc.json` and
   `.github/workflows/ci.yml`. `AGENTS.md` and `docs/threat-model.md` are
   already on `main`; delete the worktree's untracked copies before pulling.
   In the same PR, stop persisting `arguments` and `_meta` in
   `FileNativeExecutionRepository` records (`server/src/native-execution.ts`)
   with a test, so the rule in AGENTS.md is true on merge. Leave the
   uncommitted working tree in the main checkout untouched.
2. **Review-readiness fixes** (Anthropic connector checklist, Directory Policy
   §1D and §5B, OpenAI plugin guidelines):
   - `get_trace`: its input schema is the contract binding
     `Mcp.Tools.GetTraceInput` from `@ancplua/qyl-api-schema`, so new
     parameters (`errors_only`, `max_spans`, `include_attributes`) are a
     contract change in ANcpLua/qyl-api-schema first and are not required for
     this goal. In this repository: make the description state honestly that
     the full span tree is returned and point to `display_traces` and
     `search_logs` for large traces.
   - `ci_log`: its input schema is the contract binding `Mcp.Tools.CiLogInput`,
     so a `service_prefix` parameter is also a contract change. In this
     repository: make the description state the emitter convention from
     `server/src/ci.ts` (sessions whose resource `service.name` starts with
     `qyl-ci`, one span per phase with a `ci.leg` attribute), so any CI that
     emits it can use the tool; or remove the tool from the public manifest if
     that is preferred.
   - `fetch_telemetry`: remove "The model should NOT call this tool directly"
     from the description; the visibility is already correct.
   - Check every description against "schema and annotation equal behavior".
   - If write tools are added, give each its own tool with honest hints and
     update negative test cases 1 and 2 in `submission/qyl/plugin.json`.
3. **Agent skill.** `submission/qyl/skills/qyl-investigate/SKILL.md` exists
   on `main` and is shared by both plugin formats; keep it in step with the
   tool descriptions. Its workflow: start with `list_sessions` and
   `list_traces`; drill with `get_trace`, then `search_logs` on the same
   `trace_id` with `severity_min` 17; metrics via `list_metrics`,
   `get_metric_series`, `query_metric`; tool health via
   `display_mcp_dashboard`; CI via `ci_log`; visual via `display_traces`;
   Events for `trace.error`. Empty results mean no data, not no error.
4. **Fresh evidence.** Re-run and record, one by one: authentication, tool
   listing and one read-tool call in ChatGPT, claude.ai, Claude Code, Codex CLI
   and MCP Inspector, with client version, negotiated protocol and registration
   path; the Events lifecycle on a `2026-07-28` ChatGPT surface; the npm
   package state. Evidence lives in MCP-V2-INTEROP-TODO.md with date, command
   and output. No evidence, no claim.
5. **Submission preparation**, two Anthropic records and one OpenAI record.
   - Anthropic connector for `https://mcp.qyl.at/mcp`, submitted separately
     at `https://claude.ai/directory/manage` as kind "MCP connector": test
     credentials for a fully populated account, documentation URL, privacy
     URL, support contact, icon. The default result is a Community listing
     after the automatic scan.
   - Anthropic plugin bundle in the same folder as the OpenAI draft:
     `submission/qyl/.claude-plugin/plugin.json`, `submission/qyl/.mcp.json`
     pointing at `https://mcp.qyl.at/mcp`, `README.md`, `LICENSE` and the
     shared `skills/` exist on `main`. Add `supportUrl`, `privacyPolicyUrl`
     and `termsOfServiceUrl` once the owner publishes those pages. Portal
     fields:
     repository `ANcpLua/qyl.mcp`, plugin path `submission/qyl`, a branch or
     tag (no commit). The repository may stay private during validation and
     must be public to go live, with the Claude GitHub App installed.
   - OpenAI: the `submission/qyl/` ZIP with `$schema` in both manifests,
     `extensions.com.openai`, one server, five positive and three negative
     cases, a demo recording URL. The ZIP then contains `.claude-plugin/`;
     OpenAI accepts Claude-compatible manifests and `extensions.com.openai`
     takes precedence, but check the ZIP against the portal validator or
     exclude `.claude-plugin/` when zipping.
   - Local branch `codex/handoff-2026-10-08` carries reusable drafts:
     `developerName`, `category`, logo paths and release notes in
     `submission/qyl/plugin.json`, and `submission/public-pages-draft.md` with
     support, privacy and terms text. Reuse the text, not its claims.
   - Public support, privacy and terms pages on qyl.at and a reviewer account
     with isolated sample data are owner decisions; record what is missing,
     do not invent it.
6. **Submission and publication** are owner actions: legal attestations,
   portal uploads, identity selection, publish. Agents prepare and report;
   they do not submit. Publication is a separate decision after approval.
7. **Keep the documents truthful.** README, MCP-CHECKPOINT.md,
   QYL-MCP-MATRIX.md and MCP-V2-INTEROP-TODO.md state only what exists with
   evidence. Distinguish source present, local test passed, CI passed,
   production observed, portal status observed.

## Done when

All of the following hold on `origin/main`. Each is verifiable from the
repository without an owner action.

1. The rules PR (step 1) is merged: `bun run verify:sdk` exists and runs in
   CI, and `FileNativeExecutionRepository` records contain no `arguments` and
   no `_meta`.
2. `server/tool-manifest.snapshot.json` contains no description that
   addresses the model, and the `get_trace` and `ci_log` descriptions state
   their scope as described in step 2. Contract-level parameter additions
   are tracked in ANcpLua/qyl-api-schema and are not part of this goal.
3. `submission/qyl/skills/qyl-investigate/SKILL.md`,
   `submission/qyl/.claude-plugin/plugin.json`, `submission/qyl/.mcp.json`,
   `submission/qyl/README.md` (at least 40 words outside code blocks) and
   `submission/qyl/LICENSE` exist, and `submission/qyl/plugin.json` and
   `submission/qyl/mcp.json` validate against their `$schema`.
4. Every row in MCP-V2-INTEROP-TODO.md carries either dated evidence or the
   exact owner action it is waiting for.
5. MCP-CHECKPOINT.md, QYL-MCP-MATRIX.md, README.md and submission/README.md
   contain no claim without evidence.

Owner actions (publisher identity, public pages, reviewer account, demo
recording, attestations, submission, publication) are outside this goal.
They are listed, not performed.

## Standing constraints

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

## Goal status

The goal widget text is the owner's and points at this file. The goal is
complete when the "Done when" list holds; set the widget status from that
list, not from this document's prose.
