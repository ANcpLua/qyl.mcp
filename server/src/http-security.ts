import { createMcpExpressApp } from "@modelcontextprotocol/express";

export interface McpAppOptions {
  bindHost: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function createMcpApp({ bindHost, allowedHosts, allowedOrigins }: McpAppOptions) {
  return createMcpExpressApp({
    host: bindHost,
    allowedHosts: allowedHosts === undefined ? undefined : unique([...allowedHosts]),
    allowedOrigins: allowedOrigins === undefined ? undefined : unique([...allowedOrigins]),
  });
}

export function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
