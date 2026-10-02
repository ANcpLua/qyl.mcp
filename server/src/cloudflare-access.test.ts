import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { createCloudflareAccessAuth, readAccessConfig } from "./cloudflare-access.js";
import { createFetch, createHostedHandler, hostedAuth } from "./main.js";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const teamDomain = "https://example.cloudflareaccess.com";
const audience = "example-access-application";
const resource = new URL("https://mcp.qyl.at/mcp");
const { privateKey, publicKey } = await generateKeyPair("RS256");
const auth = createCloudflareAccessAuth({ teamDomain, audience, resource, key: async () => publicKey });
async function token(options: { issuer?: string; audience?: string; expired?: boolean; subject?: string } = {}) {
  return new SignJWT({ type: "app" }).setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(options.issuer ?? teamDomain).setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? "user-123").setIssuedAt()
    .setExpirationTime(options.expired ? "-1m" : "5m").sign(privateKey);
}

test("Cloudflare mode validates the edge assertion and passes read authorization into the real HTTP composition", async (context) => {
  let subject: unknown;
  const handler = createHostedHandler(() => {
    const server = new McpServer({ name: "access-test", version: "1" });
    server.registerTool("auth_context", { description: "Check auth", inputSchema: z.object({}) }, async (_args, requestContext) => {
      const info = requestContext.http?.authInfo;
      subject = info?.extra?.subject;
      assert.deepEqual(info?.scopes, ["qyl:read"]);
      assert.equal(info?.resource?.href, resource.href);
      return { content: [{ type: "text", text: "accepted" }] };
    });
    return server;
  }, () => undefined);
  context.after(() => handler.close());
  const serve = createFetch({ auth, allowedHosts: ["mcp.qyl.at"], allowedOrigins: ["mcp.qyl.at"], landingPage: "", handler });
  const assertion = await token();
  const transport = new StreamableHTTPClientTransport(resource, {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      request.headers.set("host", "mcp.qyl.at");
      request.headers.set("cf-access-jwt-assertion", assertion);
      request.headers.set("authorization", "Bearer oauth:opaque-client-token");
      return serve(request);
    },
  });
  const client = new Client({ name: "access-test-client", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  context.after(() => client.close().catch(() => undefined));
  await client.connect(transport);
  const result = await client.callTool({ name: "auth_context", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(subject, "user-123");
});

test("Cloudflare mode never accepts an opaque Bearer token or a forged assertion directly at the origin", async () => {
  for (const headers of [{}, { authorization: "Bearer oauth:opaque" }, { "cf-access-jwt-assertion": "forged" }]) {
    const response = await auth.gate(new Request(resource, { headers }));
    assert(response instanceof Response);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mcp\.qyl\.at\/\.well-known\/oauth-protected-resource"/u);
  }
});

test("Cloudflare mode rejects a valid signature for a different app, issuer, expired token or empty subject", async () => {
  for (const options of [{ audience: "different-app" }, { issuer: "https://evil.example" }, { expired: true }, { subject: "" }]) {
    const response = await auth.gate(new Request(resource, { headers: { "cf-access-jwt-assertion": await token(options) } }));
    assert(response instanceof Response);
    assert.equal(response.status, 401);
  }
});

test("Cloudflare mode leaves discovery to Access and does not advertise Auth0", async (context) => {
  const handler = createHostedHandler(() => new McpServer({ name: "discovery-test", version: "1" }), () => undefined);
  context.after(() => handler.close());
  const serve = createFetch({ auth, allowedHosts: ["mcp.qyl.at"], landingPage: "", handler });
  const response = await serve(new Request("https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp", { headers: { host: "mcp.qyl.at" } }));
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /auth0/u);
});

test("hosted startup selects Access without contacting Auth0 and requires a public URL", async () => {
  const environment = { MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: teamDomain, MCP_ACCESS_AUD: audience };
  const selected = await hostedAuth({ port: 3001, bindHost: "0.0.0.0", publicUrl: new URL("https://mcp.qyl.at") }, environment);
  assert(selected);
  assert.equal(selected.metadata, undefined);
  await assert.rejects(hostedAuth({ port: 3001, bindHost: "127.0.0.1" }, environment), /MCP_PUBLIC_URL/u);
});

test("provider selection is explicit and rejects incomplete or unsafe configuration", () => {
  assert.equal(readAccessConfig({}), undefined);
  assert.equal(readAccessConfig({ MCP_AUTH_PROVIDER: "auth0" }), undefined);
  assert.deepEqual(readAccessConfig({ MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: teamDomain, MCP_ACCESS_AUD: audience }), { teamDomain, audience });
  for (const env of [
    { MCP_AUTH_PROVIDER: "none" },
    { MCP_ACCESS_AUD: audience },
    { MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: teamDomain },
    { MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: "http://127.0.0.1", MCP_ACCESS_AUD: audience },
    { MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: teamDomain + "/other", MCP_ACCESS_AUD: audience },
    { MCP_AUTH_PROVIDER: "cloudflare-access", MCP_ACCESS_TEAM_DOMAIN: "https://evil.example", MCP_ACCESS_AUD: audience },
  ]) assert.throws(() => readAccessConfig(env));
});

test("Access assertion headers are redacted from diagnostic objects and text", async () => {
  const { SecretRedactor } = await import("./secret-redactor.js");
  const redactor = new SecretRedactor();
  assert.deepEqual(redactor.redact({ "CF-Access-Jwt-Assertion": "synthetic-assertion" }), { "CF-Access-Jwt-Assertion": "[REDACTED]" });
  assert(!redactor.redactText("CF-Access-Jwt-Assertion: synthetic-assertion").includes("synthetic-assertion"));
});
