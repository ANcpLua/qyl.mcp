# Point 9: output-schema portability, 2026-10-08

The owner reported Inspector 2.9.0 portability findings in the output schemas
of `display_traces`, `get_trace`, `list_traces`, `search_logs`,
`get_metric_series` and `query_metric`. This change normalizes the spelling
emitted by `compactOutputSchema`; it does not edit the published contract or
change its Zod validators. These are local source, test and SDK catalog checks,
not an authenticated Inspector session. The owner supplies that evidence.

## Preceding merge

Before creating `codex/point-9-schema-portability`, this command confirmed the
preceding PR and its gates:

```sh
gh pr view 119 --repo ANcpLua/qyl.mcp --json state,headRefOid,mergeCommit,mergedAt,statusCheckRollup
```

Actual result, relevant fields:

```text
state: MERGED
headRefOid: 032196367f623bbe1fecddcabe5013a8984f8072
mergeCommit: 4e69bf2d123e41b17edab9505cc4aaa2a410d196
mergedAt: 2026-10-08T08:37:26Z
lint: SUCCESS
verify: SUCCESS
owner-review/content: SUCCESS
owner-review/evidence: SUCCESS
```

The branch was created with `git switch -c codex/point-9-schema-portability origin/main`
after fetching that merge and fast-forwarding local `main` to it. All four
required statuses were read as green on the reviewed head before the merge.

## Source and snapshot comparison

The installed Zod 4.6.5 emitter applies `compactTypeUnion` after its override
hook, then returns a JSON-cloned result. Normalization therefore runs on each
finished JSON object, before choosing the smaller inline or hoisted form.
It visits schema locations, including `$defs`, but leaves literal defaults,
examples, enum and const values alone. Existing combinators remain conjunctive.
The wrapper's `validate` delegation and cache are unchanged.

The published nullable metric bucket remains unchanged. This command in
`server/` reads the installed 11.3.0 source:

```sh
node --input-type=module - <<'JS'
import schema from '@ancplua/qyl-api-schema/json-schema' with {type:'json'};
console.log(JSON.stringify(schema.$defs['OTel.Metrics.MetricBucket'].properties.value,null,2));
JS
```

Its actual value schema contains
`"anyOf": [{"type":"number","format":"double"},{"type":"null"}]`
and the existing empty-bucket description. No package, lockfile or generated
contract source changed. The advertised spelling restores `anyOf` without
adding constraints lost earlier in the existing Zod conversion.

`bun run --cwd server snapshot:tools` exited 0 and printed
`wrote /Users/alexandernachtmann/RiderProjects/qyl.mcp/server/tool-manifest.snapshot.json`.
The following comparison ran against the preceding merged `origin/main`:

```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
old=json.loads(subprocess.check_output(['git','show','origin/main:server/tool-manifest.snapshot.json']))
new=json.loads(Path('server/tool-manifest.snapshot.json').read_text())
changes=[]
def compare(a,b,path):
 if a==b:return
 if path.endswith('/additionalProperties') and a=={} and b is True:
  changes.append(('empty additionalProperties -> true',path));return
 if isinstance(a,dict) and isinstance(b,dict) and isinstance(a.get('type'),list):
  expected={k:v for k,v in a.items() if k!='type'}
  expected['anyOf']=[{'type':v} for v in a['type']]
  if expected==b:
   changes.append(('type array -> anyOf',path));return
 if isinstance(a,dict) and isinstance(b,dict) and a.keys()==b.keys():
  for k in a:compare(a[k],b[k],path+'/'+k)
 elif isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
  for i,(x,y) in enumerate(zip(a,b)):compare(x,y,path+'/'+str(i))
 else:raise AssertionError(f'Unexpected change at {path}: {a!r} -> {b!r}')
compare(old,new,'')
for kind,path in changes:
 index=int(path.split('/')[2]);print(old['tools'][index]['name']+': '+kind)
print('Only requested output spellings changed:',len(changes))
print('Unchanged contract_revision:',new['contract_revision'])
PY
```

