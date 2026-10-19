/**
 * The request header names the published Qyl OpenAPI contract defines.
 *
 * Every header this repository sends to a collector is named by the contract,
 * never by a string typed beside it: a renamed header then breaks the build and
 * the module load, not the first request at runtime. The derivation lives here
 * once because several call sites need it — the collector client, the write
 * tools' collector resources and the OTLP exporter configuration — and copies
 * of the same lookup drift one copy at a time.
 *
 * The checks run at module load, so an absent or reshaped component fails the
 * process at startup rather than at the first call that would have used it.
 */

import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

function requiredHeaderName(
  component: { in?: string; name?: string } | undefined,
  description: string,
): string {
  if (
    component?.in !== "header"
    || typeof component.name !== "string"
    || component.name.length === 0
  ) {
    throw new Error(`${description} has no header name.`);
  }
  return component.name;
}

/** Header carrying the collector API key (`ApiKeyAuth` security scheme). */
export const API_KEY_HEADER = requiredHeaderName(
  qylOpenApi.components.securitySchemes.ApiKeyAuth,
  "published Qyl API-key security scheme",
);

/** Header scoping a request to one project (`ProjectScopeHeader` parameter). */
export const PROJECT_HEADER = requiredHeaderName(
  qylOpenApi.components.parameters.ProjectScopeHeader,
  "published Qyl project-scope parameter",
);

/**
 * Header carrying the etag a PATCH or DELETE changes (`Common.IfMatchHeader`
 * parameter): a stale tag is answered 412, a missing one 428.
 */
export const IF_MATCH_HEADER = requiredHeaderName(
  qylOpenApi.components.parameters["Common.IfMatchHeader"],
  "published Qyl If-Match precondition parameter",
);

/**
 * Header carrying the retry key of a creating POST (`Common.IdempotencyKeyHeader`
 * parameter): a repeat with the same key and body returns the first result.
 */
export const IDEMPOTENCY_KEY_HEADER = requiredHeaderName(
  qylOpenApi.components.parameters["Common.IdempotencyKeyHeader"],
  "published Qyl Idempotency-Key parameter",
);
