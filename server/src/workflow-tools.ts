import type {
  ControlWorkflowRunInput,
  ControlWorkflowRunOutput,
  DisplayWorkflowGraphInput,
  DisplayWorkflowGraphOutput,
  FetchWorkflowGraphUpdatesInput,
  GetWorkflowGraphInput,
  GetWorkflowGraphOutput,
  ListWorkflowRunsInput,
} from "@ancplua/qyl-api-schema/types";
import type {
  CallToolResult,
  McpServer,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { WORKFLOW_GRAPH_RESOURCE_URI } from "./config.js";
import {
  ControlWorkflowRunInputSchema,
  ControlWorkflowRunOutputSchema,
  DisplayWorkflowGraphInputSchema,
  DisplayWorkflowGraphOutputSchema,
  FetchWorkflowGraphUpdatesInputSchema,
  FetchWorkflowGraphUpdatesOutputSchema,
  GetWorkflowGraphInputSchema,
  GetWorkflowGraphOutputSchema,
  ListWorkflowRunsInputSchema,
  ListWorkflowRunsOutputSchema,
} from "./contract-validation.js";
import { QYL_MCP_CONTROL_SCOPE } from "./oauth.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, toolError } from "./tools.js";
import {
  fetchWorkflowGraphUpdates,
  getMostRecentWorkflowRun,
  getWorkflowGraph,
  listWorkflowRuns,
  submitWorkflowControl,
} from "./workflow-data.js";

export const CONTROL_WORKFLOW_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

function toolResult<T extends object>(text: string, output: T): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: output as unknown as Record<string, unknown>,
  };
}

function graphSummary(prefix: string, graph: GetWorkflowGraphOutput["graph"]): string {
  const { statistics } = graph;
  return (
    `${prefix} ${graph.run.run_id}: ${graph.total_node_count} nodes, ` +
    `${graph.total_edge_count} edges, ${statistics.wall_time_ms.toFixed(0)} ms wall time, ` +
    `${statistics.t_infinity_ms.toFixed(0)} ms critical path at ` +
    `${statistics.peak_concurrency} peak concurrency.`
  );
}

export function hasWorkflowControlScope(scopes: readonly string[] | undefined): boolean {
  return scopes?.includes(QYL_MCP_CONTROL_SCOPE) === true;
}

