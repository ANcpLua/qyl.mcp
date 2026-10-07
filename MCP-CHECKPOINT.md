# qyl.mcp checkpoint — 7 October 2026

**Snapshot: 7 October 2026, after PR #83's production rollout.** The authenticated service works in all
five required clients, and all eight owner-account review rehearsals pass.
The public UI-origin deployment and the production Events lifecycle are
verified. Both evidence PRs are merged and deployed. The mission is not
complete: publish the corrected npm package, finish the website correction and
public plugin preparation and review.

This is the current handoff for the existing goal. Continue from the remaining
work below; do not restart the original eight-step sequence. Requirements and
authorization remain in [goal-objective.md](goal-objective.md), with detailed
evidence in [MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md).

## Current position

| Area | Verified position | Remaining work |
| --- | --- | --- |
| SDK and dependencies | SDK v2 defaults serve both supported wire eras. PRs #75 and #78 are merged. The earlier build/test/smoke evidence includes 320 tests. | Preserve these requirements in remaining work. |
| Five real clients | ChatGPT web, claude.ai, Claude Code, Codex CLI and Inspector completed personal OAuth, catalog discovery and a real read call during this goal. | The basic connection milestone is complete; do not repeat all five logins. |
| Production endpoint | Documentation PR #83 (`7157a08c`) passed main CI `37560936901` and deployment `27aefb63-0e09-40ef-96bf-c9ef3ce73f43`. `/healthz` and resource metadata probes return 200; unauthenticated MCP returns 401. Runtime code is unchanged from the viewer-verified PR #81 deployment. | The evidence rollout is complete. |
| Collector filters | [PR #640](https://github.com/ANcpLua/qyl/pull/640), `d07c45ad`, passed main CI and deployment `8f3afed5-52c2-415e-92d4-0fc1262cb63b`. Twenty-one targeted tests and expanded MCP-to-Collector smoke passed. ChatGPT's service/ERROR request returns 0 matches without unrelated records. Direct service/limit probes also pass. | The filter defect retest is complete. The controlled error traces for Events are verified below. |
| MCP corrections | [PR #80](https://github.com/ANcpLua/qyl.mcp/pull/80) is merged and deployed. A fresh ChatGPT chat retains ten traces after viewer refresh and directly declines deletion-only requests without visible qyl activity. | The three defect retests are complete. |
| Public UI origin | [PR #81](https://github.com/ANcpLua/qyl.mcp/pull/81), `3ae30b52`, is merged and deployed. Inspector reads both new resource versions. After ChatGPT metadata refresh, both viewers render at `mcp-qyl-at.web-sandbox.oaiusercontent.com`; trace Refresh retains ten results. Dashboard correctly reports no MCP spans in its 24-hour window. | Verification complete. Optional CodeRabbit was pending at merge; it is not counted as a completed review. |
| Natural-language review | All eight owner-account rehearsals passed: trace detail, filtered logs, metrics, sessions, viewer refresh, deletion refusal, rollback refusal and public-search refusal. | A dedicated reviewer account/sample-data run and real recording are still required. |
| ChatGPT Events | Matching delivery, service filtering, restart survival, automatic renewal and unsubscribe passed. ChatGPT received the exact matching trace. The task is now Paused and the store contains zero subscriptions; the final matching error produced no notification over more than three polling intervals. | The requested production Events lifecycle is complete. Keep public reviewer/demo work separate. |
| npm artifact | The registry's `qyl-mcp-server@7.1.0` still pins SDK 2.0.0 and contains `legacy: "reject"` in both entry points. The hosted/source corrections had not yet been published to npm. Patch 7.1.1, aligned workspace references and the regenerated lockfile are prepared; local build/lint and discovery plus demo metrics in both eras pass. | Merge the release preparation, run the existing trusted npm publication and verify fresh consumers of the actual published artifact. |
| Website documentation | The current `qyl.at` source is available. Regular [PR #16](https://github.com/ANcpLua/qyl.at/pull/16), head `aca0ab2d`, corrects obsolete modern-only claims and documents optional Events. Build, type checks, lint, artifact checks and 13 focused browser checks passed locally; full PR CI `37561893577` passed. | Align the release catalog with the corrected npm artifact, then merge and verify the existing Cloudflare deployment. |
| Public plugin | A local package draft, icon and eight review prompts exist. Free use and all eligible countries are confirmed. The owner completed the phone identity flow; Individual now shows **Identity in review**. | Await identity review; complete applicable public policy/support pages, reviewer access, demo, domain verification and portal scan. No package has been uploaded or submitted. |

The five-client and local-test results above were established earlier in this
goal. Subsequent checks confirm deployed Collector/MCP corrections and the
three successful ChatGPT retests. PR #81 has its own focused local/CI evidence;
the prior five client logins and full baseline suite were not repeated.

## Working copies

| Location | Current state |
| --- | --- |
| `/Users/alexandernachtmann/RiderProjects/qyl.mcp` | Local branch `codex/mcp-plugin-review`, HEAD `db414530`. Runtime/UI changes are published through PR #81; the evidence is published through regular PRs #82 and #83 (`7157a08c`). API publication did not move this checkout to those remote branches. The current resume-document updates remain local; preserve the existing worktree changes. |
| `/private/tmp/qyl-filter-contract` | Clean `codex/collector-query-filters`, pushed as `889244faf211b6bf7b2ebbcb96476bbb11df51c0`; its correction is merged through PR #640. |
| `/Users/alexandernachtmann/RiderProjects/qyl` | Clean `codex/runner-test-diagnostics`. Existing unrelated work remains on its own branch. |
| `/Users/alexandernachtmann/RiderProjects/qyl.at` | Contains the 133 current-main source files retrieved through GitHub's file API at ref `6408c305`. This is a source directory without `.git`, not a Git checkout. Nine documentation/fixture changes are published in PR #16; dependencies and the generated site are available locally. |

## Resume in this order

1. **Publish the corrected npm package.** The source and hosted service already
   accept both protocol eras, but the inspected npm artifact still rejects
   2025 clients. Release 7.1.1 through the existing `publish.yml` workflow after
   its PR gates pass. The updated consumer check uses SDK v2 clients to verify
   modern and legacy discovery, the actual package version, tool listing and
   a labelled demo-metrics call from fresh temporary directories.
2. **Finish the [website correction](https://github.com/ANcpLua/qyl.at/pull/16).**
   Its nine files align the public guides with the deployed SDK v2 serving and
   negotiation behavior. Verify CI on head `aca0ab2d`, merge, and check the
   existing Cloudflare rollout and the rendered protocol guide. Do not merge
   unrelated website dependency PRs as part of this correction.
3. **Finish public plugin preparation and verification.** Complete the missing
   publisher/listing/reviewer/demo evidence and review cases, then the domain
   challenge and tools/Events scan. Keep preparation, submission for review and
   publication as distinct states. Record the final evidence in the checklist.

Collector/MCP defect retests and public UI-origin verification are complete;
do not repeat all eight rehearsals or five logins. The fresh UI-origin check
is in [this owner-account chat](https://chatgpt.com/c/6ac5a05c-c45c-832c-bce2-ae47f40abb58).

The [Events chat](https://chatgpt.com/c/6ac5880a-bea8-8333-9632-7cdff64601e4)
is the original monitoring conversation. Its task is now paused.
The configured internal Collector accepted the nonmatching error at
`01:51:33.649Z` and matching error at `01:52:32.694Z`; both returned HTTP 200.
The same `fetchTraces(100)` path used by the poller confirms both persisted as
error traces. The latest visible task response reports only the matching one.
The current deployment was created at `01:41:15.189Z`, after the subscription's
`01:15:12.041Z` update, so this delivery also demonstrates restart survival.
Automatic renewal retained the same ID and one-record count, updating at
`01:58:55.776Z` and extending expiration to `02:58:55.776Z`. No replacement
signing key was observed. The read-only watcher exited after detecting renewal.

Pausing the task removed its subscription: the store had zero records at
`02:02:01.464Z`. The final trace `e73ab104fa2afb6d3353874fd1e8c1e5` was accepted
at `02:02:35.633Z`. At `02:04:52.044Z`, the Collector still returned that error,
the store remained empty, and the refreshed chat contained no notification for
it. This is a bounded no-delivery observation over more than three 30-second
polling intervals. No direct store edit or new authorization grant was used.

The [service data inventory](submission/service-data-inventory.md) now records
the code's actual storage, recipients and deletion behavior for the missing
public policy. Selected production settings confirm Events persistence,
content-capture opt-in absent and Collector retention configured for 30 days.
The Railway dashboard shows no backup schedule and no volume backups for either
service. The Collector uses one credential-bound project, shared by this MCP
deployment's Auth0 callers; a new login alone cannot isolate reviewer data.
Physical deletion and provider-internal retention remain unverified. The
inventory is not a published policy or a completed review gate. These latest
runtime observations are documented in PR #83. Its final head `f76201b4`
passed lint, verify, GitGuardian and CodeRabbit in PR CI `37560576765`.
It merged as `7157a08c`; main CI and the production rollout above succeeded.

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
- **Website source resolved:** automatic approval rejected cloning because
  reading Git objects/history conflicts with the owner's prohibition. The
  clone did not run. A later approved, current-file-only API download supplied
  the source without Git history or a `.git` directory. No owner response to
  the earlier source request is needed.
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
The complete requested Events lifecycle is now demonstrated above. Public
submission remains incomplete.

## Goal control

The goal is **active**. Its widget retains the original eight-step objective,
including the obsolete sentence saying to begin at step 1. The available
`update_goal` operation changes status only; it cannot replace objective text.
This checkpoint and the updated objective file define the current resume point.
Do not mark the goal complete or create a replacement to conceal that limitation.
The existing question about pausing remains unanswered; do not infer an answer
or repeat it. Saving a checkpoint has not paused the goal.
