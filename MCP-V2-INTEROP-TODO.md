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
| Anthropic bundle (`.claude-plugin/plugin.json`, `.mcp.json`) | `submission/qyl/` | absent |
| Agent skill | `submission/qyl/skills/` | absent |

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

## Production endpoint `https://mcp.qyl.at/mcp`

| Check | How | Date | Observation |
| --- | --- | --- | --- |
| Unauthenticated `/mcp` returns 401 with `resource_metadata` | curl | not recorded | |
| Protected resource metadata names the resource, issuer `https://qyl-eu.eu.auth0.com/` and scope `qyl:read` | curl | not recorded | |
| Modern `tools/list` with `MCP-Protocol-Version: 2026-07-28` | Inspector `protocolEra: modern` | not recorded | |
| 2025-era `tools/list` | default SDK client | not recorded | |
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
