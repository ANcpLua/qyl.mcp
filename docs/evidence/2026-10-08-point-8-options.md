# Point 8 Option A — 2026-10-08

This continuation follows the owner's Collector-first sequence. It supersedes
the [earlier pin blocker](2026-10-08-followup-15.md#release-blocker-refreshed-after-owner-release).
The Inspector proof is supplied by the owner. Production handshake evidence
requires a successful Collector deployment on Railway first.

## Collector prerequisite

`codex/contracts-11-3` started at qyl `origin/main`
`d1de0c953d469edf8d9ef4168dc6fb5c0f016dfd`. The initial single-property bump
exposed an existing gate: `VerifyFrontendApiTypes` reported
`Generated contract versions disagree: dashboard uses 11.2.0, .NET uses 11.3.0.`
The same PR therefore updates the dashboard dependency/lockfile and the README
release row required by `RenderReadmeVersions`. Both gates remain unchanged.

Local commands, exit 0:

```sh
dotnet msbuild services/qyl.collector/qyl.collector.csproj -getProperty:QylApiContractsVersion
dotnet restore services/qyl.collector/qyl.collector.csproj --configfile nuget.config -p:TreatWarningsAsErrors=false
dotnet build services/qyl.collector/qyl.collector.csproj --configuration Release --no-restore -p:QylEmbedDashboard=false
./eng/build.sh VerifyFrontendApiTypes RenderReadmeVersions --Configuration Release
bun run --cwd services/qyl.dashboard typecheck
```

Actual relevant output:

```text
11.3.0
Build succeeded.
    0 Warning(s)
    0 Error(s)
Product dashboard consumes @ancplua/qyl-api-schema 11.3.0 directly
README release lines already match Version.props
```

The build-tool compilation also reported two existing style warnings
(`IDE0200`, `CA1865`); the Collector build above reported none.

[qyl PR #642](https://github.com/ANcpLua/qyl/pull/642) was merged only after
all its CI checks passed at head `8691bfb2c21f2ad48222b73d2e44f9480f83620d`:
Backend, Frontend, NativeAOT, API SDK, tool packaging, dependency audit,
Playwright, CodeQL, link checks and all six consumer-platform smokes.
The release-only pack/publish jobs were skipped by their normal PR conditions.
[CI run](https://github.com/ANcpLua/qyl/actions/runs/37747010150),
[consumer run](https://github.com/ANcpLua/qyl/actions/runs/37747010032).

Command and actual output, exit 0:

```sh
gh pr view 642 --repo ANcpLua/qyl --json url,state,headRefOid,mergedAt,mergeCommit
```

```json
{"headRefOid":"8691bfb2c21f2ad48222b73d2e44f9480f83620d","mergeCommit":{"oid":"15924345bd804c358b1ab22d059b27d815bc8874"},"mergedAt":"2026-10-08T08:08:11Z","state":"MERGED","url":"https://github.com/ANcpLua/qyl/pull/642"}
```

The local qyl checkout was then moved to that `main`. Its older, unrelated
local main history was preserved as `codex/local-main-before-contracts-20261008`;
no reset was used. qyl.mcp's `codex/point-8-contract-options` branch was created
afterwards from `origin/main` `f49d55258d44810b72763b7e25f21b9e421295b1`.

## Matching local pins

Date: 2026-10-08. `git status --short --branch`, `git rev-parse HEAD` and
`rg 'QylApiContractsVersion' Version.props` in `../qyl` returned:

```text
## main...origin/main
15924345bd804c358b1ab22d059b27d815bc8874
    <QylApiContractsVersion>11.3.0</QylApiContractsVersion>
```

After updating server, workbench and dashboard to the same exact npm version,
`bun install --ignore-scripts` updated the lockfile. `bun run verify:pins`
from qyl.mcp exited 0 with this actual output:

```text
$ node verify-contract-pins.mjs
verify:pins: contract pins agree (@ancplua/qyl-api-schema 11.3.0 == Qyl.Api.Contracts 11.3.0, via /Users/alexandernachtmann/RiderProjects/qyl)
```

The checker used its ordinary sibling-checkout lookup. This is local contract
agreement, not a production handshake.

## Runtime options and manifest

`get_trace` filters error-status spans before applying `max_spans` in Collector
order. It removes a separately encoded root when that root is outside the
selection. Attribute omission covers span/resource/event/link/scope collections
and the root copy. Trace summary totals retain their Collector meanings, and
the text explicitly states returned and matching counts.

`ci_log` applies the case-sensitive prefix to session selection before the run
limit and to individual phase spans in run detail. The default is `qyl-ci`.
Empty-result messages identify the requested prefix. Upstream errors retain
the existing error path. Both tools continue to use the request's Collector
scope and the final redaction guard.

The published 11.2.0/11.3.0 JSON Schema comparison changed only
`Mcp.Tools.GetTraceInput` and `Mcp.Tools.CiLogInput`. After compilation,
`node server/update-tool-manifest-snapshot.mjs` generated the new manifest.
This comparison of the base and new JSON objects exited 0:

```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
old = json.loads(subprocess.check_output(['git','show','origin/main:server/tool-manifest.snapshot.json']))
new = json.loads(Path('server/tool-manifest.snapshot.json').read_text())
changes=[]
for before, after in zip(old['tools'],new['tools'],strict=True):
    assert before['name'] == after['name']
    for key in set(before) | set(after):
        if before.get(key) != after.get(key): changes.append(f"{after['name']}.{key}")
assert sorted(changes) == ['ci_log.description','ci_log.inputSchema','get_trace.description','get_trace.inputSchema'], changes
assert old['resources'] == new['resources']
print('Changed tool fields: '+', '.join(sorted(changes)))
print('All 11 output schemas, annotations, metadata and resource entries unchanged.')
print('Contract revision: '+old['contract_revision']+' -> '+new['contract_revision'])
PY
```

Actual output:

```text
Changed tool fields: ci_log.description, ci_log.inputSchema, get_trace.description, get_trace.inputSchema
All 11 output schemas, annotations, metadata and resource entries unchanged.
Contract revision: sha256:75278211aa54def8 -> sha256:382526f13652d18b
```

## Local verification

The first sandboxed server run passed all six new option tests. Three existing
HTTP fixture tests failed with `listen EPERM: operation not permitted 127.0.0.1`;
the manifest comparison also correctly failed before its deliberate update.
The full run with local-socket permission passed after regeneration.

`bun run build` and `QYL_MCP_TELEMETRY=0 bun run test` both exited 0.
The four test processes reported these actual totals (345 passed overall):

```text
ℹ tests 167
ℹ pass 167
ℹ fail 0
ℹ tests 142
ℹ pass 142
ℹ fail 0
ℹ tests 32
ℹ pass 32
ℹ fail 0
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

New passing tests in `server/src/tool-options.test.ts`:

- `get_trace defaults preserve the complete trace and attributes`
- `get_trace filters errors before capping spans and retains honest trace totals`
- `get_trace omits all attribute collections including the root copy and keeps event and link identities`
- `get_trace reports empty error matches without adding a nonmatching root`
- `ci_log applies the case-sensitive service prefix to run lists before their limit and to phase breakdowns`
- `filtered tools preserve upstream errors instead of manufacturing empty or demo results`

`published telemetry schemas own defaults, bounds, and required tool inputs`
also covers generated defaults, integer span bounds 1–1000, boolean types and
prefix lengths 1–256. No substitute input schema was introduced.

An initial lint run caught an unused destructuring binding in the attribute
projection. After changing that helper to delete the property from a shallow
copy, the following final commands exited 0:

```sh
bun run --cwd server build
bun run lint
bun x tsc -p server/tsconfig.test.json
QYL_MCP_TELEMETRY=0 node --test server/dist-test/tool-options.test.js server/dist-test/contracts.test.js server/dist-test/ci.test.js server/dist-test/tool-manifest.test.js
bun run verify:sdk
```

Actual final focused and SDK summaries:

```text
$ oxlint .
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ tests 5
ℹ pass 5
ℹ fail 0
MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).
```

The new tests run through SDK HTTP handling with a mocked Collector response,
not through a production account. The ordinary Collector smoke results below
are local integration evidence as well.

## Local integration and completion gates

On 2026-10-08, each command below exited 0 against the local built Collector
from the merged `../qyl` checkout. These are temporary local fixtures.

```sh
QYL_MCP_TELEMETRY=0 bun run smoke
QYL_MCP_TELEMETRY=0 bun run smoke:otlp
QYL_MCP_TELEMETRY=0 bun run smoke:projects
PATH="/private/tmp/qyl-option-a/venv/bin:$PATH" bun run verify:completion
```

Actual transport-smoke output excerpt (last eight lines):

```text
ok in-process tools/call recording is native and automatic
ok disabled MCP telemetry is explicit and does not fabricate evidence
ok invalid tool arguments return generated Problem Details
ok malformed JSON returns generated validation Problem Details
ok rebound Host is rejected
ok untrusted browser Origin is rejected
ok workbench disconnects the built-in MCP server
ok workbench reconnects the built-in MCP server
```

Actual OTLP output:

```text
$ bun run --cwd workbench smoke:otlp
$ node telemetry-smoke.mjs
ok official OTLP/protobuf receiver parsed and persisted the SDK export
ok user content and URI secrets were not exported
ok generated Qyl contract publishes the metrics read surface
ok live metrics catalog is contract-shaped (2 instruments)
ok real workbench returned exact trace evidence
ok native server span was correlated without tool payload content
ok OTel operation logs carry the matching trace and span identifiers
ok live MCP log filters exclude unrelated services, severities, traces and bodies
ok live MCP log searches preserve empty results and the requested limit
ok generated API-key auth and Qyl schemas validate live telemetry reads
```

Actual project-isolation output:

```text
$ bun run --cwd server smoke:projects
$ node project-access-smoke.mjs
ok real OTLP traces, logs and metrics stored under two separate project credentials
ok 2026-07-28: all 11 tools and viewer paths isolate concurrent accounts; foreign trace IDs and unassigned accounts denied
ok 2025-11-25: all 11 tools and viewer paths isolate concurrent accounts; foreign trace IDs and unassigned accounts denied
ok Events: same trace ID stays project-scoped; signatures, unsubscribe and assignment revocation pass
all real-Collector project-isolation checks passed (local test identities; hosted reviewer login still required)
```

Actual completion-audit output:

```text
$ python3 -m unittest discover -s scripts -p test_verify_completion.py && python3 scripts/verify-completion.py
........
----------------------------------------------------------------------
Ran 8 tests in 0.148s

OK
PASS: 8 bundle files and 5 handoff files
PASS: plugin.json and mcp.json validate against submission/schemas (Draft 2020-12)
PASS: README 687 words outside code blocks (minimum 40)
PASS: all 11 tool descriptions state user need without model instructions
PASS: strict native record contains only reviewed metadata; no arguments/_meta
PASS: ledger has no not-recorded table rows
PASS: 251 local documentation/evidence links and heading anchors resolve
Completion audit passed; production, owner actions and prose evidence still require review.
```

## Production boundary

The read-only Railway trigger query showed `ANcpLua/qyl:main`,
`checkSuites: true`, service `ff836187-b65c-4645-ab40-67b54fbfa93f` in production
environment `616ff7bf-ef19-4e34-bb22-d3eb002b74e9`.

The post-merge deployment-list command was:

```sh
railway deployment list --project 5eaa4020-71d9-4828-89d3-316cb188529e --service ff836187-b65c-4645-ab40-67b54fbfa93f --environment production --limit 2 --json | jq '[.[] | {id,status,createdAt,commitHash:.meta.commitHash,branch:.meta.branch}]'
```

Actual output at the first post-merge observation:

```json
[
  {"id":"a8f98435-c8a8-4e2d-b3a4-d9c6f9dd3145","status":"WAITING","createdAt":"2026-10-08T08:08:13.723Z","commitHash":"15924345bd804c358b1ab22d059b27d815bc8874","branch":"main"},
  {"id":"dd692b69-4c90-40e1-8363-481662f645d8","status":"SUCCESS","createdAt":"2026-10-07T22:55:08.887Z","commitHash":"d1de0c953d469edf8d9ef4168dc6fb5c0f016dfd","branch":"main"}
]
```

At that observation the new build was still waiting. No production handshake
was inferred from the merge or local tests. The Inspector evidence remains
owner-supplied and is separate from these checks.
