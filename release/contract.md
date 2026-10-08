# Release preparation contract

Requirements and evidence map, 2026-10-08. The controlling requirements are
[goal-objective.md](../goal-objective.md#work-in-order), including its
[Done when](../goal-objective.md#done-when) criteria and owner boundary.
[AGENTS.md](../AGENTS.md) governs implementation and review. This map is not a
release, submission, publication or approval claim. Each observed result below
links to dated commands and actual output; pending items are requirements.
The [ledger](../MCP-V2-INTEROP-TODO.md) retains historical and superseding rows.

## Work-item mapping

| Point | Required result / observed boundary | Dated evidence or pending requirement |
| --- | --- | --- |
| 1 | Modern tool calls emit no deprecated logging; progress/cancellation retained. | [Point 1](../docs/evidence/2026-10-08-followup-01.md): server tests, frame negative control and transport output. |
| 2 | qyl's HTTP banner goes to stderr. | [Point 2](../docs/evidence/2026-10-08-followup-02.md): real Bun process; its own stdout banner is distinguished. |
| 3 | Unchanged external `check_v2` reports zero errors. | [Point 3](../docs/evidence/2026-10-08-followup-03.md): explicit Zod imports, justified JSON-Schema allowance, checker hashes. |
| 4 | HTTP mismatch/missing-capabilities codes, cache hints and stable catalog order. | [Point 4](../docs/evidence/2026-10-08-followup-04.md): three direct factory-fetch tests. |
| 5 | Wrong audience, missing scope, expiry and cross-subject isolation pass CI. | [Point 5](../docs/evidence/2026-10-08-followup-05.md): exact test names, timestamps and successful CI run, including point 4. |
| 6 | Railway trigger, active deployment ID and commit recorded; compare with PR #91. | [Point 6](../docs/evidence/2026-10-08-followup-06.md): read-only live snapshot; running commit contains #91. It is not a perpetual production-state guarantee. |
| 7 | Challenge route observed as 404; environment name documented. | [Point 7](../docs/evidence/2026-10-08-followup-07.md): production response and token-present/absent fixture; setting `OPENAI_APPS_CHALLENGE` remains an owner action. |
| 8 | Schema change merged; consumer bump/runtime work blocked on release. | [Point 8](../docs/evidence/2026-10-08-followup-08.md): schema PR #36 merged; published 11.2.0 lacks the four fields. No release was published in this goal. |
| 9 | Separate Anthropic connector listing with acknowledgement/access owner fields. | [Point 9](../docs/evidence/2026-10-08-followup-09.md); [listing draft](../submission/anthropic-connector-listing.md). |
| 10 | Anthropic icon and rebuilt, validated OpenAI ZIP; unresolved manifest fields named. | [Point 10](../docs/evidence/2026-10-08-followup-10.md); [owner field mapping](../submission/README.md#owner-fields-still-required). |
| 11 | MCP Registry and Custom Marketplaces excluded with reason. | [Point 11](../docs/evidence/2026-10-08-followup-11.md): owner-defined distribution scope. |
| 12 | Bun HTTP both-era conformance and working legacy-only negative control. | [Point 12](../docs/evidence/2026-10-08-followup-12.md): 24 stateless checks, additional scenario results, fixture exclusions and warning, negative-control exit 1. |
| 13 | These release documents map requirements, ledger and evidence. | [Point 13](../docs/evidence/2026-10-08-followup-13.md): file/mapping/link checks. |
| 14 | Pending: repository completion audit in the verify CI job. | Required checks come from [goal point 14](../goal-objective.md#d-submission-files) and [the original audit snippet](../docs/evidence/2026-10-08-step7.md). `server/docs/completion.md` is not the audit source; external `check_v2` stays outside CI. |
| 15 | Pending: restore the four public-page sections from commit `93d8dbf`. | [Goal point 15](../goal-objective.md#d-submission-files); [current draft](../submission/public-pages-draft.md). Every number and deployment statement must be an owner-supplied field. |

## Done-when mapping

| Criterion | Evidence to assess on `origin/main` |
| --- | --- |
| 1 | Point 3, rerun the unchanged external checker for final source state. |
| 2 | Points 4–5, successful verify CI on the reviewed source; do not substitute a local run for CI. |
| 3 | Dated ledger rows and actual output for points 6, 7, 11 and 12. |
| 4 | Files/fields from points 9, 10, 13, 14 and 15, explicit owner gaps and rebuilt ZIP SHA-256. Points 14 and 15 are still pending in this dated map. |
| 5 | Point 8's documented release blocker is the permitted alternative. The merged schema PR alone does not implement these options in qyl.mcp. |
| 6 | All source, test, public-response and historical claims trace to the ledger/evidence; retain the SDK boundary, minimized records, user-need descriptions, shared skill and valid bundles. CI automation cannot establish the truth of arbitrary prose. |
| 7 | [Owner handoff](README.md#owner-handoff), [client/Events procedures](../MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending) and [submission fields](../submission/README.md#owner-fields-still-required). Owner work remains pending. |

For point 8, the owner must publish a schema release containing merge
`719e46717fa9648dbeda899c02d3fef28bdf7a90`. Only afterward can the consumers
bump in lockstep and implement/test `errors_only`, `max_spans`,
`include_attributes` and `service_prefix`. The [release/installed-schema
commands](../docs/evidence/2026-10-08-followup-08.md#concrete-release-blocker)
are the evidence for this dated blocker, not a promise that the registry will
remain unchanged.
