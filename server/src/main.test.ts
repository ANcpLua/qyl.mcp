import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { createMcpApp } from "./http-security.js";
import {
  closeHttpListener,
  mountLandingPage,
  mountProtectedResourceMetadata,
  readStreamableHTTPConfig,
  sanitizedErrorType,
} from "./main.js";

test("the public root serves the qyl MCP landing page", async (context) => {
  const app = createMcpApp({ bindHost: "127.0.0.1" });
  mountLandingPage(app, "<!doctype html><title>qyl MCP</title><main>ready</main>");
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  context.after(() => closeHttpListener(listener));
  const address = listener.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.match(await response.text(), /<main>ready<\/main>/u);
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST" })).status,
    404,
  );
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

test("hosted OAuth serves only path-aware protected-resource metadata", async (context) => {
  const app = createMcpApp({ bindHost: "127.0.0.1" });
  const resourceServerUrl = new URL("https://mcp.qyl.at/mcp");
  const oauthMetadata: OAuthMetadata = {
    issuer: "https://qyl.eu.auth0.com/",
    authorization_endpoint: "https://qyl.eu.auth0.com/authorize",
    token_endpoint: "https://qyl.eu.auth0.com/oauth/token",
    jwks_uri: "https://qyl.eu.auth0.com/.well-known/jwks.json",
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
  const metadataUrl = mountProtectedResourceMetadata(app, {
    oauthMetadata,
    resourceServerUrl,
    scopesSupported: ["qyl:read"],
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  context.after(() => closeHttpListener(listener));
  const address = listener.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  assert.equal(
    metadataUrl,
    "https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp",
  );
  const response = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), {
    resource: resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: ["qyl:read"],
  });
  assert.equal(
    (await fetch(`${origin}/.well-known/oauth-authorization-server`)).status,
    404,
  );
  const rejected = await fetch(
    `${origin}/.well-known/oauth-protected-resource/mcp`,
    { method: "POST" },
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD, OPTIONS");
});
