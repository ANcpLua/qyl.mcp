/**
 * qyl telemetry MCP Apps server (the visual half of qyl.mcp).
 *
 * Tool surface (tool-slot economy — see surfaces.ts, enforced in code here):
 * - display_traces:        trace explorer UI (waterfall + logs) — THE app tool
 * - display_mcp_dashboard: aggregate MCP traffic dashboard UI
 * - search_qyl_tools / execute_qyl_tool: the catalog holding list_traces,
 *   get_trace, list_sessions, search_logs (src/tools.ts)
 * - fetch_telemetry:       app-only (viewer iframes; hidden from the model)
 *
 * Modes: live against the qyl collector REST API (QYL_COLLECTOR_URL, default
 * http://127.0.0.1:5100) with automatic demo fallback — QYL_DEMO=1 or a
 * connection-refused startup probe serves canned telemetry so every tool is
 * fully functional offline (filters included).
 */

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registerCatalogInfrastructure } from "./catalog.js";
import { DASHBOARD_RESOURCE_URI, RESOURCE_URI } from "./config.js";
import { CollectorError } from "./collector.js";
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
import { assertToolSurface, registeredModelVisibleToolNames } from "./surfaces.js";
import { toolError } from "./tools.js";
import {
  LogRecordSchema,
  McpDashboardStatsSchema,
  ModeSchema,
  TraceSchema,
} from "./wire.js";

export { CATALOG_TOOLS, type QylToolDef } from "./tools.js";
export {
  assertToolSurface,
  APP_ONLY_TOOL_NAMES,
  CATALOG_INFRASTRUCTURE_TOOL_NAMES,
  MODEL_VISIBLE_TOOL_BUDGET,
  TOP_LEVEL_TOOL_NAMES,
} from "./surfaces.js";

// The vite-built single-file viewers live next to the compiled server code.
const DIST_DIR = import.meta.dirname;

// Cached across createServer() calls — in stateless HTTP deployments a fresh
// server is created per request and per-instance caches would be useless.
let cachedAppHtml: string | undefined;
let cachedDashboardHtml: string | undefined;

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe("Number of traces to return (1–100, default 20)");

