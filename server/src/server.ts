/**
 * qyl telemetry MCP Apps server (the visual half of qyl.mcp).
 *
 * Tool surface:
 * - display_traces:        trace explorer UI (waterfall + logs) — THE app tool
 * - display_mcp_dashboard: aggregate MCP traffic dashboard UI
 * - list_traces, get_trace, list_sessions, search_logs: direct read tools
 * - ci_log:                CI execution evidence from qyl telemetry
 * - fetch_telemetry:       app-only (viewer iframes; hidden from the model)
 *
 * Modes: live against the qyl collector REST API (QYL_COLLECTOR_URL, default
 * http://127.0.0.1:5100), or explicit generated demo telemetry when
 * QYL_DEMO=1. A collector failure remains an error and never changes modes.
 */

import type {
  DisplayMcpDashboardInput,
  DisplayMcpDashboardOutput,
  DisplayTracesInput,
  DisplayTracesOutput,
  FetchTelemetryInput,
  FetchTelemetryOutput,
} from "@ancplua/qyl-api-schema/types";
import { McpServer, ResourceNotFoundError } from "@modelcontextprotocol/server";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/server";
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
  compactOutputSchema,
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
import { registerMetricsTools } from "./metrics-tools.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import type { McpTelemetryTransport } from "./mcp-semconv.js";
import {
  assertNativeExecutionRecordingArmed,
  defaultNativeExecutionRuntime,
  installNativeExecutionRecording,
  type NativeExecutionRuntime,
} from "./native-execution.js";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export {
  closeDefaultNativeExecutionRuntime,
  hasNativeExecutionTelemetry,
} from "./native-execution.js";

// The vite-built single-file viewers live next to the compiled server code.
const DIST_DIR = import.meta.dirname;
// Cached across createServer() calls — createMcpHandler builds a fresh server
// per HTTP request, so per-instance caches would be useless.
const viewerHtmlByFile = new Map<string, string>();
const PUBLIC_CATALOG_CACHE = { ttlMs: 300_000, cacheScope: "public" } as const;
const PUBLIC_APP_CACHE = { ttlMs: 86_400_000, cacheScope: "public" } as const;

/** MCP Apps viewers declare an empty CSP: the bundles are single-file and fetch nothing. */
const SELF_CONTAINED_VIEWER_CSP = {
  ui: { csp: { connectDomains: [], resourceDomains: [] } },
} as const;

/**
 * Register one vite-built single-file viewer as a fixed-URI resource.
 *
 * A read callback has no `isError` channel, so a failure here has to leave as a
 * JSON-RPC error response. Anything that is not a `ProtocolError` becomes
 * `-32603` Internal Error carrying the raw exception message — for a missing
 * bundle that is `fs`'s ENOENT, which names an absolute server path and tells
 * the caller nothing it can act on. `ResourceNotFoundError` is the subclass the
 * SDK defines for a `resources/read` that cannot produce contents: it carries
 * the spec's `-32602`, puts the requested URI in `data`, and lets the message
 * say what to rebuild.
 */
export function registerViewerResource(
  server: McpServer,
  uri: string,
  fileName: string,
): void {
  server.registerResource(
    uri,
    uri,
    { mimeType: RESOURCE_MIME_TYPE, cacheHint: PUBLIC_APP_CACHE },
    async (): Promise<ReadResourceResult> => {
      let html = viewerHtmlByFile.get(fileName);
      if (html === undefined) {
        try {
          html = await fs.readFile(path.join(DIST_DIR, fileName), "utf-8");
        } catch {
          throw new ResourceNotFoundError(
            uri,
            `${uri} is not built: dist/${fileName} is missing — run \`bun run build\` ` +
              "in the server workspace to produce the viewer bundles",
          );
        }
        viewerHtmlByFile.set(fileName, html);
      }
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: SELF_CONTAINED_VIEWER_CSP,
          },
        ],
      };
    },
  );
}

export interface CreateServerOptions {
  /** Transport identity recorded on native server spans and durable evidence. */
  transport?: McpTelemetryTransport;
  /** Test/embedding override. Native evidence is automatic unless explicitly disabled. */
  nativeExecution?: NativeExecutionRuntime | false;
}

/** Creates a server with automatic native execution evidence for every tool. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "qyl.mcp",
      version: packageMetadata.version,
    },
    {
      // One hint per catalog method this server actually answers. McpServer
      // registers the resource trio on the first registerResource and the tool
      // handlers on the first registerTool; it never registers prompts/list,
      // because nothing here calls registerPrompt.
      cacheHints: {
        "server/discover": PUBLIC_CATALOG_CACHE,
        "tools/list": PUBLIC_CATALOG_CACHE,
        "resources/list": PUBLIC_CATALOG_CACHE,
        "resources/templates/list": PUBLIC_CATALOG_CACHE,
      },
    },
  );
  if (options.nativeExecution !== false) {
    installNativeExecutionRecording(
      server,
      options.nativeExecution ?? defaultNativeExecutionRuntime(),
      options.transport ?? "builtin",
    );
  }

  server.registerTool(
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
      outputSchema: compactOutputSchema(DisplayTracesOutputSchema),
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

  server.registerTool(
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
      outputSchema: compactOutputSchema(DisplayMcpDashboardOutputSchema),
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
  registerMetricsTools(server);

  server.registerTool(
    "fetch_telemetry",
    {
      title: "Fetch Telemetry",
      description:
        "Fetch traces, a single trace, or logs for the trace explorer UI. " +
        "The model should NOT call this tool directly.",
      inputSchema: FetchTelemetryInputSchema,
      // No outputSchema: this tool is `_meta.ui.visibility: ["app"]`, so its only
      // caller is the bundled viewer, which is compiled against the generated
      // TypeScript types and never reads the advertised schema. Publishing one
      // anyway put the whole telemetry tree into every client's `tools/list`
      // (68 KB of the 232 KB manifest) to describe a shape no model may call.
      // Structured content is still returned and still typed by the generated
      // contract at compile time, and contracts.test.ts still parses these bodies
      // against FetchTelemetryOutputSchema, so the shape stays pinned to the contract.
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

  registerViewerResource(server, RESOURCE_URI, "mcp-app.html");
  registerViewerResource(server, DASHBOARD_RESOURCE_URI, "mcp-dashboard.html");

  if (options.nativeExecution !== false) assertNativeExecutionRecordingArmed(server);

  return server;
}
