# Anthropic connector listing draft

Prepared 2026-10-08 for the separate MCP connector record. This is draft text,
not a portal record, attestation or published listing. Field checks and source
observations are in [point-9 evidence](../docs/evidence/2026-10-08-followup-09.md).
The [official submission guide](https://claude.com/docs/connectors/building/submission)
was read on that date; the evidence records its retrieval command and checks.

## Public listing fields

| Field | Draft value |
| --- | --- |
| Name | qyl |
| One-liner | Investigate your system through qyl traces, logs, metrics and sessions. |
| Categories | Developer tools — one proposed category; OWNER FIELD: confirm the matching option offered by the portal. |
| Documentation URL | https://github.com/ANcpLua/qyl.mcp#readme |
| Privacy URL | OWNER FIELD: approve and publish the [privacy draft](public-pages-draft.md), then supply and verify its actual HTTPS URL. |
| Support contact | OWNER FIELD: supply the monitored public support address or contact destination. |
| Icon | [qyl icon](qyl/assets/qyl-icon.png) |
| Slug | qyl — proposed; OWNER FIELD: confirm availability and final spelling before publication. |
| Server URL | https://mcp.qyl.at/mcp |

## Description

Investigate traces, logs, metrics, sessions and CI telemetry from your authorized qyl Collector. Find failing or slow traces, inspect spans, correlate error logs, discover recorded metric instruments, and follow session activity. Supported MCP clients can show the Trace Explorer and MCP Dashboard. The telemetry tools read qyl data and report actual empty results or upstream errors. Trace-error notifications require a supporting client and deployment plus an explicit subscription. qyl supplies evidence for diagnosis; code changes and deployment actions stay with the agent's other authorized tools.

## Product evidence and prerequisites

The description follows the committed tool manifest and shared investigation
skill, inspected by the commands in [point-9 evidence](../docs/evidence/2026-10-08-followup-09.md).
The new trace-projection and configurable CI-prefix options are deliberately
absent from this draft: their release/runtime work remains blocked as recorded
in [point 8](../docs/evidence/2026-10-08-followup-08.md).

Users need an OAuth account authorized for the intended Collector project and
recorded telemetry. The owner verifies the actual Claude connection and every
tool using an isolated populated account; local tests do not attest to those
hosted checks. See the [owner handoff](README.md#owner-fields-still-required).

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
reviewer account. In the portal's private credential fields, supply the login
URL, account identifier, password or other access mechanism, exact sign-in
steps, project/tenant selection and any required recovery instructions. Verify
access without the owner's mailbox, phone or private network, and maintain it
through review. No credentials belong in this file or the package.

OWNER FIELD: supply the submitting organization/publisher and review contact,
confirm the OAuth registration choice, perform the hosted client tests, and
complete the directory submission/publication steps only when authorized.
