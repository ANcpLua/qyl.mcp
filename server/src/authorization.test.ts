import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { createResourceAuthorization } from "./authorization.js";

const metadata = "https://mcp.example/.well-known/oauth-protected-resource/mcp";
const resource = new URL("https://mcp.example/mcp");
const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    return { token, clientId: "client", scopes: Buffer.from(token, "base64url").toString().split(" "), resource,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
  },
};
const bearer = (token: string, method = "POST") => new Request(resource, {
  method, headers: { Authorization: `Bearer ${Buffer.from(token).toString("base64url")}` },
});

test("malformed or query credentials never reach the verifier, even alongside a valid header", async () => {
  let calls = 0;
  const gate = createResourceAuthorization({
    verifier: { async verifyAccessToken() { calls++; throw new Error("must not run"); } },
    resourceMetadataUrl: metadata, requiredScopes: ["qyl:read"],
  });
  for (const headers of ["Bearer", "Bearer good, Bearer evil", "Bearer one two", "Basic abc"]) {
    const response = await gate(new Request(resource, { headers: { authorization: headers } }));
    assert(response instanceof Response);
    assert.equal(response.status, 400);
  }
  const response = await gate(new Request(`${resource.href}?access_token=secret`, {
    headers: { authorization: "Bearer good" },
  }));
  assert(response instanceof Response);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /secret|good/u);
  assert.equal(calls, 0);
});

test("scope challenges emit all operation requirements, without offline_access", async () => {
  const gate = createResourceAuthorization({ verifier, resourceMetadataUrl: metadata,
    requiredScopes: ["files:write", "files:read", "files:write"] });
  for (const request of [new Request(resource), bearer("files:read")]) {
    const response = await gate(request);
    assert(response instanceof Response);
    assert.equal(response.status, request.headers.has("authorization") ? 403 : 401);
    assert.match(response.headers.get("www-authenticate")!, /scope="files:read files:write"/u);
    assert.match(response.headers.get("www-authenticate")!, /resource_metadata=/u);
    assert.doesNotMatch(response.headers.get("www-authenticate")!, /offline_access/u);
  }
});

test("explicit scope hierarchies are transitive, cycle safe and preserve verified claims", async () => {
  const gate = createResourceAuthorization({ verifier, resourceMetadataUrl: metadata,
    requiredScopes: ["files:read"], scopeImplications: {
      admin: ["files:write"], "files:write": ["files:read"], "files:read": ["files:write"],
    } });
  const auth = await gate(bearer("admin"));
  assert(!(auth instanceof Response));
  assert.deepEqual(auth.scopes, ["admin"]);
  for (const granted of ["unrelated", "files:*", "toString", "constructor"]) {
    const denied = await gate(bearer(granted));
    assert(denied instanceof Response);
    assert.equal(denied.status, 403);
  }
});

test("authentication is checked on every HTTP method and request", async () => {
  let calls = 0;
  const countingVerifier = { async verifyAccessToken(token: string): Promise<AuthInfo> {
    calls++;
    return verifier.verifyAccessToken(token);
  } };
  const gate = createResourceAuthorization({ verifier: countingVerifier,
    resourceMetadataUrl: metadata, requiredScopes: ["read"] });
  for (const method of ["GET", "POST", "DELETE"]) {
    assert(!((await gate(bearer("read", method))) instanceof Response));
    const missing = await gate(new Request(resource, { method }));
    assert(missing instanceof Response);
    assert.equal(missing.status, 401);
  }
  assert.equal(calls, 3);
});

test("Bearer is case-insensitive, permits multiple spaces, and leaves the MCP body unread", async () => {
  const gate = createResourceAuthorization({ verifier, resourceMetadataUrl: metadata, requiredScopes: ["read"] });
  const request = new Request(resource, { method: "POST", body: "MCP body",
    headers: { authorization: `bEaReR   ${Buffer.from("read").toString("base64url")}` } });
  assert(!((await gate(request)) instanceof Response));
  assert.equal(request.bodyUsed, false);
  assert.equal(await request.text(), "MCP body");
});

test("unsafe or refresh-only resource scope configuration is refused", () => {
  for (const scope of ["offline_access", "read write", 'read"', "read\\", ""]) {
    assert.throws(() => createResourceAuthorization({ verifier,
      resourceMetadataUrl: metadata, requiredScopes: [scope] }), /Resource scopes/u);
  }
  for (const resourceMetadataUrl of ["http://mcp.example/metadata", "https://user:secret@mcp.example/metadata",
    "https://mcp.example/metadata?secret=token", "https://mcp.example/metadata#fragment",
    "https://mcp.example/\nmetadata"]) {
    assert.throws(() => createResourceAuthorization({ verifier, resourceMetadataUrl, requiredScopes: [] }), /safe HTTPS/u);
  }
});
