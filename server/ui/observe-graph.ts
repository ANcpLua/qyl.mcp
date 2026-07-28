import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type {
  ControlWorkflowRunOutput,
  DisplayWorkflowGraphOutput,
  FetchWorkflowGraphUpdatesOutput,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowJournalEvent,
} from "@ancplua/qyl-api-schema/types";
import type { CallToolResult } from "@modelcontextprotocol/server";
import packageMetadata from "../package.json";
import {
  ControlWorkflowRunOutputSchema,
  DisplayWorkflowGraphOutputSchema,
  FetchWorkflowGraphUpdatesOutputSchema,
} from "../src/contract-validation.ts";
import {
  createWorkflowDebuggerState,
  reconnectDelayMs,
  reduceWorkflowDebugger,
  selectedWorkflowEdge,
  selectedWorkflowNode,
  type WorkflowDebuggerAction,
} from "../src/workflow-reducer.ts";
import {
  isRadialEligible,
  layoutWorkflowGraph,
  visibleWorkflowNodeIds,
  type ViewTransform,
  type WorkflowLayout,
  type WorkflowLayoutMode,
} from "../src/workflow-layout.ts";
import { observeGraphVisualFixture } from "./observe-graph-fixture.ts";
import "./observe-graph.css";

const SVG_NS = "http://www.w3.org/2000/svg";
const EVENT_ROW_HEIGHT = 43;
const HEATMAP_BUCKETS = 12;
const visualFixtureMode =
  new URLSearchParams(window.location.search).get("fixture") === "fanout";

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`observe graph is missing #${id}`);
  return found as unknown as T;
}

const workflowAppEl = element<HTMLElement>("workflow-app");
const loadingStateEl = element<HTMLElement>("loading-state");
const errorStateEl = element<HTMLElement>("error-state");
const errorMessageEl = element<HTMLElement>("error-message");
const debuggerEl = element<HTMLElement>("debugger");
const runStatusMarkEl = element<HTMLElement>("run-status-mark");
const runTitleEl = element<HTMLElement>("run-title");
const runIdEl = element<HTMLElement>("run-id");
const connectionStateEl = element<HTMLElement>("connection-state");
const fullscreenButtonEl = element<HTMLButtonElement>("fullscreen-button");
const fitGraphButtonEl = element<HTMLButtonElement>("fit-graph");
const metricT1El = element<HTMLElement>("metric-t1");
const metricTInfinityEl = element<HTMLElement>("metric-tinf");
const metricWallEl = element<HTMLElement>("metric-wall");
const metricPeakEl = element<HTMLElement>("metric-peak");
const metricWorkersEl = element<HTMLElement>("metric-workers");
const metricBoundEl = element<HTMLElement>("metric-bound");
const runCardEl = element<HTMLElement>("run-card");
const agentCountEl = element<HTMLElement>("agent-count");
const agentListEl = element<HTMLElement>("agent-list");
const loadMoreGraphEl = element<HTMLButtonElement>("load-more-graph");
const layoutLayeredEl = element<HTMLButtonElement>("layout-layered");
const layoutRadialEl = element<HTMLButtonElement>("layout-radial");
const viewportCountEl = element<HTMLElement>("viewport-count");
const graphViewportEl = element<HTMLElement>("graph-viewport");
const graphWorldEl = element<SVGGElement>("graph-world");
const edgeLayerEl = element<SVGGElement>("edge-layer");
const nodeLayerEl = element<SVGGElement>("node-layer");
const heatmapEl = element<HTMLElement>("heatmap");
const heatmapRangeEl = element<HTMLElement>("heatmap-range");
const journalCursorEl = element<HTMLElement>("journal-cursor");
const eventListEl = element<HTMLElement>("event-list");
const eventListInnerEl = element<HTMLElement>("event-list-inner");
const eventWindowLabelEl = element<HTMLElement>("event-window-label");
const followEventsEl = element<HTMLButtonElement>("follow-events");
const detailDrawerEl = element<HTMLElement>("detail-drawer");
const detailTitleEl = element<HTMLElement>("detail-title");
const detailSubtitleEl = element<HTMLElement>("detail-subtitle");
const detailCloseEl = element<HTMLButtonElement>("detail-close");
const detailFactsEl = element<HTMLElement>("detail-facts");
const attemptHistoryEl = element<HTMLElement>("attempt-history");
const contentListEl = element<HTMLElement>("content-list");
const contentViewerEl = element<HTMLElement>("content-viewer");
const historicalControlNoteEl = element<HTMLElement>("historical-control-note");
const controlFormEl = element<HTMLFormElement>("control-form");
const controlActionEl = element<HTMLSelectElement>("control-action");
const controlInputLabelEl = element<HTMLElement>("control-input-label");
const controlInputEl = element<HTMLTextAreaElement>("control-input");
const controlSubmitEl = element<HTMLButtonElement>("control-submit");
const controlResultEl = element<HTMLElement>("control-result");
const liveAnnouncerEl = element<HTMLElement>("live-announcer");

