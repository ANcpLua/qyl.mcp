/**
 * qyl telemetry MCP Apps server (the visual half of qyl.mcp).
 *
 * Tool surface:
 * - display_traces:        trace explorer UI (waterfall + logs) — THE app tool
 * - display_mcp_dashboard: aggregate MCP traffic dashboard UI
 * - list_traces, get_trace, list_sessions, search_logs: direct read tools
 * - fetch_telemetry:       app-only (viewer iframes; hidden from the model)
 *
 * Modes: live against the qyl collector REST API (QYL_COLLECTOR_URL, default
 * http://127.0.0.1:5100), or explicit generated demo telemetry when
 * QYL_DEMO=1. A collector failure remains an error and never changes modes.
 */

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  DisplayMcpDashboardInput,
  DisplayMcpDashboardOutput,
  DisplayTracesInput,
  DisplayTracesOutput,
  FetchTelemetryInput,
  FetchTelemetryOutput,
} from "@ancplua/qyl-api-schema/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { DASHBOARD_RESOURCE_URI, RESOURCE_URI } from "./config.js";
import { CollectorError } from "./collector.js";
import {
  DisplayMcpDashboardInputSchema,
  DisplayMcpDashboardOutputSchema,
  DisplayTracesInputSchema,
  DisplayTracesOutputSchema,
  FetchTelemetryInputSchema,
  FetchTelemetryOutputSchema,
} from "./contract-validation.js";
import {
  fetchLogs,
  fetchMcpStats,
  fetchTrace,
  fetchTraces,
  fetchTracesForDisplay,
} from "./data.js";
import {
  humanizeNs,
  rootSpanName,
  shortId,
  summarizeMcpStats,
} from "./summaries.js";
import {
  READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
  registerTelemetryTools,
  toolError,
} from "./tools.js";
import { registerCiTools } from "./ci.js";
import { telemetryToolResult } from "./telemetry-redaction.js";

// The vite-built single-file viewers live next to the compiled server code.
const DIST_DIR = import.meta.dirname;

// Cached across createServer() calls — in stateless HTTP deployments a fresh
// server is created per request and per-instance caches would be useless.
let cachedAppHtml: string | undefined;
let cachedDashboardHtml: string | undefined;

