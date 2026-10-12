/**
 * The OAuth scope a write tool needs beyond `qyl:read`, and how a call
 * without it is refused.
 *
 * Every hosted request already carries `qyl:read`: it is the endpoint's
 * required scope, which the bearer gate checks (authorization.ts). The create
 * and update tools also need `qyl:write`, the delete tool `qyl:delete`.
 *
 * A write tool registers an SDK `scopeChallenge`. The SDK's HTTP serving runs
 * it before the handler, in both protocol eras, and answers a token without
 * the scope with `403` and `WWW-Authenticate: Bearer error="insufficient_scope"`
 * naming the scopes to request — the MCP authorization "scope challenge" a
 * client answers with step-up authorization. The handler checks again
 * (`assertToolScopes`), so a transport that runs no scope challenge still
 * refuses the call, as an `isError` result whose `structuredContent.error.code`
 * is `insufficient_scope` and whose `_meta["mcp/www_authenticate"]` carries
 * the same challenge (OpenAI's documented in-band form).
 *
 * Without verified authentication — stdio, local HTTP — there is no token to
 * check: the operator's Collector key decides what the server may change.
 * Scopes are compared as issued; an explicit scope hierarchy configured on
 * the bearer gate covers the endpoint's required scopes only.
 */

import {
  getOAuthProtectedResourceMetadataUrl,
  type AuthInfo,
  type ScopeChallenge,
  type ScopeChallengeHandler,
} from "@modelcontextprotocol/server";

/** The tool-result `_meta` key OpenAI documents for an authentication challenge. */
export const WWW_AUTHENTICATE_META_KEY = "mcp/www_authenticate";

/** A verified token lacks a scope the tool needs; the message says which. */
export class InsufficientScopeError extends Error {
  override name = "InsufficientScopeError";

  constructor(
    message: string,
    /** The RFC 6750 `WWW-Authenticate` value a client can answer with step-up. */
    readonly challenge: string,
  ) {
    super(message);
  }
}

function missingScopes(required: readonly string[], authInfo: AuthInfo): string[] {
  const granted = new Set(authInfo.scopes);
  return required.filter((scope) => !granted.has(scope));
}

function errorDescription(tool: string, missing: readonly string[]): string {
  return `${tool} needs the ${missing.join(" and ")} scope`;
}

/** The SDK registration hook: a challenge for a verified token without `required`. */
export function toolScopeChallenge(
  tool: string,
  required: readonly [string, ...string[]],
): ScopeChallengeHandler {
  return ({ authInfo }): ScopeChallenge | undefined => {
    if (authInfo === undefined) return undefined;
    const missing = missingScopes(required, authInfo);
    if (missing.length === 0) return undefined;
    return {
      scopes: [missing[0] ?? required[0], ...missing.slice(1)],
      errorDescription: errorDescription(tool, missing),
    };
  };
}

/** The same Protected Resource Metadata URL the SDK's scope challenge names. */
function resourceMetadataUrl(authInfo: AuthInfo): string | undefined {
  if (authInfo.resourceMetadataUrl !== undefined) return authInfo.resourceMetadataUrl;
  const resource = authInfo.resource;
  return resource !== undefined && (resource.protocol === "https:" || resource.protocol === "http:")
    ? getOAuthProtectedResourceMetadataUrl(resource)
    : undefined;
}

/**
 * The handler's own check: throws `InsufficientScopeError` when a verified
 * token lacks one of `required`. No verified authentication, no check.
 */
export function assertToolScopes(
  tool: string,
  required: readonly [string, ...string[]],
  authInfo: AuthInfo | undefined,
): void {
  if (authInfo === undefined) return;
  const missing = missingScopes(required, authInfo);
  if (missing.length === 0) return;
  const metadata = resourceMetadataUrl(authInfo);
  const challenge =
    `Bearer error="insufficient_scope", error_description="${errorDescription(tool, missing)}", ` +
    `scope="${missing.join(" ")}"` +
    (metadata === undefined ? "" : `, resource_metadata="${metadata}"`);
  throw new InsufficientScopeError(
    `${errorDescription(tool, missing)}, which this sign-in does not grant. ` +
      `Reconnect qyl and allow ${missing.join(" and ")} to use it.`,
    challenge,
  );
}
