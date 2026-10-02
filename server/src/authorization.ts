import {
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

export interface ResourceAuthorizationOptions {
  readonly verifier: OAuthTokenVerifier;
  readonly resourceMetadataUrl: string;
  readonly requiredScopes: readonly string[];
  /** Explicit implications only; a wildcard-looking string grants nothing by itself. */
  readonly scopeImplications?: Readonly<Record<string, readonly string[]>>;
}

function validateScopes(scopes: readonly string[]): void {
  for (const scope of scopes) {
    // RFC 6749 scope-token excludes quotes, backslashes and whitespace.
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(scope) || scope === "offline_access") {
      throw new Error("Resource scopes must be valid OAuth scope tokens and cannot include offline_access");
    }
  }
}

/** A hierarchy is an explicit, transitive relation. Cycles terminate and never
 * grant a scope without a verified scope as their starting point.
 */
export function scopeClosure(
  granted: readonly string[],
  implications: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const result = new Set(granted);
  const pending = [...granted];
  for (let i = 0; i < pending.length; i++) {
    for (const implied of implications.get(pending[i]) ?? []) {
      if (!result.has(implied)) {
        result.add(implied);
        pending.push(implied);
      }
    }
  }
  return result;
}

/** All grants converge on this gate. Extensions never see an unverified token. */
export function createResourceAuthorization(
  options: ResourceAuthorizationOptions,
): (request: Request) => Promise<AuthInfo | Response> {
  const requiredScopes = [...new Set(options.requiredScopes)].sort();
  validateScopes(requiredScopes);
  const implications = new Map(Object.entries(options.scopeImplications ?? {})
    .map(([scope, implied]) => {
      validateScopes([scope, ...implied]);
      return [scope, [...implied]] as const;
    }));
  const metadataUrl = new URL(options.resourceMetadataUrl);
  if (metadataUrl.protocol !== "https:" || metadataUrl.username || metadataUrl.password
    || metadataUrl.search || metadataUrl.hash || /["\\]/u.test(options.resourceMetadataUrl)
    || Array.from(options.resourceMetadataUrl).some((character) => character.charCodeAt(0) <= 0x20)) {
    throw new Error("Resource metadata must use a safe HTTPS URL");
  }
  const coreGate = requireBearerAuth({
    verifier: options.verifier,
    resourceMetadataUrl: metadataUrl.href,
  });
  const challenge = (status: number, error?: string): Response => {
    const parameters = [
      ...(error === undefined ? [] : [`error="${error}"`]),
      ...(requiredScopes.length === 0 ? [] : [`scope="${requiredScopes.join(" ")}"`]),
      `resource_metadata="${metadataUrl.href}"`,
    ];
    return Response.json({ error: error ?? "unauthorized" }, {
      status,
      headers: { "WWW-Authenticate": `Bearer ${parameters.join(", ")}`, "Cache-Control": "no-store" },
    });
  };
  return async (request) => {
    const authorization = request.headers.get("authorization");
    const bearer = authorization === null ? null : /^Bearer +([A-Za-z0-9._~+/-]+=*)$/iu.exec(authorization);
    if (new URL(request.url).searchParams.has("access_token")
      || (authorization !== null && bearer === null)) {
      return challenge(400, "invalid_request");
    }
    // RFC 6750 permits multiple spaces. The SDK splits on one space; normalize
    // the validated header on a bodyless request so the MCP body remains unread.
    const auth = await coreGate(bearer === null ? request : new Request(request.url, {
      headers: { authorization: `Bearer ${bearer[1]}` },
    }));
    if (auth instanceof Response) {
      // Keep authentication failures distinct from authorization failures and
      // include the complete operation scope set on every challenge.
      if (auth.status === 401) return challenge(401, authorization === null ? undefined : "invalid_token");
      return auth;
    }
    const effectiveScopes = scopeClosure(auth.scopes, implications);
    if (!requiredScopes.every((scope) => effectiveScopes.has(scope))) {
      return challenge(403, "insufficient_scope");
    }
    return auth;
  };
}
