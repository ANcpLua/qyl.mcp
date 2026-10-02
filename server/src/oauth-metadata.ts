import { OAuthMetadataSchema } from "@modelcontextprotocol/core";
import type { OAuthMetadata } from "@modelcontextprotocol/server";

const DISCOVERY_TIMEOUT_MS = 10_000;
const ASYMMETRIC_ALGORITHMS = new Set([
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA",
]);

export function secureMetadataUrl(value: unknown, field: string): URL {
  let url: URL;
  try {
    if (typeof value !== "string") throw new Error();
    url = new URL(value);
  } catch {
    throw new Error(`Authorization Server must advertise a valid ${field}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`Authorization Server must advertise an HTTPS ${field} without credentials or fragments`);
  }
  return url;
}

/** The hosted Auth0 profile supports both CIMD client types and DCR.
 * This checks discovery capabilities, not whether Auth0 has enabled DCR or
 * provisioned any particular client and API grant.
 */
export function validateAuthorizationServerCapabilities(metadata: OAuthMetadata): void {
  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "jwks_uri"] as const) {
    secureMetadataUrl(metadata[field], field);
  }
  if (metadata.client_id_metadata_document_supported !== true) {
    throw new Error("Authorization Server must enable Client ID Metadata Document Registration (CIMD)");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Authorization Server must advertise PKCE S256");
  }
  if (!metadata.response_types_supported.includes("code")
    || (metadata.grant_types_supported !== undefined
      && !metadata.grant_types_supported.includes("authorization_code"))) {
    throw new Error("Authorization Server must support the authorization_code flow");
  }
  if (metadata.authorization_response_iss_parameter_supported !== true) {
    throw new Error("Authorization Server must advertise authorization response issuer identification");
  }
  if (!metadata.token_endpoint_auth_methods_supported?.includes("private_key_jwt")
    || !metadata.token_endpoint_auth_signing_alg_values_supported?.some((alg) => ASYMMETRIC_ALGORITHMS.has(alg))) {
    throw new Error("Authorization Server must support ChatGPT CIMD private_key_jwt with an asymmetric signing algorithm");
  }
  if (!metadata.token_endpoint_auth_methods_supported.includes("none")) {
    throw new Error("Authorization Server must support Claude CIMD public-client token exchange (none)");
  }
}

export async function fetchAuthorizationServerMetadata(issuer: URL): Promise<OAuthMetadata> {
  secureMetadataUrl(issuer.href, "issuer");
  if (issuer.search) throw new Error("Authorization Server issuer must not contain a query");
  // RFC 8414 inserts the well-known component before an issuer path; OIDC
  // also defines the path-appended location. No redirects change the trust anchor.
  const issuerPath = issuer.pathname.replace(/\/$/u, "");
  const candidates = [...new Set([
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    `${issuer.origin}${issuerPath}/.well-known/openid-configuration`,
  ])];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`HTTP ${response.status}`);
        continue;
      }
      const parsed = OAuthMetadataSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.issuer !== issuer.href) {
        failures.push(parsed.success ? "issuer mismatch" : "invalid metadata");
        continue;
      }
      // looseObject preserves provider extension fields without fabricating them.
      return parsed.data;
    } catch {
      failures.push("discovery request failed");
    }
  }
  throw new Error(`Unable to load Authorization Server metadata from ${issuer.href} (${failures.join("; ")})`);
}
