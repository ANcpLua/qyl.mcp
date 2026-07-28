/**
 * Shared configuration: UI resource URIs and collector endpoint resolution.
 *
 * The collector URL is resolved lazily (per call, not at module load) so the
 * embedding host — the qyl.mcp workbench hosting this server in-process — controls
 * it through its own environment.
 */

import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

/** URI of the trace explorer UI resource. */
export const RESOURCE_URI = "ui://qyl-explorer/mcp-app.html";

/** URI of the MCP dashboard UI resource. */
export const DASHBOARD_RESOURCE_URI = "ui://qyl-explorer/mcp-dashboard.html";

/** URI of the fullscreen workflow debugger MCP App. */
export const WORKFLOW_GRAPH_RESOURCE_URI = "ui://qyl-explorer/observe-graph.html";

const apiKeyHeader = qylOpenApi.components.securitySchemes.ApiKeyAuth.name;
if (typeof apiKeyHeader !== "string" || apiKeyHeader.length === 0) {
  throw new Error("published Qyl OpenAPI has no API-key header name");
}

export function collectorUrl(): string {
  const configured = process.env.QYL_COLLECTOR_URL ?? "http://127.0.0.1:5100";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("QYL_COLLECTOR_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("QYL_COLLECTOR_URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "QYL_COLLECTOR_URL must be credential-free and cannot contain a query or fragment",
    );
  }
  return url.toString();
}

/** Optional collector credential, sent under the generated OpenAPI header. */
export function collectorHeaders(): Record<string, string> {
  const apiKey = process.env.QYL_API_KEY?.trim();
  const project = process.env.QYL_PROJECT?.trim();
  return {
    ...(apiKey ? { [apiKeyHeader]: apiKey } : {}),
    ...(project ? { "X-Qyl-Project": project } : {}),
  };
}
