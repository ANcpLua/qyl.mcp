import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import {
  fetchWorkflowGraphUpdates,
  getWorkflowGraph,
  inspectWorkflowEvents,
  listWorkflowRuns,
  parseWorkflowGraph,
  submitWorkflowControl,
} from "./workflow-data.js";
import {
  ControlWorkflowRunInputSchema,
  FetchWorkflowGraphUpdatesInputSchema,
  GetWorkflowGraphInputSchema,
  InspectWorkflowEventsInputSchema,
  ListWorkflowRunsInputSchema,
} from "./contract-validation.js";

const contentRef = `sha256:${"a".repeat(64)}`;
const generation = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const run = {
  run_id: "run-1",
  generation,
  thread_id: "thread-1",
  title: "fan-out fixture",
  status: "active",
  started_at: "2026-07-28T12:00:00+00:00",
  latest_journal_sequence: "7",
  active_attempt_id: "attempt-1",
};
const graph = {
  run,
  projection_status: {
    state: "committed",
    generation,
    journal_position: "7",
  },
  nodes: [{
    node_id: "agent:root",
    kind: "agent",
    label: "root",
    status: "running",
    attempt_id: "attempt-1",
    agent_id: "agent-root",
    started_at: "2026-07-28T12:00:00+00:00",
    duration_ms: 1500,
    content_refs: [contentRef],
  }],
  edges: [],
  statistics: {
    t1_ms: 1500,
    t_infinity_ms: 1500,
    wall_time_ms: 1500,
    peak_concurrency: 1,
    worker_count: 1,
    parallel_lower_bound_ms: 1500,
    critical_path_node_ids: ["agent:root"],
  },
  journal_sequence: "7",
  has_more_nodes: false,
  has_more_edges: false,
  total_node_count: 1,
  total_edge_count: 0,
};

test("workflow collector client enforces generated shapes and server-owned project scope", async (context) => {
  const requests: Array<{
    method: string;
    url: URL;
    headers: IncomingMessage["headers"];
    body: unknown;
  }> = [];
  const listener = createServer(async (request, response) => {
    const body = await readJson(request);
    const url = new URL(request.url ?? "/", "http://collector.test");
    requests.push({
      method: request.method ?? "",
      url,
      headers: request.headers,
      body,
    });
    routeFixture(request.method ?? "", url, body, response);
  });
  await listen(listener);
  context.after(() => close(listener));
  const address = listener.address();
  assert(address && typeof address === "object");

  const previous = {
    url: process.env.QYL_COLLECTOR_URL,
    key: process.env.QYL_API_KEY,
    project: process.env.QYL_PROJECT,
  };
  process.env.QYL_COLLECTOR_URL = `http://127.0.0.1:${address.port}/`;
  process.env.QYL_API_KEY = "collector-key";
  process.env.QYL_PROJECT = "project-server-owned";
  context.after(() => {
    restoreEnvironment("QYL_COLLECTOR_URL", previous.url);
    restoreEnvironment("QYL_API_KEY", previous.key);
    restoreEnvironment("QYL_PROJECT", previous.project);
  });

  const listed = await listWorkflowRuns(ListWorkflowRunsInputSchema.parse({ limit: 1 }));
  assert.equal(listed.runs[0]?.started_at, "2026-07-28T12:00:00.000Z");
  assert.equal(listed.mode, "live");

  const projected = await getWorkflowGraph(
    GetWorkflowGraphInputSchema.parse({ run_id: "run-1" }),
  );
  assert.equal(projected.nodes[0]?.started_at, "2026-07-28T12:00:00.000Z");
  assert.equal(projected.statistics.t_infinity_ms, 1500);

  const updates = await fetchWorkflowGraphUpdates(
    FetchWorkflowGraphUpdatesInputSchema.parse({
      run_id: "run-1",
      after_sequence: "7",
      content_ref: contentRef,
    }),
  );
  assert.equal(updates.page.events.length, 0);
  assert.equal(updates.content?.content, "captured prompt");
  assert.equal(updates.graph, undefined);

  const inspected = await inspectWorkflowEvents(
    InspectWorkflowEventsInputSchema.parse({
      run_id: "run-1",
      after_sequence: "7",
      content_ref: contentRef,
    }),
  );
  assert.equal(inspected.page.events.length, 0);
  assert.equal(inspected.content?.content, "captured prompt");
  assert.equal(Object.hasOwn(inspected, "graph"), false);

  const command = await submitWorkflowControl(
    ControlWorkflowRunInputSchema.parse({
      run_id: "run-1",
      action: "steer",
      idempotency_key: "steer-1",
      input: "focus the failing worker",
    }),
  );
  assert.equal(command.status, "requested");
  assert.equal(command.requested_at, "2026-07-28T12:00:02.000Z");

  for (const request of requests) {
    assert.equal(request.headers["x-qyl-project"], "project-server-owned");
    assert.equal(request.headers["x-otlp-api-key"], "collector-key");
  }
  assert.equal(requests[0]?.url.searchParams.get("limit"), "1");
  const eventRequests = requests.filter((request) =>
    request.url.pathname === "/api/v1/workflow-runs/run-1/events"
  );
  assert.equal(eventRequests.length, 2);
  assert.equal(eventRequests[0]?.url.searchParams.get("wait_ms"), "0");
  assert.equal(eventRequests[1]?.url.searchParams.get("wait_ms"), "0");
  assert.equal(eventRequests[1]?.url.searchParams.get("limit"), "250");
  assert.equal(
    requests.filter((request) => request.url.pathname.endsWith("/graph")).length,
    1,
  );
  assert.equal(
    requests.find((request) => request.method === "POST")?.body
      && (requests.find((request) => request.method === "POST")!.body as { idempotency_key: string })
        .idempotency_key,
    "steer-1",
  );
});

