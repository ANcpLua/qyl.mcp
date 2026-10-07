# Hosted qyl MCP data inventory

Technical evidence for preparing the public plugin's privacy, support and
reviewer-access material. Checked on 7 October 2026 against the current local
source and selected production settings. This is not a published privacy
policy or a commitment about provider retention. Keep it outside the upload
directory `submission/qyl/`.

## Verified service boundary

- Production MCP is `https://mcp.qyl.at/mcp`. Documentation PR #83
  (`7157a08c`) is deployed as `27aefb63-0e09-40ef-96bf-c9ef3ce73f43`;
  its runtime code is unchanged from the verified PR #81 (`3ae30b52`).
- Auth0 validates callers for the qyl MCP audience and `qyl:read`. The server
  authorizes each request. Clients receive telemetry returned by the configured
  Collector through read-only tools and optional viewers.
- The Collector endpoint, API key and optional project header are deployment
  configuration. Production has a Collector credential and no `QYL_PROJECT`
  override. The Collector runs in `ApiKey` mode with one configured project;
  an in-memory comparison confirmed that the MCP credential maps to that
  project. No key values were printed. The Collector derives project scope
  from the credential and rejects conflicting project headers. The MCP code
  does not assign a different Collector credential/project to each Auth0 user.
  A new reviewer login would therefore share the deployment's existing data
  scope; it would not create a sample-only project.
- Events are enabled at `/data/mcp-events.json`. Their Auth0 access checker is
  configured. Production uses the default 30-second polling interval.

Sources: [request authorization](../server/src/authorization.ts),
[token verification](../server/src/oauth.ts),
[Collector configuration](../server/src/config.ts),
[hosted startup](../server/src/main.ts), and
[Railway service declaration](../.railway/railway.ts).

Collector project-scope sources inspected in the available checkout:
`services/qyl.collector/ApiKeys/CollectorApiKeyMiddleware.cs`,
`services/qyl.collector/ApiKeys/AuthenticatedProject.cs`,
`services/qyl.collector/ApiKeys/OtlpApiKeyValidator.cs`, and
`services/qyl.collector/Hosting/CollectorAuthExtensions.cs`.

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
  A live retention cycle, physical erasure and derived-data retention were not
  demonstrated in this goal.
- On 7 October at about 01:50 UTC, the authenticated Railway Backups pages for
  both production services, `qyl-mcp` and `qyl-collector`, displayed
  **No backup schedule** and **No Backups** for their attached volumes.
  This establishes the visible service-volume backup configuration at that
  time. It does not establish provider-internal recovery copies, log retention
  or physical deletion. No backup or schedule was created or changed.
- Removing an Events subscription does not delete Collector telemetry,
  Auth0 account/consent records or copies already returned to a client.
- The production lifecycle test on 7 October observed the same subscription
  survive deployment and renew automatically. Pausing its ChatGPT task removed
  it from the persistent store before expiration. A later controlled error was
  stored in the Collector but produced no notification over more than three
  polling intervals; the Events store stayed empty. This demonstrates logical
  record removal and stopped delivery, not physical erasure. The three
  synthetic test traces remain subject to Collector retention.

Collector sources inspected in the available checkout:
`services/qyl.collector/Retention/RetentionOptions.cs`,
`services/qyl.collector/Retention/RetentionService.cs`, and
`services/qyl.collector.storage/DuckDbStore.Retention.cs`.

## Remaining publisher decisions and evidence

The public policy and support pages still need the verified publishing identity,
a confirmed public contact/support route, account/data-deletion handling,
provider retention, and any additional data uses outside the code
above. Do not infer these from a GitHub username, free pricing or an open-source
license. The individual identity check is currently in review.

Reviewer access needs an explicitly authorized account scoped to sample data.
The existing owner-account rehearsals do not supply that isolation or reviewer
credentials. Confirm that scope before recording or granting external access.
Keep login credentials in the portal's secure reviewer fields, never this file,
the public manifest, a recording or the ZIP.

No public policy URL, retention promise or reviewer-access completion is
established by this technical inventory. Current website source files are now
available locally through the approved GitHub file API; confirmation of a
public/private support route remains pending. The existing Railway browser
console supplied the needed inspection access without a new SSH key.
