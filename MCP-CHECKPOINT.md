# qyl.mcp checkpoint

Each section names the date of what it records: the 2026-10-08 observations
stay dated 2026-10-08, and the 2026-10-11 merges, releases and evidence are
dated 2026-10-11. The [objective](goal-objective.md) defines completion;
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

Point 8's Collector prerequisite is merged in [qyl PR #642](https://github.com/ANcpLua/qyl/pull/642).
The local Collector checkout is on that merged `main`; `verify:pins` confirms
11.3.0 on both sides. The consumer now implements the three trace options and
the CI service prefix. [Option-A evidence](docs/evidence/2026-10-08-point-8-options.md)
supersedes the earlier Collector-pin blocker. [Consumer PR #119](https://github.com/ANcpLua/qyl.mcp/pull/119)
merged on 2026-10-08 at `08:37:26Z` after all four review/CI gates passed on
`0321963`. After the Collector deployment reached `SUCCESS` and
`RUNNING`, the local 11.3.0 startup gate matched the production Collector's
revision at `2026-10-08T08:18:26.200Z`; the linked evidence contains the actual
output. The owner supplies the separate Inspector proof.

Point 9 in the continuation normalizes only the advertised output schemas.
[Dated evidence](docs/evidence/2026-10-08-point-9-schema-portability.md) records
the eight spelling changes across six tools, unchanged contract revision and
validation, and passing local tests. [PR #120](https://github.com/ANcpLua/qyl.mcp/pull/120)
merged on 2026-10-08 at `09:26:44Z`, merge `ee4c5a0`, after all four gates
passed on `9371b65`. The owner's authenticated Inspector proof remains separate.

Point 10 selects each viewer's domain for the connected UI host: Claude's
exact connector-URL hash, the configured HTTPS origin plus compatibility
alias for ChatGPT, or neither domain field for unknown hosts.
[Dated source and local verification](docs/evidence/2026-10-08-point-10-ui-domain.md)
cover both viewers and both wire eras.

## Point 10, toolchain, contract and releases, 2026-10-11

Point-10 progress checked **2026-10-11**: [PR #121](https://github.com/ANcpLua/qyl.mcp/pull/121)
merged as `9a84bfe`. The following work is implemented in follow-up
[PR #130](https://github.com/ANcpLua/qyl.mcp/pull/130), fixes `9ffb4f4` and `ef7727a`,
merged as `71df28b` and shipped in 7.2.2:

- [x] Select the viewer domain per caller using both `clientInfo.name` and
  `User-Agent`, including when the client name is unknown: Claude gets the
  SHA-256 hash of the exact connector URL including `/mcp`, ChatGPT gets the
  public origin, and unknown clients get no domain.
- [x] Cover Claude by name, Claude by UA with an unknown name, both ChatGPT
  UA variants with an unknown name, and an unknown client in regression tests.
- [x] Prefer a recognized client name when the UA disagrees, with regression
  tests for both Claude and ChatGPT conflicts; still evaluate both hints.
- [x] Version the changed viewers as Trace Explorer v6 and MCP Dashboard v4,
  including the resource manifest and fixtures.
- [x] Preserve the point-9 checkpoint recording PR #120 merged as `ee4c5a0`
  with all four gates green.

Verification on 2026-10-11: `QYL_MCP_TELEMETRY=0 bun run test` passed 364 tests
on PR #130 commit `ef7727a`; lint, SDK checks, completion audit and transport
smoke passed. On this branch with server 7.2.1 and contract 11.4.0, the server,
workbench, dashboard and site suites passed 186/142/32/4 tests. An initial
workbench timeout assertion failed under concurrent load and passed both
alone and in the full workbench rerun. Lint, SDK checks and transport smoke
passed after building the dashboard required by workbench smoke.

`gh pr view 121 --json state,mergeCommit` returned `MERGED` and
`9a84bfea9c4484f03c83a4153ed853237636703b`. The 2026-10-11 follow-up
`gh pr view 130 --repo ANcpLua/qyl.mcp --json state,headRefOid,mergeCommit,mergedAt,autoMergeRequest,mergeStateStatus,url`
returned `MERGED`, head `69b98a5c9ebbc5730934d46f823bbd7a4f2b4f95`,
merge `71df28b40275513c595988a6a2b78a1bd3cd39cd`, at `2026-10-11T04:35:59Z`.
The viewer runtime, tests, versions and manifest match that reviewed PR head.
[CI run 38110929009](https://github.com/ANcpLua/qyl.mcp/actions/runs/38110929009)
passed lint and verify on that head. Codex completed its review, reacted with
thumbs-up, and left no unresolved findings. The old auto-merge wait is complete.
`gh api repos/ANcpLua/qyl.mcp/rulesets/24693919` now reports
`enforcement: disabled` for `owner-review-gate`. While it stays disabled, its
four check names are not a stamping task; once the owner activates it,
`owner-review/content` and `owner-review/evidence` are required on every PR's
reviewed head. This review made no gate changes.

Documentation clarified **2026-10-11** against the
[verified references](docs/evidence/2026-10-08-point-10-ui-domain.md#clarification-and-current-behavior-2026-10-11):
Claude's optional domain must use the exact connector hash when supplied.
OpenAI documents an origin-valued domain and a dedicated, unique origin for
UI submission. Using the MCP server's origin for ChatGPT is qyl's configuration
choice. Unknown names can use a recognized UA; only when neither hint is
recognized are both domain fields omitted, allowing the host's default sandbox.
Omission alone does not disable the viewer or reject the client.

The corrected documentation merged through
[PR #136](https://github.com/ANcpLua/qyl.mcp/pull/136) as `de9c8dc` at
`2026-10-11T08:12:19Z`; new work branches from `main`. The implemented
items above are complete and must not become duplicate tasks. Observed client
identifiers and authenticated Claude/ChatGPT rendering still need separate
owner evidence; synthetic tests establish policy, not production compatibility.
Release 7.2.2 (#133) shipped the #130 fix; #134 and #135 corrected the SDK skill.

Toolchain, contract and releases checked **2026-10-11**:
[PR #126](https://github.com/ANcpLua/qyl.mcp/pull/126) pins Node 24 next to
Bun 1.4.3 in `mise.toml`, and CI no longer uses `setup-node`. The contract moved
in lockstep to 11.4.0 (TypeSpec 1.17, revision `sha256:3605ae27d2edf632`):
Collector [qyl PR #653](https://github.com/ANcpLua/qyl/pull/653) merged as
`6a0cde7`, consumer [PR #131](https://github.com/ANcpLua/qyl.mcp/pull/131) as
`89be0fd`. The release workflow published `qyl-mcp-server` 7.2.0, 7.2.1, 7.2.2 and 7.2.3 with
provenance after clean `npx` consumers passed in both eras; 7.2.3
([PR #137](https://github.com/ANcpLua/qyl.mcp/pull/137), merged as `db1c728`)
moved the contract package to 11.5.0 with the revision unchanged. The first 11.4.0
deploy refused to start until the Collector served the new revision.
[Dated evidence](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md) records the commands, output and the deploy order this
requires.

The [release contract map](release/contract.md) and [owner handoff](release/README.md)
connect all revised points and Done-when criteria to the ledger and dated
commands/output. [Point-14 evidence](docs/evidence/2026-10-08-followup-14.md) records the new CI audit;
[point-15 evidence](docs/evidence/2026-10-08-followup-15.md) records restored public-page sections
with explicit owner fields. Final completion still requires checking the merged
`origin/main` and its CI, not inferring a merge from these local records.

## Repository and local evidence, 2026-10-08 and 2026-10-11

| State | Dated evidence |
| --- | --- |
| 2026-10-11: Split SDK 2.3.1, contract package 11.5.0 (revision `sha256:3605ae27d2edf632`, unchanged since 11.4.0), server source 7.5.0 on contracts 11.6.0 (npm `latest` follows each release; see the server release notes). | [11.4.0 lockstep and release evidence](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md); [Option-A pins and manifest evidence](docs/evidence/2026-10-08-point-8-options.md); [earlier package inventory](docs/evidence/2026-10-08-step7.md#package-and-tool-inventory). |
| 2026-10-11: The source has 18 tools. The 13 read tools keep `readOnlyHint: true`; five write tools (`create_annotation`, `update_annotation`, `create_saved_query`, `update_saved_query`, `delete`) change only annotations and saved queries in the caller's project, behind `qyl:write` and `qyl:delete` step-up scopes. No tool changes or deletes telemetry. This supersedes the 11-tool row below. | [Write-tool decision](docs/decisions/2026-10-11-qyl-dev-audit.md#write-tools); [generated manifest](server/tool-manifest.snapshot.json). |
| 2026-10-08: 11 read-only tools; ten model-facing and app-only `fetch_telemetry`; trace/CI descriptions now include point-8 options. | [Option-A manifest comparison](docs/evidence/2026-10-08-point-8-options.md); earlier inventory retained in step 7. |
| 2026-10-08: Incoming native records exclude arguments, `_meta` and result bodies. | [Strict schema source](docs/evidence/2026-10-08-step7.md#native-records) and [regression evidence](MCP-V2-INTEROP-TODO.md#step-1--rules-and-native-call-records). |
| 2026-10-08: Build, 337 tests, transport, SDK, lint and project-isolation checks passed locally. | [Step-4 transcript](docs/evidence/2026-10-08-step4.md). The initial OTLP failure and successful fresh-main Collector rerun are both retained. |
| 2026-10-08: Inspector 2.9.0 passed modern/legacy discovery and schema portability. | [Black-box command/output](docs/evidence/2026-10-08-step4.md#both-era). |
| 2026-10-08: Historical drift scan produced 31 findings; revised point 3 now reports zero errors with an unchanged checker. | [Point-3 command/output](docs/evidence/2026-10-08-followup-03.md#static-checker-before-and-after); [historical raw output](docs/evidence/2026-10-08-step4.md#static-drift-findings) and [assessed rules](MCP-V2-INTEROP-TODO.md#static-findings--assessed-2026-10-08). |
| 2026-10-08: Shared skill and Anthropic files exist; both OpenAI manifests schema-valid; package build reproducible. | [Step-5 commands/output](docs/evidence/2026-10-08-step5.md). Generated ZIP is local and Git-ignored, not a submitted artifact. |

## Merge and CI evidence, as of 2026-10-08

Steps 2–6 merged sequentially as PRs #93–#97. Each has `lint`, `verify`,
`owner-review/content` and `owner-review/evidence` recorded as SUCCESS at its
reviewed head. Step 1 was already merged in #91. Exact heads, merge commits,
dates and `gh` outputs are in [step-7 merge evidence](docs/evidence/2026-10-08-step7.md#merged-steps).
This revision reconciles the step-7 documents; its own PR and CI status must
be read from GitHub rather than inferred from these earlier runs.

## Public observations and remaining owner work, 2026-10-08 and 2026-10-11

`curl` observed the public MCP 401 challenge and correct resource/issuer/scope
metadata; `npm view qyl-mcp-server version` returned 7.1.1 on 2026-10-08.
[Exact output](docs/evidence/2026-10-08-step4.md#endpoint).
These results do not prove the deployed commit, a fresh npm consumer, a real
client connection or production Events behavior. On 2026-10-11 the registry
returned `7.2.1`, then `7.2.2` after #133 and `7.2.3` after #137, and the release workflow's clean `npx` consumer smoke passed in
both eras ([release evidence](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#releases)). That is CI evidence, not the
owner's pinned-Inspector consumer observation.

The active deployment ID and commit were observed read-only in
[point-6 evidence](docs/evidence/2026-10-08-followup-06.md); recheck that dated
snapshot before reviewer access. The [2026-10-11 snapshot](docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#production-deploy-order)
records deployment `2c916c88` for `f495bf3` and the later `ffe24407` for `0f9fe4b` (7.2.2). All five client connections, production Events
lifecycle and modern request header proof, reviewer account, demo recording, publisher
identity, targeting, public pages, attestations, submission and publication
remain in the [owner-action index](MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending)
and [submission handoff](submission/README.md#owner-fields-still-required).
No current portal state is established by this repository work.
