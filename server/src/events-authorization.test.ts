import assert from "node:assert/strict";
import test from "node:test";
import { createEventsAuthorization, hostedEventsAuthorization } from "./events-authorization.js";
import { QYL_MCP_ISSUER, QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";

const principal = { subject: "auth0|test", clientId: "test-client" };

function authority(cimdClientId?: string) {
  let now = 0;
  let blocked = false;
  let consent = true;
  let permission = true;
  let application = true;
  let available = true;
  let tokenRequests = 0;
  let cimdClients: { client_id: string; external_client_id?: string }[] = cimdClientId === undefined
    ? [] : [{ client_id: principal.clientId }];
  const urls: URL[] = [];
  const check = createEventsAuthorization({
    clientId: "management-client", clientSecret: "test-secret", now: () => now,
    fetch: async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      assert.equal(url.origin, new URL(QYL_MCP_ISSUER).origin);
      assert.equal(init?.redirect, "error");
      if (url.pathname === "/oauth/token") {
        tokenRequests++;
        assert.equal(typeof init?.body, "string");
        const body = JSON.parse(init!.body as string);
        assert.equal(body.audience, `${QYL_MCP_ISSUER}api/v2/`);
        assert.equal(body.grant_type, "client_credentials");
        return Response.json({ access_token: "management-token", token_type: "Bearer", expires_in: 3600 });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer management-token");
      urls.push(url);
      if (!available) return Response.json({ message: "api_key=must-never-escape" }, { status: 503 });
      if (url.pathname.endsWith("/clients")) {
        assert.equal(url.searchParams.get("external_client_id"), cimdClientId);
        assert.equal(url.searchParams.get("fields"), "client_id,external_client_id");
        return Response.json(cimdClients);
      }
      if (url.pathname.endsWith("/permissions")) {
        return Response.json(permission ? [{ resource_server_identifier: QYL_MCP_RESOURCE, permission_name: QYL_MCP_SCOPE }] : []);
      }
      if (url.pathname.endsWith("/client-grants")) {
        assert.equal(url.searchParams.get("client_id"), principal.clientId);
        return Response.json(application ? [{ client_id: principal.clientId, audience: QYL_MCP_RESOURCE, subject_type: "user", scope: [QYL_MCP_SCOPE] }] : []);
      }
      if (url.pathname.endsWith("/grants")) {
        assert.equal(url.searchParams.get("user_id"), principal.subject);
        return Response.json(consent ? [{ clientID: principal.clientId, user_id: principal.subject, audience: QYL_MCP_RESOURCE, scope: [QYL_MCP_SCOPE] }] : []);
      }
      return Response.json({ blocked });
    },
  });
  return {
    check, urls,
    tokenRequests: () => tokenRequests,
    advance: (ms = 5_001) => { now += ms; },
    revoke: (kind: "account" | "consent" | "permission" | "application") => {
      if (kind === "account") blocked = true;
      if (kind === "consent") consent = false;
      if (kind === "permission") permission = false;
      if (kind === "application") application = false;
    },
    outage: () => { available = false; },
    mapCimd: (entries: typeof cimdClients) => { cimdClients = entries; },
  };
}

test("event authorization checks the account, application, user permission and consent", async () => {
  const auth = authority();
  const results = await Promise.all([auth.check(principal), auth.check(principal)]);
  assert.deepEqual(results, [true, true]);
  assert.equal(auth.tokenRequests(), 1);
  assert.equal(auth.urls.length, 4, "parallel deliveries share the access lookup");
  assert.equal(await auth.check(principal), true);
  assert.equal(auth.urls.length, 4);
  auth.advance();
  assert.equal(await auth.check(principal), true);
  assert.equal(auth.urls.length, 8, "current access is rechecked after five seconds");
  assert.equal(auth.tokenRequests(), 1, "the management token stays in memory until expiry");
  auth.advance(3_600_000);
  await auth.check(principal);
  assert.equal(auth.tokenRequests(), 2);
});

test("CIMD token identity resolves to Auth0's application ID and is rechecked after removal", async () => {
  const clientId = "https://chatgpt.com/oauth/client.json";
  const auth = authority(clientId);
  assert.equal(await auth.check({ ...principal, clientId }), true);
  assert.equal(auth.urls.length, 5);
  auth.mapCimd([]);
  auth.advance();
  assert.equal(await auth.check({ ...principal, clientId }), false);
});

test("CIMD lookup rejects mismatched or ambiguous application bindings", async () => {
  const clientId = "https://chatgpt.com/oauth/client.json";
  const auth = authority(clientId);
  auth.mapCimd([{ client_id: principal.clientId, external_client_id: "https://other.example/client.json" }]);
  assert.equal(await auth.check({ ...principal, clientId }), false);
  auth.advance();
  auth.mapCimd([
    { client_id: principal.clientId, external_client_id: clientId },
    { client_id: "another-application", external_client_id: clientId },
  ]);
  assert.equal(await auth.check({ ...principal, clientId }), false);
});

for (const kind of ["account", "application", "permission", "consent"] as const) {
  test(`removing ${kind} access revokes event authorization`, async () => {
    const auth = authority();
    assert.equal(await auth.check(principal), true);
    auth.revoke(kind);
    auth.advance();
    assert.equal(await auth.check(principal), false);
  });
}

test("an authorization outage cannot reuse a stale allow or reveal the API response", async () => {
  const auth = authority();
  assert.equal(await auth.check(principal), true);
  auth.advance();
  auth.outage();
  await assert.rejects(auth.check(principal), {
    name: "EventsAuthorizationUnavailable", message: "Event authorization is temporarily unavailable",
  });
});

test("Events cannot be enabled without credentials for ongoing access checks", () => {
  assert.throws(() => hostedEventsAuthorization({}), /requires MCP_EVENTS_AUTH0_CLIENT_ID/u);
});
