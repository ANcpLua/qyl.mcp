import type {
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphSnapshot,
} from "@ancplua/qyl-api-schema/types";

export type WorkflowLayoutMode = "layered" | "radial";

export interface WorkflowNodePosition {
  node: WorkflowGraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
}

export interface WorkflowLayout {
  mode: WorkflowLayoutMode;
  width: number;
  height: number;
  positions: Map<string, WorkflowNodePosition>;
}

export interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

const NODE_WIDTH = 184;
const NODE_HEIGHT = 62;

export function layoutWorkflowGraph(
  graph: WorkflowGraphSnapshot,
  requestedMode: WorkflowLayoutMode,
): WorkflowLayout {
  const mode =
    requestedMode === "radial" && isRadialEligible(graph)
      ? "radial"
      : "layered";
  return mode === "radial" ? radialLayout(graph.nodes) : layeredLayout(graph.nodes, graph.edges);
}

export function isRadialEligible(graph: WorkflowGraphSnapshot): boolean {
  if (graph.nodes.length < 4 || graph.nodes.length > 24) return false;
  const indegree = degreeMap(graph.nodes);
  const outdegree = degreeMap(graph.nodes);
  for (const edge of graph.edges) {
    indegree.set(edge.target_node_id, (indegree.get(edge.target_node_id) ?? 0) + 1);
    outdegree.set(edge.source_node_id, (outdegree.get(edge.source_node_id) ?? 0) + 1);
  }
  const roots = graph.nodes.filter((node) => (indegree.get(node.node_id) ?? 0) === 0);
  const sinks = graph.nodes.filter((node) => (outdegree.get(node.node_id) ?? 0) === 0);
  return (
    roots.length === 1
    && sinks.length === 1
    && graph.nodes.some((node) => (outdegree.get(node.node_id) ?? 0) >= 2)
    && graph.nodes.some((node) => (indegree.get(node.node_id) ?? 0) >= 2)
  );
}

export function visibleWorkflowNodeIds(
  layout: WorkflowLayout,
  transform: ViewTransform,
  viewportWidth: number,
  viewportHeight: number,
  overscan = 160,
): Set<string> {
  const visible = new Set<string>();
  for (const [nodeId, position] of layout.positions) {
    const left = position.x * transform.scale + transform.x;
    const top = position.y * transform.scale + transform.y;
    const right = left + position.width * transform.scale;
    const bottom = top + position.height * transform.scale;
    if (
      right >= -overscan
      && bottom >= -overscan
      && left <= viewportWidth + overscan
      && top <= viewportHeight + overscan
    ) {
      visible.add(nodeId);
    }
  }
  return visible;
}

function layeredLayout(
  nodes: readonly WorkflowGraphNode[],
  edges: readonly WorkflowGraphEdge[],
): WorkflowLayout {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const indegree = degreeMap(nodes);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source_node_id) || !byId.has(edge.target_node_id)) continue;
    indegree.set(edge.target_node_id, (indegree.get(edge.target_node_id) ?? 0) + 1);
    const targets = outgoing.get(edge.source_node_id) ?? [];
    targets.push(edge.target_node_id);
    outgoing.set(edge.source_node_id, targets);
  }

  const ranks = new Map<string, number>();
  const queue: string[] = nodes
    .filter((node) => (indegree.get(node.node_id) ?? 0) === 0)
    .sort(compareNodes)
    .map((node) => node.node_id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const rank = ranks.get(nodeId) ?? 0;
    for (const targetId of [...(outgoing.get(nodeId) ?? [])].sort()) {
      ranks.set(targetId, Math.max(ranks.get(targetId) ?? 0, rank + 1));
      const nextDegree = (indegree.get(targetId) ?? 1) - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) queue.push(targetId);
    }
    queue.sort();
  }

  let fallbackRank = Math.max(0, ...ranks.values());
  for (const node of [...nodes].sort(compareNodes)) {
    if (visited.has(node.node_id)) continue;
    ranks.set(node.node_id, fallbackRank++);
  }

  const layers = new Map<number, WorkflowGraphNode[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.node_id) ?? 0;
    const layer = layers.get(rank) ?? [];
    layer.push(node);
    layers.set(rank, layer);
  }
  for (const layer of layers.values()) layer.sort(compareNodes);

  const positions = new Map<string, WorkflowNodePosition>();
  const padding = 54;
  const columnGap = 104;
  const rowGap = 28;
  let maximumRows = 1;
  for (const [rank, layer] of [...layers].sort(([left], [right]) => left - right)) {
    maximumRows = Math.max(maximumRows, layer.length);
    layer.forEach((node, index) => {
      positions.set(node.node_id, {
        node,
        x: padding + rank * (NODE_WIDTH + columnGap),
        y: padding + index * (NODE_HEIGHT + rowGap),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        rank,
      });
    });
  }
  const maximumRank = Math.max(0, ...ranks.values());
  return {
    mode: "layered",
    width: padding * 2 + (maximumRank + 1) * NODE_WIDTH + maximumRank * columnGap,
    height: padding * 2 + maximumRows * NODE_HEIGHT + (maximumRows - 1) * rowGap,
    positions,
  };
}

function radialLayout(nodes: readonly WorkflowGraphNode[]): WorkflowLayout {
  const sorted = [...nodes].sort(compareNodes);
  const width = 920;
  const height = 680;
  const centerX = width / 2 - NODE_WIDTH / 2;
  const centerY = height / 2 - NODE_HEIGHT / 2;
  const positions = new Map<string, WorkflowNodePosition>();
  const root = sorted[0];
  const sink = sorted.at(-1);
  if (root) {
    positions.set(root.node_id, {
      node: root,
      x: centerX,
      y: 44,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      rank: 0,
    });
  }
  const ring = sorted.slice(1, -1);
  ring.forEach((node, index) => {
    const angle = (index / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
    positions.set(node.node_id, {
      node,
      x: centerX + Math.cos(angle) * 300,
      y: centerY + Math.sin(angle) * 220,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      rank: 1,
    });
  });
  if (sink && sink !== root) {
    positions.set(sink.node_id, {
      node: sink,
      x: centerX,
      y: height - NODE_HEIGHT - 44,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      rank: 2,
    });
  }
  return { mode: "radial", width, height, positions };
}

function degreeMap(nodes: readonly WorkflowGraphNode[]): Map<string, number> {
  return new Map(nodes.map((node) => [node.node_id, 0]));
}

function compareNodes(left: WorkflowGraphNode, right: WorkflowGraphNode): number {
  const time = (left.started_at ?? "").localeCompare(right.started_at ?? "");
  return time || left.node_id.localeCompare(right.node_id);
}
