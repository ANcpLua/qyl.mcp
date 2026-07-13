/**
 * Shared configuration: UI resource URIs and collector endpoint resolution.
 *
 * The collector URL is resolved lazily (per call, not at module load) so the
 * embedding host — the qyl.mcp runner hosting this server in-process — controls
 * it through its own environment.
 */

import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

/** URI of the trace explorer UI resource. */
export const RESOURCE_URI = "ui://qyl-explorer/mcp-app.html";

/** URI of the MCP dashboard UI resource. */
export const DASHBOARD_RESOURCE_URI = "ui://qyl-explorer/mcp-dashboard.html";

const apiKeyHeader = qylOpenApi.components.securitySchemes.ApiKeyAuth.name;
if (typeof apiKeyHeader !== "string" || apiKeyHeader.length === 0) {
  throw new Error("published Qyl OpenAPI has no API-key header name");
}

export function collectorUrl(): string {
  return process.env.QYL_COLLECTOR_URL ?? "http://127.0.0.1:5100";
}

/** Optional collector credential, sent under the generated OpenAPI header. */
export function collectorHeaders(): Record<string, string> {
  const apiKey = process.env.QYL_API_KEY?.trim();
  return apiKey ? { [apiKeyHeader]: apiKey } : {};
}
