---
name: observe-graph
description: Open qyl's fullscreen execution debugger for the current qyl codex run or a durable historical run. Use when the user asks to observe, inspect, visualize, debug, replay, interrupt, resume, or steer a Codex workflow, its agents, attempts, journal, critical path, conflicts, or tool activity.
---

# Observe Graph

Open the graph through the supported MCP App tool. Never claim or emulate an
`/observe-graph` command.

## Resolve the run

1. Call `get_active_workflow_run` on the local `qyl-observer` bridge.
2. If `active` is true, call remote `display_workflow_graph` with its `runId`.
   Treat this as the only live run for this Codex process.
3. If `active` is false, call remote `list_workflow_runs`. Choose a run named
   by the user; otherwise choose the newest returned run. Call
   `display_workflow_graph` with that `run_id`.
4. If no historical run exists, say that observation starts with `qyl codex`
   and stop.

Do not call app-only `fetch_workflow_graph_updates` directly. The MCP App owns
its bounded polling, cursor-gap recovery, and lazy content retrieval.

## Controls

- Allow `steer`, `interrupt`, and `resume` only when the local bridge returned
  the same active run.
- Use `control_workflow_run` only for an explicit user-requested action. Preserve
  its approval boundary and generate a fresh idempotency key.
- Never offer individual-agent pause, restart, or mutation.
- When the local bridge has no active run, state that the graph is historical
  and live controls are unavailable, even if remote metadata is stale.

Historical attempts and journal events are immutable. Interrupt and resume add
control events and another attempt; they never rewrite earlier outcomes.
