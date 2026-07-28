import type {
  DisplayWorkflowGraphOutput,
  FetchWorkflowGraphUpdatesOutput,
  WorkflowContent,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphSnapshot,
  WorkflowJournalEvent,
} from "@ancplua/qyl-api-schema/types";

export const MAX_EVENT_ROWS = 1_000;

export type WorkflowConnectionState =
  | "connecting"
  | "live"
  | "retrying"
  | "stopped";

export interface WorkflowDebuggerState {
  graph: WorkflowGraphSnapshot | undefined;
  events: WorkflowJournalEvent[];
  journalCursor: string;
  selectedNodeId: string | undefined;
  selectedEdgeId: string | undefined;
  content: Record<string, WorkflowContent>;
  liveControlsAvailable: boolean;
  connection: WorkflowConnectionState;
  reconnectAttempt: number;
  cursorGapCount: number;
}

export type WorkflowDebuggerAction =
  | { type: "bootstrap"; payload: DisplayWorkflowGraphOutput }
  | { type: "updates"; payload: FetchWorkflowGraphUpdatesOutput }
  | { type: "select-node"; nodeId: string | undefined }
  | { type: "select-edge"; edgeId: string | undefined }
  | {
      type: "connection";
      connection: WorkflowConnectionState;
      reconnectAttempt?: number;
    };

export function createWorkflowDebuggerState(): WorkflowDebuggerState {
  return {
    graph: undefined,
    events: [],
    journalCursor: "0",
    selectedNodeId: undefined,
    selectedEdgeId: undefined,
    content: {},
    liveControlsAvailable: false,
    connection: "connecting",
    reconnectAttempt: 0,
    cursorGapCount: 0,
  };
}

export function reduceWorkflowDebugger(
  state: WorkflowDebuggerState,
  action: WorkflowDebuggerAction,
): WorkflowDebuggerState {
  if (action.type === "bootstrap") {
    return {
      ...createWorkflowDebuggerState(),
      graph: action.payload.graph,
      journalCursor: "0",
      liveControlsAvailable: action.payload.live_controls_available,
      connection: "live",
    };
  }

  if (action.type === "connection") {
    return {
      ...state,
      connection: action.connection,
      reconnectAttempt: action.reconnectAttempt ?? state.reconnectAttempt,
    };
  }

  if (action.type === "select-node") {
    return {
      ...state,
      selectedNodeId: action.nodeId,
      selectedEdgeId: undefined,
    };
  }

  if (action.type === "select-edge") {
    return {
      ...state,
      selectedNodeId: undefined,
      selectedEdgeId: action.edgeId,
    };
  }

  const incomingGraph = action.payload.graph;
  const replacingRun =
    incomingGraph !== undefined
    && state.graph !== undefined
    && incomingGraph.run.run_id !== state.graph.run.run_id;
  const graph = incomingGraph === undefined
    ? state.graph
    : replacingRun || state.graph === undefined
      ? incomingGraph
      : mergeGraph(state.graph, incomingGraph);
  const page = action.payload.page;
  const events = page.cursor_gap || replacingRun
    ? sortedUniqueEvents(page.events).slice(-MAX_EVENT_ROWS)
    : sortedUniqueEvents([...state.events, ...page.events]).slice(-MAX_EVENT_ROWS);
  const content = action.payload.content === undefined
    ? state.content
    : {
        ...state.content,
        [action.payload.content.content_ref]: action.payload.content,
      };

  return {
    ...state,
    graph,
    events,
    journalCursor: page.next_sequence,
    content,
    liveControlsAvailable:
      graph?.run.status === "active" && state.liveControlsAvailable,
    connection: "live",
    reconnectAttempt: 0,
    cursorGapCount: state.cursorGapCount + (page.cursor_gap ? 1 : 0),
    ...(replacingRun
      ? { selectedNodeId: undefined, selectedEdgeId: undefined }
      : {}),
  };
}

function mergeGraph(
  current: WorkflowGraphSnapshot,
  incoming: WorkflowGraphSnapshot,
): WorkflowGraphSnapshot {
  return {
    ...incoming,
    nodes: mergeById(current.nodes, incoming.nodes, (node) => node.node_id),
    edges: mergeById(current.edges, incoming.edges, (edge) => edge.edge_id),
  };
}

function mergeById<T>(
  current: readonly T[],
  incoming: readonly T[],
  id: (value: T) => string,
): T[] {
  const values = new Map(current.map((value) => [id(value), value]));
  for (const value of incoming) values.set(id(value), value);
  return [...values.values()].sort((left, right) =>
    id(left).localeCompare(id(right)));
}

function sortedUniqueEvents(
  events: readonly WorkflowJournalEvent[],
): WorkflowJournalEvent[] {
  const values = new Map(events.map((event) => [event.event_id, event]));
  return [...values.values()].sort((left, right) => {
    const sequenceOrder =
      BigInt(left.journal_sequence) < BigInt(right.journal_sequence)
        ? -1
        : BigInt(left.journal_sequence) > BigInt(right.journal_sequence)
          ? 1
          : 0;
    return sequenceOrder || left.event_id.localeCompare(right.event_id);
  });
}

export function selectedWorkflowNode(
  state: WorkflowDebuggerState,
): WorkflowGraphNode | undefined {
  return state.graph?.nodes.find((node) => node.node_id === state.selectedNodeId);
}

export function selectedWorkflowEdge(
  state: WorkflowDebuggerState,
): WorkflowGraphEdge | undefined {
  return state.graph?.edges.find((edge) => edge.edge_id === state.selectedEdgeId);
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** Math.max(0, attempt));
}
