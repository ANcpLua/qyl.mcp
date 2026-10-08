# qyl

qyl is observability built for AI agents. This plugin connects Claude or
ChatGPT to the hosted qyl MCP server at `https://mcp.qyl.at/mcp`, which acts
as a semantic gateway to the telemetry in your own qyl collector: traces,
logs, metric instruments, sessions and MCP runtime statistics.

Instead of reading raw log dumps, the model asks compact questions. Which
sessions are failing? What happened inside this trace? Which log records
belong to it? How did this metric move over the last hour? qyl returns the
collector's actual answers, including empty results and upstream errors, and
can render them in an interactive Trace Explorer and MCP Dashboard. On deployments and clients that support MCP Events, an explicit
subscription can notify the client about new trace errors. qyl measures and correlates; the agent reasons and acts.

## What it needs

- A qyl collector that your account is authorized to read. Sign-in uses
  OAuth; the server announces its authorization server through its
  protected-resource metadata, and the required scope is `qyl:read`.
- No credentials in this package. Access is derived from your sign-in only.

## Tools

Every tool in the current server catalog is read-only and carries the
matching annotations. Confirmation behavior is controlled by the client. `list_sessions`, `list_traces`, `get_trace` and `search_logs`
read telemetry; `list_metrics`, `get_metric_series` and `query_metric` read
metrics; `display_traces` and `display_mcp_dashboard` open the interactive
viewers; `ci_log` reads CI runs whose telemetry follows qyl's CI emitter
convention. The bundled skill `skills/qyl-investigate/SKILL.md` describes the
investigation workflow the tools are designed for.

## Documentation and source

Source, server documentation and the tool contract live in the repository at
<https://github.com/ANcpLua/qyl.mcp>. The product site is <https://qyl.at/>.
