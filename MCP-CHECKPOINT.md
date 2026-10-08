# qyl.mcp checkpoint

Updated 8 October 2026. This file records state, not progress. The objective,
the work order and the completion criteria are in
[goal-objective.md](goal-objective.md). Working agreements are in
[AGENTS.md](AGENTS.md). Evidence is in
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md). A statement belongs here
only when the repository or a dated evidence entry backs it.

## State on main

- `main` is the commit that introduced this file, on top of `00a0aa9`. All
  `codex/*` branches are merged (PRs #75, #78, #80 to #90). No PR is open.
- Server: split TypeScript SDK v2 packages; 11 tools in
  `server/tool-manifest.snapshot.json`, all `readOnlyHint: true`;
  `fetch_telemetry` app-only; `trace.error` Events in `server/src/events.ts`;
  project scoping in `server/src/collector-access.ts`. `server/package.json`
  declares version 7.2.0.
- Submission: OpenAI draft in `submission/qyl/` (`plugin.json`, `mcp.json`,
  icon), not uploaded. No Anthropic connector record and no Anthropic plugin
  bundle yet.
- Rules: `AGENTS.md` and `docs/threat-model.md` on `main`. The SDK v1 CI
  check (`verify:sdk`) is pending in the Codex worktree on
  `codex/review-invariants`.
- The main checkout `/Users/alexandernachtmann/RiderProjects/qyl.mcp` is on
  `codex/mcp-plugin-review` with an uncommitted documentation tree 15 commits
  behind `main`. Preserve it; do not commit it unrebased.

## Not established

Client connections, the production Events lifecycle, review rehearsals, the
npm registry state, qyl.at changes, publisher identity and production rechecks
have no accepted evidence. The full list is in goal-objective.md under
"What is not established". Treat each item as not done.

## Next

Step 1 of "Work, in order" in goal-objective.md: the rules PR from
`codex/review-invariants`, including the native-execution persistence fix.

## Owner actions pending

Publisher identity selection, public support, privacy and terms pages on
qyl.at, a reviewer account with isolated sample data, the demo recording,
legal attestations, submission and publication. Agents prepare and list
these; they do not perform them.
