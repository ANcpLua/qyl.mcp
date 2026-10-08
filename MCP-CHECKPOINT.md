# qyl.mcp checkpoint

Updated 8 October 2026. This file records state, not progress. The objective,
the work order and the completion criteria are in
[goal-objective.md](goal-objective.md). Working agreements are in
[AGENTS.md](AGENTS.md). Evidence is in
[MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md). A statement belongs here
only when the repository or a dated evidence entry backs it.

## State on main

- Server: split TypeScript SDK v2 packages; `bun run verify:sdk` in CI rejects
  SDK v1 packages. 11 tools in `server/tool-manifest.snapshot.json`, all
  `readOnlyHint: true`; `fetch_telemetry` app-only; `trace.error` Events in
  `server/src/events.ts`; project scoping in `server/src/collector-access.ts`.
  Native tool-call records keep tool name, timing, status and error type only.
  `server/package.json` declares version 7.2.0.
- Submission: `submission/qyl/` holds the OpenAI plugin draft, the Anthropic
  bundle files and the shared skill `skills/qyl-investigate/SKILL.md`. Nothing
  is uploaded or submitted. `submission/public-pages-draft.md` holds draft
  text for the owner's support, privacy and terms pages.
- Step 1 of "Work, in order" is merged (PR #91). Steps 2 to 5 are open.

## Not established

Client connections, the production Events lifecycle, review rehearsals, the
npm registry state, qyl.at changes, publisher identity and production rechecks
have no accepted evidence. The full list is in goal-objective.md under
"What is not established". Treat each item as not done.

## Next

Step 2 of "Work, in order" in goal-objective.md: tool descriptions that state
what each tool does and when to use it, without new parameters.

## Owner actions pending

Publisher identity selection, public support, privacy and terms pages on
qyl.at, a reviewer account with isolated sample data, the demo recording,
legal attestations, submission and publication. Agents prepare and list
these; they do not perform them.
