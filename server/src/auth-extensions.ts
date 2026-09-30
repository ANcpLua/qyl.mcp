import type { OAuthMetadata } from "@modelcontextprotocol/server";

/** Resource-server integrations, versioned separately from the MCP wire revision.
 * Extensions declare provider requirements; they cannot replace token verification,
 * mint tokens, rewrite discovery, or grant scopes to a caller.
 */
export interface AuthorizationExtension {
  readonly id: string;
  readonly version: string;
  readonly stability: "stable" | "draft";
  readonly specification: string;
  readonly requirements: Readonly<Record<string, true | readonly string[]>>;
}

export const enterpriseManagedAuthorization: AuthorizationExtension = {
  id: "enterprise-managed-authorization",
  version: "1.0.0",
  stability: "stable",
  specification: "https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx",
  requirements: {
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
    authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
  },
};

export const clientCredentialsAuthorization: AuthorizationExtension = {
  id: "oauth-client-credentials",
  version: "1.0.0",
  stability: "draft",
  specification: "https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/oauth-client-credentials.mdx",
  requirements: {
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
  },
};

export const authorizationExtensions: readonly AuthorizationExtension[] = [
  enterpriseManagedAuthorization,
  clientCredentialsAuthorization,
];

/** Explicit version pins are mandatory, including for draft integrations. */
export function resolveAuthorizationExtensions(
  selections: readonly string[],
  available: readonly AuthorizationExtension[] = authorizationExtensions,
): readonly AuthorizationExtension[] {
  const resolved = selections.map((selection) => {
    const matches = available.filter((entry) => `${entry.id}@${entry.version}` === selection);
    if (matches.length > 1) throw new Error(`Ambiguous authorization extension registration: ${selection}`);
    const extension = matches[0];
    if (!extension) throw new Error(`Unknown authorization extension/version: ${selection}`);
    return extension;
  });
  assertUniqueExtensions(resolved);
  return resolved;
}

export function readAuthorizationExtensions(
  environment: Readonly<Record<string, string | undefined>>,
): readonly AuthorizationExtension[] {
  const configured = environment.MCP_AUTH_EXTENSIONS?.trim();
  if (!configured) return [];
  return resolveAuthorizationExtensions(configured.split(",").map((value) => value.trim()));
}

function assertUniqueExtensions(extensions: readonly AuthorizationExtension[]): void {
  const ids = new Set<string>();
  for (const extension of extensions) {
    if (!/^[a-z][a-z0-9-]+$/u.test(extension.id)
      || !/^\d+\.\d+\.\d+$/u.test(extension.version)) {
      throw new Error("Authorization extensions require an ID and an exact integration version");
    }
    if (ids.has(extension.id)) throw new Error(`Duplicate authorization extension: ${extension.id}`);
    ids.add(extension.id);
  }
}

/** Union requirements deterministically; a composition can only add requirements. */
export function validateAuthorizationExtensions(
  metadata: OAuthMetadata,
  extensions: readonly AuthorizationExtension[],
): void {
  assertUniqueExtensions(extensions);
  const requirements = new Map<string, true | Set<string>>();
  for (const extension of extensions) {
    for (const [field, expected] of Object.entries(extension.requirements)) {
      const existing = requirements.get(field);
      if (existing !== undefined && (existing === true) !== (expected === true)) {
        throw new Error(`Conflicting authorization extension requirements for ${field}`);
      }
      if (expected === true) requirements.set(field, true);
      else requirements.set(field, new Set([...(existing instanceof Set ? existing : []), ...expected]));
    }
  }
  for (const [field, expected] of [...requirements].sort(([a], [b]) => a.localeCompare(b))) {
    const actual = metadata[field];
    if (expected === true ? actual !== true
      : !Array.isArray(actual) || ![...expected].every((value) => actual.includes(value))) {
      throw new Error(`Authorization Server does not satisfy enabled extension requirement: ${field}`);
    }
  }
}
