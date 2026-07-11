/**
 * Shared configuration: UI resource URIs and collector endpoint resolution.
 *
 * The collector URL is resolved lazily (per call, not at module load) so the
 * embedding host — the qyl.mcp runner hosting this server in-process — controls
 * it through its own environment.
 */

/** URI of the trace explorer UI resource (see INTERFACE.md). */
export const RESOURCE_URI = "ui://qyl-explorer/mcp-app.html";

/** URI of the MCP dashboard UI resource (see INTERFACE.md addendum). */
export const DASHBOARD_RESOURCE_URI = "ui://qyl-explorer/mcp-dashboard.html";

export function collectorUrl(): string {
  return process.env.QYL_COLLECTOR_URL ?? "http://127.0.0.1:5100";
}
