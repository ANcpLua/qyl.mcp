import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

import {
  fetchAuthorizationServerMetadata,
  secureMetadataUrl,
  validateAuthorizationServerCapabilities,
} from "./oauth-metadata.js";
import {
  validateAuthorizationExtensions,
  type AuthorizationExtension,
} from "./auth-extensions.js";

export const QYL_MCP_ISSUER = "https://qyl-eu.eu.auth0.com/";
export const QYL_MCP_RESOURCE = "https://mcp.qyl.at/mcp";
export const QYL_MCP_SCOPE = "qyl:read";

export interface HostedOAuth {
  readonly requiredScopes: string[];
  readonly scopesSupported: string[];
  readonly oauthMetadata: OAuthMetadata;
  readonly verifier: OAuthTokenVerifier;
  readonly extensions: readonly AuthorizationExtension[];
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
      requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
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
        || typeof payload.jti !== "string" || payload.jti.length === 0
        || typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1_000)
        || (payload.scope !== undefined && (typeof payload.scope !== "string"
          || !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u.test(payload.scope)))
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

/** Auth0 remains the authorization server; every optional grant ends here as
 * an audience-bound access token, never an ID token, ID-JAG or client assertion.
 */
export async function loadHostedOAuth(
  resourceServerUrl: URL,
  options: { extensions?: readonly AuthorizationExtension[] } = {},
): Promise<HostedOAuth> {
  const issuer = new URL(QYL_MCP_ISSUER);
  const oauthMetadata = await fetchAuthorizationServerMetadata(issuer);
  validateAuthorizationServerCapabilities(oauthMetadata);
  const extensions = options.extensions ?? [];
  validateAuthorizationExtensions(oauthMetadata, extensions);
  const jwksUrl = secureMetadataUrl(oauthMetadata.jwks_uri, "jwks_uri");
  return {
    requiredScopes: [QYL_MCP_SCOPE],
    scopesSupported: [QYL_MCP_SCOPE],
    oauthMetadata,
    extensions,
    verifier: createJwtTokenVerifier({
      issuer: oauthMetadata.issuer,
      resource: resourceServerUrl,
      key: createRemoteJWKSet(jwksUrl),
    }),
  };
}
