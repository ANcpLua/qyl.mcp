/**
 * Collector endpoint and credential resolution.
 *
 * The collector URL is resolved lazily (per call, not at module load), so a
 * process or test that sets QYL_COLLECTOR_URL after importing the server
 * still controls where each call goes.
 */

import { API_KEY_HEADER, PROJECT_HEADER } from "./contract-headers.js";
import type { CollectorAccess } from "./collector-access.js";

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
export function collectorHeaders(access?: CollectorAccess): Record<string, string> {
  const apiKey = access?.apiKey ?? process.env.QYL_API_KEY?.trim();
  const project = access?.project ?? process.env.QYL_PROJECT?.trim();
  return {
    ...(apiKey ? { [API_KEY_HEADER]: apiKey } : {}),
    ...(project ? { [PROJECT_HEADER]: project } : {}),
  };
}
