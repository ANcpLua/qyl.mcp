# Anthropic connector listing draft

Prepared 2026-10-08 for the separate MCP connector record and revised the same
day for reviewer readability. This is draft text, not a portal record,
attestation or published listing. The sections follow the portal steps in the
[official submission guide](https://claude.com/docs/connectors/building/submission).
[Point-9 evidence](../docs/evidence/2026-10-08-followup-09.md) records how that
guide was retrieved and the field checks of the first draft.

## Connection and tools

| Step | Draft value |
| --- | --- |
| Server URL | https://mcp.qyl.at/mcp |
| Tools | The committed manifest `server/tool-manifest.snapshot.json` lists 11 tools, each with a `title` and `readOnlyHint: true`. `fetch_telemetry` is app-only; the Trace Explorer calls it. |

## Listing

| Field | Draft value |
| --- | --- |
| Name | qyl |
| One-liner | Investigate the traces, logs, metrics, sessions and CI runs in your qyl Collector with read-only tools, a Trace Explorer and an MCP Dashboard. |
| Categories | Developer tools — one proposed category; OWNER FIELD: confirm the matching option offered by the portal. |
| Documentation URL | https://github.com/ANcpLua/qyl.mcp#readme |
| Privacy URL | OWNER FIELD: approve and publish the [privacy draft](public-pages-draft.md), then supply and verify its actual HTTPS URL. |
| Support contact | anfh22@outlook.com — owner-supplied preparation value; OWNER FIELD: confirm monitoring and the final public support route before publication. |
| Icon | [qyl icon](qyl/assets/qyl-icon.png) |
| Slug | qyl — spelling confirmed in the owner-supplied WIP; OWNER FIELD: confirm portal availability before publication. The slug is permanent once published. |

Character counts of this revision: name 3/100, one-liner 142/200,
description 1,295/2,000.

Support contact, slug and documentation URL were supplied/confirmed in the
[owner-provided WIP, read on 2026-10-08](../docs/evidence/2026-10-08-followup-15.md#owner-supplied-wip-values); this does not establish a portal record.

## Description

qyl gives Claude read access to the telemetry your services send to a qyl Collector, so you can investigate a running system from the conversation. List recent traces and sessions, open one trace with its complete span tree, find the error logs that belong to it, discover recorded metric instruments and their attribute streams, and compare a metric over time or across groups. CI pipelines that follow qyl's CI telemetry convention can be inspected run by run, with failed phases first. In clients that display MCP Apps, the Trace Explorer shows a span waterfall with correlated logs, and the MCP Dashboard shows request, error and latency figures for each MCP tool and server.

Every qyl tool only reads data. qyl reports what the Collector returned, including empty results and errors from the Collector; an empty result means nothing matching was recorded, not that the system is healthy. qyl cannot delete or change telemetry, deploy or roll back services, or search the public web. qyl measures and correlates; the agent reasons and acts.

Sign-in uses OAuth with the qyl:read scope, and the qyl server decides which Collector project your account can read. Optional trace-error notifications through MCP Events need a client and deployment that support them and an explicit subscription.

## Use cases

| Portal question | Draft answer |
| --- | --- |
| Primary use cases | Find failing or slow traces and sessions and read the error logs that belong to one trace; discover recorded metrics and compare one over time or across groups; read CI runs that follow qyl's CI telemetry convention, failed phases first; review MCP tool latency and errors in the MCP Dashboard. |
| What users need first | An OAuth account allowed to read a qyl Collector project that holds recorded telemetry. |
| Reads or writes data | Reads only. Every tool is annotated `readOnlyHint: true`. An optional MCP Events subscription stores only its own subscription state and changes no telemetry. |

The description follows the committed tool manifest and the shared
investigation skill. The new trace-projection and configurable CI-prefix
options are deliberately absent: their Collector-lockstep/runtime work
remains open as recorded in
[the refreshed point-8 blocker](../docs/evidence/2026-10-08-followup-15.md#release-blocker-refreshed-after-owner-release).

## MCP App screenshots — owner field

`display_traces` and `display_mcp_dashboard` render MCP App viewers, so the
guide asks for 3–5 PNG carousel screenshots, at least 1000 px wide, cropped to
the app response without the prompt, with each prompt supplied separately.
OWNER FIELD: capture them from the isolated reviewer project. Proposed prompts:

1. "Open the Trace Explorer for my recent traces."
2. "Show my newest failing trace in the Trace Explorer."
3. "Show the MCP Dashboard for the last 24 hours."

## Company, authentication and data handling — owner fields

| Portal step | Draft answer |
| --- | --- |
| Company | OWNER FIELD: company or publisher name and the primary contact for review updates. Proposed website: https://qyl.at/, the existing homepage. |
| Authentication | OAuth: tokens come from qyl's Auth0 tenant `qyl-eu` with the `qyl:read` scope; the repository README documents CIMD and DCR registration. OWNER FIELD: select the registration mode the production tenant allows. |
| Underlying API | qyl's own: every tool calls only the qyl Collector API, in line with the API-ownership rule in AGENTS.md. OWNER FIELD: confirm in the portal. |
| Personal health data | Not a purpose of qyl; telemetry content depends on what users' services send. OWNER FIELD: answer for the intended users. |
| Sponsored content | None; the server returns telemetry and serves no advertising or sponsored content. OWNER FIELD: confirm. |

## Seven acknowledgements — owner fields

These are the seven topic slots from the dated official guide, not accepted
terms or exact portal wording. The owner reads the current wording and decides
each acknowledgement in the portal. Every slot remains unchecked.

| Topic | Owner field |
| --- | --- |
| Directory guidelines | OWNER FIELD: review and personally acknowledge the current directory requirements. |
| First-party API usage | OWNER FIELD: confirm the submitted service's API ownership or authorized proxy basis. |
| Financial transactions | OWNER FIELD: review the relevant restriction and attest to the submitted behavior. |
| AI media generation | OWNER FIELD: review the relevant restriction and attest to the submitted behavior. |
| Prompt injection | OWNER FIELD: inspect the submitted instructions and descriptions before attesting. |
| Conversation data collection | OWNER FIELD: verify actual data processing and attest against the current policy. |
| Public documentation | OWNER FIELD: verify accessible, accurate setup/usage documentation before attesting. |

## Reviewer access — owner fields, private channel only

OWNER FIELD: create an isolated, populated Collector project and a dedicated
reviewer account, seeded with the sample data in the
[recording walkthrough](README.md#recording-walkthrough-for-the-owner). In the
portal's private credential fields, supply the login URL, account identifier,
password or other access mechanism, exact sign-in steps, project/tenant
selection and any required recovery instructions. Verify access without the
owner's mailbox, phone or private network, and maintain it through review. No
credentials belong in this file or the package.

OWNER FIELD: before confirming the Test & launch step, run every tool with
this account through MCP Inspector or as a custom connector in Claude; local
tests do not attest to those hosted checks. Submission and publication remain
owner actions, performed only when authorized.
