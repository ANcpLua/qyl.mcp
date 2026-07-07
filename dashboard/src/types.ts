// Mirrors McpResourceState served by the runner's /runner API (camelCase, string enums).
// Port of qyl.run.console types.ts, extended with the additive mcp-run fields.
export type ResourceLifecycle =
  | "Pending" | "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed";

export interface ResourceState {
  name: string;
  lifecycle: ResourceLifecycle;
  timestamp: string;
  allocatedPort: number | null;
  endpoint: string | null;
  lastError: string | null;
  // mcp-run extensions (additive — absent fields render as "—"):
  kind?: "stdio" | "http";
  serverInfo?: { name: string; version: string } | null;
  toolCount?: number | null;
  hasAppUi?: boolean;
  restarts?: number;
}

export interface LogLine {
  resource: string;
  stream: "out" | "err";
  line: string;
}
