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
  `sha256:64c464569005a485`. The server is closed-world: a fresh runtime `tools/list` must equal the snapshot, and the
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

## Metrics reading

| Tool                | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|---------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `list_metrics`      | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `get_metric_series` | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `query_metric`      | Snapshot |  +  |    +    |   C    |    C    |     C     |

The metrics read contract arrived in `@ancplua/qyl-api-schema` 8.0.0. The three tools are read in order:
`list_metrics` for an exact instrument name and its series count, `get_metric_series` for the attribute keys
worth grouping or filtering on, `query_metric` for the windowed answer. Passing `group_by` without first
looking at the series is the common way to get either one collapsed line or a truncated fan-out.

Conditional for the same reason the generic trace and log readers are: `SemConv` and `AutoInstr` use them to
confirm that emitted instruments and their attribute vocabulary actually arrive at a running collector, and
`qyl.at` to check documented metric names against live behavior. Neither owns the data.

## Interactive displays

| Tool                    | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|-------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `display_traces`        | Snapshot |  +  |    +    |   C    |    C    |     C     |
| `display_mcp_dashboard` | Snapshot |  +  |    +    |  N/A   |   N/A   |    N/A    |

Displays are preferred over their data counterparts whenever the user wants to SEE the result: `display_traces` over
`list_traces`/`get_trace` for waterfalls. `display_mcp_dashboard` aggregates spans carrying `mcp.method.name`; only qyl
(collector ingest) and qyl.mcp (server traffic) produce and own that data.

## UI plumbing

| Tool                           | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|--------------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `fetch_telemetry`              | Snapshot |  U  |    U    |   U    |    U    |     U     |

The tool states "The model should NOT call this tool directly." `fetch_telemetry` feeds the trace explorer wherever
`display_traces` is used. It exists in the manifest for the embedded UI's callbacks, not for agents.

It publishes no `outputSchema`. Its callers are the bundled viewers, compiled against the generated TypeScript types,
so describing those bodies in `tools/list` spent context on shapes no model may request. It still returns structured
content, and the snapshot still pins its input schema and UI metadata.

## UI resources

| Resource                               | Backs                                       |
|----------------------------------------|---------------------------------------------|
| `ui://qyl-explorer/mcp-app.html`       | `display_traces` trace explorer             |
| `ui://qyl-explorer/mcp-dashboard.html` | `display_mcp_dashboard` aggregate dashboard |

## Recommended direct exposure summary

| Repository                              | Direct toolset | Conditional focus                                              |
|-----------------------------------------|---------------:|----------------------------------------------------------------|
| `qyl`                                   |       11 tools | Telemetry, metrics, CI evidence and the interactive displays   |
| `qyl.mcp`                               |       11 tools | Telemetry, metrics, CI evidence and the interactive displays   |
| `qyl.at`                                |        0 tools | Telemetry readers and trace explorer for docs verification     |
| `Qyl.OpenTelemetry.SemanticConventions` |        0 tools | Telemetry readers for verifying generated attribute vocabulary |
| `Qyl.OpenTelemetry.AutoInstrumentation` |        0 tools | Telemetry readers for verifying emitted instrumentation        |

The central policy is: keep the read-only telemetry and metrics intelligence directly available where the data is
owned, prefer the interactive displays whenever the human wants to look rather than the model wants to read, and never
let the model call the UI-plumbing fetch tool directly. Every tool in the manifest is read-only; the server publishes
no mutating tool.
