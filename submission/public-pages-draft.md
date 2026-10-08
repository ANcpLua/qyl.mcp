# Public support and policy pages — owner draft

Prepared 2026-10-08. Proposed wording only; the owner must approve factual
coverage and publish the pages before their URLs enter either manifest.
No publisher approval, live retention period, existing support route or
country availability is established by this draft. The source basis is the
[step-4 evidence](../docs/evidence/2026-10-08-step4.md) and the tool manifest;
the [step-5 record](../docs/evidence/2026-10-08-step5.md) records the package
inspection command and output. Free use is the owner decision in
[goal-objective.md](../goal-objective.md#owner-decisions).

## Support page: proposed text

qyl helps you inspect traces, logs, recorded metrics and sessions from the
Collector your account is authorized to access. Its current telemetry tools
read data. Optional trace-error notifications have a separate subscription
lifecycle on supporting clients and deployments.

For a technical issue, include the client and version, the operation you
tried, its approximate time and a short description of the result. Use a
small, sanitized reproduction. Do not put passwords, tokens, signing keys or
private telemetry in a public issue.

Account access, privacy and deletion requests should use the private contact
route supplied by the operator. Do not send credentials in a support request.

Before publication, the owner must supply and verify the public technical
support URL and a public contact route for private requests. The owner must
also approve the ownership-verification and request-handling process.

## Privacy page: proposed service description

The hosted qyl MCP service lets an authorized client read Collector telemetry
and, where Events is enabled, request trace-error notifications. Requested
results are returned to the connected client. Telemetry can include service
names, diagnostic messages and attributes supplied to the Collector.

Sign-in and project authorization determine access. A notification subscription
has an owner, event/filter identity, callback address, signing material,
expiration and delivery state. Stopping a subscription does not delete
Collector telemetry or copies already received by a connected client.

Before publication, the owner must confirm the operator/controller and contact,
the actual deployment's data collection and recipients, account and support
retention, Collector retention, infrastructure logs and recovery retention,
and the access/deletion request process. Describe any additional uses or
transfers based on actual operations. Do not infer those declarations from
free pricing, source defaults or a successful local test.

## Hosted-service terms: proposed text

qyl provides authenticated access to recorded telemetry through MCP tools
and viewers. qyl is free to use, with no purchases.

Use only accounts and telemetry you are authorized to access. Protect your
login credentials. Do not attempt to bypass another account's access boundary
or send authentication secrets through tool arguments, telemetry or support
issues.

An empty response means no matching records were returned; it does not prove
an application is healthy. The current telemetry tools cannot delete telemetry,
deploy or roll back software, or search the public internet. Notifications
are optional and depend on the Collector, supporting client and network.
Connected clients have their own settings and applicable terms.

Before publication, the owner must identify the operator and contact, set the
effective date, confirm the wording and supply any additional commitments or
legal particulars. Source-code licensing is not hosted-service terms.

## Owner publication sequence

1. Resolve the missing operational facts and contact details above.
2. Approve support, privacy and terms text and publish it on qyl.at.
3. Inspect the rendered pages anonymously and record date, URL and actual content.
4. Supply the verified URLs for OpenAI `supportURL`, `privacyPolicyURL`,
   `termsOfServiceURL` and Anthropic `supportUrl`, `privacyPolicyUrl`,
   `termsOfServiceUrl`; then rebuild and inspect the package.

This task prepares text only. Publication and attestations remain owner actions.
