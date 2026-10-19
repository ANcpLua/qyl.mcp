# Anthropic connector listing draft

Draft for the separate MCP connector record, describing the tool surface of
`qyl-mcp-server` 12.0.0. This is draft text, not a portal record, attestation or
published listing. The sections follow the portal steps in the
[official submission guide](https://claude.com/docs/connectors/building/submission).

## Connection and tools

| Step | Draft value |
| --- | --- |
| Server URL | https://mcp.qyl.at/mcp |
| Tools | The committed manifest `server/tool-manifest.snapshot.json` lists every tool with a `title`: read tools with `readOnlyHint: true`, and write tools for annotations, saved queries and failure status with `readOnlyHint: false` (the update tools and `delete_record` also `destructiveHint: true`). The server also serves the bundled skill through the MCP skills extension; Claude reads it from the plugin bundle. |

## Listing

| Field | Draft value |
| --- | --- |
| Name | qyl |
| One-liner | Investigate the traces, logs, metrics, sessions and CI runs in your qyl Collector, and keep notes and saved queries beside them. |
| Categories | Developer tools — one proposed category; OWNER FIELD: confirm the matching option offered by the portal. |
| Documentation URL | https://qyl.at/docs/mcp/ |
| Privacy URL | https://qyl.at/privacy/ (published; the hosted-service section covers this connector). |
| Support contact | anfh22@outlook.com — owner-supplied preparation value; OWNER FIELD: confirm monitoring and the final public support route before publication. |
| Icon | [qyl icon](qyl/assets/qyl-icon.png) |
| Slug | qyl — spelling confirmed in the owner-supplied WIP; OWNER FIELD: confirm portal availability before publication. The slug is permanent once published. |

Character counts of this revision: name 3/100, one-liner 128/200,
description 1,780/2,000.

Support contact, slug and documentation URL are owner-supplied values; this
does not establish a portal record.

## Description

qyl gives Claude access to the telemetry your services send to a qyl Collector, so you can investigate a running system from the conversation. Ask what changed and qyl ranks new or worsening failures, regressions and releases; it groups recurring errors, reconstructs a failure's path with its logs, compares two groups or two executions, and measures whether a fix held. List recent traces and sessions, open one trace's error path or critical path, find the error logs that belong to it, discover recorded metric instruments and their attribute streams, and compare a metric over time or across groups. CI pipelines that follow qyl's CI telemetry convention can be inspected run by run, with failed phases first, and MCP statistics report request, error and latency figures for each MCP tool and server. When you ask, Claude can leave a note on a trace, span or session, save a named filter to run again later, or mark a failure resolved or ignored.

qyl reports what the Collector returned, including empty results and errors from the Collector; an empty result means nothing matching was recorded, not that the system is healthy. qyl changes only the notes, saved queries and failure status in your project, and deletes only notes and saved queries. qyl cannot delete or change telemetry, deploy or roll back services, or search the public web. qyl measures and correlates; the agent reasons and acts.

Sign-in uses OAuth: qyl:read for reading, qyl:write to create and update notes and saved queries and to set failure status, and qyl:delete to delete notes and saved queries. The qyl server decides which Collector project your account can use. Optional trace-error notifications through MCP Events need a client and deployment that support them and an explicit subscription.

## Use cases

| Portal question | Draft answer |
| --- | --- |
| Primary use cases | Triage what changed, read a failure's context and verify a fix; find failing or slow traces and sessions and read the error logs that belong to one trace; discover recorded metrics and compare one over time or across groups; read CI runs that follow qyl's CI telemetry convention, failed phases first; review MCP tool latency and errors; record findings as notes on traces, spans or sessions, save queries to rerun and set a failure's status. |
| What users need first | An OAuth account allowed to read a qyl Collector project that holds recorded telemetry. |
| Reads or writes data | Both. The read tools are annotated `readOnlyHint: true`. The write tools create, update or delete only annotations, saved queries and failure status in the user's own Collector project, behind the `qyl:write` and `qyl:delete` scopes; none changes or deletes telemetry. An optional MCP Events subscription stores only its own subscription state and changes no telemetry. |

The description follows the committed tool manifest and the shared
investigation skill. It stays at the tool level and does not list the
trace-projection and CI-prefix options.

## Company, authentication and data handling — owner fields

| Portal step | Draft answer |
| --- | --- |
| Company | OWNER FIELD: company or publisher name and the primary contact for review updates. Proposed website: https://qyl.at/, the existing homepage. |
| Authentication | OAuth: tokens come from qyl's Auth0 tenant `qyl-eu` with the `qyl:read` scope, plus `qyl:write` (annotations, saved queries and failure status) and `qyl:delete` (annotations and saved queries) for the write tools; the repository README documents CIMD and DCR registration. OWNER FIELD: select the registration mode the production tenant allows. |
| Underlying API | qyl's own: every tool calls only the qyl Collector API, in line with the API-ownership rule in AGENTS.md. OWNER FIELD: confirm in the portal. |
| Personal health data | Not a purpose of qyl; telemetry content depends on what users' services send. OWNER FIELD: answer for the intended users. |
| Sponsored content | None; the server returns telemetry and serves no advertising or sponsored content. OWNER FIELD: confirm. |

## Seven acknowledgements — owner fields

These are the seven topic slots from the official guide, not accepted
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
reviewer account, seeded with sample traces, sessions, metrics and error
logs. In the portal's private credential fields, supply the login URL, account identifier,
password or other access mechanism, exact sign-in steps, project/tenant
selection and any required recovery instructions. Verify access without the
owner's mailbox, phone or private network, and maintain it through review. No
credentials belong in this file or the package.

OWNER FIELD: before confirming the Test & launch step, run every tool with
this account through MCP Inspector or as a custom connector in Claude; local
tests do not attest to those hosted checks. Submission and publication remain
owner actions, performed only when authorized.
