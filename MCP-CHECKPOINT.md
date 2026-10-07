# qyl.mcp checkpoint — 7 October 2026

**Snapshot: 03:09 CEST / 01:09 UTC.** The authenticated service works in all
five required clients. The mission is not complete: finish the production
corrections, demonstrate Events end to end, then finish public plugin review.

This is the current handoff for the existing goal. Continue from the remaining
work below; do not restart the original eight-step sequence. Requirements and
authorization remain in [goal-objective.md](goal-objective.md), with detailed
evidence in [MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md).

## Current position

| Area | Verified position | Remaining work |
| --- | --- | --- |
| SDK and dependencies | SDK v2 defaults serve both supported wire eras. PRs #75 and #78 are merged. The earlier build/test/smoke evidence includes 320 tests. | Preserve these requirements while fixing the newly discovered filter regression. |
| Five real clients | ChatGPT web, claude.ai, Claude Code, Codex CLI and Inspector completed personal OAuth, catalog discovery and a real read call during this goal. | The basic connection milestone is complete; do not repeat all five logins. |
| Production endpoint | Fresh probes returned HTTP 200 for `/healthz` and protected-resource metadata. Railway reports successful MCP deployment `e33fee83-c66b-4040-a6c4-2c005424ff0b`, source `856270c4`. | This is the earlier runtime; PR #80 is not deployed. Health checks do not prove query correctness. |
| Collector filters | A natural ChatGPT request for service-specific error logs returned unrelated INFO records. The Collector consumed camelCase query names where contract 11.2 requires snake_case. [PR #640](https://github.com/ANcpLua/qyl/pull/640) passed PR CI and merged as `d07c45ad`. Twenty-one targeted tests and the expanded MCP-to-Collector regression passed. | Deployment `8f3afed5-52c2-415e-92d4-0fc1262cb63b` is **WAITING**; main CI is still running. Verify deployment success, then repeat the real filtered request. |
| MCP corrections | [PR #80](https://github.com/ANcpLua/qyl.mcp/pull/80), head `acb0872`, is open with successful lint, verify and security checks. It contains the log-filter regression, Trace Explorer refresh fix and shared instructions for unsupported requests. Local browser checks preserve limit 10, a specific trace ID and a session filter with limit 2; fourteen affected tests pass. | Complete merge/review gates and deployment. Refresh ChatGPT's connection, then recheck filtered logs, viewer refresh and deletion-only routing. The green CodeRabbit status reported a rate limit, not a completed review. |
| Natural-language review | Five of eight owner-account rehearsals passed: trace detail, metrics, sessions, rollback refusal and public-search refusal. | Filtered logs, viewer refresh and deletion-only routing need production retests. A dedicated reviewer account/sample-data run is still required. |
| ChatGPT Events | Local lifecycle tests passed; a native `trace.error` task was created for `service_name = qyl-mcp-interop-oct7`. | Stored subscription, signed delivery, filtering, refresh/restart and unsubscribe still lack the complete production demonstration. |
| Public plugin | A local package draft, icon and eight review prompts exist. Free use and availability in all eligible countries are confirmed by the owner. | Publisher verification, applicable public policy/support pages, reviewer access, demo, remaining review cases, domain verification and portal scan. No package has been uploaded or submitted. |

The five-client and local-test results above were established earlier in this
goal. Checks at approximately 01:08–01:09 UTC read current working-copy state,
PR/CI state, Railway deployments, public endpoint status, the completed browser
review response and publisher-verification UI. This checkpoint did not rerun
the build or test suite.

## Working copies

| Location | Current state |
| --- | --- |
| `/Users/alexandernachtmann/RiderProjects/qyl.mcp` | `codex/mcp-plugin-review`, code verified at `acb0872` in PR #80. Checkpoint documentation follows that code in the same branch. |
| `/private/tmp/qyl-filter-contract` | Clean `codex/collector-query-filters`, pushed as `889244faf211b6bf7b2ebbcb96476bbb11df51c0`; its correction is merged through PR #640. |
| `/Users/alexandernachtmann/RiderProjects/qyl` | Clean `codex/runner-test-diagnostics`. Existing unrelated work remains on its own branch. |
| `/Users/alexandernachtmann/RiderProjects/qyl.at` | Directory is absent. Current source files are needed for website edits; see the existing owner request below. |

## Resume in this order

1. **Deploy the corrections and repeat three cases.** Track the existing
   Collector deployment through successful main CI and deployment. Complete
   MCP PR #80's remaining merge/review gates and deploy it. Refresh ChatGPT's
   connection for the new UI resource and shared instructions. Recheck the
   service/ERROR log filter, ten-trace viewer refresh and deletion-only request
   without unnecessary telemetry calls. The expanded local MCP OTLP smoke
   already verifies service/severity/trace/body filters, an empty result and
   the requested limit.
2. **Complete the real Events lifecycle.** After the pending access decision,
   inspect the owner-scoped stored subscription, ingest a controlled matching
   trace, verify the chat notification and exact trace ID, then test filtering,
   refresh/restart and unsubscribe. Do not count an active task alone as proof
   of delivery.
3. **Finish public plugin preparation and verification.** Complete the missing
   publisher/listing/reviewer/demo evidence and review cases, then the domain
   challenge and tools/Events scan. Keep preparation, submission for review and
   publication as distinct states. Record the final evidence in the checklist.

## Items waiting on the owner

- **Publisher identity:** the `ancplua` page still shows **Start** for both
  verification types, and its open **Verify your identity** dialog offers
  **Start ID Check**. Successful verification is not shown. Continue in
  [Organization settings → General → Verifications → Individual](https://platform.openai.com/settings/organization/general).
  The owner must complete the personal identity check; no identity document
  has been handled by the agent.
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
