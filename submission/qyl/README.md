# qyl

qyl is observability built for AI agents. This plugin connects Claude, ChatGPT
or Codex to the hosted qyl MCP server at `https://mcp.qyl.at/mcp`, a semantic
gateway to the telemetry your services send to a qyl Collector: traces, logs,
metrics, sessions and CI runs.

Instead of reading raw log dumps, the model asks compact questions. Which
sessions are failing? What happened inside this trace? Which log records
belong to it? How did this metric move over the last hour? qyl returns the
Collector's actual answers, including empty results and errors from the
Collector. qyl measures and correlates; the agent reasons and acts.

It is meant for developers and operators whose services already send
OpenTelemetry data to qyl and who want an agent to investigate failures,
latency and MCP tool behavior from that recorded data.

## What it needs

- An account that may read a qyl Collector project with recorded telemetry.
  Sign-in uses OAuth through qyl's Auth0 tenant, and the tools require the
  `qyl:read` scope. The server decides which Collector project an account
  can read; tool arguments never select another project.
- Nothing else: the plugin runs no local code and contains no API keys or
  other credentials.

## What it sends and receives

The plugin declares one remote MCP server. When a tool is used, your client
sends an MCP request with the tool name and its arguments (for example a
trace ID, service name or time window) and your OAuth access token to
`https://mcp.qyl.at/mcp`. The server reads the matching records from your
Collector project and returns them to your client. The server's own records of
incoming tool calls keep only the tool name, timing, status and error type,
not arguments or conversation text.

In clients and deployments that support MCP Events, you can explicitly
subscribe to notifications about new trace errors, optionally for one service.
Signed notifications go to the callback address your client registers. The
subscription record holds your account and client identifiers, the filter,
that callback address and signing keys until the subscription expires or is
removed. It holds no OAuth tokens and no copied telemetry.

## Tools

Every tool in the current catalog only reads data and is annotated as
read-only. Your client decides when to ask for confirmation.

| Tool | Use it to |
| --- | --- |
| `list_sessions`, `list_traces` | Find active, failing or slow work. |
| `get_trace` | Inspect one trace's complete span tree. |
| `search_logs` | Find error logs, including the logs that belong to one trace. |
| `list_metrics`, `get_metric_series`, `query_metric` | Discover metric instruments and their attribute streams, then compare a metric over time or across groups. |
| `ci_log` | Read CI runs that follow qyl's CI telemetry convention, failed phases first. |
| `display_traces`, `display_mcp_dashboard` | Open the Trace Explorer or the MCP Dashboard. |
| `fetch_telemetry` | Used only by the Trace Explorer to refresh or filter its view; hidden from the model. |

The bundled skill `skills/qyl-investigate/SKILL.md` describes the
investigation workflow these tools are designed for.

## Example prompts

- "Which of my recent traces failed, and what do their error logs say?"
- "List my five most recent sessions and summarize their status."
- "Which metric instruments are recorded in my qyl project?"
- "Open the Trace Explorer for my recent traces."

## Limits and troubleshooting

- qyl cannot delete or change telemetry, deploy or roll back services, or
  search the public web.
- An empty result means nothing matching was recorded in your project. It
  does not show that a system is healthy.
- Most tools take limits and filters. `get_trace` returns the full span
  tree, which can be large; `display_traces` shows it as a waterfall, and
  `search_logs` narrows logs by trace, service, severity or text.
- If sign-in fails or requests are rejected, reconnect qyl in your client and
  sign in with an account that has the `qyl:read` scope.
- If a tool reports that no Collector project is assigned to your account,
  ask the qyl operator for project access.
- The Trace Explorer and MCP Dashboard appear only in clients that display
  MCP Apps; other clients receive the text summary and structured result.
- The MCP Dashboard includes only MCP calls whose spans carry
  `mcp.method.name` and reached your Collector project.

## Documentation and source

Source, server documentation and the tool contract live in the repository at
<https://github.com/ANcpLua/qyl.mcp>. The product site is <https://qyl.at/>.