/** Creates a server with the direct telemetry tools and both UI resources. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "qyl.mcp",
    version: packageMetadata.version,
  });

  registerAppTool(
    server,
    "display_traces",
    {
      title: "Display Traces",
      description:
        "Show qyl traces in the interactive trace explorer with a span waterfall, " +
        "detail panel, and correlated logs. Pass a trace_id to open one trace, a " +
        "session_id for that session's traces, or neither for recent traces. Prefer " +
        "this over list_traces/get_trace whenever the user wants to " +
        "look at traces.",
      inputSchema: DisplayTracesInputSchema,
      outputSchema: DisplayTracesOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ trace_id, session_id, limit }: DisplayTracesInput): Promise<CallToolResult> => {
      try {
        const result = await fetchTracesForDisplay({
          trace_id,
          session_id,
          limit: limit ?? 20,
        });

        let text: string;
        if (result.selected_trace_id) {
          const trace = result.traces[0];
          text =
            `Showing trace ${shortId(trace.trace_id)} (${rootSpanName(trace)}, ` +
            `${trace.span_count} spans, ${humanizeNs(trace.duration_ns)}) in the qyl explorer` +
            `${result.mode === "demo" ? " (demo data)" : ""}.`;
        } else {
          const errorCount = result.traces.filter((t) => t.has_error).length;
          const scope = session_id ? `session ${session_id}` : "recent";
          text =
            `Showing ${result.traces.length} ${scope} traces in the qyl explorer` +
            `${errorCount > 0 ? ` (${errorCount} with errors)` : ""}` +
            `${result.mode === "demo" ? " (demo data)" : ""}.`;
        }

        const output: DisplayTracesOutput = {
          traces: result.traces,
          ...(result.selected_trace_id
            ? { selected_trace_id: result.selected_trace_id }
            : {}),
          mode: result.mode,
        };

        return telemetryToolResult(text, output);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  registerAppTool(
    server,
    "display_mcp_dashboard",
    {
      title: "Display MCP Dashboard",
      description:
        "Show an aggregate dashboard of MCP traffic (spans carrying an " +
        "`mcp.method.name` attribute): request/error timeline, per-server and " +
        "per-transport breakdowns, and per-tool latency and error " +
        "rates. Prefer this when the user asks about MCP usage, tool health, " +
        "or MCP monitoring.",
      inputSchema: DisplayMcpDashboardInputSchema,
      outputSchema: DisplayMcpDashboardOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
    },
    async ({ hours }: DisplayMcpDashboardInput): Promise<CallToolResult> => {
      try {
        const window = hours ?? 24;
        const stats = await fetchMcpStats(window);
        const output: DisplayMcpDashboardOutput = { stats };
        return telemetryToolResult(summarizeMcpStats(stats, window), output);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  registerTelemetryTools(server);
  registerCiTools(server);

  registerAppTool(
    server,
    "fetch_telemetry",
    {
      title: "Fetch Telemetry",
      description:
        "Fetch traces, a single trace, or logs for the trace explorer UI. " +
        "The model should NOT call this tool directly.",
      inputSchema: FetchTelemetryInputSchema,
      outputSchema: FetchTelemetryOutputSchema,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({
      view,
      trace_id,
      service_name,
      severity_min,
      query,
      limit,
      hours,
    }: FetchTelemetryInput): Promise<CallToolResult> => {
      try {
        if (view === "mcp_stats") {
          const stats = await fetchMcpStats(hours ?? 24);
          const output: FetchTelemetryOutput = { stats, mode: stats.mode };
          return telemetryToolResult(
            `Fetched MCP stats: ${stats.totals.requests} requests over ${hours ?? 24}h (${stats.mode} mode).`,
            output,
          );
        }

        if (view === "trace") {
          if (!trace_id) {
            throw new CollectorError('view "trace" requires a `trace_id`.');
          }
          const { trace, mode } = await fetchTrace(trace_id);
          const output: FetchTelemetryOutput = { trace, mode };
          return telemetryToolResult(
            `Fetched trace ${shortId(trace.trace_id)} (${trace.span_count} spans, ${mode} mode).`,
            output,
          );
        }

        if (view === "logs") {
          const { logs, mode } = await fetchLogs({
            trace_id,
            service_name,
            severity_min,
            query,
            limit: limit ?? 50,
          });
          const output: FetchTelemetryOutput = { logs, mode };
          return telemetryToolResult(
            `Fetched ${logs.length} logs (${mode} mode).`,
            output,
          );
        }

        const { traces, mode } = await fetchTraces(limit ?? 20);
        const output: FetchTelemetryOutput = { traces, mode };
        return telemetryToolResult(
          `Fetched ${traces.length} traces (${mode} mode).`,
          output,
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = (cachedAppHtml ??= await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      ));
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                },
              },
            },
          },
        ],
      };
    },
  );

  registerAppResource(
    server,
    DASHBOARD_RESOURCE_URI,
    DASHBOARD_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      if (cachedDashboardHtml === undefined) {
        try {
          cachedDashboardHtml = await fs.readFile(
            path.join(DIST_DIR, "mcp-dashboard.html"),
            "utf-8",
          );
        } catch {
          throw new Error(
            "dashboard UI not built yet: dist/mcp-dashboard.html is missing — " +
              "build the mcp-dashboard.html vite entry (`npm run build`) first",
          );
        }
      }
      return {
        contents: [
          {
            uri: DASHBOARD_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: cachedDashboardHtml,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                },
              },
            },
          },
        ],
      };
    },
  );

  return server;
}
