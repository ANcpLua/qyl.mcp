// ≈ Qyl.Run/QylResources.cs — immutable resource records; the builder replaces on update.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ResourceLifecycle = "Pending" | "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed";

export type ResourceKind = "stdio" | "http" | "inproc";

export interface McpLaunchSpec {
    // ≈ QylLaunchSpec
    command: string; // executable for stdio kind; "" for http/inproc kinds
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd?: string;
}

export interface McpResource {
    // ≈ QylResource (immutable; builder replaces on update)
    name: string; // unique, ordinal-compared
    kind: ResourceKind;
    environment: string; // "dev" | "staging" | "prod"
    launch: McpLaunchSpec; // http/inproc kinds: empty command, endpoint/serverFactory below
    endpoint?: string; // http kind only: upstream MCP URL
    // inproc kind only: builds a fresh MCP server instance per (re)start.
    // ≈ a Func<IMcpServer> on QylResource in the later C# port.
    serverFactory?: () => McpServer;
    waitForNames: readonly string[];
    // Resources whose resolved endpoint is injected into this resource's environment (service discovery).
    references: readonly string[];
    description?: string;
}

export interface McpResourceState {
    // ≈ QylResourceState — EXACT wire shape of the /runner API
    name: string;
    lifecycle: ResourceLifecycle;
    timestamp: string; // ISO 8601
    allocatedPort: number | null; // stdio: null (no port); http: upstream port if parseable
    endpoint: string | null; // the RUNNER PROXY url for this server
    lastError: string | null;
    // qyl.mcp extensions (additive — qyl dashboard ignores unknown fields):
    kind?: ResourceKind;
    serverInfo?: { name: string; version: string } | null; // from MCP initialize
    toolCount?: number | null;
    hasAppUi?: boolean; // any tool with _meta.ui.resourceUri
    restarts?: number;
}

export interface LogLine {
    resource: string;
    stream: "out" | "err";
    line: string;
}
