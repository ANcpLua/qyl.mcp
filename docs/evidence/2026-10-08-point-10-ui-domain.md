# Point 10: client-specific viewer domains, 2026-10-08

The owner reported that Trace Explorer and MCP Dashboard did not render in
claude.ai, with `ui.domain validation failed` for `https://mcp.qyl.at/mcp`.
This evidence covers source inspection, local SDK requests and tests. It
does not claim a fresh authenticated Claude or ChatGPT rendering observation.

## Preceding merge

Before branching, `gh pr view 120 --repo ANcpLua/qyl.mcp --json
state,headRefOid,mergeCommit,mergedAt,statusCheckRollup` returned:

```text
state: MERGED
headRefOid: 9371b65e4a3475bdd67ca7c38dc5391deefa19b0
mergeCommit: ee4c5a0ba24f450165cb62183cd1396919e0d41b
mergedAt: 2026-10-08T09:26:44Z
lint: SUCCESS
verify: SUCCESS
owner-review/content: SUCCESS
owner-review/evidence: SUCCESS
```

`git status --short --branch` showed clean `main...origin/main` at that merge.
After `git fetch origin`, `git switch -c codex/point-10-client-ui-domain
origin/main` created this point's separate branch.

## Sources and implementation

Read on 2026-10-08:

- [Claude troubleshooting](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting)
  specifies the first 32 hexadecimal SHA-256 characters of the full connector
  URL plus `.claudemcpcontent.com`. Scheme, path and trailing slash matter.
