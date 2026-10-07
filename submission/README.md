# qyl public plugin preparation

`qyl/` is the source of a public-upload draft for the existing qyl MCP service.
It is **incomplete and has not been uploaded or submitted**. Keep the existing
private ChatGPT connection; this draft does not create another private plugin.

The plugin package version starts at 1.0.0. The service it connects to reports
7.1.0; these versions identify different artifacts.

## Prepared

- Portable Agent Plugins 1.0 manifests point to the verified production MCP
  endpoint. Authentication is discovered from its 401/resource metadata.
  No credentials, private app bindings or `.app.json` are included.
- Listing copy, three default prompts, release notes, five positive cases and
  three negative cases are embedded in `qyl/plugin.json`.
- All eleven tools in the current server manifest have explicit boolean
  `readOnlyHint`, `openWorldHint` and `destructiveHint` annotations.
- The owner confirmed availability in all eligible countries, free use and
  no purchases or planned buy-ins. Empty `publication.countries` means no
  publisher-imposed country restriction; platform eligibility still applies.
- Both manifests passed the official portable JSON Schema structure checks;
  their HTTPS URI syntax, supplied OpenAI text limits and review-case counts
  passed separately. Missing submission fields are not waived by those checks.
- `assets/qyl-icon.png` renders the existing three-span waterfall motif for
  the listing and composer: PNG RGB, 1254 × 1254 pixels, 979,540 bytes. Its
  opaque white canvas preserves the mark's contrast on either host theme.

## Finish preparation in order

1. **Confirm publisher identity.** The verified developer identity remains
   unconfirmed; its field is absent. A GitHub owner name is not
   evidence of the selected verified publishing identity. The `ancplua`
   organization page offers **Start** for both individual and business
   verification; the open identity dialog offers **Start ID Check**, without
   showing completed verification. The owner was asked to complete individual
   verification themselves; no identity document was handled by the agent.
2. **Complete the listing pages.** `https://qyl.at/` is an accessible
   product website. The current [privacy page](https://qyl.at/privacy/) covers
   website performance telemetry and its optional chat widget; it does not
   establish the hosted MCP/OAuth/Events policy. The
   [qyl.mcp issue page](https://github.com/ANcpLua/qyl.mcp/issues) currently says
   issue creation is restricted, so it is not accepted here as a working
   support route. A usable support page, applicable published privacy policy
   and terms, and verified publisher details remain to be supplied. Do not
   guess URL paths or substitute the source-code license for service terms.
3. **Run review cases and record the demonstration.** Use a dedicated account
   and sample telemetry. All five positive natural-language cases have been
   rehearsed using the existing owner's production connection: trace lookup,
   metrics and sessions behaved as expected; filtered logs and viewer refresh
   exposed defects that require production rechecking. This does not replace the
   dedicated reviewer run. Earlier explicit tool tests do not prove that the
   remaining prompts select the expected tools. Complete the table below against the
   version to be submitted, then record and verify the actual walkthrough.
   No recording link or reviewer credentials have been supplied.
4. **Finalize and inspect the ZIP.** After the missing fields and evidence are
   ready, archive only `qyl/`, inspect the resulting archive and validate its
   metadata. The preparation notes belong outside the upload. No ZIP is
   presented as submission-ready at this stage.
5. **Complete the portal setup.** Use the intended `ancplua` organization and
   selected verified identity. Upload the finished package, connect the saved
   MCP server, publish its exact domain-challenge token through
   `OPENAI_APPS_CHALLENGE`, scan tools/Events and verify imported metadata.
   Reviewer credentials belong only in the portal's secure fields. The owner
   completes legal attestations; submission for review and publication are
   separate from preparation and connection testing.

## Review execution record

| Case | Status | Evidence needed |
| --- | --- | --- |
| Recent traces and one detail lookup | Owner-account rehearsal passed; reviewer run pending | UI listed ten traces and inspected the newest matching ID with service, duration and error status; raw argument JSON was not inspected |
| Filtered error logs | Owner-account rehearsal found a defect; correction not yet deployed | Service/ERROR query returned unrelated INFO records; repeat after the Collector snake_case query correction and add the MCP regression |
| Metric discovery | Owner-account rehearsal passed; reviewer run pending | UI reports metric catalog lookup, 0 instruments and no more pages; raw arguments were not exposed |
| Recent sessions | Owner-account rehearsal passed; reviewer run pending | UI lists five actual session IDs, ended status, zero recorded errors and trace/span counts |
| Interactive Trace Explorer | Initial display passed; refresh defect found | Ten live traces initially; Refresh broadened to twenty. Local correction preserves the display query, with production recheck pending |
| Reject deletion request | Owner-account rehearsal failed routing requirement; retest pending | ChatGPT correctly declined deletion, but first queried telemetry and opened the viewer. Added shared server instructions to decline unsupported action-only requests without qyl calls; verify after deployment |
| Reject production rollback | Owner-account rehearsal passed; reviewer run pending | Visible response explains that no rollback action exists; no qyl invocation or fabricated deployment |
| Reject public price search | Owner-account rehearsal passed; reviewer run pending | Visible response explains that qyl has no public-search/pricing capability; no qyl invocation or fabricated internet results |

The existing [ChatGPT rehearsal](https://chatgpt.com/c/6ac594cc-4ac8-8332-b3f6-e43418e1a9ce)
is owner-account evidence, not a public reviewer-access link. See
[the current checkpoint](../MCP-CHECKPOINT.md) for the pushed Collector correction
and remaining execution order.

## Demonstration outline

Once the cases pass, record the existing authenticated ChatGPT development
connection with sample telemetry: show the trace list and detail lookup, open
the Trace Explorer, discover metrics (an empty result is valid), and show the
deletion boundary. For Events, show the service filter, receive the controlled
test error, open its exact trace ID, and stop monitoring. Show readable results
and keep credentials and unrelated telemetry out of the recording. A script
or screenshot is not a completed video.

Sources: [OpenAI submission flow](https://developers.openai.com/plugins/deploy/submission),
[portable manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json),
[portable MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json).
