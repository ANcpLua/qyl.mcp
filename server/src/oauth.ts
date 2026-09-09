import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { OAuthMetadataSchema } from "@modelcontextprotocol/core";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

const DISCOVERY_TIMEOUT_MS = 10_000;
export const QYL_MCP_ISSUER = "https://qyl-eu.eu.auth0.com/";
export const QYL_MCP_RESOURCE = "https://mcp.qyl.at/mcp";
export const QYL_MCP_SCOPE = "qyl:read";

export interface HostedOAuth {
  readonly requiredScopes: string[];
  readonly scopesSupported: string[];
  readonly oauthMetadata: OAuthMetadata;
  readonly verifier: OAuthTokenVerifier;
}

async function fetchAuthorizationServerMetadata(issuer: URL): Promise<OAuthMetadata> {
  const base = issuer.pathname.endsWith("/") ? issuer : new URL(`${issuer.pathname}/`, issuer);
  const candidates = [
    new URL(".well-known/oauth-authorization-server", base),
    new URL(".well-known/openid-configuration", base),
  ];
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`${candidate.href}: HTTP ${response.status}`);
        continue;
      }
      const parsed = OAuthMetadataSchema.safeParse(await response.json());
      if (!parsed.success) {
        failures.push(`${candidate.href}: invalid metadata`);
        continue;
      }
      if (parsed.data.issuer !== issuer.href) {
        failures.push(`${candidate.href}: issuer mismatch`);
        continue;
      }
      return parsed.data;
    } catch (cause) {
      failures.push(`${candidate.href}: ${cause instanceof Error ? cause.name : "request failed"}`);
    }
  }

  throw new Error(
    `Unable to load Authorization Server metadata from ${issuer.href} (${failures.join("; ")})`,
  );
}

function invalidToken(): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, "Access token verification failed");
}

async function verifyJwt(
  key: JWTVerifyGetKey,
  token: string,
  issuer: string,
  audience: string,
): Promise<JWTPayload> {
  try {
    // jwtVerify already enforces every one of these from its options, and it
    // does so per RFC 7519 — `aud` may be an array, which Auth0 issues whenever
    // the client also requests userinfo. Re-checking `payload.aud !== audience`
    // rejected those tokens outright.
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience,
      algorithms: ["RS256"],
      typ: "at+jwt",
    });
    return payload;
  } catch {
    throw invalidToken();
  }
}

export function createJwtTokenVerifier(params: {
  issuer: string;
  resource: URL;
  key: JWTVerifyGetKey;
}): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const payload = await verifyJwt(
        params.key,
        token,
        params.issuer,
        params.resource.href,
      );
      if (
        typeof payload.sub !== "string"
        || payload.sub.length === 0
        || typeof payload.client_id !== "string"
        || payload.client_id.length === 0
        || typeof payload.exp !== "number"
      ) {
        throw invalidToken();
      }
      return {
        token,
        clientId: payload.client_id,
        scopes: typeof payload.scope === "string"
          ? payload.scope.split(" ").filter(Boolean)
          : [],
        expiresAt: payload.exp,
        resource: params.resource,
        extra: { subject: payload.sub },
      };
    },
  };
}

/**
 * Build the hosted resource-server posture against the pinned issuer.
 *
 * The issuer is a constant, not an operator input. It was once read from
 * `MCP_OAUTH_ISSUER`, which accepted exactly one value — this constant — and
 * threw the same class of error whether it was absent or wrong. That is a
 * variable that decides nothing: it only asked an operator to retype a string
 * the program already holds, and every deployment that got it wrong failed at
 * startup for a reason unrelated to its own configuration.
 *
 * The fail-closed property it appeared to carry lives elsewhere and is
 * unchanged: this function runs only from main()'s `hostedAuth`, which the
 * hosted runtime builds only when `MCP_PUBLIC_URL` is configured — and a
 * non-loopback bind without that URL is refused outright. There is therefore no
 * configuration that serves the public transport without this gate, and no
 * value an operator can type to weaken it.
 */
export async function loadHostedOAuth(resourceServerUrl: URL): Promise<HostedOAuth> {
  const issuer = new URL(QYL_MCP_ISSUER);
  const oauthMetadata = await fetchAuthorizationServerMetadata(issuer);
  const jwksUri = oauthMetadata.jwks_uri;
  if (typeof jwksUri !== "string" || jwksUri.length === 0) {
    throw new Error(`Authorization Server ${issuer.href} does not advertise a jwks_uri`);
  }

  let jwksUrl: URL;
  try {
    jwksUrl = new URL(jwksUri);
  } catch {
    throw new Error(`Authorization Server ${issuer.href} advertises an invalid jwks_uri`);
  }
  if (jwksUrl.protocol !== "https:") {
    throw new Error(`Authorization Server ${issuer.href} must advertise an HTTPS jwks_uri`);
  }

  return {
    requiredScopes: [QYL_MCP_SCOPE],
    scopesSupported: [QYL_MCP_SCOPE],
    oauthMetadata,
    verifier: createJwtTokenVerifier({
      issuer: oauthMetadata.issuer,
      resource: resourceServerUrl,
      key: createRemoteJWKSet(jwksUrl),
    }),
  };
}
