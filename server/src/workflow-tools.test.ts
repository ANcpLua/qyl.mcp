import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { FetchWorkflowGraphUpdatesOutputSchema } from "./contract-validation.js";
import { connectModernTestClient } from "./modern-test-client.test-helper.js";
import { QYL_MCP_CONTROL_SCOPE, QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";
import { createServer } from "./server.js";
import { hasWorkflowControlScope } from "./workflow-tools.js";

const diagnosticContentRef = `sha256:${"d".repeat(64)}`;

test("control scope predicate does not treat read access as mutation authority", () => {
  assert.equal(hasWorkflowControlScope(undefined), false);
  assert.equal(hasWorkflowControlScope([QYL_MCP_SCOPE]), false);
  assert.equal(hasWorkflowControlScope([QYL_MCP_SCOPE, QYL_MCP_CONTROL_SCOPE]), true);
});

test("control_workflow_run enforces qyl:control at the tool boundary", async (context) => {
  const handler = createMcpHandler(
    () => createServer({ nativeExecution: false }),
    { legacy: "reject" },
  );
  context.after(() => handler.close());

  const originalFetch = globalThis.fetch;
  const previousCollector = process.env.QYL_COLLECTOR_URL;
  process.env.QYL_COLLECTOR_URL = "https://collector.test/";
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://collector.test/api/v1/workflow-runs/run-1/commands");
    assert.equal(request.method, "POST");
    return Response.json({
      command_id: "command-1",
      run_id: "run-1",
      action: "interrupt",
      status: "requested",
      idempotency_key: "interrupt-1",
      requested_at: "2026-07-28T12:00:00Z",
      updated_at: "2026-07-28T12:00:00Z",
      command_sequence: "1",
    });
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (previousCollector === undefined) delete process.env.QYL_COLLECTOR_URL;
    else process.env.QYL_COLLECTOR_URL = previousCollector;
  });

  const withoutControl = await callControl(handler, [QYL_MCP_SCOPE]);
  assert.equal(withoutControl.isError, true);
  assert.match(
    withoutControl.content.find((item) => item.type === "text")?.text ?? "",
    /qyl:control/u,
  );

  const withControl = await callControl(handler, [QYL_MCP_SCOPE, QYL_MCP_CONTROL_SCOPE]);
  assert.notEqual(withControl.isError, true);
  assert.equal(
    (withControl.structuredContent as { command?: { status?: string } } | undefined)
      ?.command?.status,
    "requested",
  );
});

test("inspect_workflow_events returns diagnostic events and optional protected content", async (context) => {
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  const previousCollector = process.env.QYL_COLLECTOR_URL;
  process.env.QYL_COLLECTOR_URL = "https://collector.test/";
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);

    if (url.pathname === "/api/v1/workflow-runs/run-1/events") {
      return Response.json({
        events: [{
          event_id: "diagnostic-event-1",
          source_sequence: "8",
          timestamp: "2026-07-28T12:00:03+00:00",
          kind: "content_captured",
          content_refs: [diagnosticContentRef],
          data: {
            extension_id: "qyl.agent.diagnostic.snapshot",
            format_version: 1,
            snapshot_id: "snapshot-1",
            probe_id: "collector-response-shape",
            phase: "checkpoint",
            outcome: "pass",
            variable_count: 1,
            check_count: 1,
            failed_check_count: 0,
            content_ref: diagnosticContentRef,
          },
          run_id: "run-1",
          client_id: "codex",
          journal_sequence: "8",
        }],
        next_sequence: "8",
        high_water_mark: "8",
        cursor_gap: false,
      });
    }

    if (
      decodeURIComponent(url.pathname)
        === `/api/v1/workflow-runs/run-1/content/${diagnosticContentRef}`
    ) {
      return Response.json({
        content_ref: diagnosticContentRef,
        content_type: "application/json",
        encoding: "utf8",
        content: JSON.stringify({
          extension_id: "qyl.agent.diagnostic.snapshot",
          format_version: 1,
          snapshot_id: "snapshot-1",
          capture_nonce: "0123456789abcdef0123456789abcdef",
          probe_id: "collector-response-shape",
          phase: "checkpoint",
          variables: [{
            name: "event_count",
            type: "integer",
            classification: "internal",
            capture: "value",
            value: 3,
          }],
          checks: [{
            check_id: "event-count-exists",
            operator: "exists",
            actual: "event_count",
            outcome: "pass",
          }],
          outcome: "pass",
        }),
        size_bytes: 512,
      });
    }

    assert.fail(`unexpected collector request: ${url.pathname}`);
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (previousCollector === undefined) delete process.env.QYL_COLLECTOR_URL;
    else process.env.QYL_COLLECTOR_URL = previousCollector;
  });

  const connection = await connectModernTestClient(
    { name: "workflow-inspection-test", version: "1.0.0" },
    () => createServer({ nativeExecution: false }),
  );
  context.after(() => connection.close());

  const eventResult = await connection.client.callTool({
    name: "inspect_workflow_events",
    arguments: {
      run_id: "run-1",
      after_sequence: "7",
      wait_ms: 0,
    },
  });
  assert.notEqual(eventResult.isError, true);
  const eventOutput = FetchWorkflowGraphUpdatesOutputSchema.parse(
    eventResult.structuredContent,
  );
  assert.equal(eventOutput.page.events[0]?.kind, "content_captured");
  assert.equal(
    eventOutput.page.events[0]?.data?.extension_id,
    "qyl.agent.diagnostic.snapshot",
  );
  assert.equal(eventOutput.graph, undefined);
  assert.equal(eventOutput.content, undefined);

  const contentResult = await connection.client.callTool({
    name: "inspect_workflow_events",
    arguments: {
      run_id: "run-1",
      after_sequence: "8",
      content_ref: diagnosticContentRef,
    },
  });
  assert.notEqual(contentResult.isError, true);
  const contentOutput = FetchWorkflowGraphUpdatesOutputSchema.parse(
    contentResult.structuredContent,
  );
  assert.equal(contentOutput.graph, undefined);
  assert.equal(contentOutput.content?.content_ref, diagnosticContentRef);
  assert.match(contentOutput.content?.content ?? "", /event_count/u);

  assert.deepEqual(
    requests.map((url) => decodeURIComponent(url.pathname)),
    [
      "/api/v1/workflow-runs/run-1/events",
      "/api/v1/workflow-runs/run-1/events",
      `/api/v1/workflow-runs/run-1/content/${diagnosticContentRef}`,
    ],
  );
  assert.equal(requests[0]?.searchParams.get("after_sequence"), "7");
  assert.equal(requests[0]?.searchParams.get("wait_ms"), "0");
  assert.equal(requests[1]?.searchParams.get("wait_ms"), "0");
  assert.equal(requests.some((url) => url.pathname.endsWith("/graph")), false);
});

async function callControl(
  handler: ReturnType<typeof createMcpHandler>,
  scopes: string[],
) {
  const authInfo: AuthInfo = {
    token: "test-token",
    clientId: "workflow-tool-test",
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    resource: new URL(QYL_MCP_RESOURCE),
  };
  const transport = new StreamableHTTPClientTransport(
    new URL("http://qyl.test/mcp"),
    {
      fetch: (url, init) =>
        handler.fetch(new Request(url, init), { authInfo }),
    },
  );
  const client = new Client(
    { name: "workflow-control-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(transport);
    return await client.callTool({
      name: "control_workflow_run",
      arguments: {
        run_id: "run-1",
        action: "interrupt",
        idempotency_key: "interrupt-1",
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}
