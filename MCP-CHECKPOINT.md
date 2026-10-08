# qyl.mcp checkpoint

Checked **2026-10-08**. The [objective](goal-objective.md) defines completion;
[AGENTS.md](AGENTS.md) defines repository rules. The
[evidence ledger](MCP-V2-INTEROP-TODO.md) distinguishes source, local tests,
CI, public HTTP observations and pending owner actions.

## Revised goal, 2026-10-08

The owner supplied a new fifteen-point sequence after the earlier document
reconciliation. [goal-objective.md](goal-objective.md#work-in-order) records
those instructions. Completion of the earlier five criteria does not complete
this sequence. New point 1 removes protocol logging; its local results are in
[the follow-up evidence](docs/evidence/2026-10-08-followup-01.md). Its merge/CI
status must be read from its PR, not inferred from local tests.

Point 8's schema PR is merged, while the qyl.mcp bump and runtime options are
blocked on an owner-published contract release. The post-merge registry still
reported 11.2.0 without the four fields on 2026-10-08.
[Dated merge, checks, registry and installed-schema output](docs/evidence/2026-10-08-followup-08.md)
records the permitted Done when 5 blocker and exact owner prerequisite.

The [release contract map](release/contract.md) and [owner handoff](release/README.md)
connect all revised points and Done-when criteria to the ledger and dated
commands/output. [Point-14 evidence](docs/evidence/2026-10-08-followup-14.md) records the new CI audit;
point 15 remains pending.

## Repository and local evidence

| State | Dated evidence |
| --- | --- |
| Split SDK 2.3.1, contract package 11.2.0, server source version 7.2.0. | [Step-7 package command/output](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory). |
| 11 read-only tools; ten model-facing and app-only `fetch_telemetry`; descriptions match step 2. | Same manifest inventory; [step-2 comparison](MCP-V2-INTEROP-TODO.md#step-2--tool-descriptions) proves only descriptions changed. |
| Incoming native records exclude arguments, `_meta` and result bodies. | [Strict schema source](docs/evidence/2026-10-08-step7.md#native-records) and [regression evidence](MCP-V2-INTEROP-TODO.md#step-1--rules-and-native-call-records). |
| Build, 337 tests, transport, SDK, lint and project-isolation checks passed locally. | [Step-4 transcript](docs/evidence/2026-10-08-step4.md). The initial OTLP failure and successful fresh-main Collector rerun are both retained. |
| Inspector 2.9.0 passed modern/legacy discovery and schema portability. | [Black-box command/output](docs/evidence/2026-10-08-step4.md#both-era). |
| Historical drift scan produced 31 findings; revised point 3 now reports zero errors with an unchanged checker. | [Point-3 command/output](docs/evidence/2026-10-08-followup-03.md#static-checker-before-and-after); [historical raw output](docs/evidence/2026-10-08-step4.md#static-drift-findings) and [assessed rules](MCP-V2-INTEROP-TODO.md#static-findings--assessed-2026-10-08). |
| Shared skill and Anthropic files exist; both OpenAI manifests schema-valid; package build reproducible. | [Step-5 commands/output](docs/evidence/2026-10-08-step5.md). Generated ZIP is local and Git-ignored, not a submitted artifact. |

## Merge and CI evidence

Steps 2–6 merged sequentially as PRs #93–#97. Each has `lint`, `verify`,
`owner-review/content` and `owner-review/evidence` recorded as SUCCESS at its
reviewed head. Step 1 was already merged in #91. Exact heads, merge commits,
dates and `gh` outputs are in [step-7 merge evidence](docs/evidence/2026-10-08-step7.md#merged-steps).
This revision reconciles the step-7 documents; its own PR and CI status must
be read from GitHub rather than inferred from these earlier runs.

## Public observations and remaining owner work

`curl` observed the public MCP 401 challenge and correct resource/issuer/scope
metadata; `npm view qyl-mcp-server version` returned 7.1.1 on 2026-10-08.
[Exact output](docs/evidence/2026-10-08-step4.md#endpoint).
These results do not prove the deployed commit, a fresh npm consumer, a real
client connection or production Events behavior.

The active deployment ID and commit were observed read-only in
[point-6 evidence](docs/evidence/2026-10-08-followup-06.md); recheck that dated
snapshot before reviewer access. All five client connections, production Events
lifecycle and modern request header proof, reviewer account, demo recording, publisher
identity, targeting, public pages, attestations, submission and publication
remain in the [owner-action index](MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending)
and [submission handoff](submission/README.md#owner-fields-still-required).
No current portal state is established by this repository work.