let state = createWorkflowDebuggerState();
let layoutMode: WorkflowLayoutMode = "layered";
let currentLayout: WorkflowLayout | undefined;
let transform: ViewTransform = { x: 24, y: 24, scale: 1 };
let fittedRunAndMode = "";
let followCursor = true;
let pollGeneration = 0;
let selectedGraphIndex = 0;
let controlBusy = false;
let graphPageBusy = false;
let isPanning = false;
let panPointerId: number | undefined;
let panStart = { clientX: 0, clientY: 0, x: 0, y: 0 };

const app = new App({
  name: "qyl Observe Graph",
  version: packageMetadata.version,
});

function dispatch(action: WorkflowDebuggerAction): void {
  state = reduceWorkflowDebugger(state, action);
  render();
}

function showError(message: string): void {
  if (state.graph) {
    liveAnnouncerEl.textContent = message;
    connectionStateEl.textContent = "degraded";
    connectionStateEl.dataset.state = "retrying";
    return;
  }
  loadingStateEl.hidden = true;
  debuggerEl.hidden = true;
  errorMessageEl.textContent = message;
  errorStateEl.hidden = false;
}

function toolErrorText(result: CallToolResult): string | undefined {
  const value = result.content
    ?.map((content) => "text" in content ? content.text : "")
    .filter(Boolean)
    .join(" ");
  return value || undefined;
}

function render(): void {
  const graph = state.graph;
  loadingStateEl.hidden = graph !== undefined;
  errorStateEl.hidden = true;
  debuggerEl.hidden = graph === undefined;
  renderConnection();
  if (!graph) return;

  runTitleEl.textContent = graph.run.title ?? "untitled workflow";
  runIdEl.textContent = graph.run.run_id;
  runStatusMarkEl.dataset.status = graph.run.status;
  renderMetrics();
  renderRunRail();
  renderGraph();
  renderHeatmap();
  renderEvents();
  renderDetails();
}

function renderConnection(): void {
  const label = state.connection === "retrying"
    ? `retry ${state.reconnectAttempt}`
    : state.connection === "stopped"
      ? "replay complete"
      : state.connection;
  connectionStateEl.textContent = label;
  connectionStateEl.dataset.state = state.connection;
}

function renderMetrics(): void {
  const statistics = state.graph?.statistics;
  metricT1El.textContent = statistics ? formatDuration(statistics.t1_ms) : "—";
  metricTInfinityEl.textContent = statistics
    ? formatDuration(statistics.t_infinity_ms)
    : "—";
  metricWallEl.textContent = statistics ? formatDuration(statistics.wall_time_ms) : "—";
  metricPeakEl.textContent = statistics
    ? `${statistics.peak_concurrency}×`
    : "—";
  metricWorkersEl.textContent = statistics ? String(statistics.worker_count) : "—";
  metricBoundEl.textContent = statistics
    ? formatDuration(statistics.parallel_lower_bound_ms)
    : "—";
}

function renderRunRail(): void {
  const graph = state.graph;
  if (!graph) return;
  const attempts = new Set(
    graph.nodes.flatMap((node) => node.attempt_id ? [node.attempt_id] : []),
  );
  const agents = graph.nodes
    .filter((node) => node.kind === "agent")
    .sort(compareNodes);
  agentCountEl.textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;

  const runTitle = document.createElement("div");
  runTitle.className = "run-card-title";
  const mark = document.createElement("i");
  mark.className = "status-mark";
  mark.dataset.status = graph.run.status;
  runTitle.appendChild(mark);
  const title = document.createElement("strong");
  title.textContent = graph.run.title ?? graph.run.run_id;
  runTitle.appendChild(title);

  const facts = document.createElement("div");
  facts.className = "run-card-facts";
  facts.appendChild(runFact("status", graph.run.status));
  facts.appendChild(runFact("attempts", String(attempts.size)));
  facts.appendChild(runFact("journal", graph.journal_sequence));
  facts.appendChild(runFact("window", `${graph.nodes.length}/${graph.total_node_count}`));
  runCardEl.replaceChildren(runTitle, facts);

  const fragment = document.createDocumentFragment();
  for (const agent of agents.slice(0, 250)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-row";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(state.selectedNodeId === agent.node_id));
    button.addEventListener("click", () => selectNode(agent.node_id));

    const status = document.createElement("span");
    status.className = "status-dot";
    status.dataset.status = agent.status;
    status.setAttribute("aria-label", agent.status);
    button.appendChild(status);

    const copy = document.createElement("span");
    copy.className = "agent-copy";
    const name = document.createElement("strong");
    name.textContent = agent.label;
    copy.appendChild(name);
    const meta = document.createElement("small");
    meta.textContent = `${agent.attempt_id ?? "no attempt"} · ${agent.status}`;
    copy.appendChild(meta);
    button.appendChild(copy);

    const duration = document.createElement("span");
    duration.className = "agent-duration";
    duration.textContent = formatDuration(agent.duration_ms);
    button.appendChild(duration);
    button.appendChild(activityStrip(agent));
    fragment.appendChild(button);
  }
  agentListEl.replaceChildren(fragment);
  loadMoreGraphEl.hidden = !(graph.has_more_nodes || graph.has_more_edges);
  loadMoreGraphEl.textContent =
    `Load next graph window · ${graph.nodes.length}/${graph.total_node_count} nodes`;
}

