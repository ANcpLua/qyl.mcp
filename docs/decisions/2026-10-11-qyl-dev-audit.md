# qyl-dev audit decisions, 2026-10-11

Six read-only auditors (Claude Sonnet, one per qyl-dev repo) reported stale docs, contradictions and design problems on `main` as of 2026-10-11 around 09:40 UTC. This file records the decision taken on every finding. Finding IDs carry the repo prefix: `MCP` qyl.mcp, `QYL` qyl, `SCH` qyl-api-schema, `AT` qyl.at, `SC` Qyl.OpenTelemetry.SemanticConventions, `AI` Qyl.OpenTelemetry.AutoInstrumentation.

Before deciding, eight high-severity findings were re-checked directly: MCP-S1, MCP-S4, MCP-A1, QYL-S3, QYL-C4, SCH-1 (the published 11.5.0 tarball has no `models/metrics.tsp`), SC-5 and AI-S1. All eight are confirmed. The other findings are recorded as the auditors reported them.

## Decision vocabulary

| Decision | Meaning |
|---|---|
| **Fix** | Revision-neutral text, config or local-code change, made in the next sweep with one PR per repo. |
| **Fix with writes** | Changes in the same PR as the first write tool, because it is true until then. |
| **Contract 11.6.0** | Additive qyl-api-schema release. The contract revision changes, so the [release ripple](../../AGENTS.md#release-ripple-across-the-qyl-dev-repos) applies: schema release, then the qyl Collector deployed and serving the revision, then qyl.mcp. |
| **Contract 12.0.0** | Breaking qyl-api-schema cleanup after 11.6.0: removals and reshapes. |
| **Major** | The next breaking major of that package. No `[Obsolete]` aliases. |
| **Investigate** | A fact is unverified. Confirm it first, then apply Fix or Keep. |
| **Keep** | Unchanged, for the reason given. |
| **Owner** | Only the owner can observe or decide it. |

## Write tools

The 11 existing tools stay read-only. Write capability comes as new tools, so a host can approve reads and writes separately, and every write targets objects the user created inside the verified subject's qyl project.

| New tool | Annotations | Collector endpoint (Contract 11.6.0 unless noted) |
|---|---|---|
| `create_annotation`: a note on a trace, span or session, at most 2000 characters | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false` | `POST /api/v1/annotations` |
| `update_annotation` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` | `PATCH /api/v1/annotations/{id}` with `If-Match` |
| `create_saved_query`: a named filter for traces, logs or metrics | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | `POST /api/v1/saved-queries` |
| `update_saved_query` | `destructiveHint: true`, `idempotentHint: true` | `PATCH /api/v1/saved-queries/{id}` with `If-Match` |
| `list_saved_queries`, `run_saved_query` | read-only | `GET /api/v1/saved-queries`, `POST /api/v1/saved-queries/{id}:run` |
| `create_alert_rule`, `update_alert_rule`: a metric threshold or error rate, fired through MCP Events | as the annotation pair | `/api/v1/alert-rules` plus an evaluator in the Collector: **Contract 11.7.0**, after annotations and saved queries |
| `delete`: the one separate delete tool, taking `kind` (`annotation`, `saved_query` or `alert_rule`) and `id` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` | `DELETE /api/v1/{kind}/{id}` with `If-Match` |

Decisions behind the table:
- **No telemetry deletion.** No tool deletes traces, logs or metrics; retention does. qyl.at's terms ("The tools cannot delete telemetry, deploy or roll back software", AT-3) stay true.
- **No subscription tool.** MCP Events subscriptions already live in `server/src/events.ts` and the MCP store, so the contract gets no subscription resource (SCH-24).
- **Annotations are read back inside existing tools.** `get_trace` and `list_sessions` return them, so there is no `list_annotations`.
- **Scopes:** `qyl:write` covers create and update, and `qyl:delete` covers the delete tool. `qyl:read` alone keeps today's surface. This needs Auth0 and protected-resource-metadata changes.
- **Collector credentials:** keys get roles `ingest`, `read`, `write` and `delete` (QYL-A2), so a leaked ingest key can't change or delete anything.
- **Shared write base first (SCH-26):** a `Resource` base (`id`, `created_at`, `updated_at`, `etag`), `Idempotency-Key` on POST, `If-Match` on PATCH and DELETE, `412` and `428` in the error union, `Location` on create, and `@visibility` read/create/update model splits. Storage uses generated DuckDB DDL (the existing Collector gate).
- **Copy changes with the first write tool:** MCP-C1, MCP-S7, AT-2 and AT-4 (server `instructions`, SKILL.md, the OpenAI negative case and `capabilities`, the listing, the READMEs, the threat model, and the qyl.at support, terms and privacy pages with a new effective date).

Order:
1. The Fix sweep.
2. Contract 11.6.0 (read-side pagination and filters, tool models, write base, annotations, saved queries).
3. The Collector implementing and deploying it.
4. qyl.mcp's write tools and copy.
5. Contract 11.7.0 for alert rules.
6. Contract 12.0.0 cleanup.

## qyl.mcp

| ID | Finding | Decision |
|---|---|---|
| MCP-S1 | `server/README.md:3-5`: the npm page advertises "a graph view of agent runs", removed in 4.0.0 | **Fix**: traces, logs, metrics, sessions, CI, Trace Explorer and MCP Dashboard |
| MCP-S2 | `README.md:86`: "The source declares `7.2.3`", which is now published | **Fix** |
| MCP-S3 | `goal-objective.md:73-75`: the releases stop at 7.2.2 | **Fix** |
| MCP-S4 | `goal-objective.md:15-23,280`, `release/README.md:62-64`, `MCP-CHECKPOINT.md:91-97` send agents to `codex/point-10-client-ui-domain`, which is deleted after #136 merged | **Fix**: delete the continuation blocks; work starts from `main` |
| MCP-S5 | `MCP-CHECKPOINT.md:3` and `README.md:6`: the headers are dated 2026-10-08 over 2026-10-11 content | **Fix**: per-section dates |
| MCP-S6 | `README.md:342`: the link text "Contract 11.4.0 evidence" against the 11.5.0 pin | **Fix**: "11.4.0 and 11.5.0" |
| MCP-S7 | "11 read-only tools" in `README.md:92`, `server/README.md:86`, `MCP-CHECKPOINT.md:123`, `QYL-MCP-MATRIX.md:9`, `docs/threat-model.md:9` | **Fix with writes** |
| MCP-S8 | `MCP-V2-INTEROP-TODO.md:723`, `MCP-CHECKPOINT.md:100` record `"node" = "24"` | **Keep**: dated records; today's evidence doc already notes the exact pin |
| MCP-S9 | `server/docs/README.md`: the vendored SDK docs were fetched 2026-08-29 | **Keep**: re-fetch at the next SDK bump |
| MCP-S10 | Present-tense headings over 2026-10-08 data | **Fix**: label them "as of 2026-10-08" |
| MCP-C1 | The rules welcome write tools, but the code, site, skill and listings promise read-only | **Fix with writes** |
| MCP-C2 | Requirements A1-A3 are still missing (trace filters, log time range, six parameter descriptions) | **Contract 11.6.0** |
| MCP-C3 | The MCP never uses `/traces/{id}/spans` or the trace `cursor` | **Keep** for span paging (`/traces/{id}` already returns every span); the `cursor` input lands in **Contract 11.6.0** |
| MCP-C4 | The `QYL_PROJECT` default is stated in only one README | **Fix**: state it once, in `server/README.md`, and link to it |
| MCP-A1 | `server/src/metrics-tools.ts:73,98` hardcode `has_more: false`, so a truncated catalog reads as complete | **Fix** now (server bug); the `cursor` input lands in **Contract 11.6.0** |
| MCP-A2 | `list_traces`, `list_sessions` and `search_logs` drop `hasMore` | **Contract 11.6.0**: `has_more` and `next_cursor` in the output models |
| MCP-A3 | `list_traces` takes only `limit` | **Contract 11.6.0** plus the Collector (QYL-A5): `start_time`, `end_time`, `service_name`, `errors_only`, `cursor` |
| MCP-A4 | `list_sessions` and `search_logs` lack time ranges the Collector already parses, and `session_id` for logs | **Contract 11.6.0** |
| MCP-A5 | The `fetch_telemetry` `view`/`trace_id` dependency is checked only at runtime, and there is no `outputSchema` | **Contract 11.6.0**: a `oneOf` on `view`, plus an output schema |
| MCP-A6 | `attr`, `attr_prefix` and `group_by` are `key=value` strings | **Contract 11.6.0**: structured `[{key, op, value}]` at the tool layer, serialized to the Collector's existing parameters (QYL-A6 keeps them) |
| MCP-A7 | `hours` is a number, and the window is aggregated client-side over at most 1000 traces | **Contract 11.6.0**: integer `hours`; a Collector stats endpoint stays **Keep** until the dashboard needs it |
| MCP-A8 | Every non-Collector failure is "Telemetry request failed." | **Fix**: `structuredContent.error` with a stable `code` and `retryable` |
| MCP-A9 | `severity_min` is a raw OTel number | **Keep**: the description teaches 9, 13 and 17 |
| MCP-A10 | `ci_log` has two modes and hidden caps | **Keep**: the description discloses both |
| MCP-A11 | `idempotentHint: true` on read-only tools | **Keep**: harmless, and set deliberately on the write tools above |

## qyl

| ID | Finding | Decision |
|---|---|---|
| QYL-S1 | `README.md:70`: `qyl-mcp-server` 7.2.2 | **Fix**: 7.2.3. Stays unrendered; the release ripple owns this edge |
| QYL-S2 | `README.md:62` and `eng/build/BuildVerify.cs:738` name `tools/pins.sh`, which doesn't exist | **Fix**: delete both mentions |
| QYL-S3 | `SECURITY.md:23-25`: "the current 3.x line only" on 9.0.0 | **Fix**: "the latest release line" |
| QYL-S4 | `eng/build/Build.cs:102`: "eight-stage proof", while it now has nine stages | **Fix** |
| QYL-S5 | `DECISIONS.md:157`: the dated entry says eight stages | **Keep**: a dated record |
| QYL-S6 | `renovate.json:11` names version 10.0.9 | **Fix**: drop the number |
| QYL-S7 | `nuget-publish.yml:4` and `BuildDependencyEdges.cs:275` cite "architecture §5/§2", which doesn't exist | **Fix**: point at README and AGENTS.md |
| QYL-S8 | README build steps say only the .NET SDK and `dotnet run` | **Fix**: `mise install && mise run check`, and `./eng/build.sh` everywhere |
| QYL-C1 | README says every SDK default is conditional; `Qyl.Sdk.Api.props` sets some unconditionally and can duplicate `--openapi-version` | **Fix**: make the append idempotent and state the exceptions |
| QYL-C2 | Fallout's Versionize `Release` and `Changelog` targets contradict the documented tag-based release | **Fix**: delete the Versionize targets, `VersionizeVersion` and `IVersionize` |
| QYL-C3 | `ci.yml` and `nuget-publish.yml` run raw `dotnet` where Fallout targets exist | **Fix**: route the backend lane and the pack through Fallout targets |
| QYL-C4 | `ci.yml:64`: README- and docs-only PRs skip every lane, including the README render gate | **Fix** (H): `README.md` and `docs/configuration.md` run the backend lane |
| QYL-C5 | The SDK writes a 64-hex revision, while the Collector advertises 16 hex | **Keep**: the 16-hex form is deliberate (`emit-contract-revision.mjs:84`, contract pattern); the SDK hashes a different file in full |
| QYL-C6 | The package README omits `QylOpenApiVersion` | **Fix** |
| QYL-C7 | The README undercounts what `Ci` runs | **Fix**: point at `./eng/build.sh --help` |
| QYL-C8 | `ANcpLua.Roslyn.Utilities` 2.2.47 vs 2.2.46 | **Fix**, done: it was drift; `ANcpLuaRoslynUtilitiesVersion` is 2.2.47 (#661) |
| QYL-A1 | The Collector API has no write surface | **Contract 11.6.0**, see Write tools |
| QYL-A2 | One unscoped key type guards ingest and reads | **Contract 11.6.0**: key roles; renaming `QYL_OTLP_PROJECT_KEYS` is **Major** |
| QYL-A3 | Logs and metrics guess `HasMore = count >= limit` | **Fix** now: `limit+1`; a `next_cursor` lands in **Contract 11.6.0** |
| QYL-A4 | Three cursor schemes, and session traces are unbounded | **Contract 11.6.0**: opaque cursors everywhere, bounded session traces |
| QYL-A5 | Traces can't be filtered server-side | **Contract 11.6.0** |
| QYL-A6 | The string-encoded metric matcher DSL | **Keep** on the wire; MCP-A6 structures it at the tool layer |
| QYL-A7 | Unknown `/api/*` routes return a plain 404 | **Fix**: problem+json under `/api` |
| QYL-A8 | `QylEmitOpenApiDocument=false` makes `AddQylApi` throw at start-up | **Fix**: delete the knob |
| QYL-A9 | `QylSdk*` and `Qyl.Sdk.*` names inside `Qyl.Api.Sdk` | **Major** (Qyl.Api.Sdk 10.0.0): `QylApiSdk*` |
| QYL-A10 | `QylOpenApiVersion` isn't validated | **Fix**: an MSBuild `<Error>` for unknown values |
| QYL-A11 | The first write release changes the revision | **Keep**: planned in the order above |
| QYL-T1 | `RenderReadmeVersions` is documented but unlisted | **Fix**: list it |
| QYL-T2 | `docs/dagger.md` has been "decision pending" since 2026-09-17 | **Fix**: delete it; builds go through Fallout, make and bash |
| QYL-T3 | `mise.toml` floats `node = "24"` | **Fix**: pin 24.21.0, like qyl.mcp and qyl-api-schema; qyl.at too (AT-17) |

## qyl-api-schema

| ID | Finding | Decision |
|---|---|---|
| SCH-1 | The npm `files` list omits `models/metrics.tsp`, which `index.tsp:20` imports. Confirmed in the published 11.5.0 tarball | **Fix**: add it, and make `verify-packed` check the import closure of `index.tsp`. Ships with 11.6.0; the generated TS and C# outputs that qyl and qyl.mcp consume are unaffected |
| SCH-2 | `fallout.yml:6`: a stale pipeline comment | **Fix** |
| SCH-3 | CONTRIBUTING omits the runtime outputs | **Fix** |
| SCH-4 | The README overview lists only traces, logs and metrics | **Fix**: list every surface |
| SCH-5 | The README omits the `./runtime` and `./otel` exports | **Fix** |
| SCH-6 | The OpenAPI `info.version` is always `0.0.0` | **Contract 12.0.0**: investigated; `emit-contract-revision.mjs` hashes `info`, so stamping `info.version` changes the revision |
| SCH-7 | Two overlapping gates (`ci.yml`, `fallout.yml`) | **Keep**, plus one sentence in CONTRIBUTING |
| SCH-8 | The 2026-10-08 evidence cites TypeSpec 1.16 | **Keep**: dated |
| SCH-9 | Five list operations return `CursorPage` without a `cursor` parameter | **Contract 11.6.0** |
| SCH-10 | `@nextLink` on an opaque cursor; `prevCursor` is never served | **Contract 12.0.0**: `@continuationToken`; delete `prevCursor` |
| SCH-11 | Unused pagination, stream and error templates | **Contract 12.0.0**: delete them |
| SCH-12 | The runner API has no `@useAuth` and returns a bare array | **Keep**: qyl's runner API binds loopback and rejects a non-loopback remote endpoint or Host on every request, and checks Origin on mutations (`QylRunnerApi.cs:43,265-272`). The `@doc` sentence from #47 is being corrected to say so in the 11.6.0 draft |
| SCH-13 | `x-otlp-api-key` names the query credential | **Keep** on the wire; roles per QYL-A2 |
| SCH-14 | `ProblemDetails` carries headers inside the body model | **Contract 12.0.0** |
| SCH-15 | Mixed operation-id styles for health | **Keep** |
| SCH-16 | Limits and defaults differ per route | **Contract 12.0.0**: a shared `PageLimit` |
| SCH-17 | The `seal-object-schemas` Zod workaround | **Keep**, plus a test for each `extends` model (Fix) |
| SCH-18 | No models for the 3 metric tools; `bucketMs` is a float | **Contract 11.6.0** |
| SCH-19 | `contract_revision` is required in health | **Keep**: it is the handshake |
| SCH-20 | No stable `code` on `ProblemDetails` | **Contract 12.0.0** |
| SCH-21 to SCH-23 | No annotation, alert-rule or saved-query resources | **Contract 11.6.0** (annotations, saved queries) and **11.7.0** (alert rules) |
| SCH-24 | No subscription resource | **Keep**: MCP Events covers it |
| SCH-25 | No separate destructive scope | **Contract 11.6.0**: `qyl:delete`, `If-Match`, `412`/`428` |
| SCH-26 | No shared write base | **Contract 11.6.0**, first |
| SCH-27 | The write rollout order | **Keep**: the AGENTS.md ripple |

## qyl.at

| ID | Finding | Decision |
|---|---|---|
| AT-1 | `ReleaseTable.astro:9` says every listed version is published and indexed | **Keep**: #31 merges only once every listed package is indexed |
| AT-2 | Eight pages say or imply read-only | **Fix with writes**, with a new legal effective date |
| AT-3 | The terms promise the tools can't delete telemetry, deploy or roll back | **Keep**: those stay true by decision (no telemetry delete tool) |
| AT-4 | The workbench approval rule covers only read-only annotations | **Fix with writes** |
| AT-5 | The site names 10 tools, while the README says 11 | **Keep**: `fetch_telemetry` is app-only; the site states no count |
| AT-6, AT-7 | The qyl and qyl.mcp README versions | Covered by QYL-S1 and MCP-S2 |
| AT-8 | `headline` repeats version literals that a gate re-checks | **Fix**: derive `headline` from `release`; delete check 1 |
| AT-9 | `site.ts:41`: "`npm run check`" | **Fix**: `bun run check` |
| AT-10 | `check-versions.mjs:6`: the example `Qyl.Api.Sdk/4.0.0` | **Fix** |
| AT-11 | The version sweep is count-based and skips README and `public/` | **Fix**: per-anchor matching, and sweep README too |
| AT-12 | Nothing checks that `public/schemas/<SemConv version>` exists | **Fix**: add that check |
| AT-13 | `/support/` and `/terms/` are missing from `tests/routes.ts` and `sitemap.xml` | **Fix** |
| AT-14 | The taxonomy gate bans only `Qyl.Sdk` | **Fix**: also `Qyl.OpenTelemetry.*` package IDs and `SemanticConventions.SourceGeneration` |
| AT-15 | `public/schemas/9.7.0:2` names the `Qyl.OpenTelemetry.SemanticConventions` repository | **Keep**: a repository name, not a package ID |
| AT-16 | "does not require Node.js", then `npx` | **Fix**: "the optional stdio MCP server needs Node.js" |
| AT-17 | The README says Node 24, while `engines` is `>=22.12.0` | **Fix**: pin mise to 24.21.0 (QYL-T3); keep `engines` |
| AT-18 | Retention is stated as 28 and 30 days | **Fix**, done (#35): 30 days is the collector's default `QYL_RETENTION_DAYS`, and 28 days is the Chrome UX Report field aggregate. No "scoreboard" exists |
| AT-19 | "public directory submission is still in preparation" | **Owner** |
| AT-20 | The Wrangler `compatibility_date` is 2026-07-23 | **Keep** |
| AT-21 | The redundant `smoke` script | **Fix**: delete it |

## Qyl.OpenTelemetry.SemanticConventions

| ID | Finding | Decision |
|---|---|---|
| SC-1 | No check that the tag equals `VersionPrefix` and the manifest `schema_url` | **Fix** (H) |
| SC-2 | No check that `qyl.at/schemas/<version>` is served before publishing | **Fix**: `curl -fsS` before the push |
| SC-3, SC-4 | No index wait and no published-package smoke, though `verify-packages.sh` has a nuget.org mode | **Fix**: run `verify-packages.sh "$v" https://api.nuget.org/v3/index.json` before the release job |
| SC-5 | `CHANGELOG.md:5-8` says the tag gate proves the indexed packages, which is false today | **Fix**: becomes true with SC-3/SC-4; reword to "the publish workflow verifies" |
| SC-6 | The README links a missing `CHANGELOG 9.0.0` entry, and the SourceGeneration retirement is recorded nowhere | **Fix**: state the retirement in the README; drop the dead link |
| SC-7 | `nuget-publish.yml` says "CANONICAL — DO NOT EDIT" but carries a local release job with no departure marker | **Fix**: add the `# CANONICAL-DEPARTURE:` marker so a sync keeps SC-1 to SC-4 |
| SC-8 | `workflow_dispatch` interpolates `inputs.version` into the shell | **Fix**: delete `workflow_dispatch`; the tag is the release act |
| SC-9 | The publish passes with zero packages | **Fix**: fail unless exactly 3 |
| SC-10 | The AGENTS.md version source omits `scripts/generate.sh` | **Fix**: name it in this repo's README release section and in the shared ripple table, all six repos in one sweep |
| SC-11 | The comment on "the eight tags" | **Keep** |
| SC-12 | The live-check recipe takes the latest GitHub release | **Fix**: the latest tag |
| SC-13 | QYL0006 is Warning in `AnalyzerReleases.Shipped.md` and Info in code and docs | **Fix**: a "Changed Rules" entry in Unshipped |
| SC-14 | QYL0403 shares the QYL0012 analyzer class | **Keep**, and document the ID gaps |
| SC-15 | The rule docs call the consumer assembly `OpenTelemetry.SemanticConventions` | **Keep**: the `OpenTelemetry.SemanticConventions` category is deliberate and matches the upstream namespace the analyzers target |
| SC-16 | The JQ prelude is copied into every template | **Keep** |
| SC-17 | `jdx/mise-action` runs twice in `ci.yml` | **Fix**: delete the second |
| SC-18 | Weaver is pinned in three places | **Keep**: Renovate keeps them equal |

## Qyl.OpenTelemetry.AutoInstrumentation

| ID | Finding | Decision |
|---|---|---|
| AI-S1, AI-S2, AI-S4 | The README pin tables and prose lag `Directory.Packages.props` (Quartz 4.0.0 vs 4.4.0, and others) | **Fix**: generate them from `Directory.Packages.props` (AI-D1) |
| AI-S3 | `README.md:371` cites the `v9.3.0` registry | **Fix**: v9.7.0 |
| AI-S5 | The ABI example uses `V15` | **Fix**: "X.y pairs with V&lt;X&gt;" |
| AI-S6 | "66-row contract" vs 69 | **Fix**: generated |
| AI-S7, AI-S9, AI-S10 | The contract YAMLs and generator strings describe 14.0.1-era pins, dated `generated_at: 2026-07-19` | **Fix**: regenerate through AI-D1 |
| AI-S8 | `qyl-aot-ownership.yaml` points at missing `docs/` paths | **Fix** |
| AI-S11 | `Qyl.Telemetry.Hosting.csproj:5-8` says Qyl.Sdk stays until unlisted, and cites a missing architecture doc | **Fix**: "retired; deprecated on nuget.org, alternate Qyl.Telemetry.Hosting" |
| AI-A1 | The public `QylSdkOptions` and `QylSdkHostApplicationBuilderExtensions` keep the retired name | **Major** (24.0.0): `QylOptions` and `QylHostApplicationBuilderExtensions` |
| AI-A2 | `EnableSessionPropagation` names a span tag, not propagation | **Major** (24.0.0) rename; document the options in the Hosting README now (Fix) |
| AI-A3 | Four members are in `PublicAPI.Unshipped.txt` after 23.0.0 | **Fix**, done: the four members shipped in 23.1.0 and moved to `PublicAPI.Shipped.txt` (#58) |
| AI-D1 | Pins are copied into five places that drift | **Fix**: a structured `verified` field resolved from `Directory.Packages.props`; `verify-contract-invariants.py` fails on a mismatch |
| AI-T1 | No gate checks doc pins | **Fix**: part of AI-D1 |
| AI-T2 | Thirty per-demo verifiers | **Keep** |
| AI-C1 | The SDK 10.0.401 pins agree | **Keep** |

## Security review, 2026-10-11

| ID | Finding | Decision |
|---|---|---|
| SEC-1 | qyl-api-schema's `release` environment had no branch or tag rule, and its manual publish took any version from any ref | **Fix**, done: the environment allows only `main` and `v*` tags; the main-ancestry guard is qyl-api-schema #50 (`6b81ebd`) |
| SEC-2 | SemanticConventions' (and AutoInstrumentation's) `nuget` environment had no tag rule, so a `v*` tag on any branch could publish | **Fix**, done: both environments allow only `main` and `v*` tags; the main-ancestry guards are SemanticConventions #65 (`30e7d85`) and AutoInstrumentation #66 (open, merges on green) |
| SEC-3 | Absolute local paths in dated qyl.mcp evidence docs and `release/contract.md` | **Keep**: verbatim records. The username is public through the GitHub account and commit author, and git history keeps the old text anyway |
| SEC-4 | qyl.at floated `node = "24"` in jobs that hold `CLOUDFLARE_API_TOKEN` | **Fix**: same as AT-17 (qyl.at #36) |
| SEC-5 | grpc-dotnet decompressed a gzip or deflate OTLP/gRPC message into an unbounded buffer before the API-key interceptor ran, so an unauthenticated gzip bomb could exhaust the Collector's memory. Port 4317 has no TCP proxy in production, so it was not internet-reachable | **Fix**: qyl #670 adds `BoundedDecompressionProvider` through `PostConfigure`, answering `ResourceExhausted` above `MaxReceiveMessageSize`; red-then-green with six tests. Merges on green |

## Found after the sweep, 2026-10-11

Findings made while fixing, with the same vocabulary. Upstream OpenTelemetry rows (SEM, SPEC, OTLP, COL) live in [2026-10-11-upstream-otel.md](2026-10-11-upstream-otel.md).

| ID | Finding | Decision |
|---|---|---|
| QYL-U1 | The Collector drops `jsonrpc.request.id` and `jsonrpc.protocol.version`, which qyl.mcp emits on its own spans, logs and metrics: `jsonrpc.` is not an allowed prefix in `eng/config/collector-semantic-policy.json`, and the deprecated `rpc.jsonrpc.request_id` is renamed into the same dropped key before the check. The drop is reproduced | **Fix**: allow `jsonrpc.` in the Collector policy; it is upstream vocabulary. In the qyl OTLP 1.11.1 PR (branch `feat/otlp-upstream-1.11.1`, with OTLP-1, OTLP-2 HTTP and OTLP-3), in progress |
| QYL-F1 | `tests/Qyl.Cli.Tests/RunnerApiTests.cs:158` (`Runner_is_loopback_only_has_no_wildcard_cors_and_rejects_an_untrusted_host`) fails intermittently on linux-arm64 (run 38145289046 on #667, once on #632, #664's first run) with its own diagnostic "Cross-site POST to port 33567 answered 200; Server: Microsoft-NetCore/2.0; body empty": an `HttpListener` closed the response without a status. Either a runner path that ends a response before writing 403, or a port reused between parallel test runners | **Investigate**, then Fix: reproduce under parallel load with a listener-instance header, fix the runner path or the test's port allocation (branch `fix/runner-api-tests-port-race`, in progress). Not "just a flake" until the listener is named |

## Status, 2026-10-11 16:00 Europe/Vienna

| Repo | Rows closed | PR (merge) |
|---|---|---|
| qyl | QYL-S1, S2, S3, S4, S6, S7, S8, C1, C2, C4, C6, C7, C8, A3, A7, A8, A10, T1, T2, T3; also the CLI's unused OpenTelemetry references and the re-pin to Hosting 23.1.0 / SemanticConventions 9.8.0 | #661 (`0a39e46`); 9.1.0 changelog #663 (`b90a83a4`) |
| qyl | QYL-C3 | #664, in progress |
| qyl.mcp | MCP-S1, S2, S3, S4, S5, S6, S10, C4, A1, A8; workbench's test-only OpenTelemetry references moved to devDependencies | #140 (`455d7a6`); released in 7.3.0 (#141, `e3b697d`); a follow-up error-classification fix in 7.3.1 (#143) |
| qyl-api-schema | SCH-1, 2, 3, 4, 5, 7, 12, 17 (and the SCH-6 result) | #47 |
| qyl.at | AT-8 to AT-14, AT-16, AT-18, AT-21 | #35 |
| qyl.at | AT-17 / SEC-4 | #36 |
| SemanticConventions | SC-1 to SC-9, SC-12, SC-13, SC-17 | #62 (`31a1bef`) |
| AutoInstrumentation | AI-S1 to S11, D1, T1, A3; the Hosting options documented | #58 (`1e51d6a`) |
| all six | SC-10 | qyl #662, qyl.mcp #139, qyl.at #34, qyl-api-schema #46, SemanticConventions #63, AutoInstrumentation #59 |

Still open after this sweep at 16:00: QYL-C3 (#664); every **Contract 11.6.0**, **Contract 12.0.0**, **Major** and **Fix with writes** row (drafts in progress); AT-19 (**Owner**).

## Status, 2026-10-11 17:15 Europe/Vienna

Closed since 16:00:

| Row | PR (merge) |
|---|---|
| QYL-C3 | qyl #664 (`4452058`) |
| SCH-1 | qyl-api-schema #47 (`0649692`); the fixed `files` list ships with 11.6.0 |
| SEC-1, SEC-2 | environment policy, plus the main-ancestry guards qyl-api-schema #50 (`6b81ebd`), SemanticConventions #65 (`30e7d85`), AutoInstrumentation #66 (open, merges on green) |
| MCP-A8 follow-up | 7.3.1 (#143, `26e3944`): transient non-contract answers keep their retryable status code |
| Upstream OpenTelemetry decisions | qyl.mcp #147 (`314a4b3`), corrected by #149 (`bba50e6`) |

In progress:

| Thread | State |
|---|---|
| **Contract 11.6.0** | qyl-api-schema #49 merged (`4f2143c`); `@ancplua/qyl-api-schema` 11.6.0-rc.1 on npm (`next`) and `Qyl.Api.Contracts` 11.6.0-rc.1 on NuGet, revision `sha256:d926c3c6ab829cbf`. qyl.mcp read side: draft #148 (`feat/contract-11.6.0-read-side`): MCP-A2, A3, A4, A5, A6, A7, C3 cursor, SPEC-1; version 7.4.0. Collector: branch `feat/collector-contract-11.6.0` (`bb2f5173`, PR pending), pins the rc and implements QYL-A3, A4, A5. Write tools stack on #148. Merge order: Collector PR → Railway SUCCESS → `api.qyl.at` serves the revision → #148 → the final 11.6.0 as a pin-only bump |
| **Contract 12.0.0** | qyl-api-schema draft #51, revision `sha256:b29439eba28e752b`; qyl.at must serve `https://qyl.at/problems/<name>` (SCH-20) before release |
| AI-A1, AI-A2 (**Major** 24.0.0) | AutoInstrumentation #63: `QylTelemetryOptions` (not `QylOptions`, which collides with qyl's own type), `QylHostApplicationBuilderExtensions`, `EnableSessionTagInheritance`; then v24.0.0 and the qyl re-pin |
| QYL-A9 (**Major** Qyl.Api.Sdk 10.0.0) | qyl draft #666, after 9.1.0 |
| qyl 9.1.0 | tag `v9.1.0` on `705a0321`; publish run 38145741348 in its final job; qyl.at's display and the README row follow the index |
| SEC-5 | qyl #670, merges on green |
| QYL-U1, OTLP-1, OTLP-2 (HTTP), OTLP-3 | qyl branch `feat/otlp-upstream-1.11.1`, PR pending |
| QYL-F1 | qyl branch `fix/runner-api-tests-port-race`, PR pending |

Still open: every **Contract 11.6.0**, **Contract 12.0.0**, **Major** and **Fix with writes** row above (drafts in progress); AT-19 (**Owner**).

