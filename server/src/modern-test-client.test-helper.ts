import {
  Client,
  StreamableHTTPClientTransport,
  type Implementation,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  type McpServer,
} from "@modelcontextprotocol/server";

export interface ModernTestClient {
  client: Client;
  close(): Promise<void>;
}

export async function connectModernTestClient(
  clientInfo: Implementation,
  factory: () => McpServer | Promise<McpServer>,
): Promise<ModernTestClient> {
  const handler = createMcpHandler(factory, { legacy: "reject" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://qyl-modern-test.invalid/mcp"),
    { fetch: (url, init) => handler.fetch(new Request(url, init)) },
  );
  const client = new Client(clientInfo, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await handler.close();
    throw error;
  }

  return {
    client,
    async close() {
      const results = await Promise.allSettled([client.close(), handler.close()]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "MCP test cleanup failed.");
    },
  };
}
