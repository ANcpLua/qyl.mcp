import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function loopbackHosts(port: number): string[] {
  return [
    "127.0.0.1",
    "localhost",
    "[::1]",
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ];
}

function loopbackOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
}

/**
 * Official MCP Express ownership supplies loopback Host validation before a
 * request reaches the protocol transport.
 */
export function createLoopbackMcpApp() {
  return createMcpExpressApp({ host: "127.0.0.1" });
}

/**
 * The official Streamable HTTP transport owns the MCP error envelope emitted
 * for a rejected Host or Origin. Native clients without Origin remain valid.
 */
export function createLoopbackMcpTransport(port: number): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: loopbackHosts(port),
    allowedOrigins: loopbackOrigins(port),
  });
}