/**
 * Creates a new MCP server instance with the curated qyl telemetry tool
 * surface and both UI resources registered. Throws when the registered
 * surface violates the surfaces.ts policy (budget or curation drift).
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "qyl.mcp",
    version: "0.1.0",
  });

  // ---------------------------------------------------------------------------
  // display_traces — THE app tool (renders the trace explorer UI)
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "display_traces",
    {
      title: "Display Traces",
      description:
        "Show qyl traces in the interactive trace explorer with a span waterfall, " +
        "detail panel, and correlated logs. Pass a trace_id to open one trace, a " +
        "session_id for that session's traces, or neither for recent traces. Prefer " +
        "this over the catalog's list_traces/get_trace whenever the user wants to " +
        "look at traces.",
      inputSchema: {
        trace_id: z
          .string()
          .optional()
          .describe("Open this single trace in the explorer"),
        session_id: z
          .string()
          .optional()
          .describe("Show this session's traces"),
        limit: limitSchema.optional(),
      },
      outputSchema: z.object({
        traces: z.array(TraceSchema),
        selected_trace_id: z.string().optional(),
        mode: ModeSchema,
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ trace_id, session_id, limit }): Promise<CallToolResult> => {
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

        const structuredContent = {
          traces: result.traces,
          ...(result.selected_trace_id
            ? { selected_trace_id: result.selected_trace_id }
            : {}),
          mode: result.mode,
        };

        return {
          content: [{ type: "text", text }],
          structuredContent: structuredContent as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // display_mcp_dashboard — aggregate MCP traffic dashboard
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "display_mcp_dashboard",
    {
      title: "Display MCP Dashboard",
      description:
        "Show an aggregate dashboard of MCP traffic (spans carrying an " +
        "`mcp.method.name` attribute): request/error timeline, per-server and " +
        "per-transport breakdowns, and per-tool/per-resource latency and error " +
        "rates. Prefer this when the user asks about MCP usage, tool health, " +
        "or MCP monitoring.",
      inputSchema: {
        hours: z
          .number()
          .min(1)
          .max(168)
          .default(24)
          .describe("Aggregation window in hours (1–168, default 24)"),
      },
      outputSchema: z.object({
        stats: McpDashboardStatsSchema,
      }),
      _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
    },
    async ({ hours }): Promise<CallToolResult> => {
      try {
        const window = hours ?? 24;
        const stats = await fetchMcpStats(window);
        return {
          content: [{ type: "text", text: summarizeMcpStats(stats, window) }],
          structuredContent: { stats } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_qyl_tools + execute_qyl_tool — the catalog (src/tools.ts)
  // ---------------------------------------------------------------------------
  registerCatalogInfrastructure(server);

  // ---------------------------------------------------------------------------
  // fetch_telemetry — app-only (hidden from the model, no model tool slot)
  // Used by the viewer iframes for refresh, drill-down, logs tab, and the
  // dashboard's window selector.
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "fetch_telemetry",
    {
      title: "Fetch Telemetry",
      description:
        "Fetch traces, a single trace, or logs for the trace explorer UI. " +
        "The model should NOT call this tool directly.",
      inputSchema: {
        view: z
          .enum(["traces", "trace", "logs", "mcp_stats"])
          .describe(
            '"traces" for the recent trace list, "trace" for one trace, ' +
              '"logs" for a log search, "mcp_stats" for the MCP dashboard aggregate',
          ),
        trace_id: z
          .string()
          .optional()
          .describe('Trace id (required for view "trace"; filters view "logs")'),
        service_name: z
          .string()
          .optional()
          .describe('Service filter for view "logs"'),
        severity_min: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe('Minimum OTel severity for view "logs"'),
        query: z
          .string()
          .optional()
          .describe('Body substring filter for view "logs"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max items (default: 20 traces / 50 logs)"),
        hours: z
          .number()
          .min(1)
          .max(168)
          .optional()
          .describe('Aggregation window for view "mcp_stats" (default 24)'),
      },
      outputSchema: z.object({
        traces: z.array(TraceSchema).optional(),
        trace: TraceSchema.optional(),
        logs: z.array(LogRecordSchema).optional(),
        stats: McpDashboardStatsSchema.optional(),
        mode: ModeSchema,
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ view, trace_id, service_name, severity_min, query, limit, hours }): Promise<CallToolResult> => {
      try {
        if (view === "mcp_stats") {
          const stats = await fetchMcpStats(hours ?? 24);
          return {
            content: [
              {
                type: "text",
                text: `Fetched MCP stats: ${stats.totals.requests} requests over ${hours ?? 24}h (${stats.mode} mode).`,
              },
            ],
            structuredContent: { stats, mode: stats.mode } as any,
          };
        }

        if (view === "trace") {
          if (!trace_id) {
            throw new CollectorError('view "trace" requires a `trace_id`.');
          }
          const { trace, mode } = await fetchTrace(trace_id);
          return {
            content: [
              {
                type: "text",
                text: `Fetched trace ${shortId(trace.trace_id)} (${trace.span_count} spans, ${mode} mode).`,
              },
            ],
            structuredContent: { trace, mode } as any,
          };
        }

        if (view === "logs") {
          const { logs, mode } = await fetchLogs({
            trace_id,
            service_name,
            severity_min,
            query,
            limit: limit ?? 50,
          });
          return {
            content: [
              {
                type: "text",
                text: `Fetched ${logs.length} logs (${mode} mode).`,
              },
            ],
            structuredContent: { logs, mode } as any,
          };
        }

        const { traces, mode } = await fetchTraces(limit ?? 20);
        return {
          content: [
            {
              type: "text",
              text: `Fetched ${traces.length} traces (${mode} mode).`,
            },
          ],
          structuredContent: { traces, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // The budget and curation are enforced here, not by convention: the
  // assertion enumerates what is ACTUALLY registered on the server, so adding
  // a model-visible tool without updating surfaces.ts makes construction throw.
  assertToolSurface(registeredModelVisibleToolNames(server));

  // ---------------------------------------------------------------------------
  // UI resource: the bundled trace explorer HTML
  // ---------------------------------------------------------------------------
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
                  // Fully self-contained viewer: system font stack, no CDN,
                  // all data via fetch_telemetry — no external origins.
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

  // ---------------------------------------------------------------------------
  // UI resource: the bundled MCP dashboard HTML
  // ---------------------------------------------------------------------------
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
                  // Same as the explorer: fully self-contained, hand-rolled
                  // inline SVG charts, all data via fetch_telemetry.
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
