import assert from "node:assert/strict";
import test from "node:test";
import {
  DisplayWorkflowGraphOutputSchema,
  FetchWorkflowGraphUpdatesOutputSchema,
} from "./contract-validation.js";
import {
  createWorkflowDebuggerState,
  reconnectDelayMs,
  reduceWorkflowDebugger,
} from "./workflow-reducer.js";
import {
  isRadialEligible,
  layoutWorkflowGraph,
  visibleWorkflowNodeIds,
} from "./workflow-layout.js";

const contentRef = `sha256:${"b".repeat(64)}`;
const recorded = {
  type: "recorded" as const,
  event_ids: ["event-spawn"],
};
const graph = {
  run: {
    run_id: "run-replay",
    thread_id: "thread-1",
    title: "failure then resume",
    status: "active",
    started_at: "2026-07-28T12:00:00Z",
    latest_journal_sequence: "4",
    active_attempt_id: "attempt-2",
  },
  nodes: [
    {
      node_id: "run",
      kind: "run",
      label: "run",
      status: "active",
      started_at: "2026-07-28T12:00:00Z",
      duration_ms: 4000,
    },
    {
      node_id: "agent:a:attempt-1",
      kind: "agent",
      label: "worker A",
      status: "failed",
      attempt_id: "attempt-1",
      agent_id: "agent-a",
      started_at: "2026-07-28T12:00:00Z",
      ended_at: "2026-07-28T12:00:01Z",
      duration_ms: 1000,
      content_refs: [contentRef],
    },
    {
      node_id: "agent:b:attempt-1",
      kind: "agent",
      label: "worker B",
      status: "succeeded",
      attempt_id: "attempt-1",
      agent_id: "agent-b",
      started_at: "2026-07-28T12:00:00Z",
      ended_at: "2026-07-28T12:00:02Z",
      duration_ms: 2000,
    },
    {
      node_id: "join",
      kind: "gate",
      label: "join",
      status: "running",
      attempt_id: "attempt-2",
      started_at: "2026-07-28T12:00:02Z",
      duration_ms: 2000,
    },
  ],
  edges: [
    {
      edge_id: "root-a",
      source_node_id: "run",
      target_node_id: "agent:a:attempt-1",
      kind: "control",
      provenance: recorded,
    },
    {
      edge_id: "root-b",
      source_node_id: "run",
      target_node_id: "agent:b:attempt-1",
      kind: "control",
      provenance: recorded,
    },
    {
      edge_id: "a-join",
      source_node_id: "agent:a:attempt-1",
      target_node_id: "join",
      kind: "gate",
      provenance: {
        type: "derived",
        event_ids: ["event-write-a", "event-write-b"],
        evidence: "both workers wrote src/shared.ts",
        confidence: 0.9,
      },
    },
    {
      edge_id: "b-join",
      source_node_id: "agent:b:attempt-1",
      target_node_id: "join",
      kind: "gate",
      provenance: recorded,
    },
  ],
  statistics: {
    t1_ms: 7000,
    t_infinity_ms: 4000,
    wall_time_ms: 4000,
    peak_concurrency: 2,
    worker_count: 2,
    parallel_lower_bound_ms: 4000,
    critical_path_node_ids: ["run", "agent:b:attempt-1", "join"],
  },
  journal_sequence: "4",
  has_more_nodes: false,
  has_more_edges: false,
  total_node_count: 4,
  total_edge_count: 4,
};

