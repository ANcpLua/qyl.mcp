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
import { QYL_MCP_CONTROL_SCOPE, QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";
import { createServer } from "./server.js";
import { hasWorkflowControlScope } from "./workflow-tools.js";

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
