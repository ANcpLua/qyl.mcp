# Release preparation handoff

Dated 2026-10-08; the contract, release and deployment rows were updated 2026-10-11. Read the [release contract, its acceptance evidence and the
requirements map](contract.md), the controlling
[objective](../goal-objective.md), [ledger](../MCP-V2-INTEROP-TODO.md) and
[command/output evidence](../docs/evidence/2026-10-08-followup-13.md) together.
The map distinguishes repository work, the completed Collector pin prerequisite
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

The [point-10 completion](../docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#point-10-manifest-fields) on 2026-10-11 set
the published support, privacy and terms URLs, `developerName` and `./` icon
paths, and produced local `submission/packages/qyl-openai-1.0.0-draft.zip` with
SHA-256 `84945a46440c94b20dd2f30bb88741652d3a793424abfb974f42bdaa99583882`. It supersedes the
[listing-review rebuild](../MCP-V2-INTEROP-TODO.md#listing-review-2026-10-08)
hash `328dd9813dcbf10e581a722593b797f7ffd01f4ec6562ea3cc1ad9ae1f6aa4ce` and the
earlier [point-10 rebuild](../docs/evidence/2026-10-08-followup-10.md) hash
`16a6ffb523f90674572efc99dca430cf661d26aaa08f54d6680f7da0261fab5c`.
That archive is Git-ignored. Rebuild and revalidate after any packaged-source
change; do not apply this hash to future manifest edits. The remaining owner
fields are mapped in the [submission handoff](../submission/README.md#owner-fields-still-required).

For a newly authorized PR, follow [AGENTS.md](../AGENTS.md): a clean Codex
review and the checks currently required by GitHub. Historical four-gate
results do not impose owner stamps after that ruleset is disabled. Resolve
review findings and never set owner checks or bypass configured gates.
PRs #121 and #130 are merged; [the checkpoint](../MCP-CHECKPOINT.md) records
that result. Continue on **`codex/point-10-client-ui-domain`, targeting #136**;
the branch commits the fixes and documentation and merges `main` through #135.
The [original sequence](../goal-objective.md#work-in-order)
is not a new request to repeat completed work.

## Owner handoff

These rows describe evidence needed under [goal section E](../goal-objective.md#e-owner-actions-not-agent-actions),
not proof that every action remains undone. Reconcile each row with existing
dated owner evidence before acting; do not recreate accounts, re-publish pages
or repeat accepted observations just because an older checklist still lists
them. The 7.2.x releases and the 11.4.0 deployment are already recorded in the
[2026-10-11 evidence](../docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md).
For a genuine remaining gap, save date, command/client/version and redacted
actual output. This handoff does not authorize owner actions.

| Owner action | Exact next step and source |
| --- | --- |
| Publisher identity and countries | Verify the intended publisher and public name; the supplied WIP proposes `ancplua` pending portal confirmation. Country targeting is owner-selected as all eligible countries, with portal application still pending. Supply the approved values for the [mapped manifest fields](../submission/README.md#owner-fields-still-required). Existing source author metadata is not publisher verification. |
| Public pages and private contact | Done: `https://qyl.at/support/`, `/privacy/` and `/terms/` are published (owner WIP, 2026-10-08) and set in both manifests ([2026-10-11 evidence](../docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#point-10-manifest-fields)). Keep the private reviewer contact out of public pages; [point 15](../docs/evidence/2026-10-08-followup-15.md) records the restored sections. |
| Reviewer account | Create a populated isolated Collector project and OAuth reviewer account, usable without the owner's mailbox, phone or private network. Put credentials only in private portal fields; use the [connector access instructions](../submission/anthropic-connector-listing.md). |
| Demo and review cases | Follow the [recording walkthrough](../submission/README.md#recording-walkthrough-for-the-owner); run and record the five positive and three negative manifest cases, then supply a reviewer-accessible playback URL. |
| Five actual clients | Inspector DCR was reported blocked by Auth0 `too_many_entities` on 2026-10-08. That dated report does not establish a current failure or require another cleanup. Check existing owner evidence and use an already-provided fixed client where applicable. [Reported blocker and WIP](../docs/evidence/2026-10-08-followup-15.md#owner-reported-inspector-connection-blocker). Run ChatGPT, Codex, claude.ai, Claude Code and MCP Inspector against the hosted service with the isolated account, following the [exact client procedures](../MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending). Inspector 2.9.0 modern evidence must include the captured `MCP-Protocol-Version: 2026-07-28` header and actual tool results. Local fixture discovery is not that proof. |
| Production Events lifecycle | Follow the same ledger's `events/list`, subscribe, signed matching delivery, nonmatching filter, persistence, renewal, unsubscribe and revocation steps. Record bounded delivery/no-delivery windows without keys. |
| Deployment before reviewer access | Re-observe the active Railway deployment ID and source commit and compare with intended main. [Point 6](../docs/evidence/2026-10-08-followup-06.md) is a dated snapshot, not a guarantee about the next deployment; the [2026-10-11 snapshot](../docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#production-deploy-order) records deployment `2c916c88` for `f495bf3` and the later `ffe24407` for `0f9fe4b` (7.2.2). |
| Challenge token | Copy the portal token into `OPENAI_APPS_CHALLENGE` on the intended deployment, check the plaintext route and complete portal verification; [point 7](../docs/evidence/2026-10-08-followup-07.md) observed 404 before this action. |
| Inspector evidence after Collector deployment | [qyl PR #653](https://github.com/ANcpLua/qyl/pull/653) merged the 11.4.0 pin. The [11.4.0 evidence](../docs/evidence/2026-10-11-contract-11.4.0-release-7.2.1.md#production-deploy-order) records Collector deployment `15e4efe7` serving revision `sha256:3605ae27d2edf632` and the hosted server's completed handshake; [Option-A evidence](../docs/evidence/2026-10-08-point-8-options.md) covers the earlier 11.3.0 pin. The owner supplies the separate authenticated Inspector evidence. |
| Attestations and publication | Review the seven connector acknowledgement fields and all other applicable portal attestations, validate the three separate records, then decide and perform submission/publication. [Scope exclusions](../docs/evidence/2026-10-08-followup-11.md) still apply. |

No portal action, publisher verification, public-page publication, credential
creation, client login, challenge-token setting or schema release by this goal agent is established
by these repository checks. The agent prepares these instructions and artifacts;
the owner performs the actions above.