test("workflow graph parser rejects uncontracted projection fields", () => {
  assert.equal(parseWorkflowGraph(graph).run.started_at, "2026-07-28T12:00:00.000Z");
  assert.throws(
    () => parseWorkflowGraph({ ...graph, inferred_parallelism: 17 }),
    /Unrecognized key/u,
  );
});

function routeFixture(
  method: string,
  url: URL,
  body: unknown,
  response: ServerResponse,
): void {
  if (method === "GET" && url.pathname === "/api/v1/workflow-runs") {
    json(response, { items: [run], has_more: false });
    return;
  }
  if (method === "GET" && url.pathname === "/api/v1/workflow-runs/run-1/graph") {
    json(response, graph);
    return;
  }
  if (method === "GET" && url.pathname === "/api/v1/workflow-runs/run-1/events") {
    json(response, {
      events: [],
      next_sequence: "7",
      high_water_mark: "7",
      cursor_gap: false,
    });
    return;
  }
  if (
    method === "GET"
    && decodeURIComponent(url.pathname)
      === `/api/v1/workflow-runs/run-1/content/${contentRef}`
  ) {
    json(response, {
      content_ref: contentRef,
      content_type: "text/plain",
      encoding: "utf8",
      content: "captured prompt",
      size_bytes: 15,
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/v1/workflow-runs/run-1/commands") {
    assert.deepEqual(body, {
      action: "steer",
      idempotency_key: "steer-1",
      input: "focus the failing worker",
    });
    json(response, {
      command_id: "command-1",
      run_id: "run-1",
      action: "steer",
      status: "requested",
      idempotency_key: "steer-1",
      input: "focus the failing worker",
      requested_at: "2026-07-28T12:00:02+00:00",
      updated_at: "2026-07-28T12:00:02+00:00",
      command_sequence: "1",
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/problem+json" });
  response.end(JSON.stringify({ type: "about:blank", title: "Not found", status: 404 }));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
