import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { QYL_MCP_SCOPE } from "./oauth.js";
import type { HostedAuth } from "./main.js";

export interface AccessConfig { teamDomain: string; audience: string }

function validateConfig(config: AccessConfig): AccessConfig {
  const team = new URL(config.teamDomain);
  if (team.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(team.hostname)
      || team.port || team.username || team.password || team.pathname !== "/" || team.search || team.hash) {
    throw new Error("MCP_ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access team origin");
  }
  if (!config.audience.trim() || config.audience !== config.audience.trim()) {
    throw new Error("MCP_ACCESS_AUD must be the Access application's audience tag");
  }
  return { teamDomain: team.origin, audience: config.audience };
}

export function readAccessConfig(environment: Readonly<Record<string, string | undefined>>): AccessConfig | undefined {
  const provider = environment.MCP_AUTH_PROVIDER?.trim() || "auth0";
  if (provider === "auth0") {
    if (environment.MCP_ACCESS_TEAM_DOMAIN || environment.MCP_ACCESS_AUD) {
      throw new Error("Set MCP_AUTH_PROVIDER=cloudflare-access when configuring an Access application");
    }
    return undefined;
  }
  if (provider !== "cloudflare-access") throw new Error("MCP_AUTH_PROVIDER must be auth0 or cloudflare-access");
  if (!environment.MCP_ACCESS_TEAM_DOMAIN || !environment.MCP_ACCESS_AUD) {
    throw new Error("Cloudflare Access requires MCP_ACCESS_TEAM_DOMAIN and MCP_ACCESS_AUD");
  }
  return validateConfig({ teamDomain: environment.MCP_ACCESS_TEAM_DOMAIN, audience: environment.MCP_ACCESS_AUD });
}

/** Access validates the client's opaque OAuth token at the edge. The origin
 * accepts only its signed assertion, including on the direct Railway hostname.
 * Membership of this Access app authorizes the server's read-only tool surface;
 * the assertion does not carry an OAuth client ID or qyl scopes.
 */
export function createCloudflareAccessAuth(params: AccessConfig & {
  resource: URL;
  key?: JWTVerifyGetKey;
}): HostedAuth {
  const { teamDomain, audience } = validateConfig(params);
  const key = params.key ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", params.resource).href;
  function unauthorized(): Response {
    return Response.json({ error: "invalid_token", error_description: "Cloudflare Access authentication required" }, {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      },
    });
  }
  return {
    async gate(request: Request): Promise<AuthInfo | Response> {
      const assertion = request.headers.get("cf-access-jwt-assertion");
      if (!assertion || assertion.length > 16_384) return unauthorized();
      try {
        const { payload } = await jwtVerify(assertion, key, {
          issuer: teamDomain, audience, algorithms: ["RS256"], requiredClaims: ["exp", "sub"],
        });
        if (typeof payload.sub !== "string" || !payload.sub || typeof payload.exp !== "number") return unauthorized();
        return {
          token: assertion,
          clientId: "cloudflare-access",
          scopes: [QYL_MCP_SCOPE],
          expiresAt: payload.exp,
          resource: params.resource,
          extra: { subject: payload.sub, provider: "cloudflare-access" },
        };
      } catch {
        return unauthorized();
      }
    },
    // Access owns discovery and authorization challenges in this mode. Serving
    // the Auth0 metadata here would send clients through the wrong OAuth flow.
  };
}