function runFact(label: string, value: string): HTMLElement {
  const fact = document.createElement("span");
  fact.textContent = label;
  const strong = document.createElement("b");
  strong.textContent = value;
  fact.appendChild(strong);
  return fact;
}

function activityStrip(agent: WorkflowGraphNode): HTMLElement {
  const strip = document.createElement("span");
  strip.className = "activity-strip";
  const graph = state.graph;
  if (!graph) return strip;
  const related = graph.nodes.filter((node) =>
    node.agent_id !== undefined && node.agent_id === agent.agent_id);
  const completed = related.filter((node) =>
    node.status === "succeeded" || node.status === "completed").length;
  const failed = related.some((node) =>
    node.status === "failed" || node.status === "interrupted");
  const active = Math.max(1, Math.round((completed / Math.max(1, related.length)) * 10));
  for (let index = 0; index < 10; index += 1) {
    const cell = document.createElement("i");
    if (index < active) cell.className = failed && index === active - 1 ? "error" : "on";
    strip.appendChild(cell);
  }
  return strip;
}

function renderGraph(): void {
  const graph = state.graph;
  if (!graph) return;
  currentLayout = layoutWorkflowGraph(graph, layoutMode);
  layoutMode = currentLayout.mode;
  layoutLayeredEl.setAttribute("aria-pressed", String(layoutMode === "layered"));
  layoutRadialEl.setAttribute("aria-pressed", String(layoutMode === "radial"));
  const radialEligible = isRadialEligible(graph);
  layoutRadialEl.disabled = !radialEligible;
  layoutRadialEl.title = radialEligible
    ? "Show the small fan-out/fan-in run as a radial fleet"
    : "Radial view is available only for small fan-out/fan-in runs";

  const fitKey = `${graph.run.run_id}:${layoutMode}`;
  if (fittedRunAndMode !== fitKey) {
    fittedRunAndMode = fitKey;
    focusGraph();
    return;
  }

  graphWorldEl.setAttribute(
    "transform",
    `translate(${transform.x} ${transform.y}) scale(${transform.scale})`,
  );
  const visible = visibleWorkflowNodeIds(
    currentLayout,
    transform,
    graphViewportEl.clientWidth,
    graphViewportEl.clientHeight,
  );
  viewportCountEl.textContent =
    `${visible.size}/${graph.nodes.length} rendered · ${graph.total_node_count} total`;
  renderEdges(graph.edges, visible);
  renderNodes(visible);
}

function renderEdges(edges: readonly WorkflowGraphEdge[], visible: Set<string>): void {
  const graph = state.graph;
  const layout = currentLayout;
  if (!graph || !layout) return;
  const critical = new Set(graph.statistics.critical_path_node_ids);
  const fragment = document.createDocumentFragment();
  for (const edge of edges) {
    if (!visible.has(edge.source_node_id) && !visible.has(edge.target_node_id)) continue;
    const source = layout.positions.get(edge.source_node_id);
    const target = layout.positions.get(edge.target_node_id);
    if (!source || !target) continue;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", edgePath(source, target, layout.mode));
    path.setAttribute("class", [
      "workflow-edge",
      critical.has(edge.source_node_id) && critical.has(edge.target_node_id)
        ? "is-critical"
        : "",
      state.selectedEdgeId === edge.edge_id ? "is-selected" : "",
    ].filter(Boolean).join(" "));
    path.dataset.provenance = edge.provenance.type;
    path.dataset.kind = edge.kind;
    path.setAttribute("tabindex", "0");
    path.setAttribute("role", "button");
    path.setAttribute(
      "aria-label",
      `${edge.kind} edge from ${source.node.label} to ${target.node.label}, ${edge.provenance.type}`,
    );
    path.addEventListener("click", (event) => {
      event.stopPropagation();
      selectEdge(edge.edge_id);
    });
    path.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectEdge(edge.edge_id);
      }
    });
    fragment.appendChild(path);
  }
  edgeLayerEl.replaceChildren(fragment);
}

function edgePath(
  source: NonNullable<WorkflowLayout["positions"] extends Map<string, infer T> ? T : never>,
  target: NonNullable<WorkflowLayout["positions"] extends Map<string, infer T> ? T : never>,
  mode: WorkflowLayoutMode,
): string {
  if (mode === "radial") {
    const x1 = source.x + source.width / 2;
    const y1 = source.y + source.height / 2;
    const x2 = target.x + target.width / 2;
    const y2 = target.y + target.height / 2;
    return `M${x1},${y1} L${x2},${y2}`;
  }
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const control = Math.max(30, Math.abs(x2 - x1) * 0.45);
  return `M${x1},${y1} C${x1 + control},${y1} ${x2 - control},${y2} ${x2},${y2}`;
}

