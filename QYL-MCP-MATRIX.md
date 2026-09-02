# qyl MCP Tool Use Matrix for qyl Repositories

The following tables define which qyl MCP server tools should be used for work in each qyl repository.

This is a recommendation based on the generated tool manifest snapshot, repository architecture and project contracts.
None of the qyl MCP tools was executed while producing this matrix.

`+` means the tool should be directly available and is preferred for suitable work.
`C` means conditional — applicable only in the scenario named in the section notes.
`U` means UI plumbing — called by the embedded explorer UI, never by the model directly.
`-` means the tool is technically related but native agent tools or repository commands are preferred.
`N/A` means the tool is not applicable to that repository. A blank cell means availability or relevance is not
sufficiently verified.

For the `Baseline` column:

- `Snapshot` means the tool appears in `server/tool-manifest.snapshot.json` at contract revision
  `sha256:a11cb761a9cb6534`. The server is closed-world: a fresh runtime `tools/list` must equal the snapshot, and the
  snapshot is regenerated only deliberately with its diff inspected.

Unlike the Rider inventory, there are no `VERIFY` or `GHOST` states: the generated manifest is the contract, so a tool
either exists at the pinned revision or it does not.

Repository abbreviations:

- `qyl.mcp` — MCP server, Workbench and dashboard
- `qyl.at` — Astro site and Cloudflare Worker
- `SemConv` — `Qyl.OpenTelemetry.SemanticConventions`
- `AutoInstr` — `Qyl.OpenTelemetry.AutoInstrumentation`

## Telemetry reading

| Tool            | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|-----------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `ci_log`        | Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |
| `list_sessions` | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `list_traces`   | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `get_trace`     | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `search_logs`   | Snapshot |  +  |    +    |   C    |    C    |     C     |

`ci_log` reads sessions whose `service.name` starts with `qyl-ci`; only qyl's own CI emits that telemetry
(`qyl/eng/tools/QylToolSmoke/CiTelemetry.cs`), so the tool is meaningless for the other repositories' CI runs. It stays
direct in `qyl.mcp` because `server/src/ci.ts` owns the implementation and dogfoods it.

Conditional scenarios for the generic readers:

- `qyl.at`: verifying that product documentation (`telemetry.mdx`, `getting-started.mdx`) matches live behavior; the
  site itself emits no OTLP.
- `SemConv`: confirming generated attribute names appear on real spans and logs.
- `AutoInstr`: confirming emitted instrumentation (spans, logs, GenAI token usage) arrives at a running collector.

## Interactive displays

| Tool                    | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|-------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `display_traces`        | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `display_mcp_dashboard` | Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |
| `display_workflow_graph`| Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |

Displays are preferred over their data counterparts whenever the user wants to SEE the result: `display_traces` over
`list_traces`/`get_trace` for waterfalls, `display_workflow_graph` over `get_workflow_graph` for run inspection.
`display_mcp_dashboard` aggregates spans carrying `mcp.method.name`; only qyl (collector ingest) and qyl.mcp (server
traffic) produce and own that data.

## Workflow journal

| Tool                   | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `list_workflow_runs`   | Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |
| `get_workflow_graph`   | Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |
| `inspect_workflow_events` | Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |
| `control_workflow_run` | Snapshot |  C  |    C    |  N/A   |   N/A   |    N/A    |

The workflow journal is owned by qyl and surfaced by qyl.mcp; no other repository touches it. `control_workflow_run` is
the single mutating tool in the manifest (`destructiveHint=true`, requires `qyl:control`): it steers, interrupts or
resumes an active Codex thread. It is conditional everywhere — use it only on explicit intent to alter a live run,
never as part of routine inspection.

## UI plumbing

| Tool                           | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|--------------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `fetch_telemetry`              | Snapshot |  U  |    U    |   U    |    U    |     U     |
| `fetch_workflow_graph_updates` | Snapshot |  U  |    U    |  N/A   |   N/A   |    N/A    |

Both tools state "The model should NOT call this tool directly." `fetch_telemetry` feeds the trace explorer wherever
`display_traces` is used; `fetch_workflow_graph_updates` long-polls journal updates for the workflow debugger. They
exist in the manifest for the embedded UI's callbacks, not for agents.

Neither publishes an `outputSchema`. Their callers are the bundled viewers, compiled against the generated TypeScript
types, so describing those bodies in `tools/list` spent 86 KB of every client's context on shapes no model may request.
They still return structured content, and the snapshot still pins their input schemas and UI metadata.

## UI resources

| Resource                               | Backs                                       |
|----------------------------------------|---------------------------------------------|
| `ui://qyl-explorer/mcp-app.html`       | `display_traces` trace explorer             |
| `ui://qyl-explorer/mcp-dashboard.html` | `display_mcp_dashboard` aggregate dashboard |
| `ui://qyl-explorer/observe-graph.html` | `display_workflow_graph` workflow debugger  |

## Recommended direct exposure summary

| Repository                              | Direct toolset | Conditional focus                                              |
|-----------------------------------------|---------------:|----------------------------------------------------------------|
| `qyl`                                   |       10 tools | Run control on live Codex threads                              |
| `qyl.mcp`                               |       10 tools | Run control when testing the `qyl:control` path                |
| `qyl.at`                                |        0 tools | Telemetry readers and trace explorer for docs verification     |
| `Qyl.OpenTelemetry.SemanticConventions` |        0 tools | Telemetry readers for verifying generated attribute vocabulary |
| `Qyl.OpenTelemetry.AutoInstrumentation` |        0 tools | Telemetry readers for verifying emitted instrumentation        |

The central policy is: keep the read-only telemetry intelligence directly available where the data is owned, prefer the
interactive displays whenever the human wants to look rather than the model wants to read, keep the single mutating
control tool behind explicit intent and the `qyl:control` scope, and never let the model call the UI-plumbing fetch
tools directly.