- [OpenAI resource metadata reference](https://developers.openai.com/plugins/reference)
  requires a dedicated origin for UI plugin submission. `openai/widgetDomain`
  is a compatibility alias for the standard `ui.domain` field already used here.
  The owner's older Apps SDK reference URL redirects to this page.
- [SDK v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
  documents request-scoped client info and the default stateless legacy fallback.
  Installed `@modelcontextprotocol/server` 2.3.1 types and implementation confirm
  that every legacy HTTP request gets a fresh server instance; its earlier
  `initialize.clientInfo` is not available on a later resource read.
- [Firsthand Claude connector trace](https://github.com/anthropics/claude-ai-mcp/issues/207)
  records `Anthropic/ClaudeAI` at initialization and `Claude-User` on later
  HTTP requests. This observed header is a presentation fallback, not an
  authenticated identity or a protocol requirement.

`main.ts` derives the existing canonical `/mcp` endpoint from the configured
HTTPS origin and supplies a domain resolver. The resolver hashes that exact
string, never the incoming request URL or headers. Modern reads use the SDK's
request envelope. Recognized Claude names include `claude-ai`, `Claude` and
`Anthropic/ClaudeAI`; absent client info falls back to the `Claude-User` HTTP
header. Other or absent hints yield the configured origin. Local resources
without a configured domain still omit it. Existing constant `uiDomain`
embedding overrides remain supported.

Each resource read computes its own metadata; the shared cache contains only
HTML. Hosted dynamic responses use `ttlMs: 0`, `cacheScope: private`, because
the response varies by client hint. Public catalog caching and constant-domain
resource caching are unchanged. Trace Explorer moves to `mcp-app-v5.html`,
MCP Dashboard to `mcp-dashboard-v3.html`, to invalidate old resource metadata.
The empty CSP allowlists, display modes, tool schemas, auth and Collector
selection are unchanged.

## Exact URL hashes

Executed in the repository on 2026-10-08:

```sh
node --input-type=module - <<'JS'
import {createHash} from 'node:crypto';
for (const url of ['https://mcp.qyl.at/mcp','https://mcp.qyl.at/mcp/','https://mcp.qyl.at/proxy/mcp','https://mcp.qyl.at']) console.log(url, createHash('sha256').update(url).digest('hex').slice(0,32)+'.claudemcpcontent.com');
JS
```

Actual output:

```text
https://mcp.qyl.at/mcp d2d8a324b34d6bf33467665cbb3dc80c.claudemcpcontent.com
https://mcp.qyl.at/mcp/ 0399981e0371e2c66391e3cb1dc441c3.claudemcpcontent.com
https://mcp.qyl.at/proxy/mcp 0ae989abb3194c49c99991f70ace9b6b.claudemcpcontent.com
https://mcp.qyl.at 862c0f6ab3fb1692fbe2c21a7decb91b.claudemcpcontent.com
```

The origin alone produces the wrong Claude domain. Tests use the three full
endpoint values as fixed expectations, while HTTP requests use a different
proxy hostname to check that configuration controls the hash.

## Local verification

All commands below ran on 2026-10-08 from the repository root.

```sh
QYL_MCP_TELEMETRY=0 bun run --cwd server snapshot:tools
QYL_MCP_TELEMETRY=0 bun run test
QYL_MCP_TELEMETRY=0 bun run smoke
bun run lint
bun run verify:sdk
bun run verify:pins
git diff --check
```

All exited 0 in the final run. The snapshot command printed
`wrote /Users/alexandernachtmann/RiderProjects/qyl.mcp/server/tool-manifest.snapshot.json`.
The full test command built the bundles and passed 356 tests:

```text
server:    tests 178, pass 178, fail 0
workbench: tests 142, pass 142, fail 0
dashboard: tests 32, pass 32, fail 0
site:      tests 4, pass 4, fail 0
```

The five new passing SDK-level tests in `server/src/ui-domain.test.ts` are:

```text
hosted viewers select Claude's hash or ChatGPT's origin per modern request
stateless legacy viewer reads use Claude-User without retaining initialize identity
Claude viewer domains hash the exact configured connector path and trailing slash
modern requests without clientInfo use the origin and do not inherit another caller
viewers without a public URL omit ui.domain for local clients
```

Both resources are read in every case. Modern tests interleave two Claude
client names with ChatGPT and Codex, repeat after the HTML cache is warm,
check unchanged CSP/display modes, and verify zero-TTL private cache hints.
A conflicting HTTP hint cannot override an explicit SDK client name.
Existing tests retain the constant-domain embedding path and public cache.

The initial build exposed SDK 2.3.1's empty neutral `RequestMetaEnvelope`
declaration. The implementation now narrows the runtime envelope and name
without importing wire types or using a deprecated accessor. The initial
test run also exposed three sandbox `listen EPERM` failures and a handcrafted
request missing the SDK-required `Mcp-Name` header. After adding that header
to the test and permitting local test listeners, the complete rerun above
passed. No transport validation or production gate was changed.

Actual smoke output excerpt:

```text
resources/read ui://qyl-explorer/mcp-dashboard-v3.html
  ok  dashboard resource serves non-empty HTML
  ok  dashboard resource has empty-CSP _meta
  ok  native tool execution evidence is automatic and terminal
  ok  native records contain only operation metadata
2025-era stdio compatibility
  ok  stock client negotiated the legacy era
  ok  legacy catalog has all 11 tools
  ok  legacy read tool returns real demo metrics
  ok  legacy invalid arguments remain a tool error
all checks passed
ok real SDK discovery returns eleven tools and server surfaces
ok rebound Host is rejected
ok untrusted browser Origin is rejected
ok workbench reconnects the built-in MCP server
```

Lint and `git diff --check` had no diagnostics. SDK verification passed five
tests and printed:

```text
MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).
```

Actual pin verification:

```text
verify:pins: contract pins agree (@ancplua/qyl-api-schema 11.3.0 == Qyl.Api.Contracts 11.3.0, via /Users/alexandernachtmann/RiderProjects/qyl)
```

## Snapshot review

This comparison ran against the preceding merged `origin/main`:

```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
old=json.loads(subprocess.check_output(['git','show','origin/main:server/tool-manifest.snapshot.json']))
new=json.loads(Path('server/tool-manifest.snapshot.json').read_text())
changes=[]
renames={'ui://qyl-explorer/mcp-app-v4.html':'ui://qyl-explorer/mcp-app-v5.html','ui://qyl-explorer/mcp-dashboard-v2.html':'ui://qyl-explorer/mcp-dashboard-v3.html'}
def compare(a,b,path=''):
    if a==b:return
    if isinstance(a,str) and renames.get(a)==b:
        changes.append(path);return
    if isinstance(a,dict) and isinstance(b,dict) and a.keys()==b.keys():
        for k in a: compare(a[k],b[k],path+'/'+k)
    elif isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
        for i,(x,y) in enumerate(zip(a,b)): compare(x,y,path+'/'+str(i))
    else: raise AssertionError(f'Unexpected change at {path}')
compare(old,new)
assert len(changes)==6,changes
print('Snapshot: only 6 versioned viewer URI/name values changed')
for path in changes: print(path)
print('All 11 tool schemas, descriptions and annotations unchanged')
PY
```

Actual output:

```text
Snapshot: only 6 versioned viewer URI/name values changed
/tools/1/meta/ui/resourceUri
/tools/2/meta/ui/resourceUri
/resources/0/uri
/resources/0/name
/resources/1/uri
/resources/1/name
All 11 tool schemas, descriptions and annotations unchanged
```

The point-10 PR requires its own `lint`, `verify`, `owner-review/content` and
`owner-review/evidence` success on the reviewed head. Local tests do not set
or substitute for those statuses. Authenticated host rendering remains a
separate owner observation after deployment.

## Documentation audit

On 2026-10-08, `PATH="/private/tmp/qyl-option-a/venv/bin:$PATH" bun run
verify:completion` exited 0 using the existing environment with the
repository's pinned audit requirements. Actual output:

```text
Ran 8 tests
OK
PASS: 8 bundle files and 5 handoff files
PASS: plugin.json and mcp.json validate against submission/schemas (Draft 2020-12)
PASS: README 687 words outside code blocks (minimum 40)
PASS: all 11 tool descriptions state user need without model instructions
PASS: strict native record contains only reviewed metadata; no arguments/_meta
PASS: ledger has no not-recorded table rows
PASS: 255 local documentation/evidence links and heading anchors resolve
Completion audit passed; production, owner actions and prose evidence still require review.
```
