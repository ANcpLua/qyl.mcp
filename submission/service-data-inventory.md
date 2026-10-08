# qyl MCP service data inventory

Source-derived input for privacy, support and reviewer-access drafting,
checked **2026-10-08**. This is not a published policy or a production
configuration observation. Commands and actual source output are in
[step-7 evidence](../docs/evidence/2026-10-08-step7.md), including the
[additional inventory excerpts](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source).
Keep this document outside the upload directory `submission/qyl/`.

## Service boundary in source

The public endpoint's unauthenticated challenge and metadata were observed at
`https://mcp.qyl.at/mcp`; see the dated `curl` output in
[step 4](../docs/evidence/2026-10-08-step4.md#endpoint).
**Deployed commit: owner compares the active Railway deployment with
`git rev-parse origin/main` and records date, deployment ID and both commits.**
No release PR or version response substitutes for this observation.

The Auth0 source validates audience, issuer, expiry and `qyl:read` and gates
hosted requests. Collector URL, credential and project are server configuration.
With `MCP_COLLECTOR_PROJECTS`, the verified subject selects a configured project
and credential; without it, the source also supports single-project operation.
No current production mapping or reviewer isolation is established here.
[Configuration and authorization source](../docs/evidence/2026-10-08-step7.md#configuration-and-serving).

Events are optional in authenticated Auth0 mode with `MCP_EVENTS_STORE` and
ongoing authorization-check credentials. The source default poll interval is
30 seconds. This is not evidence that production enables Events or uses that
interval. [Events source](../docs/evidence/2026-10-08-step7.md#events).

## Data flow and persistence in source

| Data | Purpose and handling | Source evidence, 2026-10-08 |
| --- | --- | --- |
| OAuth token and validated claims | Authenticate and authorize a request; Events persist owner subject/client ID, not the subscriber's access or refresh token. Provider/client retention is outside this source observation. | [Authentication](../docs/evidence/2026-10-08-step7.md#deployment-and-authentication), [Events schema](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source). |
| Tool arguments and Collector results | Execute the requested query and return traces, logs, metrics or sessions to the client/viewer. Hosted HTTP with `MCP_PUBLIC_URL` disables the local native store; native record fields exclude arguments, metadata and result bodies. | [Serving](../docs/evidence/2026-10-08-step7.md#configuration-and-serving), [native schema](../docs/evidence/2026-10-08-step7.md#native-records). |
| Events subscription | Persist `id`, `subject`, `clientId`, event name, `arguments` (optional `service_name`), callback URL, current/previous signing secret and rotation expiry, `refreshBefore` and `updatedAt`. No copied Collector telemetry is in this schema. | [Stored subscription schema](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source). |
| Delivery bookkeeping | In-memory seen-trace, verification and in-flight state; delivered events use `cursor: null`. The persisted subscription schema contains no replay queue. | [Delivery and schema](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source). |
| Auth0 management access | Host credentials support ongoing account/grant/consent/permission checks. The checker caches access results in memory; it does not add management tokens to subscription records. | [Authorization checker](../docs/evidence/2026-10-08-step7.md#events). |
| Operational diagnostics | Startup, polling and delivery paths report errors; some delivery diagnostics include event/subscription IDs. This does not establish hosting or edge log retention. | [Serving](../docs/evidence/2026-10-08-step7.md#configuration-and-serving), [delivery excerpts](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source). |

Workbench's optional content capture is separate from the minimized native
incoming-call records. Its source reads `QYL_MCP_CAPTURE_CONTENT`; no live
setting is asserted. [Workbench/telemetry source](../docs/evidence/2026-10-08-step7.md#workbench).

## Recipients and roles

| Destination | Source-derived role and evidence, 2026-10-08 |
| --- | --- |
| Connected MCP client and viewer | Receive the requested Collector data; see [tool inventory](../docs/evidence/2026-10-08-step7.md#package-and-tool-inventory). Telemetry content is input data, not a guarantee that no personal information can occur. |
| Verified callback | Receives signed `trace.error` payloads with trace ID, root-span name, services, span count, duration and start time. HTTPS/public-address checks and redirect rejection are implemented; these do not remove personal data from telemetry names. See [Events](../docs/evidence/2026-10-08-step7.md#events) and [callback excerpts](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source). |
| Configured Collector | Supplies telemetry for tools and polling; underlying storage is separate from the MCP subscription store. See [configuration](../docs/evidence/2026-10-08-step7.md#configuration-and-serving). |
| Auth0 | Configured token issuer and ongoing Events authorization provider in Auth0 mode; see [authentication](../docs/evidence/2026-10-08-step7.md#deployment-and-authentication). |
| Hosting and edge providers | Owner identifies the actually deployed providers, processing roles and retention from current deployment/account settings and records dated output; repository deployment declarations alone do not establish these facts. |

## Retention and deletion in source

The [Events constants and tests](../docs/evidence/2026-10-08-step7.md#events)
set the default subscription TTL to one hour, bounded from five minutes to
24 hours, with ten minutes of prior-key overlap. Expiry pruning removes
expired subscriptions and previous keys. Unsubscribe removes owner-scoped
records and cancels deliveries. Confirmed revocation or callback HTTP 410
removes a subscription; authorization outages pause delivery.
[Lifecycle and atomic-store excerpts](../docs/evidence/2026-10-08-step7.md#inventory-and-allowlist-source)
show these paths and file mode `0600`. Logical removal and file permissions
are not proof of physical erasure, encryption or backup deletion.

| Unobserved production fact | Exact pending owner action |
| --- | --- |
| Collector retention and deletion | Inspect the active Collector retention configuration and deployed implementation, run an approved expiry fixture, and record date, inputs and actual deletion results. |
| Hosting/edge logs and backups | Inspect current provider log-retention and volume-backup settings; record date, service IDs and redacted output, including provider recovery-copy limitations. |
| Events lifecycle in production | Run the subscribe, matching/non-matching delivery, restart, renewal, unsubscribe and revocation procedures in the [owner checklist](../MCP-V2-INTEROP-TODO.md#owner-only-observations-still-pending), retaining actual results. |
| Deletion outside the MCP store | Establish and document how the owner handles Collector data, identity/consent records and copies already returned to clients; removing a subscription alone is not that process. |

## Remaining publisher decisions

**Owner action: verify the publisher identity in the portal**, recording the
date, selected identity and actual verification status. No identity approval
is established by repository author metadata.

The owner must also provide confirmed public support/privacy/terms URLs,
reviewer credentials for an isolated populated project, a demo recording and
any retention/deletion commitments. Inspect the live project mapping before
sharing reviewer access; a new login alone does not prove isolation. Keep
credentials in private reviewer fields. The exact handoff is in
[submission preparation](README.md#owner-fields-still-required).
