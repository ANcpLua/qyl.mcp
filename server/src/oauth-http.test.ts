import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import {
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { createMcpApp } from "./http-security.js";
import { closeHttpListener } from "./main.js";
import { QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";

const resourceMetadataUrl =
  "https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp";

test("bearer middleware fails closed with the resource challenge and scopes", async (context) => {
  const verifier = testVerifier();
  const app = createMcpApp({ bindHost: "127.0.0.1" });
  app.all("/mcp", requireBearerAuth({
    verifier,
    requiredScopes: [QYL_MCP_SCOPE],
    resourceMetadataUrl,
  }), (_request, response) => response.status(204).end());
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  context.after(() => closeHttpListener(listener));
  const address = listener.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const missing = await fetch(endpoint);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/u);
  assert.match(
    missing.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/mcp\.qyl\.at\/\.well-known\/oauth-protected-resource\/mcp"/u,
  );

  const invalid = await fetch(endpoint, {
    headers: { authorization: "Bearer invalid" },
  });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get("www-authenticate") ?? "", /invalid_token/u);

  const missingScope = await fetch(endpoint, {
    headers: { authorization: "Bearer missing-scope" },
  });
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
  const nodeHandler = toNodeHandler(handler);
  const app = createMcpApp({ bindHost: "127.0.0.1" });
  app.all("/mcp", requireBearerAuth({
    verifier: testVerifier(),
    requiredScopes: [QYL_MCP_SCOPE],
    resourceMetadataUrl,
  }), async (request, response) => {
    await nodeHandler(request, response, request.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  context.after(async () => {
    await handler.close();
    await closeHttpListener(listener);
  });
  const address = listener.address();
  assert(address && typeof address === "object");

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { authorization: "Bearer good" } } },
  );
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
