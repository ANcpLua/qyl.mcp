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
| Tool-call records persist `arguments` and `_meta` | `server/src/native-execution.ts` | present, removal is goal step 1 |
| OpenAI plugin draft | `submission/qyl/plugin.json`, `mcp.json` | present, not uploaded |
| Anthropic bundle (`.claude-plugin/plugin.json`, `.mcp.json`) | `submission/qyl/` | absent |
| Agent skill | `submission/qyl/skills/` | absent |

## Local checks

| Check | Command | Last run | Result |
| --- | --- | --- | --- |
| Build | `bun run build` | not recorded | |
| Tests | `bun run test` | not recorded | |
| Transport smoke, both eras | `bun run smoke` | not recorded | |
| Collector contract smoke | `bun run smoke:otlp` | not recorded | |
| Project isolation smoke | `bun run smoke:projects` | not recorded | |
| SDK v1 dependency check | `bun run verify:sdk` | not on `main` yet | |

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
