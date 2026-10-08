import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type McpHttpHandler } from "@modelcontextprotocol/server";
import { createHostedHandler } from "./main.js";
import { createServer } from "./server.js";
import { RESOURCE_URI, DASHBOARD_RESOURCE_URI } from "./config.js";
import { hostedUiDomain } from "./ui-domain.js";

const publicMcpUrl = "https://mcp.qyl.at/mcp";
const claudeDomain = "d2d8a324b34d6bf33467665cbb3dc80c.claudemcpcontent.com";
const viewerUris = [RESOURCE_URI, DASHBOARD_RESOURCE_URI];

function endpoint(context: TestContext, url: string = publicMcpUrl): McpHttpHandler {
  const handler = createHostedHandler(() => createServer({
    nativeExecution: false,
    uiDomain: hostedUiDomain(url),
  }), (error) => { throw error; });
  context.after(() => handler.close());
  return handler;
}

async function connect(
  context: TestContext,
  handler: McpHttpHandler,
  name: string,
  era: "modern" | "legacy" = "modern",
  userAgent?: string,
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" }, {
    versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
  });
  context.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL("http://proxy.invalid/mcp"), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      if (userAgent !== undefined) request.headers.set("user-agent", userAgent);
      return handler.fetch(request);
    },
  }));
  assert.equal(client.getProtocolEra(), era);
  return client;
}

async function expectViewers(client: Client, domain: string | undefined): Promise<void> {
  for (const uri of viewerUris) {
    const result = await client.readResource({ uri });
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(result.contents[0]?._meta, {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        ...(domain === undefined ? {} : { domain }),
      },
      "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
    }, uri);
    if (client.getProtocolEra() === "modern" && domain !== undefined) {
      const cache = result as typeof result & { ttlMs: number; cacheScope: string };
      assert.equal(cache.ttlMs, 0);
      assert.equal(cache.cacheScope, "private");
    }
  }
}

test("hosted viewers select Claude's hash or ChatGPT's origin per modern request", async (context) => {
  const handler = endpoint(context);
  const clients = await Promise.all([
    connect(context, handler, "claude-ai"),
    connect(context, handler, "Anthropic/ClaudeAI"),
    // An explicit SDK identity wins over an inconsistent HTTP hint.
    connect(context, handler, "ChatGPT", "modern", "Claude-User/1.0"),
    connect(context, handler, "codex"),
  ]);
  // Repeat after the shared HTML cache is populated, interleaving both hosts.
  for (let pass = 0; pass < 2; pass += 1) {
    await Promise.all(clients.map((client, i) =>
      expectViewers(client, i < 2 ? claudeDomain : "https://mcp.qyl.at")));
  }
});

test("stateless legacy viewer reads use Claude-User without retaining initialize identity", async (context) => {
  const handler = endpoint(context);
  const claude = await connect(context, handler, "Anthropic/ClaudeAI", "legacy", "Claude-User/1.0");
  const chatgpt = await connect(context, handler, "ChatGPT", "legacy", "ChatGPT-User/1.0");
  await Promise.all([
    expectViewers(claude, claudeDomain),
    expectViewers(chatgpt, "https://mcp.qyl.at"),
  ]);
});

test("Claude viewer domains hash the exact configured connector path and trailing slash", async (context) => {
  for (const [url, expected] of [
    [publicMcpUrl, claudeDomain],
    ["https://mcp.qyl.at/mcp/", "0399981e0371e2c66391e3cb1dc441c3.claudemcpcontent.com"],
    ["https://mcp.qyl.at/proxy/mcp", "0ae989abb3194c49c99991f70ace9b6b.claudemcpcontent.com"],
  ] as const) {
    const handler = endpoint(context, url);
    const client = await connect(context, handler, "Claude");
    await expectViewers(client, expected);
  }
});

test("modern requests without clientInfo use the origin and do not inherit another caller", async (context) => {
  const handler = endpoint(context);
  const claude = await connect(context, handler, "claude-ai");
  await expectViewers(claude, claudeDomain);
  for (const uri of viewerUris) {
    const response = await handler.fetch(new Request("http://proxy.invalid/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "resources/read",
        "Mcp-Name": uri,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: {
        uri,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      } }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: {
      contents: { _meta: { ui: { domain: string } } }[];
    } };
    assert.equal(body.result.contents[0]?._meta.ui.domain, "https://mcp.qyl.at");
  }
});

test("viewers without a public URL omit ui.domain for local clients", async (context) => {
  const handler = createHostedHandler(() => createServer({ nativeExecution: false }), () => undefined);
  context.after(() => handler.close());
  await expectViewers(await connect(context, handler, "claude-ai"), undefined);
});
