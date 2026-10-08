# qyl.mcp checkpoint

Updated 8 October 2026 UTC for step 2. This file records state. The objective,
the work order and the completion criteria are in
[goal-objective.md](goal-objective.md). Working agreements are in
[AGENTS.md](AGENTS.md). Evidence is in
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md). A statement belongs here
only when the repository or a dated evidence entry backs it.

## Step 1: merged in PR #91

- [PR #91](https://github.com/ANcpLua/qyl.mcp/pull/91) starts from the owner's
  reset at `8c658fd62b413ae682bea256002f83f18d5ade6a`. The worktree was rebased
  with `git rebase --autostash origin/main`; `git rev-parse HEAD` returned
  that commit before the step-1 changes.
- `git log -1 origin/main` now records its merge at
  `4685c2471a4100ed6a00601b44ec3ead1b6a0f6f`. Step 2 starts from that commit.
- Server: split TypeScript SDK v2 packages; 11 tools in
  `server/tool-manifest.snapshot.json`, all `readOnlyHint: true`;
  `fetch_telemetry` app-only; `trace.error` Events in `server/src/events.ts`;
  project scoping in `server/src/collector-access.ts`. `server/package.json`
  declares version 7.2.0.
- Submission: OpenAI draft in `submission/qyl/` (`plugin.json`, `mcp.json`,
  icon), plus the Anthropic bundle files and shared `qyl-investigate` skill
  added on main. Their presence is source evidence, not portal validation.
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

## Step 2: descriptions and manifest

- Branch `codex/tool-description-scope` starts from `origin/main` at
  `4685c2471a4100ed6a00601b44ec3ead1b6a0f6f`.
- `get_trace` now states that it returns the full span tree and names the
  interactive viewer and correlated-log query. `ci_log` explains the
  `qyl-ci` emitter convention and the existing discovery/detail limits.
- Tool descriptions no longer direct the model's behavior. The app-only
  `fetch_telemetry` description lists its existing viewer data modes, and
  `query_metric` describes grouping without promising one scalar result.
- The deliberately regenerated manifest changes ten descriptions only.
  The comparison preserves all 11 tools' schemas, annotations and metadata,
  the resource catalog and the generated contract revision. No parameters
  were added to `get_trace` or `ci_log`.
- SDK checks, lint and 18 focused tests passed locally; commands and outputs
  are in the [step-2 evidence](MCP-V2-INTEROP-TODO.md#step-2--tool-descriptions).
  CI and Codex review remain the merge gates for this step's PR.

## Not established

Client connections, the production Events lifecycle, review rehearsals, the
npm registry state, qyl.at changes, publisher identity and production rechecks
have no accepted evidence. The full list is in goal-objective.md under
"What is not established". Treat each item as not done.

## Next

The owner resumed for step 2 on 8 October 2026: open one PR, merge after green
CI and clean review, then pause. On the next resume, continue with steps 3
and 4: align the existing shared skill and collect fresh evidence. Submission
preparation follows separately in step 5. New trace/CI parameters require a
released contract change in `ANcpLua/qyl-api-schema` first.

## Owner actions pending

Publisher identity selection, public support, privacy and terms pages on
qyl.at, a reviewer account with isolated sample data, the demo recording,
legal attestations, submission and publication. Agents prepare and list
these; they do not perform them.
