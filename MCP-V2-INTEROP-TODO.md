# qyl.mcp evidence ledger

Reset on 8 October 2026. An entry counts only with a date, the exact command
or client and version, and the actual output or observation. Unobserved states carry the exact pending owner action. Nothing in this file is inferred from another row,
from a passing unit test or from a successful initialize. Requirements and
the work order are in [goal-objective.md](goal-objective.md).

## Repository facts — source inspected 2026-10-08

Commands and actual source output are in [step-7 evidence](docs/evidence/2026-10-08-step7.md).
This table describes source, not a deployed or portal-observed state.

| Item | Dated command/output evidence |
| --- | --- |
| SDK v2 split packages, no SDK-v1 dependency | Package-inventory command outputs core/server 2.3.1; `bun run verify:sdk` outputs `MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).` |
| HTTP factory and stdio factory | Serving-source commands output `createHostedHandler` using a server factory and `serveStdio(serverFactory, ...)`; package tests cover both eras. |
| 11 tools, all read-only | Package/tool inventory outputs all 11 names and `readOnlyHint: true`, `destructiveHint: false`. |
| App-only fetch | Same inventory outputs `fetch_telemetry` visibility `["app"]`. |
| Trace-error Events | Events-source command outputs `TRACE_ERROR_EVENT_NAME = "trace.error"` and subscription/list handlers; local test evidence is separate below. |
| Account/project scoping | Configuration-source command outputs verified-subject lookup in `collectorAccessForSubject`; arguments and metadata are not selectors. |
| Minimized native records | Native-source command outputs strict `NativeExecutionRecordSchema` with ID, tool name, status, timing and error type only; regression tests are recorded below. |
| OpenAI draft | Step-5 validation outputs PASS for `plugin.json` and `mcp.json`; no portal result follows. |
| Anthropic bundle and shared skill | Step-5 inventory outputs each required file `present`; README 269 words; Claude local validator passes. |

## Local checks — fresh run, 2026-10-08

Exact commands, timestamps, exit codes and actual output are in the
[step-4 transcript](docs/evidence/2026-10-08-step4.md). Tests use explicit
local fixtures; these results do not establish production or owner-client behavior.

| Check | Command | Result / dated output |
| --- | --- | --- |
| Build | `bun run build` | 2026-10-08, exit 0; Vite bundle-size warning retained in transcript. |
| Tests | `bun run test` | 2026-10-08, exit 0; server 159, workbench 142, dashboard 32, site 4 passed; 337 total, 0 failures. |
| Transport | `bun run smoke` | 2026-10-08, exit 0; `all checks passed`, stock legacy negotiation and workbench reconnect recorded. |
| Collector contracts | `bun run smoke:otlp` | 2026-10-08, initial exit 1: `live search_logs did not honor its combined filters`; four logs returned from the existing separate qyl checkout. Fresh-main fixture rerun: exit 0; `ok generated API-key auth and Qyl schemas validate live telemetry reads`. See the dated command below. |
| Project isolation | `bun run smoke:projects` | 2026-10-08, exit 0; both eras and Events signatures/unsubscribe/revocation pass with local identities. |
| SDK boundary | `bun run verify:sdk` | 2026-10-08, exit 0; 5 tests pass, `MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).` |
| Lint | `bun run lint` | 2026-10-08, exit 0; `$ oxlint .`. |
| Static v1 drift | `node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/check_v2.mjs /Users/alexandernachtmann/RiderProjects/qyl.mcp/server` | 2026-10-08, exit 1; `31 error(s), 0 warning(s) in 146 file(s)`. All findings retained in transcript, including generated `dist-test` findings. No suppression added. |
| Both-era black box, after `bun run --cwd server build` | `node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/verify_server.mjs --cwd /Users/alexandernachtmann/RiderProjects/qyl.mcp/server -- sh -c 'QYL_DEMO=1 exec node dist/main.js --stdio'` | 2026-10-08, exit 0; GREEN modern-era tools/list (11), GREEN legacy-era tools/list (11), GREEN tool-schema portability. Inspector 2.9.0 explicitly pins modern and legacy. |

Fresh Collector rerun on 2026-10-08:

```sh
QYL_MCP_TELEMETRY=0 QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-step4-evidence/native-fresh.json QYL_COLLECTOR_PROJECT=/private/tmp/qyl-step4-collector/services/qyl.collector/qyl.collector.csproj bun run smoke:otlp
```

