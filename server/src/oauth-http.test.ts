import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";

const resourceMetadataUrl =
  "https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp";
const endpoint = new URL(QYL_MCP_RESOURCE);

test("bearer gate fails closed with the resource challenge and scopes", async () => {
  const gate = bearerGate();

  const missing = await gate(new Request(endpoint));
  assert(missing instanceof Response);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/u);
  assert.match(
    missing.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/mcp\.qyl\.at\/\.well-known\/oauth-protected-resource\/mcp"/u,
  );

  const invalid = await gate(bearer("invalid"));
  assert(invalid instanceof Response);
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get("www-authenticate") ?? "", /invalid_token/u);

  const missingScope = await gate(bearer("missing-scope"));
  assert(missingScope instanceof Response);
  assert.equal(missingScope.status, 403);
  assert.match(missingScope.headers.get("www-authenticate") ?? "", /insufficient_scope/u);
  assert.match(missingScope.headers.get("www-authenticate") ?? "", /scope="qyl:read"/u);
});

test("verified SDK AuthInfo reaches the modern tool request context", async (context) => {
  let observed: AuthInfo | undefined;
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "auth-context-test", version: "1.0.0" },
    );
    server.registerTool(
      "auth_context",
      {
        description: "Read verified authentication context.",
        inputSchema: z.object({}),
      },
      async (_arguments, requestContext) => {
        observed = requestContext.http?.authInfo;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    return server;
  }, { legacy: "reject" });
  context.after(() => handler.close());

  // The hosted composition minus the socket: gate the request, hand the
  // verified AuthInfo to the handler, return its Response. A real client
  // transport still drives it, so the negotiated envelope stays under test —
  // only the Node adapter, which the endpoint will not run, is gone.
  const gate = bearerGate();
  const serve: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const auth = await gate(request);
    return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
  };

  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: serve,
    requestInit: { headers: { authorization: "Bearer good" } },
  });
  const client = new Client(
    { name: "auth-context-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  context.after(() => client.close().catch(() => undefined));

  await client.connect(transport);
  await client.callTool({ name: "auth_context", arguments: {} });

  assert.equal(observed?.clientId, "strict-dcr-client");
  assert.deepEqual(observed?.scopes, [QYL_MCP_SCOPE]);
  assert.equal(observed?.resource?.href, QYL_MCP_RESOURCE);
  assert.equal(typeof observed?.expiresAt, "number");
});

function bearerGate(): (request: Request) => Promise<AuthInfo | Response> {
  return requireBearerAuth({
    verifier: testVerifier(),
    requiredScopes: [QYL_MCP_SCOPE],
    resourceMetadataUrl,
  });
}

function bearer(token: string): Request {
  return new Request(endpoint, { headers: { authorization: `Bearer ${token}` } });
}

function testVerifier(): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token === "invalid") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token verification failed");
      }
      return {
        token,
        clientId: "strict-dcr-client",
        scopes: token === "missing-scope" ? [] : [QYL_MCP_SCOPE],
        expiresAt: Math.floor(Date.now() / 1_000) + 300,
        resource: new URL(QYL_MCP_RESOURCE),
      };
    },
  };
}
