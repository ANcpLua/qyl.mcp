import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS } from "./tools.js";

test("all qyl telemetry tools publish explicit read-only safety annotations", async () => {
  const server = createServer({ nativeExecution: false });
  const client = new Client({ name: "tool-annotations-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "ci_log",
        "display_mcp_dashboard",
        "display_traces",
        "fetch_telemetry",
        "get_trace",
        "list_sessions",
        "list_traces",
        "search_logs",
      ],
    );
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, tool.name);
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
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
    assert.equal(tools.length, 8);
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
    const appResult = await client.readResource({ uri: "ui://qyl-explorer/mcp-app.html" }) as
      Awaited<ReturnType<Client["readResource"]>> & { ttlMs: number; cacheScope: string };
    assert.equal(appResult.ttlMs, 86_400_000);
    assert.equal(appResult.cacheScope, "public");
  } finally {
    await client.close().catch(() => undefined);
    await handler.close().catch(() => undefined);
  }
});
