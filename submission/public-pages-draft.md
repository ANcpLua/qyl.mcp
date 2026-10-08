# Public support and policy pages — preparation draft

Draft text only. Statements in this file about deployments, identity
approval, retention or confirmations are not verified evidence; see
"What is not established" in [goal-objective.md](../goal-objective.md).
Reuse the wording, not the claims.

Prepared on 8 October 2026 for qyl's hosted MCP plugin. **Not published, not
submission-ready, and not a statement that legal review is complete.** Keep
this file outside the upload directory. The factual sections come from the
[service data inventory](service-data-inventory.md) and current source; owner
decisions are listed separately rather than replaced with invented promises.

## Confirmed and remaining details

| Item | Current evidence or decision needed |
| --- | --- |
| Public publisher | The `ancplua` upload form selects the approved Individual identity `ALEXANDER ROBERT NACHTMANN`. |
| Price and availability | Free use, no purchases or planned buy-ins, and all platform-eligible countries are confirmed by the owner. |
| Public technical support | Proposed existing route: the public [qyl.at issue tracker](https://github.com/ANcpLua/qyl.at/issues). Its page exposes New issue. Owner adoption as the plugin's support route remains unconfirmed. |
| Private support/privacy contact | An owner-approved public address remains missing. Do not derive it from a login email. |
| Service operator/controller | Confirm the party responsible for hosted data handling and any required contact particulars; a verified listing identity alone does not establish these details. |
| Account and support retention | Confirm when Auth0 accounts, consent records and private support correspondence are removed and who handles deletion requests. |
| Operational retention | Confirm applicable hosting/edge/identity log retention and any provider recovery retention before stating a time limit. The inspected Collector setting is 30 days; that does not establish the retention of every other data category. |
| Other uses | Confirm whether any data uses or recipients exist outside the inspected implementation. Do not infer advertising, sale, training or international-transfer declarations from free pricing. |
| Terms choices | Confirm the proposed service-use terms below and supply any additional operator commitments or applicable legal particulars. No liability waiver, governing jurisdiction or service-level guarantee is invented here. |

The intended website pages are a support page, an extension of the existing
privacy page and hosted-service terms. Their final URLs will be added to the
manifest only after publication and a successful anonymous content check.

## Support page: proposed public text

### Get help with qyl

qyl helps you inspect traces, logs, recorded metrics and sessions from the
Collector your account is authorized to access. Its telemetry tools are
read-only. Optional trace-error notifications have a separate subscription
lifecycle.

For a technical issue, include the client and version, the operation you tried,
the approximate time, and a short description of the result. Use a small,
sanitized reproduction. Do not put passwords, tokens, signing keys, private
telemetry or account identifiers in a public issue.

Account access, privacy and deletion requests should use the private contact
route supplied on this page. Describe the request without sending credentials.
The operator may need to verify ownership before changing access or deleting
account-related records.

Stopping an Events subscription removes that subscription and stops its
delivery. It does not delete Collector telemetry or copies already received
by a connected client. The plugin has no tool for deleting telemetry.

**Before publication:** insert the confirmed technical support link and public
private-contact address. Confirm the ownership-verification procedure; the
paragraph above is a proposed workflow, not evidence it has been implemented.

## Privacy page: hosted MCP addition

### Hosted qyl MCP service

The hosted qyl MCP service at `https://mcp.qyl.at/mcp` lets an authorized client
read Collector telemetry and, in clients that support Events, request
trace-error notifications. This section covers that service. The website's
Core Web Vitals and optional Tluma chat sections remain applicable to their
own features.

### Data processed and purposes

- **Authentication:** access tokens and their issuer, audience, expiry,
  subject, client and permission claims are checked to authorize requests.
  Auth0 supplies sign-in and the account/grant checks used by Events.
- **Project assignment:** the
  operator keeps the account's Auth0 subject, assigned Collector project and
  project credential in the host's secret configuration to restrict which
  telemetry the account can read. This assignment is separate from Events
  subscriptions and remains until the operator changes or removes access.
- **Telemetry queries:** tool arguments select traces, spans, logs, recorded
  metric instruments/series and sessions. Requested results are returned to
  your connected client and its viewer. These records can include timestamps,
  service names, diagnostic messages and attributes supplied to the Collector.
- **Notifications:** a subscription records its owner and client identifiers,
  event name, optional service filter, callback address, signing material,
  expiration and update time. Signing material is used to verify deliveries.
  The subscription file does not store the subscriber's OAuth access or
  refresh token or a copy of the Collector's telemetry.
- **Operational diagnostics:** the service reports startup, request and
  notification failures. Some diagnostics contain subscription/event IDs.
  In the inspected deployment, optional request/response content capture is
  off and the local native-execution evidence file is disabled.

Telemetry can itself contain personal or confidential information. Supply only
data appropriate for the service and the people and clients allowed to read it.

### Destinations

Requested tool results go to the connected MCP client, including ChatGPT when
you use that client. Optional signed events go to the verified callback
provided by the subscribing client. An event contains trace identity,
root-span name, service names, span count, duration and start time.

The configured qyl Collector supplies and stores telemetry. Auth0 handles
authentication and continuing authorization checks. Railway hosts the MCP and
Collector services and the MCP's subscription storage. Cloudflare supplies the
public endpoint's edge layer. Connected clients and infrastructure providers
also have their own applicable data practices.

### Retention and controls

An Events subscription defaults to one hour and can request an expiration
between five minutes and 24 hours. Refresh extends its lifetime. Unsubscribing
removes the matching owner-scoped subscription and stops in-flight deliveries.
Expiration, confirmed loss of authorization or a callback reporting that the
subscription is gone also ends it. A temporary authorization-check failure
suspends delivery while the check cannot be completed.

Collector telemetry retention was configured for 30 days in the inspected
deployment. Cleanup runs periodically; this is not a promise of physical
erasure at an exact time. Removing a subscription does not remove Collector
data, identity-provider account/consent records or data already returned to a
client. The public plugin's tools do not delete those records.

**Before publication:** add the confirmed controller/contact, account and
support-request retention, provider-specific operational retention, deletion
process, and any other applicable disclosures. Recheck deployed settings and
the final reviewer data boundary. Do not publish unknown retention periods as
"zero", "never stored" or an unsupported maximum.

## Hosted-service terms: proposed public text

### Purpose and cost

qyl provides authenticated access to recorded telemetry through MCP tools and
viewers. The qyl plugin is free to use, has no purchases or payment flow, and
does not require buying additional qyl features.

### Account and data access

Use only accounts and telemetry you are authorized to access. Protect your
login credentials. Do not attempt to bypass another account's access boundary
or send authentication secrets through tool arguments, telemetry or support
issues.

### What the plugin can do

Telemetry tools read the Collector's actual data. An empty response means no
matching records were returned; it does not prove an application is healthy.
Tools cannot delete telemetry, deploy or roll back software, or search the
public internet. Notifications are optional and can be stopped through their
subscription controls.

### Notifications and third-party clients

Notifications depend on the Collector, the subscribing client and the network
between them. Clients may impose their own limits or terms. Data sent to a
connected client remains subject to that client's settings and practices.

**Before publication:** identify the service operator and contact, set the
effective date, confirm these proposed terms and supply any additional legal
particulars or commitments. Do not treat source-code licensing as these hosted
service terms.

## Publication checks

1. Resolve the owner decisions above and replace all preparation notes with
   final, accurate public text.
2. Implement the pages in the existing qyl.at layout; preserve the website and
   optional chat disclosures when extending privacy coverage.
3. Review the actual rendered text and links, deploy, then inspect all four
   listing URLs without a private login. Verify their content, not only status.
4. Write the verified URLs into `extensions.com.openai.interface` and rebuild
   and inspect the ZIP. Keep private reviewer access in the secure portal.

Sources: [OpenAI listing and submission fields](https://developers.openai.com/plugins/deploy/submission#automatically-provide-submission-and-review-information),
[plugin privacy requirements](https://developers.openai.com/plugins/plugin-guidelines#privacy),
[current data inventory](service-data-inventory.md), and the existing
[qyl.at privacy page](https://qyl.at/privacy/).