Output includes `ok live MCP log filters exclude unrelated services, severities,
traces and bodies`, `ok live MCP log searches preserve empty results and the
requested limit`, and `ok generated API-key auth and Qyl schemas validate live telemetry reads`; exit 0.
The [transcript](docs/evidence/2026-10-08-step4.md#collector-fixture-provenance)
records the original Collector branch/commit and the separate fresh `main`
fixture at `d1de0c953d469edf8d9ef4168dc6fb5c0f016dfd`. No production inference
follows from either local run.

Static checker output retained: 25 `TS-ZOD-ROOT`, 2 `TS-RAW-SHAPE`,
2 `TS-STDOUT-LOG`, and 2 `TS-PUSH-REQUEST` occurrences, including compiled
duplicates. All 31 error-severity diagnostics remain in the transcript;
the assessments below explain their concrete paths without changing the
checker, suppressing findings or changing code.

### Static findings — assessed, 2026-10-08

Commands below ran from the repository root against this PR's unchanged
runtime source and installed SDK 2.3.1. Output excerpts are literal; the
assessment is the interpretation of that output, not a changed checker result.

| Rule | Assessment | Command | Actual output excerpt |
| --- | --- | --- | --- |
| `TS-STDOUT-LOG` | **assessed**: `server/src/main.ts:414` is the HTTP-start banner inside `createHostedRuntime`, not the stdio path. `bootstrap` returns after `startStdioServer` for `--stdio`. | `sed -n '372,425p' server/src/main.ts`; `sed -n '453,490p' server/src/main.ts` | `async function createHostedRuntime(`; `console.log(` followed by the template string `MCP server serving ${endpoint}`; `if (transport === "stdio") {` / `startStdioServer(() => createServer({ transport: "stdio" }));` / `return undefined;` |
| `TS-PUSH-REQUEST` | **assessed**: `server/src/request-scope.ts:94` calls the deprecated logging notification. SDK 2.3.1 filters it on the modern path using the request's `logLevel`; absent threshold returns without delivery, and messages below the threshold are filtered. This is not an elicitation or sampling request. | `sed -n '90,96p' server/src/request-scope.ts`; `sed -n '2216,2230p' server/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`; `sed -n '1083,1100p' server/node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs` | `await ctx.mcpReq.log(level, { tool, ...data }, LOGGER);`; `@deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).`; `threshold = ctx.mcpReq.envelope?.[LOG_LEVEL_META_KEY];`; `if (threshold === void 0) return Promise.resolve();`; `method: "notifications/message",` |
| `TS-RAW-SHAPE` | **assessed**: `server/src/events.ts:77` is the JSON Schema of the `events/list` definition, not a raw Zod tool-registration shape. | `sed -n '70,89p' server/src/events.ts`; `sed -n '330,332p' server/src/events.ts` | `export const TRACE_ERROR_EVENT = {`; `inputSchema: {` / `type: "object",` / `properties: {`; `return { events: [TRACE_ERROR_EVENT] };` |
| `TS-ZOD-ROOT` | **assessed**: the root imports resolve to installed Zod 4.6.5 in this repository; the diagnostic's Zod-3 condition is not the installed dependency state. Generated duplicates refer to the same imports. | `node -p "require('./server/node_modules/zod/package.json').version"`; `node -p "require('./server/package.json').dependencies.zod"` | `4.6.5` from each command. |

The SDK package-version command
`node -p "require('./server/node_modules/@modelcontextprotocol/server/package.json').version"`
returned `2.3.1` on 2026-10-08. These are source/dependency assessments;
the separate both-era test remains the recorded runtime evidence.

### Step 1 — rules and native call records

Local run on 2026-10-08 UTC, branch `codex/review-invariants`, based on
`8c658fd62b413ae682bea256002f83f18d5ade6a` (`git rev-parse HEAD` immediately
after `git rebase --autostash origin/main`). These are local results; they
do not establish CI, deployment or a real hosted client connection.

`bun run test` produced these regression-test results:

```text
✔ native tools/call records operation metadata and keeps payloads out of telemetry
✔ native evidence records validation failure without persisting results of any size
✔ native telemetry reports terminal evidence persistence failures
✔ file native repository persists only operation metadata for successful and failed calls
✔ version-1 state loses payloads before it is read or written again
✔ version-2 state loses payloads before it is read or written again
```

The file-backed test sends ordinary private text through arguments, metadata,
text and structured results on success and failure. It verifies that the
client receives its result, that the serialized file excludes the text and
payload fields, that reopening preserves the metadata, and that an attempted
write containing `arguments` and `_meta` is rejected without changing the file.
Native OTLP inputs likewise omit request/response bodies and client request IDs;
only `traceparent` is passed to OpenTelemetry's parser for trace correlation.

The schema is version 3. Valid version-1/2 files are projected to operation
metadata and replaced atomically without a payload-bearing backup. Unreadable
files retain the existing archive recovery behavior; old recovery archives
are not purged by this change.

`bun run smoke` also produced:

```text
ok native tool execution evidence is automatic and terminal
ok native records contain only operation metadata
ok stock client negotiated the legacy era
ok legacy catalog has all 11 tools
ok legacy read tool returns real demo metrics
ok in-process tools/call recording is native and automatic
```

The native-store assertions in both smoke scripts now require the new metadata
shape. This intentionally replaces their former requirement to retain result
bodies and protocol messages, matching the owner's revised storage requirement.
Workbench's own execution-result checks remain in place.

CI evidence, 2026-10-08 UTC, for code commit
`2ad06673b5bcdebf1097be5f4b75e9cd039b86f2` in
[PR #91](https://github.com/ANcpLua/qyl.mcp/pull/91):

- `gh run view 37713013285 --repo ANcpLua/qyl.mcp --json status,conclusion`
  returned `{"conclusion":"success","status":"completed"}`.
- `gh run view 37713013285 --repo ANcpLua/qyl.mcp --log --job 113103037324`
  records `bun run verify:sdk`, the combined build/tests/smokes, and these
  real-Collector outputs:

```text
ok OTel operation logs carry the matching trace and span identifiers
ok real OTLP traces, logs and metrics stored under two separate project credentials
ok 2026-07-28: all 11 tools and viewer paths isolate concurrent accounts; foreign trace IDs and unassigned accounts denied
ok 2025-11-25: all 11 tools and viewer paths isolate concurrent accounts; foreign trace IDs and unassigned accounts denied
ok Events: same trace ID stays project-scoped; signatures, unsubscribe and assignment revocation pass
all real-Collector project-isolation checks passed (local test identities; hosted reviewer login still required)
```

A subsequent compatibility correction delegates `traceparent` parsing entirely
to OpenTelemetry instead of accepting only the version-00 spelling. On
2026-10-08 UTC, `./node_modules/.bin/tsc -p server/tsconfig.test.json` followed by
`QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-step1-native.json QYL_MCP_TELEMETRY=0 node --test server/dist-test/native-execution.test.js`
returned `tests 10`, `pass 10`, `fail 0`, including a version-01 traceparent
fixture. The CI evidence above belongs to the stated commit; the PR must pass
CI and review again after this correction. No production or hosted-client
claim follows from these fixture runs.

For corrected code commit `5c835be4dfb0a873be39bd9b8e76318739ce0999`, checked
on 2026-10-08 UTC:

```text
$ gh run view 37713263607 --repo ANcpLua/qyl.mcp --json status,conclusion --jq '{status,conclusion}'
{"conclusion":"success","status":"completed"}
```

This is the complete CI workflow, including lint, the SDK check, build, tests,
transport smoke, live OTLP and project-isolation smoke. Later checkpoint edits
do not change that runtime code. Codex's first review reported the version-00
traceparent restriction; the correction above removes it. A new code review
was requested with `gh pr comment 91 --repo ANcpLua/qyl.mcp --body-file /private/tmp/qyl-step1-review-request.md`
on 2026-10-08 UTC, returning
<https://github.com/ANcpLua/qyl.mcp/pull/91#issuecomment-6050323909>.

### Step 2 — tool descriptions

Local evidence, 2026-10-08, branch `codex/step2-tool-descriptions`, compared
with base `9e2476b` (`origin/main` when run). These commands establish local
source and manifest results only.

| Command | Actual output / result |
| --- | --- |
| `bun run --cwd server snapshot:tools` | Exit 0; `wrote /Users/alexandernachtmann/RiderProjects/qyl.mcp/server/tool-manifest.snapshot.json` (includes server build and test compilation). |
| `QYL_MCP_TELEMETRY=0 node --test server/dist-test/tool-manifest.test.js` | `✔ the published tool manifest matches its committed snapshot`; `tests 1`, `pass 1`, `fail 0`. |
| `bun run verify:sdk` | `tests 5`, `pass 5`, `fail 0`; `MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).` |
| `bun run lint` | `$ oxlint .`; exit 0. |
| `git diff --check` | No output; exit 0. |
| `git diff -- server/src server/tool-manifest.snapshot.json` | Review: all 11 descriptions name the function and user need; `get_trace` states full-tree size and alternatives; `ci_log` states emitter convention and 50-session/100-trace limits; `query_metric` states one number per series. No handler, schema, title, annotation or visibility edits. |

Manifest comparison command, run on 2026-10-08:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const before = JSON.parse(execFileSync('git', ['show', '9e2476b:server/tool-manifest.snapshot.json']));
const after = JSON.parse(readFileSync('server/tool-manifest.snapshot.json'));
const strip = m => ({ ...m, tools: m.tools.map(({ description, ...rest }) => rest) });
assert.deepEqual(strip(after), strip(before));
assert.equal(after.tools.filter((t, i) => t.description !== before.tools[i].description).length, 11);
console.log('PASS: 11 descriptions changed; all other manifest fields unchanged');
JS
```

Output:

```text
PASS: 11 descriptions changed; all other manifest fields unchanged
```

### Step 3 — agent skill

Source and local validation evidence, 2026-10-08, branch
`codex/step3-agent-skill`, based on merged step 2 at `84cad49`.
The workflow below is supported by the manifest descriptions: sessions and
traces, full trace then correlated error logs, metric discovery/series/query,
MCP dashboard, CI convention/limits and trace visualization. Empty results
report missing matching data; they do not prove system health. Events are an
opt-in workflow for clients and deployments exposing the extension, not a
claim of production delivery.

Command:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; const {tools}=JSON.parse(readFileSync("server/tool-manifest.snapshot.json")); for(const t of tools) console.log(t.name+": "+t.description); console.log("all_read_only="+tools.every(t=>t.annotations.readOnlyHint===true));'
```

Actual output:

```text
ci_log: Read CI telemetry from qyl when the user wants recent runs or a per-leg phase breakdown with failures first. Any CI can emit this convention: resource service.name starts with 'qyl-ci', session.id identifies the run, and one span per phase carries a ci.leg attribute; failed phases set span status to error. Without run_id, filters the 50 most recent sessions and returns up to limit matching runs (default 10). With run_id, reads up to 100 traces for that session; phase output can be large.
display_mcp_dashboard: Show an aggregate dashboard of MCP traffic (spans carrying an `mcp.method.name` attribute): request/error timeline, per-server and per-transport breakdowns, and per-tool latency and error rates. Useful when the user wants to inspect MCP usage or tool health over a time window.
display_traces: Show qyl traces in the interactive trace explorer with a span waterfall, detail panel, and correlated logs when the user wants to see the trace waterfall. A trace_id opens one trace, a session_id shows that session's traces, and neither shows recent traces.
fetch_telemetry: Fetch traces, a single trace, or logs for the trace explorer UI when the user refreshes the view or changes its filters.
get_metric_series: List the distinct attribute streams recorded under one metric name, with each stream's attributes, service, and first/last seen. Useful when the user wants to discover group_by keys or attr filters for query_metric before choosing the groups in a range query.
get_trace: Fetch a single qyl trace by trace_id when the user wants its complete span data, including timing, attributes, events, and status. The full span tree is returned and can be large. For large traces, display_traces provides the visual waterfall and search_logs provides filtered, correlated logs.
list_metrics: List the metric instruments recorded for this project: name, kind (gauge/sum/histogram), unit, how many attribute streams exist under each name, and when it was last written. Useful when the user wants to discover instrument names before querying a metric by its exact name.
list_sessions: List qyl sessions when the user wants to find active or failing sessions, with trace/span/error counts, state, and GenAI token usage where present. display_traces accepts a session_id to show that session's traces in the explorer.
list_traces: List recent qyl traces when the user wants a compact overview of activity and failures: root span, services, duration, span count, and error flag. Spans are omitted; get_trace returns the full span tree, while display_traces provides the interactive explorer.
query_metric: Run a time-bucketed range query when the user wants to compare a metric over time or across groups: a window (start_time, end_time), a bucket width (step_ms), a reducer (aggregation: avg, min, max, sum, count, last, p50, p90, p95, p99), optional group_by attribute keys, and optional attr/attr_prefix matchers written 'key=value'. Returns one stream per grouping with its buckets. With step_ms equal to the window duration, each grouping yields one bucket: one number per series.
search_logs: Search qyl log records when the user wants error details or logs correlated with a trace. Filters include trace_id, service_name, minimum severity (OTel numbers: 9 INFO, 13 WARN, 17 ERROR), and a body substring query.
all_read_only=true

```

Events and empty-result source command:

```sh
rg -n 'TRACE_ERROR_EVENT_NAME|No .*found|No .*record|No .*match' server/src/events.ts server/src/summaries.ts
```

Actual output:

```text
server/src/summaries.ts:133:  if (logs.length === 0) return `No logs matched${modeNote(mode)}.`;
server/src/summaries.ts:182:  if (metrics.length === 0) return `No metrics recorded (${mode} mode).`;
server/src/summaries.ts:192:  if (series.length === 0) return `No series match those attributes (${mode} mode).`;
server/src/summaries.ts:215:  if (result.series.length === 0) return `${header}\nNo matching series.`;
server/src/events.ts:46:export const TRACE_ERROR_EVENT_NAME = "trace.error";
server/src/events.ts:72:  name: TRACE_ERROR_EVENT_NAME,
server/src/events.ts:143:  name: z.literal(TRACE_ERROR_EVENT_NAME),
server/src/events.ts:223:  if (name !== TRACE_ERROR_EVENT_NAME) throw invalidParams(`unknown event "${name}"`);
server/src/events.ts:383:        name: TRACE_ERROR_EVENT_NAME,

```

`sed -n '65,90p' server/src/events.ts` returned an Events definition with
`service_name` as an optional string property, `delivery: ["webhook"]` and
`Only traces that involve this service.` The subscription instruction requires
the user's notification request; it does not authorize owner-client testing.

Validation on 2026-10-08:

- Initial `python3 /Users/alexandernachtmann/.codex/skills/.system/skill-creator/scripts/quick_validate.py submission/qyl/skills/qyl-investigate`
  returned `ModuleNotFoundError: No module named 'yaml'`. The bundled Python
  had the same missing dependency.
- `python3 -m venv /private/tmp/qyl-skill-validation-20261008` returned exit 0;
  `/private/tmp/qyl-skill-validation-20261008/bin/python -m pip install PyYAML==6.0.3`
  returned `Successfully installed PyYAML-6.0.3`.
- `/private/tmp/qyl-skill-validation-20261008/bin/python /Users/alexandernachtmann/.codex/skills/.system/skill-creator/scripts/quick_validate.py submission/qyl/skills/qyl-investigate`
  returned `Skill is valid!`.
- `bun run lint` returned `$ oxlint .`, exit 0.
- `git diff --check` returned no output, exit 0.

Owner-review correction, 2026-10-08:
`gh pr view 94 --repo ANcpLua/qyl.mcp --json comments` returned
[the owner's two requested changes](https://github.com/ANcpLua/qyl.mcp/pull/94#issuecomment-6051328564):
remove the skill's internal Evidence section and restore the explicit
limitations for deletion, deployment, rollback and web search. The revised
skill keeps evidence here and names those limitations next to the authorized
connector guidance. After the edit, the same temporary-environment
`quick_validate.py` command above returned `Skill is valid!`;
`git diff --check` returned no output (exit 0).

## Step 4 — production HTTP and package observations

2026-10-08, exact response headers/bodies and command start times are in the
[step-4 transcript](docs/evidence/2026-10-08-step4.md#endpoint).

| Observation | Command | Actual output |
| --- | --- | --- |
| Unauthenticated MCP | `curl --silent --show-error --include https://mcp.qyl.at/mcp` | `HTTP/2 401`; `www-authenticate: Bearer scope="qyl:read", resource_metadata="https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp"`; `{"error":"unauthorized"}`. |
| Resource metadata | `curl --silent --show-error --include https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp` | `HTTP/2 200`; `{"resource":"https://mcp.qyl.at/mcp","authorization_servers":["https://qyl-eu.eu.auth0.com/"],"scopes_supported":["qyl:read"]}`. |
| npm latest | `npm view qyl-mcp-server version` | `7.1.1`. This is a registry observation, not evidence of publishing or a consumer test. |

## Owner-only observations still pending

Recorded 2026-10-08 from the work boundary in `goal-objective.md`, steps 4–6.
The actions below are instructions, not claims that any portal or client was
opened. For every run, save the date, exact client version, registration path
(pre-registered/CIMD/DCR), granted scopes, negotiated protocol, tool name and
redacted actual output. Never record tokens, cookies or callback signing keys.

| Observation | Exact owner action |
| --- | --- |
| ChatGPT web connection | In the owner's ChatGPT workspace, add `https://mcp.qyl.at/mcp` as a custom connector, complete OAuth for an isolated reviewer account with `qyl:read`, record discovery, call `list_traces` with `limit: 1`, and retain its actual result plus the fields above. |
| Codex plugin/CLI connection | In the owner's chosen Codex client, record its version, configure the remote MCP URL `https://mcp.qyl.at/mcp`, complete OAuth, record discovery and call `list_traces` with `limit: 1`; retain the actual result and negotiated protocol. |
| claude.ai connection | In the owner's Claude connector settings, add the same endpoint, complete OAuth with the isolated reviewer account, record discovery and a `list_traces` call with `limit: 1` plus the fields above. |
| Claude Code connection | In the owner's Claude Code client, record its version, add the endpoint as a Streamable HTTP MCP server, complete OAuth, record discovery and a `list_traces` call with `limit: 1` plus the fields above. |
| Production modern-era proof / MCP Inspector | Save an Inspector config with `{"mcpServers":{"qyl":{"type":"streamable-http","url":"https://mcp.qyl.at/mcp","protocolEra":"modern"}}}`. Run `npx -y @modelcontextprotocol/inspector@2.9.0 --config inspector-modern.json`, log in through OAuth, run `tools/list`, and retain its output and the captured request header `MCP-Protocol-Version: 2026-07-28`. Also run `list_traces` with `limit: 1`. |
| Production legacy-era proof | Repeat the Inspector 2.9.0 OAuth procedure with `protocolEra: "legacy"`; retain the negotiated protocol, `tools/list`, a `list_traces` result and redacted request headers. |
| Production `events/list` | On the authorized modern ChatGPT/Inspector connection, invoke `events/list` and save the actual response, including whether `trace.error` is offered. |
| Deployment commit | In the owner's Railway project, inspect the active deployment ID and its source commit; compare it with `git rev-parse origin/main`. Save the date and both values. Do not infer deployment from a successful HTTP response. |
| Events subscribe | In the owner's Events-capable 2026-07-28 ChatGPT surface, explicitly request `trace.error` notifications for an isolated test service; retain the redacted subscription response and expiration. |
| Matching signed notification | Emit an owner-approved error trace for that service into the isolated project; retain the trace ID, received notification time and signature-verification outcome without signing keys. |
| Non-matching service | Emit an error trace for a different test service, record both IDs and the bounded observation window, and verify it produces no notification on the filtered subscription. |
| Subscription survives deployment | Record subscription ID/expiration, perform an owner-approved deployment, emit another matching error and record delivery for the same subscription. |
| Automatic renewal | Observe the owner's client across its renewal time; retain before/after expiration and subscription/renewal responses, then a matching delivery. |
| Unsubscribe stops delivery | Unsubscribe in the owner client, retain its response, emit a fresh matching test error and record the bounded no-delivery window. |
| Revocation stops delivery | On a separate test subscription, revoke the isolated account's access, emit a fresh matching test error, and retain revocation timing plus the bounded no-delivery window. Restore access only by owner decision. |
| npm fresh consumer | In a fresh temporary project, install the exact observed `qyl-mcp-server@7.1.1`, run the pinned Inspector 2.9.0 with modern and legacy configurations against its stdio command in explicit demo mode, and record discovery plus a read result in both eras. The registry version alone is not this proof. |
| Public directory statuses | For each of OPENAI_PLUGIN, ANTHROPIC_CONNECTOR and ANTHROPIC_PLUGIN, the owner reads the corresponding portal and records date, record identifier and actual draft/submitted/approved/published state. No portal state is established here. |

## Directory records

Historical step-4 repository-side inventory, rechecked 2026-10-08. `git show ff930a8:submission/README.md` reports OPENAI_PLUGIN as `local draft` and both
Anthropic records as `not created`; these are preparation states recorded in
the repository, not independently observed portal states. The owner's
[2026-10-08 review](https://github.com/ANcpLua/qyl.mcp/pull/95#issuecomment-6051431328)
requests retaining those states in this index. Portal status verification
remains an explicit owner action above.

| Record | Repository-side state and dated evidence | Exact pending owner action |
| --- | --- | --- |
| OPENAI_PLUGIN | 2026-10-08: local draft; `plugin.json` and `mcp.json` present (inventory output below). | Supply the missing review fields, then separately authorize and perform portal validation/upload at `https://platform.openai.com/plugins`; record the actual status. |
| ANTHROPIC_CONNECTOR | 2026-10-08: `git show ff930a8:submission/README.md` records `not created`; endpoint draft is `https://mcp.qyl.at/mcp`. | Create the separate MCP connector record at `https://claude.ai/directory/manage` after supplying the reviewer account, documentation/privacy URLs, support contact and icon; record its actual status. |
| ANTHROPIC_PLUGIN | 2026-10-08: bundle files present; `git show ff930a8:submission/README.md` records the portal record as `not created`. | Select repository `ANcpLua/qyl.mcp`, plugin path `submission/qyl` and a branch or tag in the separate plugin-bundle record; arrange the Claude GitHub App access and later publication decision; record actual portal status. |

Inventory command, 2026-10-08:

```sh
node --input-type=module <<'JS'
import { existsSync } from 'node:fs';
for (const f of ['submission/qyl/plugin.json','submission/qyl/mcp.json','submission/qyl/.claude-plugin/plugin.json','submission/qyl/.mcp.json','submission/qyl/README.md','submission/qyl/LICENSE','submission/public-pages-draft.md']) console.log(`${f}: ${existsSync(f) ? 'present' : 'absent'}`);
JS
```

Actual output:

```text
submission/qyl/plugin.json: present
submission/qyl/mcp.json: present
submission/qyl/.claude-plugin/plugin.json: present
submission/qyl/.mcp.json: present
submission/qyl/README.md: present
submission/qyl/LICENSE: present
submission/public-pages-draft.md: present
```

## Owner actions required

Open preparation actions, recorded 2026-10-08 from `goal-objective.md`,
steps 4–6. These instructions are not evidence of execution or authorization
to perform them in this task.

| Action | Needed for | Exact owner action |
| --- | --- | --- |
| Publisher identity | OPENAI_PLUGIN | Select the intended publisher identity in the OpenAI portal and record its actual verified status before submission. |
| Public pages | All three records | Approve the wording in `submission/public-pages-draft.md`, publish support/privacy/terms pages on qyl.at, and supply their final reachable URLs for the manifests and portal fields. |
| Reviewer account | All three records | Create or choose an isolated reviewer account, populate its Collector project with representative sample traces/logs/metrics, verify OAuth access, and supply credentials through the portal's private reviewer field. |
| Demo recording | OPENAI_PLUGIN | Record the installed plugin performing the positive review cases with sample data, host the recording, and supply its reachable URL for `review.demo_recording_url`. |
| Attestations and submission | All three records | Review legal attestations, approve final fields, and explicitly submit each separate portal record; retain the date, record ID and portal response. |
| Publication | All three records | After approval, make a separate publication decision; for the Anthropic bundle ensure required repository visibility and GitHub App access, then publish and record the observed listing URL. |

## Auth0 discovery decision

Source/metadata evidence, 2026-10-08: the commands in
[step-7 authentication evidence](docs/evidence/2026-10-08-step7.md#deployment-and-authentication)
show resource metadata routes and the pinned Auth0 issuer. The public OAuth
metadata command outputs Auth0's `issuer`; qyl.mcp does not implement its own
OIDC issuer discovery. See [README authentication guidance](README.md#authentication).
Workspace domain claiming and any verified-email requirement remain an owner
check; they do not replace `qyl:read` resource authorization.

## Step 5 — local submission preparation, 2026-10-08

Commands and actual output are in the [step-5 evidence record](docs/evidence/2026-10-08-step5.md).
These are local artifact observations. The owner-action rows above remain
open; this does not establish any current portal state.

| Artifact | Dated command and result |
| --- | --- |
| OpenAI root manifests | 2026-10-08: Python/jsonschema command in step-5 record validates each manifest against its fetched `$schema`; both print `PASS`. |
| OpenAI generated draft ZIP (Git-ignored; build with `python3 submission/build-openai-package.py`) | 2026-10-08: archive verification in the same command prints `ZIP: six source-identical files; no .claude-plugin, .mcp.json, .app.json or apps binding`; SHA-256 `16a6ffb523f90674572efc99dca430cf661d26aaa08f54d6680f7da0261fab5c`. |
| Anthropic bundle and shared skill | 2026-10-08: file inventory prints all five required paths `present`; README 269 words outside code blocks; `claude plugin validate ./submission/qyl` prints `✔ Validation passed`. |
| Cases and server | 2026-10-08: Python inspection prints `review cases: 5 positive, 3 negative; servers: 1; owner identity/countries unset`. These are drafted cases, not executed hosted-client evidence. |
| Missing owner fields | Exact remaining actions are in [submission/README.md](submission/README.md#owner-fields-still-required): publisher, targeting, URLs, reviewer access, recording, hosted review cases, attestations and later publication. |

## Step 6 — owner submission/publication handoff, 2026-10-08

This is a boundary record, not a completed submission. The exact owner actions
remain in [Owner actions required](#owner-actions-required) and the missing
fields in [submission/README.md](submission/README.md#owner-fields-still-required).
No portal status is inferred from a merged preparation PR.

Scope evidence, command `sed -n '195,201p' goal-objective.md`, output excerpt:

```text
6. **Submission and publication** are owner actions: legal attestations,
   portal uploads, identity selection, publish. Agents prepare and report;
   they do not submit. Publication is a separate decision after approval.
```

Preparation boundary, command `git rev-parse origin/main`, output:

```text
698f045c4dfbb39a171cc59154f64abbc8fd3040
```

The following are pending owner actions, not tasks executed by this goal:

| Record | Submission handoff | Publication handoff |
| --- | --- | --- |
| OPENAI_PLUGIN | Resolve publisher/targeting/URLs/demo/reviewer access, rebuild the local ZIP, upload and validate it, perform attestations, and submit through the owner's portal. Record the actual response. | After approval, owner makes a separate decision to publish and records the observed listing URL/status. |
| ANTHROPIC_CONNECTOR | Supply the isolated populated account and connector fields, create/validate the separate MCP connector record and submit it. Record the actual response. | Owner verifies the automatic-scan/review result and actual listing state; a successful private connection is not a published connector. |
| ANTHROPIC_PLUGIN | Supply public page URLs, repository branch/tag and GitHub App access, validate the separate plugin-bundle record, perform attestations and submit it. Record the actual response. | After approval, owner supplies required public repository access and explicitly publishes; record the observed listing URL/status. |

Local verification, 2026-10-08: `git diff --name-only` returned only
`MCP-V2-INTEROP-TODO.md`; `git diff --check` returned no output (exit 0).

## Step 7 — documentation reconciliation, 2026-10-08

[Source and merge evidence](docs/evidence/2026-10-08-step7.md) records the
commands behind README, checkpoint and matrix statements. Local checks:
`bun run --cwd server build` exits 0 including the unchanged deployment-guidance
verifier; `bun run verify:sdk` reports 5 passes and the boundary success;
`bun run lint` prints `$ oxlint .` and exits 0; `git diff --check` is silent,
exit 0. This documentation revision does not change runtime code or gates.

Earlier unaccepted claims remain separated as follows:

| Claim | Fresh evidence or exact pending owner action |
| --- | --- |
| qyl.at PR #16 | On 2026-10-08, `gh pr view 16 --repo ANcpLua/qyl.at --json state,mergeCommit,mergedAt,url` returned `MERGED`, merge `098e4138fab7443fe8d3f558a92867e5d1ba39fc`, merged at `2026-10-07T19:50:42Z`. This proves the PR state only. |
| Live protocol guide | Owner opens the deployed guide, records its exact URL/date and rendered protocol text, and compares the deployed revision with the intended qyl.at source. PR #16 alone is not deployment evidence. |
| Collector PR #640 | On 2026-10-08, `gh pr view 640 --repo ANcpLua/qyl --json state,mergeCommit,mergedAt,url` returned `MERGED`, merge `d07c45add9384aa285df693bd651dfbd89e330a4`, merged at `2026-10-07T01:04:22Z`. This proves the PR state only. |
| Eight hosted review rehearsals | Owner runs all five positive and three negative cases from `submission/qyl/plugin.json`, records client/version/date, actual tool calls and results, and marks each passed/failed. They remain unrun as hosted cases here. |
| Approved Individual publisher identity | Owner reads the selected identity and verification status in the intended portal and records the date/status. Package author names do not establish this. |
| Production filters and viewer refresh | Owner runs a bounded combined trace/service/severity/body log query against isolated sample data and refreshes the viewer with empty host input; records inputs, expected fixture IDs and actual output. Local smoke and UI tests are not production proof. |

The five client connections, production Events lifecycle, npm consumer,
publication and other owner decisions remain indexed in the existing owner
sections above; none was deleted to satisfy a completion criterion.

Owner correction, 2026-10-08: `gh pr view 98 --repo ANcpLua/qyl.mcp --json comments`
returned [two requested changes](https://github.com/ANcpLua/qyl.mcp/pull/98#issuecomment-6051677237).
The follow-up replaces the service data inventory's unsupported live deployment,
configuration, retention, Events and identity claims with exact owner actions,
while retaining source-derived data flows. README restores the five clients'
setup and registration paths plus `MCP_ALLOWED_HOSTS` and
`MCP_ALLOWED_ORIGIN_HOSTS`. The [dated help, documentation and source output](docs/evidence/2026-10-08-step7.md#client-setup-and-owner-review-correction)
backs those instructions; no client login or owner action was performed.

## Revised goal — point 1: remove protocol logging, 2026-10-08

The owner revised the work sequence after PR #98. Earlier entries are retained
as dated historical observations; this point supersedes the earlier decision
to retain deprecated request logging. The new requirements are in
[goal-objective.md](goal-objective.md#work-in-order).

| Check | Dated command and actual output |
| --- | --- |
| Modern calls never emit deprecated logging | 2026-10-08: `QYL_MCP_TELEMETRY=0 QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-followup-1/native-rerun.json node --test server/dist-test/*.test.js` passed `modern tool calls emit no logging notifications, even when the client requests a log level`; 158 passed, 0 failed. The test checks absent capability and success/error calls with info, warning and absent levels. |
| Progress, cancellation, native records and schemas | Same 158-test run passed existing progress/cancellation/native-record/manifest tests. No manifest snapshot changed. |
| Transport | 2026-10-08: `QYL_MCP_TELEMETRY=0 QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-followup-1/native-smoke.json bun run smoke` exited 0; server `all checks passed` and workbench reconnect succeeded. |
| SDK and lint | 2026-10-08: `bun run verify:sdk` reported 5 passed and the seven-manifest boundary success; `bun run lint` exited 0. |
| Frame gate | 2026-10-08: `bun run --cwd server verify:frame` still checks every registration and all 11 manifest tools. It now matches the frame's cancellation/progress signature after the log-only name argument was removed. The temporary missing-frame negative control exits 1 and names `list_traces`. |

[Commands and actual output](docs/evidence/2026-10-08-followup-01.md) retain the
initial sandbox `listen EPERM` failures and successful permitted-listener rerun.
No production or owner-client observation follows from these fixture checks.

Point-1 owner correction, 2026-10-08: `gh pr view 100 --repo ANcpLua/qyl.mcp --json comments`
returned the outdated package-README logging claim. The paragraph and 7.2.0
release notes now document removal; `bun run --cwd server verify:readme`
returned `11 tools documented; 0 mutating (none) named with its exception.`,
exit 0. The source evidence and exact output are retained in the linked record.

Point-1 follow-up, 2026-10-08: the second `gh pr view 100 --repo ANcpLua/qyl.mcp --json comments`
response identified the local SDK skill's stale logging instruction. Hidden-file
search also found the landing-page claim. Both were corrected; the skill's
qyl-specific legacy rejection claim was reconciled with the recorded factory
source. `quick_validate.py` returned `Skill is valid!`; server build and lint
exited 0. Full commands/output are in the point-1 evidence record.

## Revised goal — point 2: HTTP banner on stderr, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Preceding point merged | 2026-10-08: `gh pr view 100 --repo ANcpLua/qyl.mcp --json state,mergedAt,mergeCommit,headRefOid,statusCheckRollup` returned `MERGED`, merge `150a158eae054d4f553dae94c6add9f4e33d741e`, all four required checks `SUCCESS` at head `1ef923b`. |
| Application banner | 2026-10-08: the Python Bun-process command in [point-2 evidence](docs/evidence/2026-10-08-followup-02.md#actual-http-process) returned `HTTP /healthz: 200`, `stderr: MCP server serving http://127.0.0.1:52045/mcp`; stdout contained only Bun's own development-server line. The command asserts qyl's banner is not on stdout. |
| Build and lint | 2026-10-08: `bun run --cwd server build` and `bun run lint` exited 0; `git diff --check` was silent, exit 0. |

The evidence retains the initial fixture cleanup timeout and overly broad
stdout assertion, along with the corrected fixture and successful output.
The earlier HTTP-banner assessment describes the prior source; this point
changes that application banner's stream without changing the stdio path.

## Revised goal — point 3: static drift resolved, 2026-10-08

The earlier 31-finding scan and four assessments remain historical evidence
from PR #95. The revised owner instruction now authorizes explicit `zod/v4`
imports and a justified marker for the Events JSON Schema.

| Check | Dated command and actual output |
| --- | --- |
| Preceding point merged | 2026-10-08: `gh pr view 101 --repo ANcpLua/qyl.mcp --json state,mergedAt,mergeCommit,headRefOid,statusCheckRollup` returned `MERGED`, merge `ac2faefa794121fcbfb75d8984c8e75b5859c0c8`, all four required checks `SUCCESS` at head `5612068`. |
| Drift checker | 2026-10-08: `node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/check_v2.mjs /Users/alexandernachtmann/RiderProjects/qyl.mcp/server` returned `0 error(s), 0 warning(s) in 146 file(s)` and `GREEN: no v1 fingerprints at error severity.`, exit 0 after the server test build. |
| Checker integrity | 2026-10-08: `shasum -a 256` on the checker and `drift_rules.json`, then `diff` of before/after snapshots, returned unchanged hashes and no diff (exit 0). Exact commands and hashes are in [point-3 evidence](docs/evidence/2026-10-08-followup-03.md#unchanged-checker-and-rules). |
| Tests and lint | 2026-10-08: `QYL_MCP_TELEMETRY=0 QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-followup-3/native.json bun run --cwd server test` passed 158 tests, 0 failed; `bun run lint` and `bun run verify:sdk` exited 0, SDK tests 5 passed. |

[Full before/after and test output](docs/evidence/2026-10-08-followup-03.md)
includes the single reasoned `TS-RAW-SHAPE` allowance and installed Zod factory
identity. This is local evidence; the external skill is not added to CI.

## Revised goal — point 4: HTTP contract tests, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Protocol header/body mismatch | 2026-10-08: `QYL_MCP_TELEMETRY=0 QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-followup-4/native.json bun run --cwd server test` passed `HTTP protocol-version mismatch returns 400 and -32020`. |
| Missing per-request capabilities | Same dated command passed `HTTP missing clientCapabilities returns 400 and -32602`, including the missing-key diagnostic. |
| Catalog cache and order | Same dated command passed `HTTP tools/list carries cache hints and preserves order across requests`: two direct factory-fetch responses, 11 tools each, `ttlMs: 300000`, `cacheScope: public`, unchanged returned order. |
| Combined gates | Same dated command: 161 passed, 0 failed. `bun run lint` exited 0; `bun run verify:sdk` reported 5 passed and the seven-manifest boundary success. |

[Exact commands and output](docs/evidence/2026-10-08-followup-04.md) record local
verification and the preceding point's merge. The verify CI job already runs
this server test glob; its result is recorded by the PR checks.

## Revised goal — point 5: authorization and isolation, 2026-10-08

Every row below uses `gh run view 37732682331 --repo ANcpLua/qyl.mcp --log`,
read on 2026-10-08 (exit 0). [Dated source assertions and actual CI output](docs/evidence/2026-10-08-followup-05.md)
record the scope of these fixtures; no production identity claim follows.

| Case | Exact test name and actual output |
| --- | --- |
| Wrong audience | `token verification rejects the wrong token type, audience, or missing client ID` — `✔`, at `2026-10-08T05:30:35.0404189Z`; signed token with foreign audience is rejected. |
| Missing scope | `bearer gate fails closed with the resource challenge and scopes` — `✔`, at `2026-10-08T05:30:34.0401921Z`; 403, `insufficient_scope`, `qyl:read` challenge. |
| Expired token | `token validation rejects expiry, foreign issuers, missing RFC9068 claims and assertion tokens` — `✔`, at `2026-10-08T05:30:34.7990495Z`; signed `exp: 0` is rejected. |
| Cross-subject project access | `verified account scope reaches model and viewer tools over 2026-07-28` and `verified account scope reaches model and viewer tools over 2025-11-25` — both `✔`, at `2026-10-08T05:30:32.6120565Z` and `2026-10-08T05:30:32.6715834Z`; forged metadata never switches project credentials, foreign trace ID fails, unassigned subject makes no upstream call. |
| Signed-token HTTP integration | `real signed access tokens reach modern MCP tools with zero, one, or both extensions` — `✔` in the linked output; wrong audience/expiry return 401, insufficient scope returns 403 with resource and scope challenges. |
| CI conclusion, including point 4 | `gh run view 37732682331 --repo ANcpLua/qyl.mcp --json conclusion,headSha,url,jobs` on 2026-10-08 returned `success` at head `0b0aa8d10b2841456aa708b0318f30050dd86d78`; lint, verify and the account/Events isolation step succeeded. Server tests: 161 passed. |

## Revised goal — point 6: Railway deployment observation, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Automatic main trigger | 2026-10-08: the exact `railway api` service/repoTriggers query in [point-6 evidence](docs/evidence/2026-10-08-followup-06.md#source-configuration-versus-live-trigger) returned `provider: github`, `repository: ANcpLua/qyl.mcp`, `branch: main`, `checkSuites: true`, production environment `616ff7bf-ef19-4e34-bb22-d3eb002b74e9`. `.github/workflows/railway-config.yml` separately plans/applies configuration for its path-filtered PR events. |
| Running deployment | 2026-10-08: `railway status --project 5eaa4020-71d9-4828-89d3-316cb188529e --environment production --json` returned active deployment `2c548573-5f6a-4293-9d89-5b366f282a15`, `SUCCESS`, `deploymentStopped: false`, instance `RUNNING`, commit `369c54acd78a8a6ccdef62d03c26601440163be3`. Latest successor `1f37877e-079d-44a0-8f7b-9c7bb32fb300` at `e85773e6e6a1a1dc12ab55e5c91b320488a64d24` was `WAITING`; it was not claimed as running. |
| PR #91 included | 2026-10-08: `git merge-base --is-ancestor 4685c2471a4100ed6a00601b44ec3ead1b6a0f6f 369c54acd78a8a6ccdef62d03c26601440163be3` exited 0. The running commit contains the record-minimization fix. No pre-#91 build was observed, so no owner redeploy request is needed for that condition. Existing stored-data erasure was not inspected. |
| Read-only scope | Only `railway list/status/deployment list/service status/api` reads and Git/GitHub reads were used. No deployment or configuration mutation was invoked; [commands/output](docs/evidence/2026-10-08-followup-06.md) include the initial unlinked-checkout error and explicit-ID recovery. |

## Revised goal — point 7: production challenge, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Production challenge route | 2026-10-08: the exact `curl` command in [point-7 evidence](docs/evidence/2026-10-08-followup-07.md#production-observation) returned `HTTP 404`, body `Not Found`; server Date `Thu, 08 Oct 2026 05:46:20 GMT`. This is response evidence, not an inspection of environment values. |
| Token behavior | 2026-10-08: `QYL_MCP_TELEMETRY=0 node --test --test-name-pattern='the OpenAI domain challenge' server/dist-test/main.test.js` passed `the OpenAI domain challenge answers the configured token as plain text, before the gate`, 1 passed, 0 failed; absent/blank token returns 404 in the fixture. |
| Owner action | README names `OPENAI_APPS_CHALLENGE`, the exact GET route and the pending action to copy the portal-provided token into the intended hosted environment, then verify in the portal. No variable was set and no portal action was performed. Source and command output are in the linked dated evidence. |
| Documentation gate | 2026-10-08: `bun run --cwd server verify:deployment-guidance` passed; `git diff --check` was silent, exit 0. |

## Revised goal — point 8: schema merged, release blocker, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Upstream schema PR | 2026-10-08: `gh pr view 36 --repo ANcpLua/qyl-api-schema --json headRefOid,mergeCommit,mergedAt,statusCheckRollup,url` returned merge `719e46717fa9648dbeda899c02d3fef28bdf7a90`, merged at `2026-10-08T05:59:22Z`; all four required checks `SUCCESS` at `29adfd52ef55225473ed2af1e56de90c40996c41`. [PR #36](https://github.com/ANcpLua/qyl-api-schema/pull/36) contains the four optional TypeSpec fields and generated OpenAPI. |
| Released package | 2026-10-08, after that merge: `npm view @ancplua/qyl-api-schema version gitHead --@ancplua:registry=https://registry.npmjs.org --json` returned `11.2.0`, commit `131b116227fb0362a1003bbb23eb7b57ed50c293`; `gh release view --repo ANcpLua/qyl-api-schema --json tagName,publishedAt,targetCommitish,url` returned `v11.2.0`, published `2026-09-17T11:07:10Z`. |
| Blocker under Done when 5 | The exact Node command in [point-8 evidence](docs/evidence/2026-10-08-followup-08.md#concrete-release-blocker) returned installed `11.2.0`, GetTrace keys `[trace_id]`, CiLog keys `[run_id, limit]`. The published contract lacks the new fields; publication is forbidden in this goal. Dependency bump and runtime implementation remain open, explicitly not claimed complete. |
| Owner prerequisite and follow-through | Owner publishes a schema release containing merge `719e46717fa9648dbeda899c02d3fef28bdf7a90`; then consumers can bump in lockstep and implement/filter/test the four options. The exact sequence and unchanged release boundary are in the linked evidence. |

## Revised goal — point 9: Anthropic connector listing, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Listing fields | 2026-10-08: the exact Python draft check in [point-9 evidence](docs/evidence/2026-10-08-followup-09.md#draft-and-source-checks) returned name `3/100`, one-liner `71/200`, description `603/2000`, one proposed category and an existing icon. [Draft](submission/anthropic-connector-listing.md) includes documentation/privacy/support/slug fields. |
| Public documentation | 2026-10-08: `curl` to the repository page returned `HTTP 200`; the content check found the qyl purpose and hosted-setup section. Exact command/output is in the linked evidence. |
| Owner acknowledgements/access | The dated draft check returned `Acknowledgements: 7/7 pending owner fields`. The official-guide check returned `Acknowledgement topics found: 7/7`. Credentials, unresolved public-page/contact values and attestations are owner fields; no portal action occurred. |

## Revised goal — point 10: icon and rebuilt package, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Anthropic icon | 2026-10-08: `claude plugin validate ./submission/qyl` returned `Validation passed`; the exact Python field check in [point-10 evidence](docs/evidence/2026-10-08-followup-10.md) resolved `./assets/qyl-icon.png` inside the package to the same existing PNG as both OpenAI icon fields. |
| Owner fields | Same dated field check returned `Owner fields absent: Anthropic URLs=3; OpenAI URLs/identity/countries=5` and `Owner destination mapping: PASS`. [Submission instructions](submission/README.md#owner-fields-still-required) name every target field and publication prerequisite. |
| Rebuilt ZIP | 2026-10-08: `python3 submission/build-openai-package.py` returned six entries and SHA-256 `16a6ffb523f90674572efc99dca430cf661d26aaa08f54d6680f7da0261fab5c`. The linked validator output confirms source-identical contents and both root schemas. The unchanged hash is expected: the changed Anthropic manifest is excluded from this OpenAI archive. |

## Revised goal — point 11: excluded distribution targets, 2026-10-08

| Target | Reason and dated evidence |
| --- | --- |
| MCP Registry | Excluded by owner requirement, `goal-objective.md` point 11. The preparation scope is the OpenAI plugin plus Anthropic connector and plugin bundle; adding a registry entry expands that scope and publication is an owner action. 2026-10-08: the exact `rg` command in [point-11 evidence](docs/evidence/2026-10-08-followup-11.md) returned that requirement and the three submission destinations. No registry action was performed. |
| Custom Marketplaces | Excluded by the same requirement: a custom distribution catalog is an additional distribution target, outside these three directory records. The same dated command/output establishes the agreed scope, not any claim of platform incompatibility. No marketplace was created or published. |

## Revised goal — point 12: HTTP conformance and negative control, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| HTTP both eras | 2026-10-08: the exact `verify_server.mjs --url http://127.0.0.1:54306/mcp --cwd …/server --start -- … bun dist/main.js` command in [point-12 evidence](docs/evidence/2026-10-08-followup-12.md#http-both-era-verification-with-conformance) exited 0: modern and legacy each listed 11 tools; schema portability GREEN. |
| HTTP conformance | Same command: `server-stateless 24 passed; 4 n/a (need SDK fixtures); 1 SHOULD-warning(s)` for list-change notification; `tools-list 4 passed`; `dns-rebinding-protection 2 passed`; verifier GREEN. Scope and warning are retained, not claimed as a complete fixture suite. |
| Bun HTTP entry | 2026-10-08: `env QYL_DEMO=1 QYL_MCP_TELEMETRY=0 node dist/main.js` in `server/` exited 1 with the explicit message to run the HTTP entry with Bun; Node serves stdio only. The successful HTTP command above uses Bun 1.4.2. |
| Legacy-only negative control | 2026-10-08: `verify_server.mjs --cwd /private/tmp/qyl-followup-12/legacy-only -- bun index.ts` exited 1: modern RED (pinned 2026-07-28 not offered), legacy GREEN (`notes_get`), schema skipped. The evidence retains the initial broken dependency link and its rejected run, corrected fixture setup, exact command and unchanged verifier hashes. |

## Revised goal — point 13: release requirement/evidence map, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Release documents | 2026-10-08: the Python command in [point-13 evidence](docs/evidence/2026-10-08-followup-13.md) returned `Mappings: work points 1..15; Done when 1..7` for [release/contract.md](release/contract.md). [release/README.md](release/README.md) links the objective, ledger and evidence and names exact pending owner actions. |
| Scope and links | Same dated command returned `Pending points 14/15 and point-8 release blocker: explicit` and `Local document links and heading anchors: 70 resolve`. These are snapshot results; later points update the map. Manual claim review and separate owner review are still required. |

## Revised goal — point 14: repository completion CI audit, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Audit and negative controls | 2026-10-08: `PATH="/private/tmp/qyl-followup-14/clean-venv/bin:$PATH" bun run verify:completion` passed 8 tests, both declared schemas, 8 bundle and 5 handoff files, README 263 words, 11 descriptions, strict metadata-only record, ledger rows and local links. [Point-14 evidence](docs/evidence/2026-10-08-followup-14.md) contains exact setup and output. |
| CI placement and boundary | Same dated source review of `.github/workflows/ci.yml` and `package.json` shows `bun run verify:completion` in `verify`, after tests, with a temporary Python environment and pinned requirements. `check_v2` stays outside CI. Manual prose/owner-state review is still required. |
| Existing gates | 2026-10-08: `bun run lint` exited 0; `bun run verify:sdk` passed 5 tests and the seven-manifest boundary; `git diff --check` was silent, exit 0. |

## Revised goal — point 15: restored public-page draft, 2026-10-08

| Check | Dated command and actual output |
| --- | --- |
| Restoration | 2026-10-08: `git show 93d8dbf:submission/public-pages-draft.md` and the exact Python comparison in [point-15 evidence](docs/evidence/2026-10-08-followup-15.md#original-source-and-restoration) retain the historical output and confirm all four required headings plus the original data-purpose categories. |
| Owner fields | The final dated comparison returned `Rendered paragraphs/cells with digits: 5; all marked OWNER FIELD` and `Deployment, providers, enabled features and retention: 9 explicit owner fields`. Unsupported historical identity/country/capture/retention claims are absent. Publication remains pending. |
| Point-14 CI | 2026-10-08: `gh run view 37739805623 --repo ANcpLua/qyl.mcp --log` returned the successful completion-audit step: 8 tests passed and all repository criteria passed, with timestamps retained in point-15 evidence. |
| Static source recheck | 2026-10-08: the unchanged external `check_v2.mjs` reported `0 error(s), 0 warning(s) in 82 file(s)` after the server build cleaned generated test output. Checker/rule hashes match point 3. |
| Refreshed point-8 blocker | 2026-10-08: `npm view` now returns schema `11.3.0`; its release is published. The pinned GitHub read of Collector main `d1de0c9` returns `QylApiContractsVersion` 11.2.0. The unchanged gate rejects the temporary 11.3.0 candidate with `cross-repo contract skew`, exit 1. [Exact commands/output and next prerequisite](docs/evidence/2026-10-08-followup-15.md#release-blocker-refreshed-after-owner-release). No unilateral bump or runtime-option completion is claimed. |
| Owner-supplied values and client failure | 2026-10-08: `cat /Users/alexandernachtmann/Downloads/wip.md` supplies support contact, all-eligible-country selection and slug confirmation; [excerpt and attribution](docs/evidence/2026-10-08-followup-15.md#owner-supplied-wip-values). The owner's Inspector 2.9.0 screenshot/error reports DCR 403 `too_many_entities`; the fixed client and tenant review are assigned to Advisor 1, with actual connection proof still pending. No tenant, portal or credential action was performed by this goal agent. |

## Listing review, 2026-10-08

PR #117 revised the listing and review texts, including the packaged
`README.md`, `plugin.json` and `SKILL.md`, after rebasing onto main `9779ced`.

| Check | Dated command and actual output |
| --- | --- |
| Rebuilt OpenAI ZIP | 2026-10-08: `python3 submission/build-openai-package.py` exited 0 and printed the six entries `LICENSE`, `README.md`, `assets/qyl-icon.png`, `mcp.json`, `plugin.json`, `skills/qyl-investigate/SKILL.md` and `sha256 328dd9813dcbf10e581a722593b797f7ffd01f4ec6562ea3cc1ad9ae1f6aa4ce`. This hash supersedes the point-10 hash `16a6ffb523f90674572efc99dca430cf661d26aaa08f54d6680f7da0261fab5c`, which remains the historical record of the earlier packaged sources. The ZIP stays Git-ignored. |
| Package validation | Same date and sources: the point-10 `validate.py` checks, extended to reject `hooks/`, returned `plugin.json: PASS` and `mcp.json: PASS` against their declared schemas, all five Anthropic bundle files present, `README words outside code blocks: 736`, `review cases: 5 positive, 3 negative; servers: 1; owner identity/countries unset`, `ZIP: six source-identical files; no .claude-plugin, .mcp.json, .app.json, hooks or apps binding` and the same SHA-256. `python3 -m json.tool` exited 0 for both manifests; `claude plugin validate ./submission/qyl` (Claude Code 2.1.294) printed `Validation passed`, exit 0. |
| Listing field lengths | Connector draft, counted with the point-9 check method: name `3/100`, one-liner `142/200`, description `1295/2000`, `Acknowledgements: 7/7 pending owner fields`. OpenAI interface: `displayName` 3/30, `shortDescription` 26/30, `longDescription` 1268/4000 and three unique `defaultPrompt` entries of 67, 56 and 45 characters (limit 128). |
| Completion audit | 2026-10-08, after these ledger, release and submission edits: a fresh virtual environment with the pinned `scripts/completion-audit-requirements.txt`, then `PATH="<venv>/bin:$PATH" bun run verify:completion`, exit 0. Output: `Ran 8 tests`, `OK`; `PASS: 8 bundle files and 5 handoff files`; both declared schemas pass; `PASS: README 687 words outside code blocks (minimum 40)`; all 11 tool descriptions pass; the strict native record passes; the ledger-row check passes; `PASS: 239 local documentation/evidence links and heading anchors resolve`. |


## Point 8 Option A — contract 11.3.0, 2026-10-08

This continuation supersedes the earlier Collector-pin blocker. The [dated
commands and output](docs/evidence/2026-10-08-point-8-options.md) distinguish
local checks, the merged Collector prerequisite and pending external evidence.

| Check | Dated command and actual output |
| --- | --- |
| Collector prerequisite | 2026-10-08: [qyl PR #642](https://github.com/ANcpLua/qyl/pull/642) merged at `2026-10-08T08:08:11Z`, merge `15924345bd804c358b1ab22d059b27d815bc8874`, after green CI. Local `../qyl` is on that `main`. The unchanged frontend and README gates required matching dashboard and README pins in the same PR. |
| Actual cross-repo gate | 2026-10-08: `bun run verify:pins` exited 0: `verify:pins: contract pins agree (@ancplua/qyl-api-schema 11.3.0 == Qyl.Api.Contracts 11.3.0, via /Users/alexandernachtmann/RiderProjects/qyl)`. This used the normal sibling checkout, not a substitute fixture. |
| Options and regression coverage | 2026-10-08: full `bun run test` with telemetry disabled passed 167 server + 142 workbench + 32 dashboard + 4 site tests. Six new SDK-level option tests and generated input-bound checks passed; after the final lint fix, 21 focused tests passed. Exact names and commands are in the linked evidence. |
| Reviewed manifest | 2026-10-08: comparison prints `Changed tool fields: ci_log.description, ci_log.inputSchema, get_trace.description, get_trace.inputSchema`; all 11 output schemas, annotations, metadata and resources are unchanged. New revision: `sha256:382526f13652d18b`. |
| Production and Inspector boundary | 2026-10-08: first post-merge Railway observation reports deployment `a8f98435-c8a8-4e2d-b3a4-d9c6f9dd3145` for the merge commit as `WAITING`. A production handshake is only recorded after a successful Collector deployment. Inspector evidence is supplied by the owner. |
| Local integration gates | 2026-10-08: `smoke`, `smoke:otlp` and `smoke:projects` exited 0 against the local Collector. OTLP parsing, combined log filters, all 11 tools across both wire eras, signatures, unsubscribe and assignment revocation passed. `verify:completion` passed its 8 tests, all checks and 251 local links. Exact output is in the linked Option-A evidence. |
