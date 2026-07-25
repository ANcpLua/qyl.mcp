import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createFixtureMcpServer } from "./fixture-server.js";

export interface RunningFixtureStdioServer {
  close(): Promise<void>;
}

export function startFixtureStdioServer(): RunningFixtureStdioServer {
  const handle = serveStdio(
    () => createFixtureMcpServer().server,
    { legacy: "reject" },
  );

  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
