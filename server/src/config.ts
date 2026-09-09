/**
 * Shared configuration: UI resource URIs and collector endpoint resolution.
 *
 * The collector URL is resolved lazily (per call, not at module load) so the
 * embedding host — the qyl.mcp workbench hosting this server in-process — controls
 * it through its own environment.
 */

import { API_KEY_HEADER, PROJECT_HEADER } from "./contract-headers.js";

/** URI of the trace explorer UI resource. */
export const RESOURCE_URI = "ui://qyl-explorer/mcp-app.html";

/** URI of the MCP dashboard UI resource. */
export const DASHBOARD_RESOURCE_URI = "ui://qyl-explorer/mcp-dashboard.html";

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

/** Optional collector credential and project scope, under the contract's headers. */
export function collectorHeaders(): Record<string, string> {
  const apiKey = process.env.QYL_API_KEY?.trim();
  const project = process.env.QYL_PROJECT?.trim();
  return {
    ...(apiKey ? { [API_KEY_HEADER]: apiKey } : {}),
    ...(project ? { [PROJECT_HEADER]: project } : {}),
  };
}
