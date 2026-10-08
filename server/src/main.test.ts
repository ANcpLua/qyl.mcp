import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import {
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  createFetch,
  createHostedHandler,
  hostedEvents,
  openaiAppsChallenge,
  readStreamableHTTPConfig,
  recordsNativeExecutionEvidence,
  sanitizedErrorType,
} from "./main.js";
import { createResourceAuthorization } from "./authorization.js";
import { QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";

const resourceServerUrl = new URL(QYL_MCP_RESOURCE);
const origin = resourceServerUrl.origin;
const landingPage = "<!doctype html><title>qyl MCP</title><main>ready</main>";

const oauthMetadata: OAuthMetadata = {
  issuer: "https://qyl-eu.eu.auth0.com/",
  authorization_endpoint: "https://qyl-eu.eu.auth0.com/authorize",
  token_endpoint: "https://qyl-eu.eu.auth0.com/oauth/token",
  jwks_uri: "https://qyl-eu.eu.auth0.com/.well-known/jwks.json",
  registration_endpoint: "https://qyl-eu.eu.auth0.com/oidc/register",
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
};

interface Endpoint {
  fetch: (request: Request) => Promise<Response>;
  handler: McpHttpHandler;
}

// The endpoint as main.ts assembles it for a hosted deployment. Tests drive
// this function, not `handler.fetch` — going straight to the handler would
// skip discovery, the rebinding guards, and the gate, which is most of what
// the serving layer is.
function hostedEndpoint(options: { authenticated?: boolean; openaiAppsChallenge?: string } = {}): Endpoint {
  const handler = createHostedHandler(() => {
    const server = new McpServer({ name: "qyl-serving-test", version: "1.0.0" });
    server.registerTool(
      "auth_context",
      { description: "Read verified authentication context.", inputSchema: z.object({}) },
      async (_arguments, requestContext) => ({
        content: [{
          type: "text",
          text: requestContext.http?.authInfo?.clientId ?? "anonymous",
        }],
      }),
    );
    return server;
  }, () => undefined);

  return {
    handler,
    fetch: createFetch({
      handler,
      landingPage,
      allowedHosts: [resourceServerUrl.hostname],
      allowedOrigins: [resourceServerUrl.hostname],
      ...(options.openaiAppsChallenge === undefined ? {} : { openaiAppsChallenge: options.openaiAppsChallenge }),
      ...(options.authenticated === false ? {} : {
        auth: {
          gate: createResourceAuthorization({
            verifier: testVerifier(),
            requiredScopes: [QYL_MCP_SCOPE],
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
          }),
          metadata: {
            oauthMetadata,
            resourceServerUrl,
            scopesSupported: [QYL_MCP_SCOPE],
          },
        },
      }),
    }),
  };
}

function hosted(path: string, init: RequestInit = {}): Request {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { ...headerRecord(init.headers), host: resourceServerUrl.host },
  });
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(headers));
}

// The in-process wiring from the migration guide's "In-process testing", with
// the endpoint's own fetch in place of the handler's: the URL is never dialed.
function transportFetch(endpoint: Endpoint): FetchLike {
  return (url, init) => endpoint.fetch(new Request(url, {
    ...init,
    headers: { ...headerRecord(init?.headers), host: resourceServerUrl.host },
  }));
}

