import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { AnonymousOAuthProvider } from "./oauth.js";

const ISSUER = new URL("https://mcp.qyl.test");
const STATIC_TOKEN = "static-operator-token";

function buildApp() {
  const provider = new AnonymousOAuthProvider(STATIC_TOKEN, STATIC_TOKEN);
  const app = express();
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: ISSUER,
      resourceName: "qyl telemetry MCP server (test)",
      scopesSupported: ["qyl"],
    }),
  );
  app.get(
    "/protected",
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource", ISSUER).href,
    }),
    (request, response) => {
      response.status(200).json({ clientId: request.auth?.clientId });
    },
  );
  return app;
}

async function listen(app: express.Express): Promise<{ base: string; close: () => void }> {
  return new Promise((resolvePromise) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolvePromise({
        base: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}

interface FlowResult {
  accessToken: string;
  refreshToken: string | undefined;
  clientId: string;
}

async function runAuthorizationFlow(base: string): Promise<FlowResult> {
  const redirectUri = "http://127.0.0.1:39999/callback";

  const registration = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const client = (await registration.json()) as { client_id: string };
  assert.ok(client.client_id.startsWith("qylci."));

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "flow-state");

  const authorize = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const location = new URL(authorize.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, redirectUri);
  assert.equal(location.searchParams.get("state"), "flow-state");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const token = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  assert.equal(token.status, 200);
  const tokens = (await token.json()) as {
    access_token: string;
    token_type: string;
    refresh_token?: string;
  };
  assert.equal(tokens.token_type.toLowerCase(), "bearer");
  assert.ok(tokens.access_token.startsWith("qylat."));
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId: client.client_id,
  };
}

test("authorization server metadata is discoverable", async () => {
  const { base, close } = await listen(buildApp());
  try {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.equal(metadata["issuer"], ISSUER.href);
    assert.ok(metadata["authorization_endpoint"]);
    assert.ok(metadata["token_endpoint"]);
    assert.ok(metadata["registration_endpoint"]);
  } finally {
    close();
  }
});

test("full anonymous flow: register, authorize, exchange, call", async () => {
  const { base, close } = await listen(buildApp());
  try {
    const flow = await runAuthorizationFlow(base);
    const protectedResponse = await fetch(`${base}/protected`, {
      headers: { authorization: `Bearer ${flow.accessToken}` },
    });
    assert.equal(protectedResponse.status, 200);
  } finally {
    close();
  }
});

test("refresh token grants a new access token", async () => {
  const { base, close } = await listen(buildApp());
  try {
    const flow = await runAuthorizationFlow(base);
    assert.ok(flow.refreshToken);
    const refreshed = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: flow.clientId,
        refresh_token: flow.refreshToken,
      }),
    });
    assert.equal(refreshed.status, 200);
    const tokens = (await refreshed.json()) as { access_token: string };
    assert.ok(tokens.access_token.startsWith("qylat."));
  } finally {
    close();
  }
});

test("wrong PKCE verifier is rejected", async () => {
  const { base, close } = await listen(buildApp());
  try {
    const redirectUri = "http://127.0.0.1:39999/callback";
    const registration = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    const client = (await registration.json()) as { client_id: string };
    const challenge = createHash("sha256").update("honest-verifier", "ascii").digest("base64url");
    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code");
    assert.ok(code);

    const token = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: "a-different-verifier-entirely",
        redirect_uri: redirectUri,
      }),
    });
    assert.equal(token.status, 400);
  } finally {
    close();
  }
});

test("static operator token and garbage tokens verify correctly", async () => {
  const { base, close } = await listen(buildApp());
  try {
    const operator = await fetch(`${base}/protected`, {
      headers: { authorization: `Bearer ${STATIC_TOKEN}` },
    });
    assert.equal(operator.status, 200);
    const body = (await operator.json()) as { clientId: string };
    assert.equal(body.clientId, "qyl-operator");

    const garbage = await fetch(`${base}/protected`, {
      headers: { authorization: "Bearer qylat.not-a-real-token.nope" },
    });
    assert.equal(garbage.status, 401);
    assert.match(garbage.headers.get("www-authenticate") ?? "", /resource_metadata/);

    const missing = await fetch(`${base}/protected`);
    assert.equal(missing.status, 401);
  } finally {
    close();
  }
});

test("material signed by a different secret is rejected", async () => {
  const foreign = new AnonymousOAuthProvider("some-other-secret");
  const foreignTokens = foreign["clientsStore"].registerClient?.({
    redirect_uris: ["http://127.0.0.1:39999/callback"],
    token_endpoint_auth_method: "none",
  });
  assert.ok(foreignTokens);
  const { base, close } = await listen(buildApp());
  try {
    const response = await fetch(`${base}/protected`, {
      headers: {
        authorization: `Bearer ${(foreignTokens as { client_id: string }).client_id.replace("qylci.", "qylat.")}`,
      },
    });
    assert.equal(response.status, 401);
  } finally {
    close();
  }
});
