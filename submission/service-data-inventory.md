# Hosted qyl MCP data inventory

Technical evidence for preparing the public plugin's privacy, support and
reviewer-access material. Checked on 7 October 2026 against the current local
source and selected production settings. This is not a published privacy
policy or a commitment about provider retention. Keep it outside the upload
directory `submission/qyl/`.

## Verified service boundary

- Production MCP is `https://mcp.qyl.at/mcp`, running source `3ae30b52` from
  PR #81. Railway reports deployment
  `cf19d6da-2feb-491a-95d3-9809ad461575` as successful.
- Auth0 validates callers for the qyl MCP audience and `qyl:read`. The server
  authorizes each request. Clients receive telemetry returned by the configured
  Collector through read-only tools and optional viewers.
- The Collector endpoint, API key and optional project header are deployment
  configuration. Production has a Collector credential and no `QYL_PROJECT`
  override. The code does not create a separate Collector/project for each
  Auth0 user. Confirm the Collector credential's actual data scope before
  granting reviewer access; a new login alone does not establish isolation.
- Events are enabled at `/data/mcp-events.json`. Their Auth0 access checker is
  configured. Production uses the default 30-second polling interval.

Sources: [request authorization](../server/src/authorization.ts),
[token verification](../server/src/oauth.ts),
[Collector configuration](../server/src/config.ts),
[hosted startup](../server/src/main.ts), and
[Railway service declaration](../.railway/railway.ts).

## Data used and retained by the MCP service

| Data | Purpose and handling | Persistence established by source |
| --- | --- | --- |
| OAuth access token and claims | Validate issuer, audience, expiry, subject, client ID, token ID and scopes; associate the request with its authorized caller | Request authentication uses the token in memory. Subscriber access/refresh tokens are not fields in the Events store. This does not establish Auth0 or client-side token retention. |
| Tool arguments and returned traces, logs, metrics and sessions | Execute a bounded query against the configured Collector and return its actual result to the connected client/viewer | The public HTTP server disables the local native-execution evidence file. The Events file contains no copy of the Collector's telemetry. Collector storage remains separate. |
| Events subscription | Own, filter, verify, sign, refresh and expire a webhook subscription | The persistent JSON fields are `id`, `subject`, `clientId`, `name`, `arguments`, `url`, `secret`, optional `previousSecret` and `previousSecretUntil`, `refreshBefore`, and `updatedAt`. `arguments` currently contains only the optional `service_name` filter. |
| Events delivery bookkeeping | Suppress already observed trace errors and track in-flight delivery | Seen trace IDs, callback-verification cache and in-flight delivery state are in process memory. The current persisted schema has no replay queue or cursor history; responses use `cursor: null`. |
| Auth0 Management API credential and token | Recheck the subscriber's account, application grant, consent and permission while Events run | Client credentials are supplied by host configuration. The Management API access token and short-lived authorization cache are in memory, not in subscriber records. |
| Operational diagnostics | Report startup/request failures and event authorization, polling or delivery failures | The application writes diagnostics to stdout/stderr. Some event messages include subscription/event IDs. Hosting/edge log retention was not established by this inspection. |

`QYL_MCP_CAPTURE_CONTENT` is absent in the inspected production settings; its
implementation enables request/response content capture only for the explicit
value `1`. This flag and the disabled native-execution file do not establish
that every hosting, edge, identity-provider or client log contains no data.

Sources: [Events schema and lifecycle](../server/src/events.ts),
[atomic JSON persistence](../server/src/atomic-json-store.ts),
[ongoing access checks](../server/src/events-authorization.ts),
[public-host evidence setting](../server/src/main.ts),
[telemetry configuration](../server/src/telemetry.ts), and
[Collector result handling](../server/src/collector.ts).

## Recipients and service roles

| Service or destination | Verified role |
| --- | --- |
| Connected MCP client, including ChatGPT | Receives requested tool results and viewer data. Telemetry fields can contain personal or confidential content supplied to the Collector. |
| Subscription's verified HTTPS callback | Receives signed `trace.error` notifications. The payload includes trace ID, root-span name, service names, span count, duration and start time, plus event metadata. The root-span name and service names are user-supplied telemetry. |
| Configured qyl Collector | Supplies the traces, logs, metrics and sessions requested by tools and Events polling. It owns the underlying telemetry store. |
| Auth0 | Provides the login/token issuer and account/grant/consent/permission checks used for continuing Events authorization. |
| Railway | Hosts the deployed MCP service and its persistent Events volume; the Collector is a separate service. |
| Cloudflare | Provides the public endpoint's edge/security layer. Its separate data practices and retention were not established here. |

Callback verification and delivery reject non-public destinations and redirects
and use HTTPS. This destination check does not remove personal information from
the event payload. The subscribers' callback URLs and signing secrets are not
public listing or review-demo material.

Sources: [event payload](../server/src/events.ts),
[callback verification and signing](../server/src/webhook.ts), and the
[production evidence checklist](../MCP-V2-INTEROP-TODO.md).

## Retention and deletion behavior

- An Events subscription defaults to one hour and accepts a TTL between five
  minutes and 24 hours. Refresh can extend it. Expired records and expired
  prior signing keys are removed during startup/polling and subscription
  updates; the prior signing-key overlap is ten minutes.
- `events/unsubscribe` removes the matching owner-scoped record and aborts
  and waits for its in-flight deliveries. Confirmed loss of authorization or
  callback HTTP 410 also removes the subscription. An unavailable authorization
  service suspends delivery; it does not count as confirmed revocation.
- The Events store is atomically replaced with file mode `0600`. This is
  application-level file access and record removal, not a guarantee about
  encryption, physical erasure or hosting backups.
- The inspected Collector production setting is `QYL_RETENTION_DAYS=30`.
  Its source defaults to hourly retention cycles when no interval override is
  present, as in the inspected settings. Source deletes expired logs, spans and
  metric data in batches and performs a database checkpoint after deletion.
  A live retention cycle, physical erasure, derived-data retention and backup
  retention were not demonstrated in this goal.
- Removing an Events subscription does not delete Collector telemetry,
  Auth0 account/consent records or copies already returned to a client.

Collector sources inspected in the available checkout:
`services/qyl.collector/Retention/RetentionOptions.cs`,
`services/qyl.collector/Retention/RetentionService.cs`, and
`services/qyl.collector.storage/DuckDbStore.Retention.cs`.

## Remaining publisher decisions and evidence

The public policy and support pages still need the verified publishing identity,
a confirmed public contact/support route, account/data-deletion handling,
provider and backup retention, and any additional data uses outside the code
above. Do not infer these from a GitHub username, free pricing or an open-source
license. The individual identity check is currently in review.

Reviewer access needs an explicitly authorized account scoped to sample data.
The existing owner-account rehearsals do not supply that isolation or reviewer
credentials. Confirm that scope before recording or granting external access.
Keep login credentials in the portal's secure reviewer fields, never this file,
the public manifest, a recording or the ZIP.

No public policy URL, retention promise or reviewer-access completion is
established by this technical inventory. The website source and temporary SSH
access decisions already requested from the owner remain pending.