function renderNodes(visible: Set<string>): void {
  const graph = state.graph;
  const layout = currentLayout;
  if (!graph || !layout) return;
  const critical = new Set(graph.statistics.critical_path_node_ids);
  const fragment = document.createDocumentFragment();
  for (const node of graph.nodes) {
    if (!visible.has(node.node_id)) continue;
    const position = layout.positions.get(node.node_id);
    if (!position) continue;
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", `translate(${position.x} ${position.y})`);
    group.setAttribute("class", [
      "workflow-node",
      state.selectedNodeId === node.node_id ? "is-selected" : "",
      critical.has(node.node_id) ? "is-critical" : "",
    ].filter(Boolean).join(" "));
    group.dataset.status = node.status;
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "treeitem");
    group.setAttribute(
      "aria-label",
      `${node.kind} ${node.label}, ${node.status}, ${formatDuration(node.duration_ms)}`,
    );
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      selectNode(node.node_id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(node.node_id);
      }
    });

    const shell = document.createElementNS(SVG_NS, "rect");
    shell.setAttribute("class", "node-shell");
    shell.setAttribute("width", String(position.width));
    shell.setAttribute("height", String(position.height));
    group.appendChild(shell);

    const band = document.createElementNS(SVG_NS, "rect");
    band.setAttribute("class", "node-status-band");
    band.setAttribute("width", "3");
    band.setAttribute("height", String(position.height));
    group.appendChild(band);

    group.appendChild(svgText("node-kind", 12, 14, node.kind.replace("_", " ")));
    group.appendChild(svgText("node-label", 12, 33, truncate(node.label, 25)));
    group.appendChild(svgText(
      "node-meta",
      12,
      50,
      `${node.status} · ${formatDuration(node.duration_ms)} · ${node.attempt_id ?? "run"}`,
    ));
    fragment.appendChild(group);
  }
  nodeLayerEl.replaceChildren(fragment);
}

function svgText(
  className: string,
  x: number,
  y: number,
  value: string,
): SVGTextElement {
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", className);
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y));
  text.textContent = value;
  return text;
}

function fitGraph(showAll = true): void {
  const layout = currentLayout;
  if (!layout) return;
  const width = Math.max(1, graphViewportEl.clientWidth - 48);
  const height = Math.max(1, graphViewportEl.clientHeight - 48);
  const minimumScale = showAll ? 0.15 : 0.82;
  const scale = Math.min(
    1.15,
    Math.max(minimumScale, Math.min(width / layout.width, height / layout.height)),
  );
  const scaledWidth = layout.width * scale;
  transform = {
    x: scaledWidth <= graphViewportEl.clientWidth
      ? (graphViewportEl.clientWidth - scaledWidth) / 2
      : 22,
    y: (graphViewportEl.clientHeight - layout.height * scale) / 2,
    scale,
  };
  renderGraph();
}

function focusGraph(): void {
  fitGraph(false);
}

function renderHeatmap(): void {
  const graph = state.graph;
  if (!graph) return;
  const agents = graph.nodes
    .filter((node) => node.kind === "agent" && node.agent_id)
    .slice(0, 8);
  const start = new Date(graph.run.started_at).getTime();
  const end = graph.run.ended_at
    ? new Date(graph.run.ended_at).getTime()
    : start + Math.max(1, graph.statistics.wall_time_ms);
  const duration = Math.max(1, end - start);
  heatmapRangeEl.textContent = `${formatDuration(duration)} window`;

  const fragment = document.createDocumentFragment();
  for (const agent of agents) {
    const label = document.createElement("span");
    label.className = "heatmap-label";
    label.textContent = truncate(agent.label, 13);
    label.title = agent.label;
    fragment.appendChild(label);
    const related = graph.nodes.filter((node) => node.agent_id === agent.agent_id);
    for (let bucket = 0; bucket < HEATMAP_BUCKETS; bucket += 1) {
      const bucketStart = start + duration * bucket / HEATMAP_BUCKETS;
      const bucketEnd = start + duration * (bucket + 1) / HEATMAP_BUCKETS;
      const overlap = related.filter((node) => {
        const nodeStart = node.started_at ? new Date(node.started_at).getTime() : start;
        const nodeEnd = node.ended_at
          ? new Date(node.ended_at).getTime()
          : nodeStart + (node.duration_ms ?? 0);
        return nodeStart < bucketEnd && nodeEnd >= bucketStart;
      }).length;
      const cell = document.createElement("span");
      cell.className = "heatmap-cell";
      cell.dataset.level = String(Math.min(3, overlap));
      cell.setAttribute(
        "aria-label",
        `${agent.label}, phase ${bucket + 1}: ${overlap} active record${overlap === 1 ? "" : "s"}`,
      );
      cell.title = cell.getAttribute("aria-label") ?? "";
      fragment.appendChild(cell);
    }
  }
  heatmapEl.replaceChildren(fragment);
}

