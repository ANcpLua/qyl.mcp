# Release preparation handoff

Dated 2026-10-08. Read the [contract map](contract.md), the controlling
[objective](../goal-objective.md), [ledger](../MCP-V2-INTEROP-TODO.md) and
[command/output evidence](../docs/evidence/2026-10-08-followup-13.md) together.
The map distinguishes repository work, the permitted Collector-lockstep blocker
and pending owner actions. This directory does not authorize a release
or establish a submitted/published portal state.

## Reproducing repository checks

Run the checks appropriate to the current diff under [AGENTS.md](../AGENTS.md).
The following are commands to run, not a claim of a new execution:

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run verify:sdk
bun run lint
python3 submission/build-openai-package.py
claude plugin validate ./submission/qyl
```

The completion audit runs in `verify` CI. To run it locally without changing
your global Python environment:

```sh
python3 -m venv /tmp/qyl-completion-audit
/tmp/qyl-completion-audit/bin/python -m pip install -r scripts/completion-audit-requirements.txt
PATH="/tmp/qyl-completion-audit/bin:$PATH" bun run verify:completion
```

[Point-14 evidence](../docs/evidence/2026-10-08-followup-14.md) records local audit
and negative-control results. The audit checks bundle/handoff files, schemas,
README length, tool descriptions, the strict native record, ledger rows and
local links across the goal/handoff documents and their evidence. It does not
establish production or portal state or the truth of arbitrary claims.
Run the external skill's `check_v2.mjs` separately; its path,
unchanged hashes and earlier zero-error output are in [point-3 evidence](../docs/evidence/2026-10-08-followup-03.md).
For transport changes, the required `smoke` commands remain in AGENTS.md; the
[HTTP both-era command](../docs/evidence/2026-10-08-followup-12.md) also records
its Bun-only entry and conformance scope.

The [listing-review rebuild](../MCP-V2-INTEROP-TODO.md#listing-review-2026-10-08)
on 2026-10-08 produced local `submission/packages/qyl-openai-1.0.0-draft.zip`
with SHA-256 `328dd9813dcbf10e581a722593b797f7ffd01f4ec6562ea3cc1ad9ae1f6aa4ce`.
It supersedes the [point-10 rebuild](../docs/evidence/2026-10-08-followup-10.md)
hash `16a6ffb523f90674572efc99dca430cf661d26aaa08f54d6680f7da0261fab5c`, which
covered the earlier packaged README, manifest and skill.
That archive is Git-ignored. Rebuild and revalidate after any packaged-source
change; do not apply this hash to future manifest edits. Missing URLs,
publisher name and countries are mapped in the [submission handoff](../submission/README.md#owner-fields-still-required).

Merge each point only after a clean own review and green `lint`, `verify`,
`owner-review/content`, `owner-review/evidence` on the reviewed head. Read and
resolve owner comments; never set those owner checks. Begin the next point
only after merge. These are the owner's process requirements, as recorded in
[the objective](../goal-objective.md#work-in-order).

## Owner handoff

These are pending instructions under [goal section E](../goal-objective.md#e-owner-actions-not-agent-actions),
not claims of work performed. Save date, command/client/version and redacted
actual output for each completed observation.

| Owner action | Exact next step and source |
| --- | --- |
| Publisher identity and countries | Verify the intended publisher and public name; the supplied WIP proposes `ancplua` pending portal confirmation. Country targeting is owner-selected as all eligible countries, with portal application still pending. Supply the approved values for the [mapped manifest fields](../submission/README.md#owner-fields-still-required). Existing source author metadata is not publisher verification. |
| Public pages and private contact | Resolve operational facts and contacts in the [public-page draft](../submission/public-pages-draft.md), approve and publish on qyl.at, inspect anonymously, then supply the actual support/privacy/terms URLs. [Point 15](../docs/evidence/2026-10-08-followup-15.md) restores the required sections with explicit owner fields. |
| Reviewer account | Create a populated isolated Collector project and OAuth reviewer account, usable without the owner's mailbox, phone or private network. Put credentials only in private portal fields; use the [connector access instructions](../submission/anthropic-connector-listing.md). |
| Demo and review cases | Follow the [recording walkthrough](../submission/README.md#recording-walkthrough-for-the-owner); run and record the five positive and three negative manifest cases, then supply a reviewer-accessible playback URL. |
| Five actual clients | Inspector DCR is currently blocked by the owner-reported Auth0 `too_many_entities` response. The supplied WIP assigns tenant review and a fixed Inspector client to Advisor 1; retry with that public client ID when supplied. [Reported blocker and WIP](../docs/evidence/2026-10-08-followup-15.md#owner-reported-inspector-connection-blocker). Run ChatGPT, Codex, claude.ai, Claude Code and MCP Inspector against the hosted service with the isolated account, following the [exact client procedures](../MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending). Inspector 2.9.0 modern evidence must include the captured `MCP-Protocol-Version: 2026-07-28` header and actual tool results. Local fixture discovery is not that proof. |
| Production Events lifecycle | Follow the same ledger's `events/list`, subscribe, signed matching delivery, nonmatching filter, persistence, renewal, unsubscribe and revocation steps. Record bounded delivery/no-delivery windows without keys. |
| Deployment before reviewer access | Re-observe the active Railway deployment ID and source commit and compare with intended main. [Point 6](../docs/evidence/2026-10-08-followup-06.md) is a dated snapshot, not a guarantee about the next deployment. |
| Challenge token | Copy the portal token into `OPENAI_APPS_CHALLENGE` on the intended deployment, check the plaintext route and complete portal verification; [point 7](../docs/evidence/2026-10-08-followup-07.md) observed 404 before this action. |
| Collector contract prerequisite | Schema 11.3.0 is published. Coordinate the Collector main bump from 11.2.0, then qyl.mcp can bump and implement/test the new options; [refreshed blocker](../docs/evidence/2026-10-08-followup-15.md#release-blocker-refreshed-after-owner-release) includes the failing candidate gate. |
| Attestations and publication | Review the seven connector acknowledgement fields and all other applicable portal attestations, validate the three separate records, then decide and perform submission/publication. [Scope exclusions](../docs/evidence/2026-10-08-followup-11.md) still apply. |

No portal action, publisher verification, public-page publication, credential
creation, client login, challenge-token setting or schema release by this goal agent is established
by these repository checks. The agent prepares these instructions and artifacts;
the owner performs the actions above.
