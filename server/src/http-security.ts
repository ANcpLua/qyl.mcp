import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { RequestHandler } from "express";

/**
 * Browser access is not needed for the standalone MCP transport. Keep local
 * same-origin probes possible, while rejecting arbitrary browser origins.
 * Requests without Origin remain valid for native MCP clients.
 */
export function loopbackOriginGuard(port: number): RequestHandler {
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);

  return (request, response, next) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      response.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin" },
        id: null,
      });
      return;
    }
    next();
  };
}

/**
 * Official MCP Express ownership supplies loopback Host validation. The
 * additional Origin guard closes browser-origin access without wildcard CORS.
 */
export function createLoopbackMcpApp(port: number) {
  const app = createMcpExpressApp();
  app.use(loopbackOriginGuard(port));
  return app;
}
