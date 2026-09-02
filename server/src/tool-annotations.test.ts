import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { connectModernTestClient } from "./modern-test-client.test-helper.js";
import { createServer, registerViewerResource } from "./server.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS } from "./tools.js";
import { CONTROL_WORKFLOW_TOOL_ANNOTATIONS } from "./workflow-tools.js";

test("qyl tools publish explicit read versus control safety annotations", async () => {
  const connection = await connectModernTestClient(
    { name: "tool-annotations-test", version: "1.0.0" },
    () => createServer({ nativeExecution: false }),
  );

  try {
    const { tools } = await connection.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "ci_log",
        "control_workflow_run",
        "display_mcp_dashboard",
        "display_traces",
        "display_workflow_graph",
        "fetch_telemetry",
        "fetch_workflow_graph_updates",
        "get_metric_series",
        "get_trace",
        "get_workflow_graph",
        "inspect_workflow_events",
        "list_metrics",
        "list_sessions",
        "list_traces",
        "list_workflow_runs",
        "query_metric",
        "search_logs",
      ],
    );
    for (const tool of tools) {
      assert.deepEqual(
        tool.annotations,
        tool.name === "control_workflow_run"
          ? CONTROL_WORKFLOW_TOOL_ANNOTATIONS
          : READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
        tool.name,
      );
    }

    const inspectionTool = tools.find((tool) => tool.name === "inspect_workflow_events");
    assert.ok(inspectionTool, "inspect_workflow_events must be model-visible");
    assert.equal(inspectionTool._meta, undefined);
    assert.match(inspectionTool.description ?? "", /content_captured/u);
    assert.match(inspectionTool.description ?? "", /safe machine-readable summary in data/u);
    assert.match(inspectionTool.description ?? "", /protected evidence.*content_ref/u);
  } finally {
    await connection.close();
  }
});

test("qyl server factory serves protocol revision 2026-07-28 over the fetch entry", async () => {
  const handler = createMcpHandler(
    () => createServer({ nativeExecution: false }),
    { legacy: "reject" },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://qyl.test/mcp"),
    {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    },
  );
  const client = new Client(
    { name: "qyl-modern-conformance", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.equal(client.getServerVersion()?.name, "qyl.mcp");

    const toolsResult = await client.listTools() as Awaited<ReturnType<Client["listTools"]>> & {
      ttlMs: number;
      cacheScope: string;
    };
    const { tools } = toolsResult;
    assert.equal(tools.length, 17);
    assert.equal(toolsResult.ttlMs, 300_000);
    assert.equal(toolsResult.cacheScope, "public");
    const discover = client.getDiscoverResult() as ReturnType<Client["getDiscoverResult"]> & {
      ttlMs: number;
      cacheScope: string;
    };
    assert.equal(discover?.ttlMs, 300_000);
    assert.equal(discover?.cacheScope, "public");
    const displayMetadata = tools.find((tool) => tool.name === "display_traces")?._meta as
      | { ui?: { resourceUri?: unknown } }
      | undefined;
    assert.equal(
      displayMetadata?.ui?.resourceUri,
      "ui://qyl-explorer/mcp-app.html",
    );
    const workflowMetadata = tools.find((tool) => tool.name === "display_workflow_graph")?._meta as
      | { ui?: { resourceUri?: unknown } }
      | undefined;
    assert.equal(
      workflowMetadata?.ui?.resourceUri,
      "ui://qyl-explorer/observe-graph.html",
    );

    const resourcesResult = await client.listResources() as Awaited<ReturnType<Client["listResources"]>> & {
      ttlMs: number;
      cacheScope: string;
    };
    const { resources } = resourcesResult;
    assert.equal(resourcesResult.ttlMs, 300_000);
    assert.equal(resourcesResult.cacheScope, "public");
    assert.equal(
      resources.find((resource) => resource.uri === "ui://qyl-explorer/mcp-app.html")?.mimeType,
      "text/html;profile=mcp-app",
    );
    assert.equal(
      resources.find((resource) =>
        resource.uri === "ui://qyl-explorer/observe-graph.html"
      )?.mimeType,
      "text/html;profile=mcp-app",
    );
    const appResult = await client.readResource({ uri: "ui://qyl-explorer/mcp-app.html" }) as
      Awaited<ReturnType<Client["readResource"]>> & { ttlMs: number; cacheScope: string };
    assert.equal(appResult.ttlMs, 86_400_000);
    assert.equal(appResult.cacheScope, "public");
    const workflowResult = await client.readResource({
      uri: "ui://qyl-explorer/observe-graph.html",
    }) as Awaited<ReturnType<Client["readResource"]>> & {
      ttlMs: number;
      cacheScope: string;
    };
    assert.equal(workflowResult.ttlMs, 86_400_000);
    assert.equal(workflowResult.cacheScope, "public");
    const workflowContent = workflowResult.contents[0];
    assert(workflowContent && "text" in workflowContent);
    assert.match(workflowContent.text, /qyl · observe graph/);
  } finally {
    await client.close().catch(() => undefined);
    await handler.close().catch(() => undefined);
  }
});

test("a viewer whose bundle is missing reads as a typed resource-not-found error", async () => {
  const missingUri = "ui://qyl-explorer/not-built.html";
  const connection = await connectModernTestClient(
    { name: "viewer-error-test", version: "1.0.0" },
    () => {
      const server = createServer({ nativeExecution: false });
      registerViewerResource(server, missingUri, "definitely-not-built.html");
      return server;
    },
  );

  try {
    await assert.rejects(
      () => connection.client.readResource({ uri: missingUri }),
      (error: unknown) => {
        // errors.md: a read callback has no isError channel, and anything that
        // is not a ProtocolError leaves as -32603 carrying the raw exception —
        // here fs's ENOENT, which would also publish an absolute server path.
        assert.ok(ProtocolError.isInstance(error), `not a ProtocolError: ${String(error)}`);
        assert.equal(error.code, ProtocolErrorCode.InvalidParams);
        assert.deepEqual(error.data, { uri: missingUri });
        assert.match(error.message, /is not built/u);
        assert.doesNotMatch(error.message, /ENOENT/u);
        assert.doesNotMatch(error.message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        return true;
      },
    );
  } finally {
    await connection.close();
  }
});
