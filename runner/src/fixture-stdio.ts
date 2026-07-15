import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFixtureMcpServer } from "./fixture-server.js";

export interface RunningFixtureStdioServer {
  server: McpServer;
  close(): Promise<void>;
}

export async function startFixtureStdioServer(): Promise<RunningFixtureStdioServer> {
  const fixture = createFixtureMcpServer();
  const transport = new StdioServerTransport();
  await fixture.server.connect(transport);

  let closed = false;
  return {
    server: fixture.server,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await fixture.server.close();
    },
  };
}