function renderEvents(): void {
  const events = state.events;
  journalCursorEl.textContent = `seq ${state.journalCursor}`;
  eventWindowLabelEl.textContent =
    `${events.length} buffered${state.cursorGapCount ? ` · ${state.cursorGapCount} gap recoveries` : ""}`;
  eventListInnerEl.style.height = `${events.length * EVENT_ROW_HEIGHT}px`;

  const visibleCount = Math.ceil(eventListEl.clientHeight / EVENT_ROW_HEIGHT);
  const start = Math.max(0, Math.floor(eventListEl.scrollTop / EVENT_ROW_HEIGHT) - 5);
  const end = Math.min(events.length, start + visibleCount + 10);
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index += 1) {
    const event = events[index]!;
    const row = document.createElement("div");
    row.className = "event-row";
    row.style.top = `${index * EVENT_ROW_HEIGHT}px`;
    row.dataset.tone = eventTone(event);
    row.tabIndex = 0;
    row.addEventListener("click", () => selectEventTarget(event));
    row.addEventListener("keydown", (keyboardEvent) => {
      if (keyboardEvent.key === "Enter") selectEventTarget(event);
    });

    const sequence = document.createElement("code");
    sequence.className = "event-seq";
    sequence.textContent = event.journal_sequence;
    row.appendChild(sequence);
    const copy = document.createElement("span");
    copy.className = "event-copy";
    const kind = document.createElement("strong");
    kind.textContent = event.kind.replaceAll("_", " ");
    copy.appendChild(kind);
    const identity = document.createElement("small");
    identity.textContent =
      event.agent_id
      ?? event.tool_call_id
      ?? event.turn_id
      ?? event.attempt_id
      ?? event.event_id;
    copy.appendChild(identity);
    row.appendChild(copy);
    const time = document.createElement("time");
    time.className = "event-time";
    time.dateTime = event.timestamp;
    time.textContent = formatClock(event.timestamp);
    row.appendChild(time);
    fragment.appendChild(row);
  }
  eventListInnerEl.replaceChildren(fragment);

  if (followCursor && events.length > 0) {
    requestAnimationFrame(() => {
      eventListEl.scrollTop = eventListEl.scrollHeight;
    });
  }
}

function eventTone(event: WorkflowJournalEvent): string {
  if (
    event.kind.includes("failed")
    || event.kind.includes("interrupted")
    || event.kind === "approval_resolved"
  ) return "failure";
  if (event.kind.startsWith("control_")) return "control";
  if (
    event.kind.startsWith("agent_")
    || event.kind.startsWith("message_")
    || event.kind.startsWith("wait_")
    || event.kind === "joined"
  ) return "collaboration";
  return "neutral";
}

function selectEventTarget(event: WorkflowJournalEvent): void {
  const graph = state.graph;
  if (!graph) return;
  const target = graph.nodes.find((node) =>
    (event.tool_call_id !== undefined && node.attributes?.tool_call_id === event.tool_call_id)
    || (event.agent_id !== undefined && node.agent_id === event.agent_id)
    || (event.attempt_id !== undefined && node.attempt_id === event.attempt_id));
  if (target) selectNode(target.node_id);
}

function renderDetails(): void {
  const node = selectedWorkflowNode(state);
  const edge = selectedWorkflowEdge(state);
  detailDrawerEl.hidden = node === undefined && edge === undefined;
  if (!node && !edge) return;

  if (node) renderNodeDetails(node);
  else if (edge) renderEdgeDetails(edge);
  const graph = state.graph;
  const live = state.liveControlsAvailable && graph?.run.status === "active";
  controlFormEl.hidden = !live;
  historicalControlNoteEl.hidden = live;
}

function renderNodeDetails(node: WorkflowGraphNode): void {
  detailTitleEl.textContent = node.label;
  detailSubtitleEl.textContent = `${node.kind} · ${node.status} · ${node.node_id}`;
  const facts: Array<[string, string]> = [
    ["node", node.node_id],
    ["kind", node.kind],
    ["status", node.status],
    ["attempt", node.attempt_id ?? "—"],
    ["agent", node.agent_id ?? "—"],
    ["parent", node.parent_node_id ?? "—"],
    ["started", node.started_at ?? "—"],
    ["ended", node.ended_at ?? "—"],
    ["duration", formatDuration(node.duration_ms)],
  ];
  if (node.attributes) facts.push(["attributes", JSON.stringify(node.attributes)]);
  renderFactList(facts);

  const graph = state.graph;
  const history = graph?.nodes
    .filter((candidate) =>
      candidate.node_id === node.node_id
      || (
        node.agent_id !== undefined
        && candidate.agent_id === node.agent_id
        && candidate.attempt_id !== node.attempt_id
      ))
    .sort(compareNodes) ?? [];
  attemptHistoryEl.replaceChildren(
    ...history.map((candidate) => {
      const record = document.createElement("div");
      record.className = "attempt-record";
      const copy = document.createElement("strong");
      copy.textContent = candidate.attempt_id ?? "run";
      record.appendChild(copy);
      const status = document.createElement("span");
      status.textContent = candidate.status;
      record.appendChild(status);
      const kind = document.createElement("span");
      kind.textContent = candidate.kind;
      record.appendChild(kind);
      const duration = document.createElement("span");
      duration.textContent = formatDuration(candidate.duration_ms);
      record.appendChild(duration);
      return record;
    }),
  );
  renderContentRefs(node.content_refs ?? []);
}

