# qyl.mcp checkpoint — 7 October 2026

**Snapshot: 03:31 CEST / 01:31 UTC.** The authenticated service works in all
five required clients, and all eight owner-account review rehearsals pass.
The public UI-origin deployment is also verified. The mission is not complete:
demonstrate Events end to end, then finish public plugin preparation and review.

This is the current handoff for the existing goal. Continue from the remaining
work below; do not restart the original eight-step sequence. Requirements and
authorization remain in [goal-objective.md](goal-objective.md), with detailed
evidence in [MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md).

## Current position

| Area | Verified position | Remaining work |
| --- | --- | --- |
| SDK and dependencies | SDK v2 defaults serve both supported wire eras. PRs #75 and #78 are merged. The earlier build/test/smoke evidence includes 320 tests. | Preserve these requirements in remaining work. |
| Five real clients | ChatGPT web, claude.ai, Claude Code, Codex CLI and Inspector completed personal OAuth, catalog discovery and a real read call during this goal. | The basic connection milestone is complete; do not repeat all five logins. |
| Production endpoint | PR #81 (`3ae30b52`) passed main CI `37557011340` and deployment `cf19d6da-2feb-491a-95d3-9809ad461575`. Authenticated ChatGPT requests, both viewers and trace refresh work against that deployment. | Continue with the Events lifecycle; endpoint and UI checks are complete. |
| Collector filters | [PR #640](https://github.com/ANcpLua/qyl/pull/640), `d07c45ad`, passed main CI and deployment `8f3afed5-52c2-415e-92d4-0fc1262cb63b`. Twenty-one targeted tests and expanded MCP-to-Collector smoke passed. ChatGPT's service/ERROR request now returns 0 matches without unrelated records. Direct service/limit probes also pass. | The controlled matching production ERROR fixture remains part of the pending Events test; its matching behavior is covered locally. |
| MCP corrections | [PR #80](https://github.com/ANcpLua/qyl.mcp/pull/80) is merged and deployed. A fresh ChatGPT chat retains ten traces after viewer refresh and directly declines deletion-only requests without visible qyl activity. | The three defect retests are complete. |
| Public UI origin | [PR #81](https://github.com/ANcpLua/qyl.mcp/pull/81), `3ae30b52`, is merged and deployed. Inspector reads both new resource versions. After ChatGPT metadata refresh, both viewers render at `mcp-qyl-at.web-sandbox.oaiusercontent.com`; trace Refresh retains ten results. Dashboard correctly reports no MCP spans in its 24-hour window. | Verification complete. Optional CodeRabbit was pending at merge; it is not counted as a completed review. |
| Natural-language review | All eight owner-account rehearsals passed: trace detail, filtered logs, metrics, sessions, viewer refresh, deletion refusal, rollback refusal and public-search refusal. | A dedicated reviewer account/sample-data run and real recording are still required. |
| ChatGPT Events | Local lifecycle tests passed; a native `trace.error` task was created for `service_name = qyl-mcp-interop-oct7`. | Stored subscription, signed delivery, filtering, refresh/restart and unsubscribe still lack the complete production demonstration. |
| Public plugin | A local package draft, icon and eight review prompts exist. Free use and all eligible countries are confirmed. The owner completed the phone identity flow; Individual now shows **Identity in review**. | Await identity review; complete applicable public policy/support pages, reviewer access, demo, domain verification and portal scan. No package has been uploaded or submitted. |

The five-client and local-test results above were established earlier in this
goal. Subsequent checks confirm deployed Collector/MCP corrections and the
three successful ChatGPT retests. PR #81 has its own focused local/CI evidence;
the prior five client logins and full baseline suite were not repeated.

## Working copies

| Location | Current state |
| --- | --- |
| `/Users/alexandernachtmann/RiderProjects/qyl.mcp` | Local branch `codex/mcp-plugin-review`, HEAD `db414530`. Eight local source/doc changes match PR #81's already-published files. The checkpoint, objective, checklist and preparation README are updated, and a service data inventory is added. Remote branches are published through the API from main, without downloading Git history. This checkout is not clean or on the remote evidence branch. |
| `/private/tmp/qyl-filter-contract` | Clean `codex/collector-query-filters`, pushed as `889244faf211b6bf7b2ebbcb96476bbb11df51c0`; its correction is merged through PR #640. |
| `/Users/alexandernachtmann/RiderProjects/qyl` | Clean `codex/runner-test-diagnostics`. Existing unrelated work remains on its own branch. |
| `/Users/alexandernachtmann/RiderProjects/qyl.at` | Directory is absent. Current source files are needed for website edits; see the existing owner request below. |

## Resume in this order

1. **Complete the real Events lifecycle.** After the pending access decision,
   inspect the owner-scoped stored subscription, ingest a controlled matching
   trace, verify the chat notification and exact trace ID, then test filtering,
   refresh/restart and unsubscribe. Do not count an active task alone as proof
   of delivery.
2. **Finish public plugin preparation and verification.** Complete the missing
   publisher/listing/reviewer/demo evidence and review cases, then the domain
   challenge and tools/Events scan. Keep preparation, submission for review and
   publication as distinct states. Record the final evidence in the checklist.

Collector/MCP defect retests and public UI-origin verification are complete;
do not repeat all eight rehearsals or five logins. The fresh UI-origin check
is in [this owner-account chat](https://chatgpt.com/c/6ac5a05c-c45c-832c-bce2-ae47f40abb58).

The [service data inventory](submission/service-data-inventory.md) now records
the code's actual storage, recipients and deletion behavior for the missing
public policy. Selected production settings confirm Events persistence,
content-capture opt-in absent and Collector retention configured for 30 days.
Physical deletion, provider/backup retention and reviewer data isolation remain
unverified; the inventory is not a published policy or a completed review gate.

## Waiting items

- **Publisher identity review:** the owner reports **Successful** on the
  phone, and the `ancplua` page confirms **Identity in review** for Individual.
  Do not press Start again. Wait for the review result in
  [Organization settings → General → Verifications → Individual](https://platform.openai.com/settings/organization/general).
  This is identity review, not a submitted plugin review. No reliable processing
  time was established from official plugin documentation, and no identity
  document has been handled by the agent.
- **Temporary Railway SSH access:** the existing confirmation is unanswered.
  Automatic approval rejected registering the temporary key because it grants
  additional Railway access. No key was created or registered. The requested
  scope is subscription inspection and internal test ingestion, followed by
  removal of that registration and both key files.
- **Website source:** the existing request is to supply the current `qyl.at`
  files without `.git` at the path above. Automatic approval rejected cloning
  because reading Git objects/history conflicts with the owner's explicit
  prohibition. The clone did not run; do not work around that rejection.

## Goal control

The goal is **active**. Its widget retains the original eight-step objective,
including the obsolete sentence saying to begin at step 1. The available
`update_goal` operation changes status only; it cannot replace objective text.
This checkpoint and the updated objective file define the current resume point.
Do not mark the goal complete or create a replacement to conceal that limitation.
The existing question about pausing remains unanswered; do not infer an answer
or repeat it. Saving a checkpoint has not paused the goal.
