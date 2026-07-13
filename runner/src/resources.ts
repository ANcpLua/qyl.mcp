// Immutable resource records; the builder replaces on update.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
    RunnerLogLine,
    RunnerResourceLifecycle,
    RunnerResourceState,
} from "@ancplua/qyl-api-schema/types";

export type ResourceLifecycle = RunnerResourceLifecycle;

export interface McpLaunchSpec {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd?: string;
}

interface McpResourceBase {
    name: string; // unique, ordinal-compared
    waitForNames: readonly string[];
}

export interface StdioMcpResource extends McpResourceBase {
    kind: "stdio";
    launch: McpLaunchSpec;
}

export interface HttpMcpResource extends McpResourceBase {
    kind: "http";
    endpoint: string;
}

export interface InProcessMcpResource extends McpResourceBase {
    kind: "inproc";
    /** Builds a fresh MCP server instance per (re)start. */
    serverFactory: () => McpServer;
}

export type McpResource = StdioMcpResource | HttpMcpResource | InProcessMcpResource;

export type McpResourceState = RunnerResourceState;
export type LogLine = RunnerLogLine;