function renderEdgeDetails(edge: WorkflowGraphEdge): void {
  detailTitleEl.textContent = `${edge.kind} edge`;
  detailSubtitleEl.textContent =
    `${edge.source_node_id} → ${edge.target_node_id}`;
  const facts: Array<[string, string]> = [
    ["edge", edge.edge_id],
    ["kind", edge.kind],
    ["source", edge.source_node_id],
    ["target", edge.target_node_id],
    ["provenance", edge.provenance.type],
    ["events", edge.provenance.event_ids.join(", ")],
  ];
  if (edge.provenance.type === "derived") {
    facts.push(["evidence", edge.provenance.evidence]);
    facts.push(["confidence", `${Math.round(edge.provenance.confidence * 100)}%`]);
  }
  renderFactList(facts);
  attemptHistoryEl.replaceChildren(emptyCopy("Edges do not own attempt history."));
  renderContentRefs([]);
}

function renderFactList(facts: readonly [string, string][]): void {
  const fragment = document.createDocumentFragment();
  for (const [name, value] of facts) {
    const term = document.createElement("dt");
    term.textContent = name;
    fragment.appendChild(term);
    const definition = document.createElement("dd");
    definition.textContent = value;
    fragment.appendChild(definition);
  }
  detailFactsEl.replaceChildren(fragment);
}

function renderContentRefs(refs: readonly string[]): void {
  if (refs.length === 0) {
    contentListEl.replaceChildren(emptyCopy("No captured content is attached to this record."));
    contentViewerEl.textContent = "Captured payloads are fetched only when opened.";
    return;
  }
  contentListEl.replaceChildren(...refs.map((contentRef) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "content-ref";
    const label = document.createElement("strong");
    label.textContent = contentRef.slice(0, 20);
    button.appendChild(label);
    const status = document.createElement("span");
    status.textContent = state.content[contentRef] ? "cached" : "fetch";
    button.appendChild(status);
    button.addEventListener("click", () => void openContent(contentRef));
    return button;
  }));
}

function emptyCopy(value: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "historical-note";
  span.textContent = value;
  return span;
}

async function openContent(contentRef: string): Promise<void> {
  const cached = state.content[contentRef];
  if (cached) {
    contentViewerEl.textContent = decodeContent(cached.encoding, cached.content);
    return;
  }
  const runId = state.graph?.run.run_id;
  if (!runId) return;
  contentViewerEl.textContent = "Decrypting captured content…";
  try {
    const result = await app.callServerTool({
      name: "fetch_workflow_graph_updates",
      arguments: {
        run_id: runId,
        after_sequence: state.journalCursor,
        wait_ms: 0,
        content_ref: contentRef,
      },
    });
    if (result.isError) {
      throw new Error(toolErrorText(result) ?? "content retrieval failed");
    }
    const payload = parseUpdates(result);
    if (!payload?.content) throw new Error("content response was missing");
    dispatch({ type: "updates", payload });
    contentViewerEl.textContent = decodeContent(
      payload.content.encoding,
      payload.content.content,
    );
  } catch (error) {
    contentViewerEl.textContent =
      `Content unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function decodeContent(encoding: string, content: string): string {
  if (encoding === "utf8") return content;
  try {
    const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "[invalid base64 content]";
  }
}

function selectNode(nodeId: string): void {
  const sorted = graphNodesInVisualOrder();
  selectedGraphIndex = Math.max(0, sorted.findIndex((node) => node.node_id === nodeId));
  dispatch({ type: "select-node", nodeId });
}

function selectEdge(edgeId: string): void {
  dispatch({ type: "select-edge", edgeId });
}

function graphNodesInVisualOrder(): WorkflowGraphNode[] {
  const layout = currentLayout;
  if (!layout) return [];
  return [...layout.positions.values()]
    .sort((left, right) => left.x - right.x || left.y - right.y)
    .map((position) => position.node);
}

function moveGraphSelection(delta: number): void {
  const nodes = graphNodesInVisualOrder();
  if (nodes.length === 0) return;
  selectedGraphIndex =
    (selectedGraphIndex + delta + nodes.length) % nodes.length;
  selectNode(nodes[selectedGraphIndex]!.node_id);
}

function parseDisplay(result: CallToolResult): DisplayWorkflowGraphOutput | undefined {
  const parsed = DisplayWorkflowGraphOutputSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : undefined;
}

function parseUpdates(
  result: CallToolResult,
): FetchWorkflowGraphUpdatesOutput | undefined {
  const parsed = FetchWorkflowGraphUpdatesOutputSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : undefined;
}

function parseControl(result: CallToolResult): ControlWorkflowRunOutput | undefined {
  const parsed = ControlWorkflowRunOutputSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : undefined;
}

function beginPolling(): void {
  const generation = ++pollGeneration;
  void poll(generation);
}

async function poll(generation: number): Promise<void> {
  let attempt = 0;
  while (generation === pollGeneration && state.graph) {
    const runId = state.graph.run.run_id;
    try {
      const result = await app.callServerTool({
        name: "fetch_workflow_graph_updates",
        arguments: {
          run_id: runId,
          after_sequence: state.journalCursor,
          limit: 250,
          wait_ms: state.graph.run.status === "active" ? 20_000 : 0,
        },
      });
      if (generation !== pollGeneration) return;
      if (result.isError) {
        throw new Error(toolErrorText(result) ?? "journal update failed");
      }
      const payload = parseUpdates(result);
      if (!payload) throw new Error("journal update did not match the published contract");
      dispatch({ type: "updates", payload });
      attempt = 0;
      if (
        state.graph?.run.status !== "active"
        && payload.page.next_sequence === payload.page.high_water_mark
      ) {
        dispatch({ type: "connection", connection: "stopped" });
        return;
      }
    } catch (error) {
      if (generation !== pollGeneration) return;
      attempt += 1;
      dispatch({
        type: "connection",
        connection: "retrying",
        reconnectAttempt: attempt,
      });
      liveAnnouncerEl.textContent =
        `Workflow journal disconnected. Retry ${attempt}.`;
      await delay(reconnectDelayMs(attempt - 1));
    }
  }
}

async function loadMoreGraph(): Promise<void> {
  const graph = state.graph;
  if (!graph || graphPageBusy) return;
  graphPageBusy = true;
  loadMoreGraphEl.disabled = true;
  try {
    const result = await app.callServerTool({
      name: "fetch_workflow_graph_updates",
      arguments: {
        run_id: graph.run.run_id,
        after_sequence: state.journalCursor,
        wait_ms: 0,
        ...(graph.has_more_nodes && graph.next_node_cursor
          ? { node_cursor: graph.next_node_cursor }
          : {}),
        ...(graph.has_more_edges && graph.next_edge_cursor
          ? { edge_cursor: graph.next_edge_cursor }
          : {}),
      },
    });
    if (result.isError) throw new Error(toolErrorText(result) ?? "graph page failed");
    const payload = parseUpdates(result);
    if (!payload?.graph) throw new Error("graph page was missing");
    dispatch({ type: "updates", payload });
  } catch (error) {
    liveAnnouncerEl.textContent =
      `Graph page failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    graphPageBusy = false;
    loadMoreGraphEl.disabled = false;
  }
}

