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

function readIssuer(environment: NodeJS.ProcessEnv): URL {
  const configured = environment.MCP_OAUTH_ISSUER;
  if (!configured) {
    throw new Error("MCP_OAUTH_ISSUER must name the external HTTPS OAuth issuer");
  }
  if (configured !== QYL_MCP_ISSUER) {
    throw new Error(`MCP_OAUTH_ISSUER must be exactly ${QYL_MCP_ISSUER}`);
  }
  return new URL(QYL_MCP_ISSUER);
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

export async function loadHostedOAuth(
  resourceServerUrl: URL,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HostedOAuth> {
  const issuer = readIssuer(environment);
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
