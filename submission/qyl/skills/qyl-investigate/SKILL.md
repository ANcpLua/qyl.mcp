---
name: qyl-investigate
description: Investigate a running system through qyl telemetry with the qyl MCP tools. Use when asked why something failed or is slow, what a trace, session, log or metric shows, or how healthy the MCP tools themselves are.
---

# Investigate with qyl

qyl measures and correlates. You reason and act. Every qyl tool only reads,
so you can investigate freely; the fix belongs to the agent or person who
owns the code.

## Workflow

1. **Find the failing unit.** Start with `list_sessions` (use `active_only`
   for what is running now) or `list_traces`. The error flag and duration tell
   you where to go deeper.
2. **Follow one trace.** Call `get_trace` with the trace id. It returns the
   whole span tree, so pick the trace deliberately. Then call `search_logs`
   with the same `trace_id` and `severity_min` 17 to get the error logs that
   belong to it. That is the trace-to-log correlation; do not guess it.
3. **Read metrics in order.** `list_metrics` gives the exact instrument
   names. `get_metric_series` shows which attribute streams exist under one
   name, so you know what to pass as `group_by` or `attr`. `query_metric`
   returns the windowed series; one bucket over the whole window collapses the
   answer to a single number.
4. **Check the tools themselves.** `display_mcp_dashboard` with `hours`
   shows latency and error rate per MCP tool and server, including your own
   calls.
5. **Show, don't paste.** When a person is watching, open `display_traces`
   for the waterfall and detail panel instead of quoting spans.
6. **CI from telemetry.** `ci_log` lists CI runs whose resource
   `service.name` starts with `qyl-ci` and, with a `run_id`, the per-leg
   phases with failures first. Any CI that emits that convention can use it.
7. **Get notified.** In clients that support MCP Events, subscribe to
   `trace.error`, optionally narrowed to one `service_name`.

## Rules

- An empty result means no matching data was recorded. It does not mean
  there was no error, and it does not mean the system is healthy.
- Never invent a trace, session or metric name. Take ids from a previous
  result.
- Report what the collector returned, including upstream errors, in the
  words of the result. Do not substitute demo data for live data.
- qyl cannot delete telemetry, deploy, roll back or search the web. Say so
  and hand the action to the right tool.
