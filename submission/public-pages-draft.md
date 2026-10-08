# Public support and policy pages — owner draft

Proposed wording for owner review and publication. The owner-requested source
version, inspection date, exact command/output and restoration comparison are
in the [dated restoration evidence](../docs/evidence/2026-10-08-followup-15.md).
Source-derived behavior below describes the implementation, not an observation
of an active deployment. The [service data inventory](service-data-inventory.md)
links each data flow to dated source excerpts. Keep this preparation file
outside the upload directory.

**OWNER FIELD** means an unconfirmed value or operational statement that the
owner must resolve with current evidence before publication. Candidate numbers
from the older draft are prompts to verify, not facts or retention promises.
No publisher approval, legal review, live configuration, support route or
country availability is established by this text.

## Owner fields to resolve

| Item | Required owner value or decision |
| --- | --- |
| Public publisher | **OWNER FIELD:** choose and verify the intended publisher and exact public name in the portal; do not copy the older draft's identity-approval claim. |
| Price and availability | Free use with no purchases is the [owner decision](../goal-objective.md#owner-decisions). **OWNER FIELD:** the supplied WIP selects all platform-eligible countries; apply and confirm the actual portal selection. Supply any additional commercial wording separately; no future-price commitment is inferred. |
| Public technical support | **OWNER FIELD:** the [supplied WIP](../docs/evidence/2026-10-08-followup-15.md#owner-supplied-wip-values) gives public support contact `anfh22@outlook.com`; confirm it is monitored and supply the final support-page URL. An existing issue tracker is not automatically the adopted support route. |
| Private support/privacy contact | **OWNER FIELD:** provide the public contact route for private requests; never derive it from a login email. |
| Operator/controller | **OWNER FIELD:** identify the responsible party and required contact particulars; listing identity alone does not establish data-controller details. |
| Account and support retention | **OWNER FIELD:** state retention and deletion handling for identity accounts, consent/grant records and private support correspondence, with current evidence. |
| Operational retention | **OWNER FIELD:** state the actual hosting, edge, identity, subscription, log, backup and recovery-copy retention and deletion limits; complete the retention fields below. |
| Other uses and recipients | **OWNER FIELD:** disclose actual additional uses, recipients or transfers, if any; do not infer advertising, sale or training declarations from free pricing. |
| Terms choices | **OWNER FIELD:** approve the proposed terms, effective date and any additional commitments or legal particulars. This draft supplies no liability waiver, jurisdiction or service-level guarantee. |

Publish support, privacy and hosted-service terms only after these fields are
resolved. The [manifest handoff](README.md#owner-fields-still-required) specifies
where the owner-approved URLs will go after anonymous content verification.

## Support page: proposed public text

### Get help with qyl

qyl helps inspect traces, logs, recorded metrics and sessions from the Collector
an account is authorized to access. The current telemetry tools read data;
optional trace-error notifications use a separate subscription lifecycle.
[Tool and lifecycle source evidence](service-data-inventory.md).

For a technical issue, include the client and version, the operation attempted,
approximate time and a short description of the result. Use a small, sanitized
reproduction. Do not put passwords, tokens, signing keys, private telemetry or
account identifiers in a public issue.

Account access, privacy and deletion requests should use the private contact
route supplied by the operator. Describe the request without sending
credentials. Stopping a notification subscription is separate from deleting
Collector telemetry, identity records or copies already received by a client.
The current telemetry tools do not perform that deletion.
[Source boundary](service-data-inventory.md#retention-and-deletion-in-source).

**OWNER FIELD — Support handling:** [Supply the public technical-support link,
private contact route, ownership-verification procedure and actual request
handling process. These proposed instructions do not establish that a support
process is already operating.]

## Privacy page: hosted MCP addition

### Hosted qyl MCP service

The service design gives authorized MCP clients access to Collector telemetry
and provides an optional Events subscription lifecycle. The paragraphs below
cover the categories and purposes in that design.
[Source basis](service-data-inventory.md#service-boundary-in-source).

**OWNER FIELD — Deployment scope:** [Confirm the service covered by the final
policy, its actual endpoint (candidate `https://mcp.qyl.at/mcp`), active source
revision, authentication configuration and enabled capabilities. Record the
date, deployment ID, command and actual output; do not infer this scope from a
repository configuration or successful local test.]

**OWNER FIELD — Website scope:** [Confirm which existing website disclosures
remain applicable, including any Core Web Vitals or optional Tluma chat
features, and preserve those disclosures when adding the MCP section.]

### Data processed and purposes

- **Authentication:** the authorization code checks access tokens and issuer,
  audience, expiry, subject, client and permission claims to authorize requests.
- **Project assignment:** in account-mapping mode, the verified subject selects
  the configured Collector project and credential. Tool arguments and request
  metadata do not select another account's credentials.
- **Telemetry queries:** tool arguments select traces, spans, logs, recorded
  metric instruments/series and sessions. Requested results go to the connected
  client and its viewer. Records can include timestamps, service names,
  diagnostic messages and attributes supplied to the Collector.
- **Notifications:** subscription state contains owner/client identifiers,
  event/filter identity, callback address, signing material, expiration and
  delivery/update state. Its source schema does not hold the subscriber's
  OAuth access/refresh token or copied Collector telemetry.
- **Operational diagnostics:** startup, request and delivery failures can
  produce diagnostics, including event/subscription identifiers. Native
  incoming-tool-call records are restricted to operation metadata such as
  tool name, timing, status and error type; they exclude argument values,
  request metadata and result bodies. Optional Workbench content capture is a
  separate configuration surface.

[Data-flow and record source evidence](service-data-inventory.md#data-flow-and-persistence-in-source).
Telemetry can itself contain personal or confidential information. Supply only
data appropriate for the service and the people and clients allowed to read it.

**OWNER FIELD — Live authentication and mapping:** [Confirm the actual identity
provider (the older draft named Auth0), mapping mode, subject/project credential
storage and access-removal process. Do not publish a claim that account mapping
is enabled or reviewer isolation is established without inspecting it.]

**OWNER FIELD — Live diagnostics and capture:** [Inspect actual native-record,
request/response content-capture and hosting-log settings, destinations and
retention. Replace the older draft's claim that capture and the native evidence
file are disabled only after current deployment evidence supports it.]

### Destinations

The implementation returns requested results to the connected MCP client and
viewer, including ChatGPT when chosen by the user. The configured Collector
supplies telemetry for queries and polling. Optional signed notifications go
to the verified callback provided by the subscribing client. Their payload can
contain trace identity, root-span name, service names, span count, duration and
start time. Connected clients and infrastructure providers also have their own
data practices. [Source-derived recipients](service-data-inventory.md#recipients-and-roles).

**OWNER FIELD — Actual providers and recipients:** [Identify the deployed
Collector and its storage, identity provider, MCP/Collector hosting,
subscription storage and edge layer. The older draft named Auth0, Railway and
Cloudflare; confirm or replace each provider and role, including actual
processing regions, transfers and any additional recipients. Do not present
those names as a verified deployment inventory.]

### Notifications

The source provides explicit subscription, callback verification and signed
delivery, renewal, signing-key rotation, expiration and unsubscribe controls.
Subscriptions are scoped to the authenticated owner and project, with an
optional service filter and re-authorization before delivery. Confirmed loss
of authorization stops delivery; an authorization-check outage pauses it.
Removal of a subscription does not delete telemetry or copies already delivered
to a client. [Lifecycle source evidence](service-data-inventory.md#retention-and-deletion-in-source).

**OWNER FIELD — Enabled notification service:** [Confirm that the intended
production deployment and client actually support and enable Events. Run the
[owner lifecycle procedures](../MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending)
and record actual subscription, matching/nonmatching delivery, signature,
renewal, persistence, rotation, unsubscribe and revocation results. Local source
and fixture behavior are not production lifecycle evidence.]

**OWNER FIELD — Notification timing:** [Confirm or replace the older draft's
candidate default of 1 hour and requested range of 5 minutes to 24 hours.
Supply actual renewal, key-overlap, polling and delivery-window values with
dated configuration and test output. No number here is an adopted service
commitment.]

### Retention and controls

The source removes expired or unsubscribed Events records and ends delivery
after confirmed revocation or a callback indicating the subscription is gone.
Refresh extends subscription lifetime. Logical removal from the subscription
store does not demonstrate physical erasure or deletion of backups. Removing a
subscription does not remove Collector data, identity-provider account/consent
records or data already returned to clients; the public telemetry tools do not
delete those records. [Retention and deletion source evidence](service-data-inventory.md#retention-and-deletion-in-source).

**OWNER FIELD — Collector retention:** [Confirm or replace the older draft's
candidate 30 days using the active Collector configuration and an approved
expiry/deletion check. Record cleanup cadence and the limits of logical versus
physical erasure; the candidate value is not an observed deployment setting or
an exact erasure promise.]

**OWNER FIELD — Other retention and controls:** [Supply account, consent,
project-mapping, support-request, operational-log, subscription-store, hosting,
edge, backup and recovery-copy retention and deletion procedures. Identify who
handles access/deletion requests, how ownership is verified, and what remains
with connected clients or providers. Recheck the reviewer-data boundary. Do not
publish unknown retention as zero, never stored or an unsupported maximum.]

## Hosted-service terms: proposed public text

### Purpose and cost

qyl provides access to recorded telemetry through MCP tools and viewers. qyl
is free to use, with no purchases, under the [explicit owner decision](../goal-objective.md#owner-decisions).

### Account and data access

Use only accounts and telemetry you are authorized to access. Protect login
credentials. Do not bypass another account's access boundary or send
authentication secrets through tool arguments, telemetry or support issues.

### What the plugin can do

Telemetry tools read the Collector's actual data. An empty result means no
matching records were returned; it does not prove an application is healthy.
The current tools cannot delete telemetry, deploy or roll back software, or
search the public internet. Notifications are optional and have separate
subscription controls. [Tool and result evidence](../docs/evidence/2026-10-08-step7.md#package-and-tool-inventory).

### Notifications and connected clients

Notification behavior depends on the Collector, subscribing client and network.
Clients may impose their own limits or terms. Data already received by a client
is subject to its own controls. Do not treat a subscription's removal as erasure
of all previously delivered data.

**OWNER FIELD — Final terms:** [Supply the responsible operator, contact and
effective date; approve the final wording and any additional legal particulars
or service commitments. Source-code licensing is not hosted-service terms.]

## Owner publication sequence

- Resolve every owner field with actual operational evidence and approved
  contact details, replacing preparation notes with accurate public text.
- Approve support, privacy and terms; publish them in the existing qyl.at
  layout and preserve other applicable website disclosures.
- Inspect rendered content and links without a private login; record date,
  exact URLs and actual content, not just response status.
- Supply the verified OpenAI and Anthropic support/privacy/terms URLs, then
  rebuild and inspect the package using the [submission handoff](README.md).
  Keep reviewer credentials in private portal fields.

This task prepares wording and owner fields. Publication, attestations and
claims about active operations remain owner actions.