test("workflow replay reducer is deterministic and preserves failed attempts", () => {
  const display = DisplayWorkflowGraphOutputSchema.parse({
    graph,
    live_controls_available: true,
    mode: "live",
  });
  const initial = reduceWorkflowDebugger(createWorkflowDebuggerState(), {
    type: "bootstrap",
    payload: display,
  });
  assert.equal(initial.journalCursor, "0");

  const update = FetchWorkflowGraphUpdatesOutputSchema.parse({
    page: {
      events: [{
        event_id: "event-resume",
        source_sequence: "5",
        timestamp: "2026-07-28T12:00:04Z",
        kind: "attempt_completed",
        attempt_id: "attempt-2",
        run_id: "run-replay",
        client_id: "qyl-codex",
        journal_sequence: "5",
      }],
      next_sequence: "5",
      high_water_mark: "5",
      cursor_gap: false,
    },
    graph: {
      ...graph,
      nodes: [{
        node_id: "agent:a:attempt-2",
        kind: "agent",
        label: "worker A",
        status: "succeeded",
        attempt_id: "attempt-2",
        agent_id: "agent-a",
        started_at: "2026-07-28T12:00:03Z",
        ended_at: "2026-07-28T12:00:04Z",
        duration_ms: 1000,
      }],
      edges: [],
      journal_sequence: "5",
      total_node_count: 5,
      total_edge_count: 4,
    },
    content: {
      content_ref: contentRef,
      content_type: "text/plain",
      encoding: "utf8",
      content: "resume result",
      size_bytes: 13,
    },
    mode: "live",
  });
  const once = reduceWorkflowDebugger(initial, { type: "updates", payload: update });
  const twice = reduceWorkflowDebugger(once, { type: "updates", payload: update });

  assert.deepEqual(twice, once);
  assert.equal(
    once.graph?.nodes.find((node) => node.node_id === "agent:a:attempt-1")?.status,
    "failed",
  );
  assert.equal(
    once.graph?.nodes.find((node) => node.node_id === "agent:a:attempt-2")?.status,
    "succeeded",
  );
  assert.equal(once.events.length, 1);
  assert.equal(once.content[contentRef]?.content, "resume result");
  assert.equal(
    once.graph?.edges.find((edge) => edge.edge_id === "a-join")?.provenance.type,
    "derived",
  );
});

test("cursor-gap recovery replaces the event window and reconnect backoff is bounded", () => {
  const display = DisplayWorkflowGraphOutputSchema.parse({
    graph,
    live_controls_available: true,
    mode: "live",
  });
  const initial = reduceWorkflowDebugger(createWorkflowDebuggerState(), {
    type: "bootstrap",
    payload: display,
  });
  const gap = FetchWorkflowGraphUpdatesOutputSchema.parse({
    page: {
      events: [{
        event_id: "event-retained",
        source_sequence: "50",
        timestamp: "2026-07-28T13:00:00Z",
        kind: "thread_resumed",
        run_id: "run-replay",
        client_id: "qyl-codex",
        journal_sequence: "50",
      }],
      next_sequence: "50",
      high_water_mark: "50",
      cursor_gap: true,
    },
    mode: "live",
  });
  const recovered = reduceWorkflowDebugger(initial, { type: "updates", payload: gap });
  assert.deepEqual(recovered.events.map((event) => event.event_id), ["event-retained"]);
  assert.equal(recovered.cursorGapCount, 1);
  assert.equal(reconnectDelayMs(0), 500);
  assert.equal(reconnectDelayMs(20), 15_000);
});

test("workflow layouts are deterministic and radial mode is limited to fan-out/fan-in", () => {
  const snapshot = DisplayWorkflowGraphOutputSchema.parse({
    graph,
    live_controls_available: true,
    mode: "live",
  }).graph;
  assert.equal(isRadialEligible(snapshot), true);

  const first = layoutWorkflowGraph(snapshot, "layered");
  const second = layoutWorkflowGraph(snapshot, "layered");
  assert.deepEqual([...first.positions], [...second.positions]);
  assert.equal(first.mode, "layered");

  const radial = layoutWorkflowGraph(snapshot, "radial");
  assert.equal(radial.mode, "radial");
  const visible = visibleWorkflowNodeIds(
    first,
    { x: 0, y: 0, scale: 1 },
    first.width,
    first.height,
  );
  assert.equal(visible.size, snapshot.nodes.length);
});
