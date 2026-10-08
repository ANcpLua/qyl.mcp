# qyl directory preparation

Checked 2026-10-08. This is local preparation, with reproducible commands and
actual outputs in [step-5 evidence](../docs/evidence/2026-10-08-step5.md).
The package is **incomplete for submission**: owner identity, targeting,
reviewer access, demo and public policy/support URLs remain open. No current
portal status is established by these local checks.

## Three separate records

These targets and fields follow `goal-objective.md`, step 5; they are
preparation instructions, not claims of portal creation or approval.

| Record | Prepared source / observed local state | Owner destination and remaining fields |
| --- | --- | --- |
| OPENAI_PLUGIN | `python3 submission/build-openai-package.py` produces a local draft ZIP with six source-identical files; both root manifests schema-valid. | `https://platform.openai.com/plugins`; select publisher, countries, supply support/privacy/terms URLs, reviewer access and `review.demo_recording_url`, then validate the saved draft. |
| ANTHROPIC_CONNECTOR | Endpoint `https://mcp.qyl.at/mcp`; unauthenticated challenge and resource metadata observed in [step 4](../docs/evidence/2026-10-08-step4.md#endpoint). No connector portal record is evidenced. | `https://claude.ai/directory/manage`, kind **MCP connector**; supply a fully populated isolated test account, documentation URL, privacy URL, support contact, icon, slug and category. Goal step 5 identifies the default route as Community listing after automatic scan; this is not an observed listing. |
| ANTHROPIC_PLUGIN | `qyl/.claude-plugin/plugin.json`, `.mcp.json`, README, LICENSE and shared skill exist; local Claude validator passes. No bundle portal record is evidenced. | Same portal, kind **Plugin bundle**; repository `ANcpLua/qyl.mcp`, plugin path `submission/qyl`, branch `main` or owner-selected tag (**not a commit SHA**). Owner arranges Claude GitHub App access; repository may remain private during validation and must be public to go live per goal step 5. |

## Package verification

On 2026-10-08, the commands in [step-5 evidence](../docs/evidence/2026-10-08-step5.md)
validated `plugin.json` and `mcp.json` against their fetched `$schema` documents,
then checked the ZIP against the source bytes. The root plugin has
`extensions.com.openai`, one server, five positive and three negative cases.
The README contains 269 words outside code blocks. The shared skill remains
identical for both plugin formats.

Build from the repository root with `python3 submission/build-openai-package.py`.
The output `submission/packages/qyl-openai-1.0.0-draft.zip` is ignored by Git;
rebuild and revalidate it after changing packaged files. The recorded hash
belongs to the inspected 2026-10-08 build, not to future source changes.

The OpenAI ZIP excludes `.claude-plugin/` and `.mcp.json` deliberately, so it
uses only the root portable manifests. The Anthropic files stay in `qyl/`.
This chooses the exclusion option in goal step 5; no portal validator ran.
Schema validation does not validate all `com.openai` review requirements.

The existing icon is PNG, 1254 × 1254, 979540 bytes (`sips` and `wc` outputs
in the evidence record). The package has no reviewer credentials or app
bindings. Source author metadata is not proof of a verified publisher.

The separate [Anthropic connector listing draft](anthropic-connector-listing.md)
was checked on 2026-10-08; [commands/output](../docs/evidence/2026-10-08-followup-09.md)
record lengths, source-backed behavior, seven pending acknowledgement slots and
the public documentation check.

## Owner fields still required

| Item | Exact next owner action |
| --- | --- |
| Publisher identity | Choose and verify the intended publisher in the OpenAI portal. The supplied WIP proposes `ancplua`; confirm the permitted public name in the portal. `developerName` is currently omitted. |
| Country targeting | The owner-supplied WIP selects all eligible countries; apply that selection in the portal. `publication.countries` remains omitted as directed. [Dated supplied values](../docs/evidence/2026-10-08-followup-15.md#owner-supplied-wip-values). |
| Website, support, privacy, terms | Recheck the existing `https://qyl.at/` homepage for the final listing; approve and publish the [public-page drafts](public-pages-draft.md). Supply the actual URLs. Then add OpenAI `supportURL`, `privacyPolicyURL`, `termsOfServiceURL` and Anthropic `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`. Missing URLs stay absent. |
| Reviewer account | Provide an isolated populated Collector project and OAuth account that reviewers can use without the owner's mailbox, phone or private network. Enter credentials only in private portal fields. |
| Demo recording | Record the walkthrough below in a working owner client and supply a reviewer-accessible playback URL; only then set `review.demo_recording_url`. |
| Hosted connection and review cases | Run the exact five positive and three negative prompts in `qyl/plugin.json` through the saved owner-client connection. Record actual calls/results and status per case. All eight are **not run** as hosted review cases in this preparation. |
| Legal attestations, submission, publication | Owner reviews and performs these separately. An uploaded draft or a schema-valid ZIP does not establish approval or publication. |

Free use with no purchases is the explicit owner decision in
[goal-objective.md](../goal-objective.md#owner-decisions); no future-commerce commitment is inferred from it. The separate country
decision comes from the supplied WIP, as linked above.

Point 10 was checked on 2026-10-08; [commands and actual output](../docs/evidence/2026-10-08-followup-10.md)
record the Anthropic icon validation and the rebuilt OpenAI ZIP. Apply these
remaining fields only after the owner supplies approved values and publishes
the pages. Placeholder strings are not manifest values.

| Owner-supplied value | Anthropic `.claude-plugin/plugin.json` | OpenAI root `plugin.json` |
| --- | --- | --- |
| Published support URL | `supportUrl` | `extensions.com.openai.interface.supportURL` |
| Published privacy URL | `privacyPolicyUrl` | `extensions.com.openai.interface.privacyPolicyURL` |
| Published terms URL | `termsOfServiceUrl` | `extensions.com.openai.interface.termsOfServiceURL` |
| Verified public publisher name | Owner confirms existing `author` metadata | `extensions.com.openai.interface.developerName` |
| Approved country selection | Owner supplies portal targeting if requested | `extensions.com.openai.publication.countries` |

All five OpenAI fields and the three Anthropic URLs above remain absent, as
verified in the linked evidence. After setting approved values, rerun both
manifest validators and rebuild the ZIP; the current hash cannot cover those
future edits.

## Recording walkthrough for the owner

Use the prompts and expected behavior in `qyl/plugin.json` as the test contract.
Prepare sample traces, sessions, metrics and error logs for the named service
`qyl-mcp-interop-oct7` in the isolated project. Show the plugin version and a
successful OAuth connection, then record trace discovery/detail, filtered error
logs, metric discovery, session discovery and the Trace Explorer. Refresh the
viewer and show that the original query is preserved. Finish with the deletion,
rollback and public-web-search negative prompts, showing the stated limitations.
Keep credentials and unrelated telemetry off screen. Play the recording back,
verify readable results, host it for reviewers and supply the final URL.

This is a recording plan, not a recording or a passed rehearsal.
