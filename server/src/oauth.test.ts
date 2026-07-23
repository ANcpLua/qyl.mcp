import assert from "node:assert/strict";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  QYL_MCP_SCOPE,
  createJwtTokenVerifier,
  loadHostedOAuth,
} from "./oauth.js";

const resource = new URL("https://mcp.qyl.at/mcp");
const issuer = "https://qyl.eu.auth0.com/";

test("hosted OAuth fails closed when no issuer is configured", async () => {
  await assert.rejects(
    () => loadHostedOAuth(resource, {}),
    /MCP_OAUTH_ISSUER must name/u,
  );
});

test("hosted OAuth rejects an invalid issuer URL", async () => {
  await assert.rejects(
    () => loadHostedOAuth(resource, { MCP_OAUTH_ISSUER: "http://auth.example.com" }),
    /MCP_OAUTH_ISSUER must use HTTPS/u,
  );
  await assert.rejects(
    () => loadHostedOAuth(resource, { MCP_OAUTH_ISSUER: "auth.example.com" }),
    /MCP_OAUTH_ISSUER must be an absolute URL/u,
  );
  await assert.rejects(
    () => loadHostedOAuth(resource, { MCP_OAUTH_ISSUER: "https://user:secret@auth.example.com" }),
    /must not contain credentials/u,
  );
});

test("hosted OAuth loads matching metadata and requires the qyl read scope", async () => {
  await withMockFetch(authMetadata(), async () => {
    const oauth = await loadHostedOAuth(resource, { MCP_OAUTH_ISSUER: issuer });
    assert.deepEqual(oauth.requiredScopes, [QYL_MCP_SCOPE]);
    assert.equal(oauth.oauthMetadata.issuer, issuer);
  });
});

test("hosted OAuth rejects an insecure JWKS endpoint", async () => {
  await withMockFetch(authMetadata({ jwks_uri: "http://qyl.eu.auth0.com/.well-known/jwks.json" }), async () => {
    await assert.rejects(
      () => loadHostedOAuth(resource, { MCP_OAUTH_ISSUER: issuer }),
      /must advertise an HTTPS jwks_uri/u,
    );
  });
});

test("RFC 9068 access tokens populate the SDK AuthInfo contract", async () => {
  const keys = await testKeys();
  const token = await issueToken(keys.privateKey, {
    sub: "auth0|user-1",
    client_id: "https://client.example/mcp.json",
    scope: `${QYL_MCP_SCOPE} openid`,
  });
  const verifier = createJwtTokenVerifier({
    issuer,
    resource,
    key: keys.verificationKey,
  });

  const auth = await verifier.verifyAccessToken(token);
  assert.equal(auth.clientId, "https://client.example/mcp.json");
  assert.deepEqual(auth.scopes, [QYL_MCP_SCOPE, "openid"]);
  assert.equal(auth.resource?.href, resource.href);
  assert.equal(auth.extra?.subject, "auth0|user-1");
  assert.equal(typeof auth.expiresAt, "number");
});

test("token verification rejects the wrong token type, audience, or missing client ID", async () => {
  const keys = await testKeys();
  const verifier = createJwtTokenVerifier({
    issuer,
    resource,
    key: keys.verificationKey,
  });
  const validClaims = {
    sub: "auth0|user-1",
    client_id: "https://client.example/mcp.json",
    scope: QYL_MCP_SCOPE,
  };

  await assert.rejects(
    async () => verifier.verifyAccessToken(await issueToken(keys.privateKey, validClaims, { typ: "JWT" })),
    /Access token verification failed/u,
  );
  await assert.rejects(
    async () => verifier.verifyAccessToken(await issueToken(keys.privateKey, validClaims, {
      audience: "https://wrong.example/mcp",
    })),
    /Access token verification failed/u,
  );
  await assert.rejects(
    async () => verifier.verifyAccessToken(await issueToken(keys.privateKey, {
      sub: "auth0|user-1",
      scope: QYL_MCP_SCOPE,
    })),
    /Access token verification failed/u,
  );
});

test("token verification rejects signing algorithms other than RS256", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "ec-test-key";
  const verifier = createJwtTokenVerifier({
    issuer,
    resource,
    key: createLocalJWKSet({ keys: [jwk] }),
  });
  const token = await new SignJWT({
    sub: "auth0|user-1",
    client_id: "https://client.example/mcp.json",
    scope: QYL_MCP_SCOPE,
  })
    .setProtectedHeader({ alg: "ES256", kid: "ec-test-key", typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource.href)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  await assert.rejects(
    () => verifier.verifyAccessToken(token),
    /Access token verification failed/u,
  );
});

async function testKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  return {
    privateKey,
    verificationKey: createLocalJWKSet({ keys: [jwk] }),
  };
}

async function issueToken(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  claims: Record<string, unknown>,
  options: { typ?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: options.typ ?? "at+jwt" })
    .setIssuer(issuer)
    .setAudience(options.audience ?? resource.href)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti("test-token")
    .sign(privateKey);
}

function authMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}authorize`,
    token_endpoint: `${issuer}oauth/token`,
    jwks_uri: `${issuer}.well-known/jwks.json`,
    registration_endpoint: `${issuer}oidc/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

async function withMockFetch<T>(
  body: Record<string, unknown>,
  action: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}