Actual output, exit 0:

```text
display_traces: empty additionalProperties -> true
get_metric_series: empty additionalProperties -> true
get_trace: empty additionalProperties -> true
list_traces: empty additionalProperties -> true
list_traces: empty additionalProperties -> true
query_metric: type array -> anyOf
query_metric: empty additionalProperties -> true
search_logs: empty additionalProperties -> true
Only requested output spellings changed: 8
Unchanged contract_revision: sha256:382526f13652d18b
```

Thus all input schemas, descriptions, annotations, resource references and the
other output schemas match the preceding merged manifest.

## Tests and repository gates

On 2026-10-08:

```sh
QYL_MCP_TELEMETRY=0 node --test server/dist-test/compact-output-schema.test.js server/dist-test/tool-manifest.test.js
QYL_MCP_TELEMETRY=0 bun run test
bun run lint
bun run verify:sdk
bun run verify:pins
git diff --check
```

The focused run passed six tests, including the existing snapshot comparison:

```text
compact output spells unconstrained additional properties as true and preserves constraints
compact output spells nullable type arrays as anyOf without changing validation
compact output normalizes hoisted definitions and retains their references
compact output preserves literal data and an existing anyOf conjunction
the published tool manifest matches its committed snapshot
telemetry tools advertise portable output schema spellings through the SDK
tests 6; pass 6; fail 0
```

After strengthening the dictionary-validation assertions, the full command
exited 0: server `tests 173; pass 173; fail 0`, workbench
`tests 142; pass 142; fail 0`, dashboard `tests 32; pass 32; fail 0`, and site
`tests 4; pass 4; fail 0` (351 total). Valid and invalid dictionary and nullable
number inputs produce the same Standard Schema results before and after
wrapping. Constrained dictionaries and `additionalProperties: false` remain
constrained, including in the emitted output.

Lint printed `$ oxlint .` and exited 0. The SDK check passed five tests and
printed `MCP SDK boundary passed for 7 manifests/lockfiles (SDK v2; exact pins).`
The diff check was silent, exit 0. The actual pin output was:

```text
$ node verify-contract-pins.mjs
verify:pins: contract pins agree (@ancplua/qyl-api-schema 11.3.0 == Qyl.Api.Contracts 11.3.0, via /Users/alexandernachtmann/RiderProjects/qyl)
```

`QYL_MCP_TELEMETRY=0 bun run smoke` also exited 0 on 2026-10-08. Actual final
output excerpt:

```text
ok real SDK discovery returns eleven tools and server surfaces
ok all qyl inspection tools publish complete read-only safety annotations
ok explicitly read-only tools run without synthesized confirmation
ok schema-aware workbench invocation retains real execution evidence
ok in-process tools/call recording is native and automatic
ok disabled MCP telemetry is explicit and does not fabricate evidence
ok invalid tool arguments return generated Problem Details
ok malformed JSON returns generated validation Problem Details
ok rebound Host is rejected
ok untrusted browser Origin is rejected
ok workbench disconnects the built-in MCP server
ok workbench reconnects the built-in MCP server
```

Final documentation check on 2026-10-08:

```sh
PATH="/private/tmp/qyl-option-a/venv/bin:$PATH" bun run verify:completion
```

Actual output, exit 0:

```text
Ran 8 tests in 0.139s
OK
PASS: 8 bundle files and 5 handoff files
PASS: plugin.json and mcp.json validate against submission/schemas (Draft 2020-12)
PASS: README 687 words outside code blocks (minimum 40)
PASS: all 11 tool descriptions state user need without model instructions
PASS: strict native record contains only reviewed metadata; no arguments/_meta
PASS: ledger has no not-recorded table rows
PASS: 253 local documentation/evidence links and heading anchors resolve
Completion audit passed; production, owner actions and prose evidence still require review.
```