function handleHostContext(context: McpUiHostContext): void {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  const fullscreenAvailable =
    context.availableDisplayModes?.includes("fullscreen") === true;
  fullscreenButtonEl.hidden =
    !fullscreenAvailable || context.displayMode === "fullscreen";
  if (context.safeAreaInsets) {
    workflowAppEl.style.paddingTop = `${context.safeAreaInsets.top}px`;
    workflowAppEl.style.paddingRight = `${context.safeAreaInsets.right}px`;
    workflowAppEl.style.paddingBottom = `${context.safeAreaInsets.bottom}px`;
    workflowAppEl.style.paddingLeft = `${context.safeAreaInsets.left}px`;
  }
}

app.ontoolinput = () => {
  loadingStateEl.hidden = false;
  errorStateEl.hidden = true;
};

app.ontoolresult = (result) => {
  const payload = parseDisplay(result);
  if (!payload) {
    showError(toolErrorText(result) ?? "Display result failed contract validation.");
    return;
  }
  dispatch({ type: "bootstrap", payload });
  beginPolling();
};

app.ontoolcancelled = () => {
  if (!state.graph) showError("Workflow display was cancelled.");
};

app.onhostcontextchanged = handleHostContext;
app.onerror = (error) => {
  console.error(error);
};
app.onteardown = async () => {
  pollGeneration += 1;
  dispatch({ type: "connection", connection: "stopped" });
  return {};
};

fitGraphButtonEl.addEventListener("click", () => fitGraph(true));
layoutLayeredEl.addEventListener("click", () => {
  layoutMode = "layered";
  fittedRunAndMode = "";
  renderGraph();
});
layoutRadialEl.addEventListener("click", () => {
  if (!state.graph || !isRadialEligible(state.graph)) return;
  layoutMode = "radial";
  fittedRunAndMode = "";
  renderGraph();
});
loadMoreGraphEl.addEventListener("click", () => void loadMoreGraph());
detailCloseEl.addEventListener("click", () => {
  dispatch({ type: "select-node", nodeId: undefined });
});
followEventsEl.addEventListener("click", () => {
  followCursor = !followCursor;
  followEventsEl.setAttribute("aria-pressed", String(followCursor));
  if (followCursor) {
    eventListEl.scrollTop = eventListEl.scrollHeight;
    renderEvents();
  }
});
eventListEl.addEventListener("scroll", () => {
  const remaining =
    eventListEl.scrollHeight - eventListEl.clientHeight - eventListEl.scrollTop;
  if (remaining > EVENT_ROW_HEIGHT * 2 && followCursor) {
    followCursor = false;
    followEventsEl.setAttribute("aria-pressed", "false");
  }
  renderEvents();
});

