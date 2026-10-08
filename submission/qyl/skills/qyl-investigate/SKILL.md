---
name: qyl-investigate
description: Investigate a running system through qyl telemetry with the qyl MCP tools. Use when asked why something failed or is slow, what a trace, session, log or metric shows, or how healthy the MCP tools themselves are.
---

# Investigate with qyl

qyl measures and correlates; use the results to reason about the system.
The current telemetry tools read data. Actions in other systems belong to
the agent or person with the appropriate connector and authorization.

## Workflow

1. **Find the failing unit.** Start with `list_sessions` (use `active_only`
   for what is running now) and `list_traces`. The error flag and duration tell
   you where to go deeper.
2. **Follow one trace.** Call `get_trace` with the trace id. It returns the
   whole span tree and can be large, so pick the trace deliberately. For large
   traces, use `display_traces` for a visual waterfall and `search_logs` for
   filtered detail. Then call `search_logs`
   with the same `trace_id` and `severity_min` 17 to get the error logs that
   belong to it. That is the trace-to-log correlation; do not guess it.
3. **Read metrics in order.** `list_metrics` gives the exact instrument
   names. `get_metric_series` shows which attribute streams exist under one
   name, so you know what to pass as `group_by` or `attr`. `query_metric`
   returns the windowed series. With `step_ms` equal to the window duration,
   each grouping yields one bucket: one number per series.
4. **Check the tools themselves.** `display_mcp_dashboard` with `hours`
   shows latency and error rate per MCP tool and server for recorded spans
   carrying `mcp.method.name`. A call is visible only if its telemetry reached
   the selected Collector project.
5. **Show, don't paste.** When a person is watching, open `display_traces`
   for the waterfall and detail panel instead of quoting spans.
6. **CI from telemetry.** `ci_log` lists CI runs whose resource
   `service.name` starts with `qyl-ci`. Emit `session.id` for the run and one
   span per phase with `ci.leg`; failed phases set span status to error. The
   run list filters the 50 most recent sessions and defaults to 10 matching
   runs. With `run_id`, the tool reads up to 100 traces for that session and
   returns per-leg phases with failures first. Any CI emitting this convention
   can use the tool; these bounds can leave older runs or phases out.
7. **Get notified.** When the user wants notifications, use a client and deployment that expose
   MCP Events to subscribe to `trace.error`, optionally narrowed to one
   `service_name`. A telemetry investigation alone does not authorize a
   subscription. Check the subscription result rather than assuming delivery.

## Rules

- An empty result means no matching data was recorded. It does not mean
  there was no error, and it does not mean the system is healthy.
- Never invent a trace, session or metric name. Take ids from a previous
  result.
- Report what the collector returned, including upstream errors, in the
  words of the result. Do not substitute demo data for live data.
- qyl cannot delete telemetry, deploy, roll back or search the web. State
  the limitation plainly and use the appropriate authorized connector for
  those actions.
