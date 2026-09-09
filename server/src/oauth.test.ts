import assert from "node:assert/strict";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { hostedAuth, readStreamableHTTPConfig } from "./main.js";
import {
  QYL_MCP_ISSUER,
  QYL_MCP_SCOPE,
  createJwtTokenVerifier,
  loadHostedOAuth,
} from "./oauth.js";

const resource = new URL("https://mcp.qyl.at/mcp");
const issuer = QYL_MCP_ISSUER;

// The issuer used to be read from MCP_OAUTH_ISSUER, which accepted exactly one
// value, so there is nothing left to deviate from and nothing to reject. What
// remains worth proving is the property that variable never carried: whether a
// gate is built at all is decided by MCP_PUBLIC_URL alone, and no reachable
// deployment can answer "no".
test("no hosted OAuth gate is built without a public URL", async () => {
  // Runs to completion without a network call: the absent public URL short-
  // circuits before any Authorization Server discovery would be attempted.
  assert.equal(await hostedAuth(readStreamableHTTPConfig({})), undefined);
  assert.equal(
    await hostedAuth(readStreamableHTTPConfig({ MCP_BIND_HOST: "::1" })),
    undefined,
  );
});

test("a reachable deployment cannot start without the public URL that builds the gate", () => {
  for (const bindHost of ["0.0.0.0", "::", "10.0.0.4"]) {
    assert.throws(
      () => readStreamableHTTPConfig({ MCP_BIND_HOST: bindHost }),
      /MCP_PUBLIC_URL must be set/u,
      `expected ${bindHost} to require a public URL`,
    );
  }
  // With one configured it is the origin the gate is built for, and
  // `<origin>/mcp` is the resource identifier tokens are bound to.
  assert.equal(
    readStreamableHTTPConfig({
      MCP_BIND_HOST: "0.0.0.0",
      MCP_PUBLIC_URL: "https://mcp.qyl.at",
    }).publicUrl?.href,
    "https://mcp.qyl.at/",
  );
});

test("hosted OAuth requires and advertises read access only", async () => {
  await withMockFetch(authMetadata(), async () => {
    const oauth = await loadHostedOAuth(resource);
    assert.deepEqual(oauth.requiredScopes, [QYL_MCP_SCOPE]);
    assert.deepEqual(oauth.scopesSupported, [QYL_MCP_SCOPE]);
    assert.equal(oauth.oauthMetadata.issuer, issuer);
  });
});

test("hosted OAuth rejects an insecure JWKS endpoint", async () => {
  await withMockFetch(authMetadata({ jwks_uri: `http://${new URL(QYL_MCP_ISSUER).host}/.well-known/jwks.json` }), async () => {
    await assert.rejects(
      () => loadHostedOAuth(resource),
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

test("an access token audienced to several resources is accepted for the qyl one", async () => {
  const keys = await testKeys();
  const verifier = createJwtTokenVerifier({
    issuer,
    resource,
    key: keys.verificationKey,
  });

  // Auth0 issues a multi-valued `aud` whenever the client also asks for
  // userinfo, and RFC 7519 allows it. Only the presence of this resource
  // decides acceptance.
  const auth = await verifier.verifyAccessToken(await issueToken(keys.privateKey, {
    sub: "auth0|user-1",
    client_id: "https://client.example/mcp.json",
    scope: QYL_MCP_SCOPE,
  }, { audience: [resource.href, `${issuer}userinfo`] }));
  assert.equal(auth.clientId, "https://client.example/mcp.json");
  assert.equal(auth.resource?.href, resource.href);

  await assert.rejects(
    async () => verifier.verifyAccessToken(await issueToken(keys.privateKey, {
      sub: "auth0|user-1",
      client_id: "https://client.example/mcp.json",
      scope: QYL_MCP_SCOPE,
    }, { audience: [`${issuer}userinfo`, "https://wrong.example/mcp"] })),
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
  options: { typ?: string; audience?: string | string[] } = {},
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
