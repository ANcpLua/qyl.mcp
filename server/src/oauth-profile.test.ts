import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createFetch, createHostedHandler, hostedAuth, readStreamableHTTPConfig } from "./main.js";
import { createJwtTokenVerifier, loadHostedOAuth, QYL_MCP_ISSUER } from "./oauth.js";
import { fetchAuthorizationServerMetadata } from "./oauth-metadata.js";
import { authorizationExtensions } from "./auth-extensions.js";

const resource = new URL("https://mcp.qyl.at/mcp");
const issuer = QYL_MCP_ISSUER;
const keys = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "profile-test" };
const verifier = createJwtTokenVerifier({ issuer, resource, key: createLocalJWKSet({ keys: [jwk] }) });
const metadata = {
  issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}oauth/token`,
  registration_endpoint: `${issuer}oidc/register`,
  jwks_uri: `${issuer}.well-known/jwks.json`, response_types_supported: ["code"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
  token_endpoint_auth_signing_alg_values_supported: ["RS256"],
  grant_types_supported: ["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
};

async function token(overrides: Record<string, unknown> = {}, typ = "at+jwt"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: resource.href, sub: "auth0|user",
    client_id: "https://client.example/client.json", iat: now, exp: now + 300,
    jti: "unique-token", scope: "qyl:read", ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ }).sign(keys.privateKey);
}

test("the hosted profile requires CIMD, DCR, PKCE, both client methods and issuer binding", async (t) => {
  const cases = [
    { client_id_metadata_document_supported: false },
    { code_challenge_methods_supported: ["plain"] },
    { registration_endpoint: undefined },
    { token_endpoint_auth_methods_supported: ["none"] },
    { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
    { token_endpoint_auth_signing_alg_values_supported: ["HS256"] },
    { authorization_response_iss_parameter_supported: false },
    { grant_types_supported: ["client_credentials"] },
    { token_endpoint: "http://issuer.example/token" },
    { authorization_endpoint: "https://user:password@issuer.example/authorize" },
  ];
  let response: Record<string, unknown> = metadata;
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  for (const invalid of cases) {
    response = { ...metadata, ...invalid };
    await assert.rejects(() => loadHostedOAuth(resource), /Authorization Server/u);
  }
  response = metadata;
  const auth = await loadHostedOAuth(resource);
  assert.deepEqual(auth.extensions, []);
  assert.equal(auth.oauthMetadata.registration_endpoint, `${issuer}oidc/register`);
  assert.deepEqual(auth.scopesSupported, ["qyl:read"]);
});

test("discovery falls back to OIDC and preserves extension metadata without redirects", async (t) => {
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requested.push(url);
    assert.equal(init.redirect, "error");
    return requested.length === 1 ? new Response(null, { status: 404 }) : Response.json(metadata);
  });
  const auth = await loadHostedOAuth(resource, { extensions: authorizationExtensions });
  assert.deepEqual(requested, [`${issuer}.well-known/oauth-authorization-server`, `${issuer}.well-known/openid-configuration`]);
  assert.deepEqual(auth.oauthMetadata.authorization_grant_profiles_supported,
    metadata.authorization_grant_profiles_supported);
});

test("discovery binds the exact issuer and implements path-aware well-known locations", async (t) => {
  const pathIssuer = "https://issuer.example/tenant";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return Response.json({ ...metadata, issuer: requests.length < 3 ? `${pathIssuer}/` : pathIssuer });
  });
  assert.equal((await fetchAuthorizationServerMetadata(new URL(pathIssuer))).issuer, pathIssuer);
  assert.deepEqual(requests, [
    "https://issuer.example/.well-known/oauth-authorization-server/tenant",
    "https://issuer.example/.well-known/openid-configuration/tenant",
    "https://issuer.example/tenant/.well-known/openid-configuration",
  ]);
});

test("token validation rejects expiry, foreign issuers, missing RFC9068 claims and assertion tokens", async () => {
  for (const claims of [
    { exp: 0 }, { exp: undefined }, { iss: "https://foreign.example/" },
    { iat: undefined }, { iat: Math.floor(Date.now() / 1000) + 3600 }, { jti: undefined },
    { sub: "" }, { client_id: "" }, { aud: "https://another.example/mcp" },
    { nbf: Math.floor(Date.now() / 1000) + 3600 }, { scope: ["qyl:read"] },
    { scope: "qyl:read\nadmin" },
  ]) {
    await assert.rejects(() => token(claims).then((value) => verifier.verifyAccessToken(value)), /verification failed/u);
  }
  for (const typ of ["JWT", "oauth-id-jag+jwt", "client-authentication+jwt"]) {
    await assert.rejects(() => token({}, typ).then((value) => verifier.verifyAccessToken(value)), /verification failed/u);
  }
  const otherKeys = await generateKeyPair("RS256");
  const forged = await new SignJWT(decodeJwt(await token())).setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ: "at+jwt" }).sign(otherKeys.privateKey);
  await assert.rejects(() => verifier.verifyAccessToken(forged), /verification failed/u);
});

test("invalid extension configuration cannot silently start in local or Access modes", async () => {
  const config = readStreamableHTTPConfig({});
  await assert.rejects(() => hostedAuth(config, {
    MCP_AUTH_EXTENSIONS: "oauth-client-credentials@latest",
  }), /Unknown/u);
  await assert.rejects(() => hostedAuth(config, {
    MCP_AUTH_EXTENSIONS: "oauth-client-credentials@1.0.0",
  }), /requires hosted Auth0/u);
  await assert.rejects(() => hostedAuth(readStreamableHTTPConfig({ MCP_PUBLIC_URL: resource.origin }), {
    MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    MCP_ACCESS_AUD: "aud", MCP_AUTH_EXTENSIONS: "oauth-client-credentials@1.0.0",
  }), /requires hosted Auth0/u);
});

test("real signed access tokens reach modern MCP tools with zero, one, or both extensions", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: URL | Request | string) => {
    const url = input instanceof Request ? input.url : String(input);
    return Response.json(url === metadata.jwks_uri ? { keys: [jwk] } : metadata);
  });
  for (const extensions of [[], [authorizationExtensions[0]], [authorizationExtensions[1]], authorizationExtensions]) {
    const auth = await hostedAuth(readStreamableHTTPConfig({ MCP_PUBLIC_URL: resource.origin }), {
      MCP_AUTH_EXTENSIONS: extensions.map((extension) => `${extension.id}@${extension.version}`).join(","),
    });
    assert(auth);
    const handler = createHostedHandler(() => {
      const server = new McpServer({ name: "extension-proof", version: "1.0.0" });
      server.registerTool("identity", { inputSchema: z.object({}) }, async (_, context) => ({
        content: [{ type: "text", text: context.http!.authInfo!.clientId }],
      }));
      return server;
    }, () => undefined);
    t.after(() => handler.close());
    const serve = createFetch({ handler, landingPage: "", auth, allowedHosts: [resource.hostname] });
    const fetch = (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("host", resource.host);
      return serve(new Request(request, { headers }));
    };
    const discovery = await fetch(new Request(`${resource.origin}/.well-known/oauth-protected-resource/mcp`));
    assert.deepEqual(await discovery.json(), {
      resource: resource.href, authorization_servers: [issuer], scopes_supported: ["qyl:read"],
    });
    for (const subject of ["auth0|interactive-user", "service-client@clients", "enterprise|user"]) {
      const signed = await token({ sub: subject });
      const client = new Client({ name: "extension-client", version: "1.0.0" }, {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      });
      t.after(() => client.close().catch(() => undefined));
      await client.connect(new StreamableHTTPClientTransport(resource, {
        fetch: (url, init) => fetch(new Request(url, init)),
        requestInit: { headers: { Authorization: `Bearer ${signed}` } },
      }));
      const result = await client.callTool({ name: "identity", arguments: {} });
      assert.deepEqual(result.content, [{ type: "text", text: "https://client.example/client.json" }]);
      await client.close();
    }
    for (const [signed, status] of [
      [await token({ scope: "different" }), 403],
      [await token({ aud: "https://foreign.example/" }), 401],
      [await token({}, "oauth-id-jag+jwt"), 401],
      [await token({ exp: 0 }), 401],
    ] as const) {
      const response = await fetch(new Request(resource, { method: "POST", headers: { Authorization: `Bearer ${signed}` } }));
      assert.equal(response.status, status);
      assert.match(response.headers.get("www-authenticate")!, /scope="qyl:read"/u);
      assert.match(response.headers.get("www-authenticate")!, /resource_metadata=/u);
    }
  }
});
