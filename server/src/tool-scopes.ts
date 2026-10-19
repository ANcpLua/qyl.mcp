/**
 * The OAuth scope a write tool needs beyond `qyl:read`, and how a call
 * without it is refused.
 *
 * Every hosted request already carries `qyl:read`: it is the endpoint's
 * required scope, which the bearer gate checks (authorization.ts). The create
 * and update tools also need `qyl:write`, and `delete_record` needs `qyl:delete`.
 *
 * A write tool registers an SDK `scopeChallenge`. The SDK's HTTP serving runs
 * it before the handler, in both protocol eras, and answers a token without
 * the scope with `403` and `WWW-Authenticate: Bearer error="insufficient_scope"`
 * naming the scopes to request — the MCP authorization "scope challenge" a
 * client answers with step-up authorization. That is the only check: the
 * server's two transports are HTTP, where the SDK challenge always runs first,
 * and stdio, which carries no token.
 *
 * Without verified authentication — stdio, local HTTP — there is no token to
 * check: the operator's Collector key decides what the server may change.
 * Scopes are compared as issued; an explicit scope hierarchy configured on
 * the bearer gate covers the endpoint's required scopes only.
 */

import type { AuthInfo, ScopeChallenge, ScopeChallengeHandler } from "@modelcontextprotocol/server";

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