/** Register the generated-shape workflow inspection, display, update, and control tools. */
export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "list_workflow_runs",
    {
      title: "List Workflow Runs",
      description:
        "List observed Codex workflow runs from qyl's durable journal. Results are " +
        "cursor-paged and contain run metadata only; use get_workflow_graph or " +
        "display_workflow_graph to inspect execution.",
      inputSchema: ListWorkflowRunsInputSchema,
      outputSchema: ListWorkflowRunsOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (input: ListWorkflowRunsInput, context): Promise<CallToolResult> => {
      try {
        const output = await listWorkflowRuns(input, context.mcpReq.signal);
        return toolResult(
          `Found ${output.runs.length} workflow runs${output.has_more ? " (more available)" : ""}.`,
          output,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_workflow_graph",
    {
      title: "Get Workflow Graph",
      description:
        "Read a bounded page of the deterministic workflow DAG, including typed edges, " +
        "recorded or derived provenance, attempt-preserving nodes, and weighted timing statistics.",
      inputSchema: GetWorkflowGraphInputSchema,
      outputSchema: GetWorkflowGraphOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (input: GetWorkflowGraphInput, context): Promise<CallToolResult> => {
      try {
        const output: GetWorkflowGraphOutput = {
          graph: await getWorkflowGraph(input, context.mcpReq.signal),
          mode: "live",
        };
        return toolResult(graphSummary("Read workflow", output.graph), output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "display_workflow_graph",
    {
      title: "Display Workflow Graph",
      description:
        "Open the fullscreen qyl workflow debugger. Pass a run_id for a known live or " +
        "historical run, or omit it to open the newest journaled run.",
      inputSchema: DisplayWorkflowGraphInputSchema,
      outputSchema: DisplayWorkflowGraphOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: WORKFLOW_GRAPH_RESOURCE_URI } },
    },
    async (input: DisplayWorkflowGraphInput, context): Promise<CallToolResult> => {
      try {
        const runId = input.run_id
          ?? (await getMostRecentWorkflowRun(context.mcpReq.signal)).run_id;
        const graph = await getWorkflowGraph(
          {
            run_id: runId,
            node_cursor: input.node_cursor,
            node_limit: input.node_limit,
            edge_cursor: input.edge_cursor,
            edge_limit: input.edge_limit,
          },
          context.mcpReq.signal,
        );
        const output: DisplayWorkflowGraphOutput = {
          graph,
          live_controls_available: graph.run.status === "active",
          mode: "live",
        };
        return toolResult(graphSummary("Displaying workflow", graph), output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "inspect_workflow_events",
    {
      title: "Inspect Workflow Events",
      description:
        "Read immutable workflow journal events after a collector sequence and optionally " +
        "retrieve one protected payload by content_ref. Versioned diagnostics arrive as " +
        "content_captured events: inspect the safe machine-readable summary in data, then " +
        "fetch protected evidence through a listed content_ref when needed. Graph pages are " +
        "returned only when graph cursor or non-default graph limit input explicitly requests one.",
      inputSchema: FetchWorkflowGraphUpdatesInputSchema,
      outputSchema: FetchWorkflowGraphUpdatesOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (input: FetchWorkflowGraphUpdatesInput, context): Promise<CallToolResult> => {
      try {
        const output = await fetchWorkflowGraphUpdates(
          input,
          context.mcpReq.signal,
          { includeGraphOnJournalChange: false },
        );
        return toolResult(
          `Inspected ${output.page.events.length} workflow events through sequence ` +
            `${output.page.next_sequence}${output.content === undefined ? "" : " and fetched protected content"}.`,
          output,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "fetch_workflow_graph_updates",
    {
      title: "Fetch Workflow Graph Updates",
      description:
        "Long-poll workflow journal updates, refresh a bounded graph page, or lazily " +
        "retrieve one captured content object. The model should NOT call this tool directly.",
      inputSchema: FetchWorkflowGraphUpdatesInputSchema,
      outputSchema: FetchWorkflowGraphUpdatesOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input: FetchWorkflowGraphUpdatesInput, context): Promise<CallToolResult> => {
      try {
        const output = await fetchWorkflowGraphUpdates(input, context.mcpReq.signal);
        return toolResult(
          `Fetched ${output.page.events.length} workflow events through sequence ` +
            `${output.page.next_sequence}.`,
          output,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "control_workflow_run",
    {
      title: "Control Workflow Run",
      description:
        "Submit an idempotent run-level steer, interrupt, or resume command. This mutates " +
        "the active Codex thread through its outbound observer channel and requires qyl:control.",
      inputSchema: ControlWorkflowRunInputSchema,
      outputSchema: ControlWorkflowRunOutputSchema,
      annotations: CONTROL_WORKFLOW_TOOL_ANNOTATIONS,
    },
    async (input: ControlWorkflowRunInput, context): Promise<CallToolResult> => {
      if (!hasWorkflowControlScope(context.http?.authInfo?.scopes)) {
        return {
          content: [{
            type: "text",
            text: `control_workflow_run requires the ${QYL_MCP_CONTROL_SCOPE} OAuth scope.`,
          }],
          isError: true,
        };
      }

      try {
        const output: ControlWorkflowRunOutput = {
          command: await submitWorkflowControl(input, context.mcpReq.signal),
        };
        return toolResult(
          `Workflow ${input.run_id} ${input.action} command accepted as ` +
            `${output.command.command_id} (${output.command.status}).`,
          output,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
