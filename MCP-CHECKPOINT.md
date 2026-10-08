# qyl.mcp checkpoint

Updated 8 October 2026 UTC for PR #91. This file records state. The objective,
the work order and the completion criteria are in
[goal-objective.md](goal-objective.md). Working agreements are in
[AGENTS.md](AGENTS.md). Evidence is in
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md). A statement belongs here
only when the repository or a dated evidence entry backs it.

## Step 1: source and checks in PR #91

- [PR #91](https://github.com/ANcpLua/qyl.mcp/pull/91) starts from the owner's
  reset at `8c658fd62b413ae682bea256002f83f18d5ade6a`. The worktree was rebased
  with `git rebase --autostash origin/main`; `git rev-parse HEAD` returned
  that commit before the step-1 changes.
- Server: split TypeScript SDK v2 packages; 11 tools in
  `server/tool-manifest.snapshot.json`, all `readOnlyHint: true`;
  `fetch_telemetry` app-only; `trace.error` Events in `server/src/events.ts`;
  project scoping in `server/src/collector-access.ts`. `server/package.json`
  declares version 7.2.0.
- Submission: OpenAI draft in `submission/qyl/` (`plugin.json`, `mcp.json`,
  icon), not uploaded. No Anthropic connector record and no Anthropic plugin
  bundle yet.
- Rules: the owner's `AGENTS.md` and `docs/threat-model.md` are unchanged.
  `verify:sdk` now checks split SDK v2 dependency pins and Bun resolutions in
  CI; lint rejects imports of the monolithic SDK package.
- Native execution state is schema version 3: generated execution ID, tool
  name, timing, status and error type. Payloads are excluded from the file
  and from native OTLP content logging. Valid old version-1/2 records are
  reduced to that shape on load. Unreadable files and pre-existing recovery
  archives still require operator review.
- Dated commands and actual outputs are in the
  [step-1 evidence](MCP-V2-INTEROP-TODO.md#step-1--rules-and-native-call-records):
  local build, 337 tests, 5 SDK-rule tests, lint and transport smokes passed.
  The initial CI run also passed the live-Collector checks. Each CI claim in
  the ledger names its tested commit; it is not a production claim.
- Preserve the uncommitted checkout at
  `/Users/alexandernachtmann/RiderProjects/qyl.mcp`. Work for this PR uses only
  `/Users/alexandernachtmann/.codex/worktrees/reviewer-project-isolation/qyl.mcp`.

## Not established

Client connections, the production Events lifecycle, review rehearsals, the
npm registry state, qyl.at changes, publisher identity and production rechecks
have no accepted evidence. The full list is in goal-objective.md under
"What is not established". Treat each item as not done.

## Next

The owner requested a pause after PR #91 on 8 October 2026. Finish its CI and
review, then pause. On the owner's next resume, check PR #91's merge state
and start step 2 of "Work, in order": bounded `get_trace`, usable CI-tool
scope, and descriptions that match behavior. Steps 2–5 remain open.

## Owner actions pending

Publisher identity selection, public support, privacy and terms pages on
qyl.at, a reviewer account with isolated sample data, the demo recording,
legal attestations, submission and publication. Agents prepare and list
these; they do not perform them.
