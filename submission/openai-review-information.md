# OpenAI plugin review information (draft for the portal's review fields)

Paste each section into the field of the same name on the plugin's review page
(https://platform.openai.com/plugins/manage/plugin_asdk_app_6acf4a9531888191af07c032f362f95d?tab=mcp).
Fields marked OWNER FIELD need values that never go into this file.

## What the plugin does

qyl connects ChatGPT to the telemetry a user's services send to a qyl Collector: traces, logs, metrics, sessions, CI runs and MCP tool calls, recorded on OpenTelemetry semantic conventions. Users investigate a running system from the conversation:
- what changed, with new or worsening failures, regressions and releases ranked
- a failure's path with its logs
- whether a fix held

They can also keep notes and saved queries beside the data. Two interactive views ship with the server: a Trace Explorer and an MCP Dashboard.

## Server and authentication

- **MCP server:** https://mcp.qyl.at/mcp (Streamable HTTP).
- **Sign-in:** OAuth 2.1 through Auth0, with three scopes:
  - `qyl:read`: every read tool
  - `qyl:write`: create and update notes and saved queries, and set a failure's status
  - `qyl:delete`: delete notes and saved queries
- **Project:** the server picks the Collector project the account may use. No project id is typed by the user.
- **Tool schemas:** output schemas are inlined, without `$ref`.
- **Skill:** the bundle carries the qyl-investigate skill, which says which tool to start with.

## Tools (32; manifest `server/tool-manifest.snapshot.json`)

- **26 read tools** with `readOnlyHint: true`:
  - triage, failures and failure context, fix verification
  - trace, session, log, metric and CI reads
  - aggregates, group comparisons, attribute discovery
  - agent runs, releases, service map, telemetry health, MCP statistics
  - the two viewers
  - `fetch_telemetry`, which only the Trace Explorer calls
- **6 write tools** with `readOnlyHint: false`:
  - create and update annotations
  - create and update saved queries
  - update failure status
  - `delete`

  The update tools and `delete` also carry `destructiveHint: true`.
- **What no tool can do:** change or delete telemetry, deploy or roll back anything, or reach the public web.

## How to test (with the reviewer account below)

1. "What changed in the last 24 hours?" calls `triage`. It returns ranked failures, regressions and releases, or states plainly that nothing was recorded.
2. "Show me the slowest traces today and open the worst one" calls `list_traces`, then `get_trace` or `display_traces` (the Trace Explorer view).
3. "Why is the checkout failing?" calls `list_failures`, then `get_failure_context`, which returns the failure's spans with their error logs.
4. "Did the fix for that failure hold since the last release?" calls `verify_fix` with the failure id and `release`.
5. "Compare the error rate of the two latest versions" calls `compare_groups`.
6. "Which metrics do we record? Plot the request duration p95 per hour" calls `list_metrics`, then `query_metric`. A percentile on a gauge is refused with a clear validation error, by design.
7. "Note on that trace: investigated, caused by the cache flush" calls `create_annotation` (needs `qyl:write`). Then "delete that note" calls `delete` (needs `qyl:delete`).
8. "Open the MCP dashboard" calls `display_mcp_dashboard`.

An empty answer means nothing matching was recorded in the project, not that the system is healthy. The tools say so in their text.

## Data handling

- **What it reads:** telemetry already stored in the user's own Collector project.
- **What it writes:** only annotations, saved queries and failure status, in that project.
- **What the Collector stores:** before storing, it drops attributes the qyl registry denies, such as credentials, message bodies, personal identifiers and full URLs.
- **What it shares:** nothing with third parties.
- **Privacy policy:** https://qyl.at/privacy/
- **Documentation:** https://qyl.at/docs/mcp/

## Reviewer access — OWNER FIELD (private credential fields only)

An isolated, populated Collector project and a dedicated reviewer account. They must be seeded with traces, sessions, metrics, error logs and at least one failure with a later release, so steps 1–8 return data.

In the portal's private fields, supply:
- the login URL
- the account
- the access mechanism
- the exact sign-in steps

Access must work without the owner's mailbox, phone or network, and stay valid through the review.
