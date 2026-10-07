# qyl.mcp checkpoint — 7 October 2026

This is the current handoff for the existing goal. Continue from the remaining
work below; do not restart the original eight-step sequence. Requirements and
authorization remain in [goal-objective.md](goal-objective.md), with detailed
evidence in [MCP-V2-INTEROP-TODO.md](MCP-V2-INTEROP-TODO.md).

## Current position

| Area | Verified position | Remaining work |
| --- | --- | --- |
| SDK and dependencies | SDK v2 defaults serve both supported wire eras. PRs #75 and #78 are merged. The earlier build/test/smoke evidence includes 320 tests. | Preserve these requirements while fixing the newly discovered filter regression. |
| Five real clients | ChatGPT web, claude.ai, Claude Code, Codex CLI and Inspector completed personal OAuth, catalog discovery and a real read call during this goal. | The basic connection milestone is complete; do not repeat all five logins. |
| Production endpoint | Fresh checkpoint probes returned HTTP 200 for `/healthz` and protected-resource metadata. | These checks do not prove that every query filter works. |
| Collector filters | A natural ChatGPT request for service-specific error logs returned unrelated INFO records. The Collector consumed camelCase query names where contract 11.2 requires snake_case. Correction `889244fa` is in regular [PR #640](https://github.com/ANcpLua/qyl/pull/640); 21 targeted tests passed. The added MCP-to-Collector regression also passes against that build. | Finish CI, merge/deploy the Collector correction and repeat the real filtered request. |
| Trace Explorer refresh | The ChatGPT viewer initially showed the requested ten traces but refreshed to twenty. The local correction reuses the original display query. Browser checks preserve limit 10, a specific trace ID and a session filter with limit 2. Fourteen affected schema/resource/catalog tests pass. | Publish/deploy the MCP change, refresh the connection for the versioned UI resource and repeat the ChatGPT check. |
| ChatGPT Events | Local lifecycle tests passed; a native `trace.error` task was created for `service_name = qyl-mcp-interop-oct7`. | Stored subscription, signed delivery, filtering, refresh/restart and unsubscribe still lack the complete production demonstration. |
| Public plugin | A local package draft, icon and eight review prompts exist. Free use and availability in all eligible countries are confirmed by the owner. | Publisher verification, applicable public policy/support pages, reviewer access, demo, remaining review cases, domain verification and portal scan. No package has been uploaded or submitted. |

The five-client and test results above are evidence from earlier runs of this
goal, not new test runs performed while making this checkpoint. Fresh checks
at approximately 00:54–00:56 UTC confirmed the checkout states, remote filter
branch, absent filter PR, merged MCP PRs, endpoint health and the portal status.

## Working copies

| Location | Current state |
| --- | --- |
| `/Users/alexandernachtmann/RiderProjects/qyl.mcp` | `codex/mcp-plugin-review`, based on merged MCP main. Contains the checkpoint, review-package draft, log-filter regression and Trace Explorer refresh correction. |
| `/private/tmp/qyl-filter-contract` | Clean `codex/collector-query-filters`, pushed as `889244faf211b6bf7b2ebbcb96476bbb11df51c0`. Use this checkout for the Collector fix. |
| `/Users/alexandernachtmann/RiderProjects/qyl` | Clean `codex/runner-test-diagnostics`. Existing unrelated work remains on its own branch. |
| `/Users/alexandernachtmann/RiderProjects/qyl.at` | Directory is currently absent. Website edits will require an available checkout. |

## Resume in this order

1. **Finish the two verified corrections.** Complete Collector PR #640 through
   the required CI checks, merge and deployment, then repeat the failing
   natural-language request. The expanded MCP OTLP smoke already verifies
   service/severity/trace/body filters, an empty result and the requested limit.
   Publish the MCP regression, Trace Explorer refresh correction and review
   documentation after the corrected Collector is available to CI. Refresh
   ChatGPT's connection and verify the new UI resource in production.
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

- **Publisher identity:** the freshly inspected `ancplua` page still shows
  **Start** for both Individual and Business. The personal verification entry
  is [Organization settings → General → Verifications → Individual → Start](https://platform.openai.com/settings/organization/general).
  Billing is a separate page; no identity document has been handled by the agent.
- **Temporary Railway SSH access:** the existing confirmation is unanswered.
  Automatic approval rejected registering the temporary key because it grants
  additional Railway access. No key was created or registered. The requested
  scope is subscription inspection and internal test ingestion, followed by
  removal of that registration and both key files.

## Goal control

The goal tool currently retains the original eight-step objective text. Its
available update operation can change status only; it cannot replace that text.
This checkpoint and the updated objective file define the current resume point.
The user has been asked once whether to pause at this checkpoint; do not infer
that answer or repeat the question.