controlActionEl.addEventListener("change", () => {
  const needsInput = controlActionEl.value !== "interrupt";
  controlInputLabelEl.hidden = !needsInput;
  controlInputEl.required = needsInput;
});
controlFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitControl();
});

async function submitControl(): Promise<void> {
  const graph = state.graph;
  if (!graph || controlBusy) return;
  const action = controlActionEl.value as "steer" | "interrupt" | "resume";
  const input = controlInputEl.value.trim();
  if (action !== "interrupt" && !input) {
    controlResultEl.textContent = `${action} requires input.`;
    return;
  }
  controlBusy = true;
  controlSubmitEl.disabled = true;
  controlResultEl.textContent = "Waiting for host approval…";
  try {
    const result = await app.callServerTool({
      name: "control_workflow_run",
      arguments: {
        run_id: graph.run.run_id,
        action,
        idempotency_key: crypto.randomUUID(),
        ...(action === "interrupt" ? {} : { input }),
      },
    });
    if (result.isError) throw new Error(toolErrorText(result) ?? "control failed");
    const payload = parseControl(result);
    if (!payload) throw new Error("control result failed contract validation");
    controlResultEl.textContent =
      `${payload.command.action} ${payload.command.status} · ${payload.command.command_id}`;
    if (action !== "interrupt") controlInputEl.value = "";
  } catch (error) {
    controlResultEl.textContent =
      `Control rejected: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    controlBusy = false;
    controlSubmitEl.disabled = false;
  }
}

fullscreenButtonEl.addEventListener("click", () => {
  void app.requestDisplayMode({ mode: "fullscreen" }).catch((error: unknown) => {
    liveAnnouncerEl.textContent =
      `Fullscreen unavailable: ${error instanceof Error ? error.message : String(error)}`;
  });
});

graphViewportEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  isPanning = true;
  panPointerId = event.pointerId;
  panStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: transform.x,
    y: transform.y,
  };
  graphViewportEl.setPointerCapture(event.pointerId);
  graphViewportEl.classList.add("is-panning");
});
graphViewportEl.addEventListener("pointermove", (event) => {
  if (!isPanning || event.pointerId !== panPointerId) return;
  transform = {
    ...transform,
    x: panStart.x + event.clientX - panStart.clientX,
    y: panStart.y + event.clientY - panStart.clientY,
  };
  renderGraph();
});
graphViewportEl.addEventListener("pointerup", endPan);
graphViewportEl.addEventListener("pointercancel", endPan);
graphViewportEl.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = graphViewportEl.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const nextScale = Math.min(2.2, Math.max(0.15, transform.scale * Math.exp(-event.deltaY * 0.0015)));
  const worldX = (pointerX - transform.x) / transform.scale;
  const worldY = (pointerY - transform.y) / transform.scale;
  transform = {
    scale: nextScale,
    x: pointerX - worldX * nextScale,
    y: pointerY - worldY * nextScale,
  };
  renderGraph();
}, { passive: false });

function endPan(event: PointerEvent): void {
  if (event.pointerId !== panPointerId) return;
  isPanning = false;
  panPointerId = undefined;
  graphViewportEl.classList.remove("is-panning");
}

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement) return;
  if (event.key === "Escape") {
    dispatch({ type: "select-node", nodeId: undefined });
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    moveGraphSelection(1);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    moveGraphSelection(-1);
  }
});

const resizeObserver = new ResizeObserver(() => {
  renderGraph();
  renderEvents();
});
resizeObserver.observe(graphViewportEl);
resizeObserver.observe(eventListEl);

if (visualFixtureMode) {
  const display = DisplayWorkflowGraphOutputSchema.parse(observeGraphVisualFixture.display);
  const updates = FetchWorkflowGraphUpdatesOutputSchema.parse(
    observeGraphVisualFixture.updates,
  );
  dispatch({ type: "bootstrap", payload: display });
  dispatch({ type: "updates", payload: updates });
  fullscreenButtonEl.hidden = true;
} else {
  app.connect().then(async () => {
    const context = app.getHostContext();
    if (context) {
      handleHostContext(context);
      if (
        context.displayMode !== "fullscreen"
        && context.availableDisplayModes?.includes("fullscreen")
      ) {
        await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
      }
    }
  }).catch((error: unknown) => {
    showError(error instanceof Error ? error.message : String(error));
  });
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1_000) return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getHours()).padStart(2, "0")}:` +
    `${String(date.getMinutes()).padStart(2, "0")}:` +
    `${String(date.getSeconds()).padStart(2, "0")}.` +
    `${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function compareNodes(left: WorkflowGraphNode, right: WorkflowGraphNode): number {
  return (left.started_at ?? "").localeCompare(right.started_at ?? "")
    || left.node_id.localeCompare(right.node_id);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
