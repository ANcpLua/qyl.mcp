# qyl.mcp checkpoint — 7 October 2026

**Snapshot: 03:56 CEST / 01:56 UTC.** The authenticated service works in all
five required clients, and all eight owner-account review rehearsals pass.
The public UI-origin deployment and a real ChatGPT Events delivery are verified.
The mission is not complete: finish Events renewal/unsubscribe, then public
plugin preparation and review.

This is the current handoff for the existing goal. Continue from the remaining
work below; do not restart the original eight-step sequence. Requirements and
authorization remain in [goal-objective.md](goal-objective.md), with detailed
evidence in [MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md).

## Current position

| Area | Verified position | Remaining work |
| --- | --- | --- |
| SDK and dependencies | SDK v2 defaults serve both supported wire eras. PRs #75 and #78 are merged. The earlier build/test/smoke evidence includes 320 tests. | Preserve these requirements in remaining work. |
| Five real clients | ChatGPT web, claude.ai, Claude Code, Codex CLI and Inspector completed personal OAuth, catalog discovery and a real read call during this goal. | The basic connection milestone is complete; do not repeat all five logins. |
| Production endpoint | Documentation PR #82 (`27a0bf73`) passed main CI `37558331956` and deployment `de261a52-aba4-4899-8e0a-94044e088d1e`. Fresh health/resource metadata probes return 200; unauthenticated MCP returns 401. Runtime code is unchanged from the viewer-verified PR #81 deployment. | Continue with the Events lifecycle; endpoint and UI checks are complete. |
| Collector filters | [PR #640](https://github.com/ANcpLua/qyl/pull/640), `d07c45ad`, passed main CI and deployment `8f3afed5-52c2-415e-92d4-0fc1262cb63b`. Twenty-one targeted tests and expanded MCP-to-Collector smoke passed. ChatGPT's service/ERROR request now returns 0 matches without unrelated records. Direct service/limit probes also pass. | The controlled matching production ERROR fixture remains part of the pending Events test; its matching behavior is covered locally. |
| MCP corrections | [PR #80](https://github.com/ANcpLua/qyl.mcp/pull/80) is merged and deployed. A fresh ChatGPT chat retains ten traces after viewer refresh and directly declines deletion-only requests without visible qyl activity. | The three defect retests are complete. |
| Public UI origin | [PR #81](https://github.com/ANcpLua/qyl.mcp/pull/81), `3ae30b52`, is merged and deployed. Inspector reads both new resource versions. After ChatGPT metadata refresh, both viewers render at `mcp-qyl-at.web-sandbox.oaiusercontent.com`; trace Refresh retains ten results. Dashboard correctly reports no MCP spans in its 24-hour window. | Verification complete. Optional CodeRabbit was pending at merge; it is not counted as a completed review. |
| Natural-language review | All eight owner-account rehearsals passed: trace detail, filtered logs, metrics, sessions, viewer refresh, deletion refusal, rollback refusal and public-search refusal. | A dedicated reviewer account/sample-data run and real recording are still required. |
| ChatGPT Events | The production store contains one owner-bound subscription. ChatGPT received matching trace `e70ecd31c3bbf6ac02a07919e3c4d558` with the exact service/error/time; it did not report the nonmatching-service trace. The subscription predates and survived the current deployment. | Verify automatic renewal before the current `02:15:12.041Z` expiration, then stop monitoring and prove removal/no further delivery. |
| Public plugin | A local package draft, icon and eight review prompts exist. Free use and all eligible countries are confirmed. The owner completed the phone identity flow; Individual now shows **Identity in review**. | Await identity review; complete applicable public policy/support pages, reviewer access, demo, domain verification and portal scan. No package has been uploaded or submitted. |

The five-client and local-test results above were established earlier in this
goal. Subsequent checks confirm deployed Collector/MCP corrections and the
three successful ChatGPT retests. PR #81 has its own focused local/CI evidence;
the prior five client logins and full baseline suite were not repeated.

## Working copies

| Location | Current state |
| --- | --- |
| `/Users/alexandernachtmann/RiderProjects/qyl.mcp` | Local branch `codex/mcp-plugin-review`, HEAD `db414530`. Eight local source/doc changes match PR #81's already-published files. Five evidence files were uploaded to `codex/mcp-review-evidence` at `2b2027c8` through the API from main, without downloading Git history; PR #82 passed CI and merged as `27a0bf73`. This later working-copy note is local only. The checkout is not clean or on the remote evidence branch. |
| `/private/tmp/qyl-filter-contract` | Clean `codex/collector-query-filters`, pushed as `889244faf211b6bf7b2ebbcb96476bbb11df51c0`; its correction is merged through PR #640. |
| `/Users/alexandernachtmann/RiderProjects/qyl` | Clean `codex/runner-test-diagnostics`. Existing unrelated work remains on its own branch. |
| `/Users/alexandernachtmann/RiderProjects/qyl.at` | Directory is absent. Current source files are needed for website edits; see the existing owner request below. |

## Resume in this order

1. **Complete the real Events lifecycle.** Observe the existing subscription's
   automatic renewal before `2026-10-07T02:15:12.041Z` (04:15 Vienna).
   ChatGPT's tools explicitly reported that they cannot force a manual renewal;
   the attempted request did not change the task. Check the stored ID/count,
   `updatedAt` and new `refreshBefore` through the existing authenticated
   Railway browser console. Then stop monitoring in ChatGPT, verify removal,
   and ingest one final controlled error to check that delivery has stopped.
   Do not replace this with a second subscription or a direct store edit.
   A read-only Node watcher started in that console at `01:55:53Z`; it prints
   only subscription metadata on renewal/removal and exits. It stops by the
   current expiration plus 90 seconds. Leave the terminal tab available and
   inspect its result before starting another command there.
2. **Finish public plugin preparation and verification.** Complete the missing
   publisher/listing/reviewer/demo evidence and review cases, then the domain
   challenge and tools/Events scan. Keep preparation, submission for review and
   publication as distinct states. Record the final evidence in the checklist.

Collector/MCP defect retests and public UI-origin verification are complete;
do not repeat all eight rehearsals or five logins. The fresh UI-origin check
is in [this owner-account chat](https://chatgpt.com/c/6ac5a05c-c45c-832c-bce2-ae47f40abb58).

The [Events chat](https://chatgpt.com/c/6ac5880a-bea8-8333-9632-7cdff64601e4)
is the original monitoring conversation. Its current task is still active.
The configured internal Collector accepted the nonmatching error at
`01:51:33.649Z` and matching error at `01:52:32.694Z`; both returned HTTP 200.
The same `fetchTraces(100)` path used by the poller confirms both persisted as
error traces. The latest visible task response reports only the matching one.
The current deployment was created at `01:41:15.189Z`, after the subscription's
`01:15:12.041Z` update, so this delivery also demonstrates restart survival.

The [service data inventory](submission/service-data-inventory.md) now records
the code's actual storage, recipients and deletion behavior for the missing
public policy. Selected production settings confirm Events persistence,
content-capture opt-in absent and Collector retention configured for 30 days.
The Railway dashboard shows no backup schedule and no volume backups for either
service. The Collector uses one credential-bound project, shared by this MCP
deployment's Auth0 callers; a new login alone cannot isolate reviewer data.
Physical deletion and provider-internal retention remain unverified. The
inventory is not a published policy or a completed review gate. These latest
runtime observations are local updates after PR #82, not a new deployment.

## Waiting items

- **Publisher identity review:** the owner reports **Successful** on the
  phone, and the `ancplua` page confirms **Identity in review** for Individual.
  Do not press Start again. Wait for the review result in
  [Organization settings → General → Verifications → Individual](https://platform.openai.com/settings/organization/general).
  This is identity review, not a submitted plugin review. No reliable processing
  time was established from official plugin documentation, and no identity
  document has been handled by the agent.
- **Railway access resolved:** no answer to the earlier SSH-key request is
  needed for this work. The CLI volume reader reported `No SSH keys found`, but
  the existing authenticated browser console connected and supplied the
  required inspection/ingestion access. No key was created or registered and
  no protection was disabled.
- **Website source:** the existing request is to supply the current `qyl.at`
  files without `.git` at the path above. Automatic approval rejected cloning
  because reading Git objects/history conflicts with the owner's explicit
  prohibition. The clone did not run; do not work around that rejection.
- **Public support contact:** the existing unanswered proposal is to use the
  qyl.at issue tracker for technical questions and an owner-confirmed public
  email for private account/privacy/deletion requests. Do not use a private
  login email or repeat the question.

The owner explicitly approved keeping the five evidence documents public and
opening their regular PR after an automatic publication-approval rejection.
The repeated create command reported existing [PR #82](https://github.com/ANcpLua/qyl.mcp/pull/82),
which was verified open and not a draft at `2b2027c8`; no duplicate was created.
Its CI run `37558090276` passed lint, build, tests, smoke and the real
Collector/OTLP contract check. It merged as `27a0bf73`. Main CI `37558331956`
and Railway deployment `de261a52-aba4-4899-8e0a-94044e088d1e` both succeeded.
This documentation-only rollout follows the viewer-verified runtime above.
Events delivery, filtering and restart survival are now demonstrated as above;
renewal/unsubscribe and public submission remain incomplete.

## Goal control

The goal is **active**. Its widget retains the original eight-step objective,
including the obsolete sentence saying to begin at step 1. The available
`update_goal` operation changes status only; it cannot replace objective text.
This checkpoint and the updated objective file define the current resume point.
Do not mark the goal complete or create a replacement to conceal that limitation.
The existing question about pausing remains unanswered; do not infer an answer
or repeat it. Saving a checkpoint has not paused the goal.