test("the public root serves the qyl MCP landing page", async (context) => {
  const endpoint = hostedEndpoint();
  context.after(() => endpoint.handler.close());

  const response = await endpoint.fetch(hosted("/"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.match(await response.text(), /<main>ready<\/main>/u);
  assert.equal((await endpoint.fetch(hosted("/", { method: "POST" }))).status, 404);
  assert.equal((await endpoint.fetch(hosted("/healthz"))).status, 200);
});

test("the OpenAI domain challenge answers the configured token as plain text, before the gate", async (context) => {
  const withToken = hostedEndpoint({ openaiAppsChallenge: "oai-token-123" });
  const without = hostedEndpoint();
  context.after(() => Promise.all([withToken.handler.close(), without.handler.close()]));

  const response = await withToken.fetch(hosted("/.well-known/openai-apps-challenge"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), "oai-token-123");
  assert.equal((await withToken.fetch(hosted("/.well-known/openai-apps-challenge", { method: "POST" }))).status, 404);
  assert.equal((await without.fetch(hosted("/.well-known/openai-apps-challenge"))).status, 404);
  assert.equal(openaiAppsChallenge({ OPENAI_APPS_CHALLENGE: "  " }), undefined);
  assert.equal(openaiAppsChallenge({ OPENAI_APPS_CHALLENGE: " tok " }), "tok");
});

test("MCP Events are off without a store and refuse to run unauthenticated", async () => {
  assert.equal(await hostedEvents(undefined, {}), undefined);
  await assert.rejects(hostedEvents(undefined, { MCP_EVENTS_STORE: "/tmp/x.json" }), /requires hosted authorization/u);
});

test("sanitized errors expose only a safe error class", () => {
  assert.equal(sanitizedErrorType(new Error("api_key=secret")), "Error");
  const unusual = new Error("secret");
  unusual.name = "Bad Name: secret";
  assert.equal(sanitizedErrorType(unusual), "Error");
  assert.equal(sanitizedErrorType("bearer secret"), "UnknownError");
});

test("standalone HTTP configuration keeps the loopback default", () => {
  const config = readStreamableHTTPConfig({});

  assert.equal(config.port, 3001);
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.allowedHosts, undefined);
  assert.equal(config.allowedOrigins, undefined);
});

test("hosted HTTP configuration composes public and additional allowlists", () => {
  const config = readStreamableHTTPConfig({
    PORT: "8080",
    MCP_BIND_HOST: "0.0.0.0",
    MCP_PUBLIC_URL: "https://mcp.qyl.at",
    MCP_ALLOWED_HOSTS: "railway.example, healthcheck.railway.app",
    MCP_ALLOWED_ORIGIN_HOSTS: "railway.example",
  });

  assert.equal(config.port, 8080);
  assert.equal(config.bindHost, "0.0.0.0");
  assert.equal(config.publicUrl?.origin, "https://mcp.qyl.at");
  assert.deepEqual(config.allowedHosts, [
    "mcp.qyl.at",
    "railway.example",
    "healthcheck.railway.app",
  ]);
  assert.deepEqual(config.allowedOrigins, ["mcp.qyl.at", "railway.example"]);
});

test("durable execution evidence is written by a local server and not a hosted one", () => {
  assert.equal(recordsNativeExecutionEvidence(readStreamableHTTPConfig({})), true);
  assert.equal(
    recordsNativeExecutionEvidence(
      readStreamableHTTPConfig({
        MCP_BIND_HOST: "0.0.0.0",
        MCP_PUBLIC_URL: "https://mcp.qyl.at",
      }),
    ),
    false,
    "a public deployment must not persist every caller's tools/call into one " +
      "container-local file under $HOME",
  );
});

test("a non-loopback bind fails closed without a public URL", () => {
  assert.throws(
    () => readStreamableHTTPConfig({ MCP_BIND_HOST: "0.0.0.0" }),
    /MCP_PUBLIC_URL must be set/u,
  );
});

test("the hosted resource identity is an HTTPS origin", () => {
  assert.throws(
    () => readStreamableHTTPConfig({ MCP_PUBLIC_URL: "http://mcp.qyl.at" }),
    /must use HTTPS/u,
  );
  assert.throws(
    () => readStreamableHTTPConfig({ MCP_PUBLIC_URL: "https://mcp.qyl.at/base" }),
    /without a path/u,
  );
});

test("the discovery chain is closed for a client that arrives with nothing", async (context) => {
  const endpoint = hostedEndpoint();
  context.after(() => endpoint.handler.close());

  const unauthorized = await endpoint.fetch(hosted("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  assert.equal(unauthorized.status, 401);
  const challenge = unauthorized.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer/u);
  assert.match(challenge, /scope="qyl:read"/u);
  assert.match(
    challenge,
    /resource_metadata="https:\/\/mcp\.qyl\.at\/\.well-known\/oauth-protected-resource\/mcp"/u,
  );

  // The document the challenge points at answers before the gate, or the
  // discovery path is a circle.
  const metadata = await endpoint.fetch(hosted("/.well-known/oauth-protected-resource/mcp"));
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await metadata.json(), {
    resource: resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: [QYL_MCP_SCOPE],
  });

  const originMetadata = await endpoint.fetch(hosted("/.well-known/oauth-protected-resource"));
  assert.equal(originMetadata.status, 200);
  assert.equal(originMetadata.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await originMetadata.json(), {
    resource: resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: [QYL_MCP_SCOPE],
  });

  // Clients that probe the origin directly get the AS mirror rather than a 404.
  const mirror = await endpoint.fetch(hosted("/.well-known/oauth-authorization-server"));
  assert.equal(mirror.status, 200);
  assert.equal((await mirror.json() as OAuthMetadata).issuer, oauthMetadata.issuer);
  assert.equal(
    ((await (await endpoint.fetch(hosted("/.well-known/oauth-authorization-server")))
      .json()) as OAuthMetadata).registration_endpoint,
    oauthMetadata.registration_endpoint,
  );

  const rejected = await endpoint.fetch(hosted("/.well-known/oauth-protected-resource/mcp", {
    method: "POST",
  }));
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD, OPTIONS");
  const rootRejected = await endpoint.fetch(hosted("/.well-known/oauth-protected-resource", {
    method: "POST",
  }));
  assert.equal(rootRejected.status, 405);
  assert.equal(rootRejected.headers.get("allow"), "GET, HEAD, OPTIONS");
});

test("a browser client can read the challenge and pass its preflight", async (context) => {
  const endpoint = hostedEndpoint();
  context.after(() => endpoint.handler.close());
  const browserOrigin = `https://${resourceServerUrl.hostname}`;

  const preflight = await endpoint.fetch(hosted("/mcp", {
    method: "OPTIONS",
    headers: {
      origin: browserOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), browserOrigin);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "authorization,content-type");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/u);

  const challenge = await endpoint.fetch(hosted("/mcp", {
    method: "POST",
    headers: {
      origin: browserOrigin,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers.get("access-control-allow-origin"), browserOrigin);
  assert.match(
    challenge.headers.get("access-control-expose-headers") ?? "",
    /WWW-Authenticate/u,
  );
});

for (const era of ["modern", "legacy"] as const) {
  test(`${era} clients share authenticated tools through the whole pipeline`, async (context) => {
    const endpoint = hostedEndpoint();
    const client = new Client(
      { name: `${era}-pipeline-client`, version: "1.0.0" },
      era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
    );
    context.after(async () => {
      await client.close().catch(() => undefined);
      await endpoint.handler.close();
    });

    await client.connect(new StreamableHTTPClientTransport(resourceServerUrl, {
      fetch: transportFetch(endpoint),
      requestInit: { headers: { authorization: "Bearer good" } },
    }));

    assert.equal(client.getProtocolEra(), era);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["auth_context"]);
    const result = await client.callTool({ name: "auth_context", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: "https://client.example/client.json" }]);
    await assert.rejects(client.callTool({ name: "unknown_tool", arguments: {} }));
  });

  test(`${era} requests cannot bypass authorization`, async (context) => {
    const endpoint = hostedEndpoint();
    context.after(() => endpoint.handler.close());
    for (const token of [undefined, "bad", "missing-scope"]) {
      const response = await endpoint.fetch(hosted("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/list",
          params: era === "modern" ? { _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          } } : {},
        }),
      }));
      assert.equal(response.status, token === "missing-scope" ? 403 : 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /qyl:read/u);
    }
  });
}

function testVerifier(): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token !== "good" && token !== "missing-scope") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token verification failed");
      }
      return {
        token,
        clientId: "https://client.example/client.json",
        scopes: token === "missing-scope" ? [] : [QYL_MCP_SCOPE],
        expiresAt: Math.floor(Date.now() / 1_000) + 300,
        resource: resourceServerUrl,
      };
    },
  };
}
