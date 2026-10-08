# qyl.mcp evidence ledger

Reset on 8 October 2026. An entry counts only with a date, the exact command
or client and version, and the actual output or observation. Rows without
that say `not recorded`. Nothing in this file is inferred from another row,
from a passing unit test or from a successful initialize. Requirements and
the work order are in [goal-objective.md](goal-objective.md).

## Repository facts

Checked in source on 8 October 2026.

| Item | Where | State |
| --- | --- | --- |
| SDK v2 split packages, no `@modelcontextprotocol/sdk` | `server/package.json`, `workbench/package.json` | present |
| HTTP via `createMcpHandler`, stdio via `serveStdio` | `server/src/main.ts` | present |
| 11 tools, all `readOnlyHint: true` | `server/tool-manifest.snapshot.json` | present |
| `fetch_telemetry` app-only visibility | `server/src/server.ts` | present |
| Trace-error Events implementation | `server/src/events.ts`, `events-authorization.ts`, `webhook.ts` | present |
| Account and project scoping | `server/src/collector-access.ts`, `request-scope.ts` | present |
| Native tool-call records contain operation metadata only | `server/src/native-execution.ts` | implemented in step 1; dated tests below |
| OpenAI plugin draft | `submission/qyl/plugin.json`, `mcp.json` | present, not uploaded |
| Anthropic bundle (`.claude-plugin/plugin.json`, `.mcp.json`, `README.md`, `LICENSE`) | `submission/qyl/` | present; portal validation not recorded |
| Agent skill | `submission/qyl/skills/qyl-investigate/SKILL.md` | present |

## Local checks

| Check | Command | Last run | Result |
| --- | --- | --- | --- |
| Build | `bun run build` | 2026-10-08 UTC | exit 0; Vite reports its bundle-size warning |
| Tests | `QYL_MCP_NATIVE_STATE_PATH=/private/tmp/qyl-step1-native.json QYL_MCP_TELEMETRY=0 bun run test` | 2026-10-08 UTC | 337 passed: server 159, Workbench 142, dashboard 32, site 4; 0 failures |
| Transport smoke, both eras | `bun run smoke` | 2026-10-08 UTC | exit 0; `all checks passed`, Workbench connects/disconnects/reconnects |
| Lint | `bun run lint` | 2026-10-08 UTC | `$ oxlint .`; exit 0 |
| Collector contract smoke | `bun run smoke:otlp` | not recorded | |
| Project isolation smoke | `bun run smoke:projects` | not recorded | |
| SDK v1 dependency check | `bun run verify:sdk` | 2026-10-08 UTC | 5 tests passed; `MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).` |
| v1-drift check (mcp-builder-v2 skill) | `node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/check_v2.mjs /Users/alexandernachtmann/RiderProjects/qyl.mcp/server` | not recorded | |
| Both-era black-box check, after `bun run --cwd server build` | `node /Users/alexandernachtmann/RiderProjects/mcp-builder-v2/skills/mcp-builder-v2/scripts/verify_server.mjs --cwd /Users/alexandernachtmann/RiderProjects/qyl.mcp/server -- sh -c 'QYL_DEMO=1 exec node dist/main.js --stdio'` | not recorded | GREEN required for modern tools/list, legacy tools/list, schema portability |

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

## Production endpoint `https://mcp.qyl.at/mcp`

| Check | How | Date | Observation |
| --- | --- | --- | --- |
| Unauthenticated `/mcp` returns 401 with `resource_metadata` | curl | not recorded | |
| Protected resource metadata names the resource, issuer `https://qyl-eu.eu.auth0.com/` and scope `qyl:read` | curl | not recorded | |
| Modern `tools/list` with `MCP-Protocol-Version: 2026-07-28` | owner action: Inspector 2.9.0 with OAuth login and `protocolEra: "modern"` (goal step 4) | not recorded | |
| 2025-era `tools/list` | owner action: same Inspector run with `protocolEra: "legacy"` | not recorded | |
| `events/list` returns `trace.error` | modern client | not recorded | |
| Deployed commit equals `main` | Railway deployment id | not recorded | |

## Client connections

Each row needs the client version, the registration path (pre-registered,
CIMD or DCR), the negotiated protocol, the granted scopes, the read tool
called and its result.

| Client | Date | Version | Registration | Protocol | Auth | `tools/list` | Read call | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT web | not recorded | | | | | | | |
| Codex plugin or CLI | not recorded | | | | | | | |
| claude.ai | not recorded | | | | | | | |
| Claude Code | not recorded | | | | | | | |
| MCP Inspector | not recorded | | | | | | | |

## Events lifecycle on a 2026-07-28 ChatGPT surface

| Step | Date | Observation |
| --- | --- | --- |
| Subscribe to `trace.error` | not recorded | |
| A matching error delivers a signed notification | not recorded | |
| A non-matching service does not deliver | not recorded | |
| The subscription survives a deployment | not recorded | |
| Automatic renewal | not recorded | |
| Unsubscribe removes the subscription and stops delivery | not recorded | |
| Revoked access stops delivery | not recorded | |

## Package

| Item | Value | Date | Observation |
| --- | --- | --- | --- |
| `server/package.json` version | 7.2.0 | 8 October 2026 | source |
| npm `qyl-mcp-server` latest | not recorded | | `npm view qyl-mcp-server version` |
| Fresh consumer check, both eras | `server/published-smoke.mjs` | not recorded | |

## Directory records

| Record | Portal | State | Evidence |
| --- | --- | --- | --- |
| OPENAI_PLUGIN | https://platform.openai.com/plugins | local draft, not uploaded | `submission/qyl/` |
| ANTHROPIC_CONNECTOR | https://claude.ai/directory/manage | not created | |
| ANTHROPIC_PLUGIN | https://claude.ai/directory/manage | not created, bundle files absent | |

Portal status is recorded only from the portal itself, with a date. Uploaded
is not submitted, validated is not approved, approved is not published.

## Owner actions required

| Action | Needed for | State |
| --- | --- | --- |
| Select the publisher identity in the OpenAI portal | OPENAI_PLUGIN | open |
| Publish support, privacy and terms pages on qyl.at | all three records | open |
| Reviewer account with isolated sample telemetry | all three records | open |
| Demo recording URL | OPENAI_PLUGIN review | open |
| Legal attestations and submission | all three records | open |
| Publication after approval | all three records | separate decision |

## Auth0 discovery decision

Auth0 is the authorization server and already serves OIDC discovery at
`https://qyl-eu.eu.auth0.com/.well-known/openid-configuration`. qyl.mcp does not
serve `/.well-known/openid-configuration` on `mcp.qyl.at`, because qyl.mcp is a
resource server rather than the token issuer. If ChatGPT workspace domain
claiming is needed, enable `openid` and `email` for the OAuth client and verify
that Auth0 UserInfo returns a verified email; this does not replace the
resource permission `qyl:read`.
