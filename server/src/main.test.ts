import assert from "node:assert/strict";
import test from "node:test";
import {
  closeMcpRequestResources,
  readStreamableHTTPConfig,
  sanitizedErrorType,
} from "./main.js";

test("server-owned cleanup closes the transport only as a failure fallback", async () => {
  let transportCloses = 0;
  const success = await closeMcpRequestResources(
    { close: async () => undefined },
    { close: async () => { transportCloses += 1; } },
  );
  assert.deepEqual(success, []);
  assert.equal(transportCloses, 0);

  const failures = await closeMcpRequestResources(
    { close: async () => { throw new TypeError("authorization=do-not-log"); } },
    { close: async () => { transportCloses += 1; throw new RangeError("token=do-not-log"); } },
  );
  assert.deepEqual(failures, [
    { resource: "server", errorType: "TypeError" },
    { resource: "transport", errorType: "RangeError" },
  ]);
  assert.equal(transportCloses, 1);
  assert.doesNotMatch(JSON.stringify(failures), /authorization|token|do-not-log/);
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
  assert.equal(config.hosted, false);
  assert.equal(config.authToken, undefined);
  assert.deepEqual(config.allowedOrigins, [
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://[::1]:3001",
  ]);
});

test("hosted HTTP configuration composes public and additional allowlists", () => {
  const config = readStreamableHTTPConfig({
    PORT: "8080",
    MCP_BIND_HOST: "0.0.0.0",
    MCP_PUBLIC_URL: "https://mcp.qyl.at",
    MCP_ALLOWED_HOSTS: "railway.example, healthcheck.railway.app",
    MCP_ALLOWED_ORIGINS: "https://railway.example",
    MCP_AUTH_TOKEN: "hosted-static-token",
  });

  assert.equal(config.port, 8080);
  assert.equal(config.bindHost, "0.0.0.0");
  assert.equal(config.publicUrl?.origin, "https://mcp.qyl.at");
  assert.deepEqual(config.allowedHosts, [
    "mcp.qyl.at",
    "railway.example",
    "healthcheck.railway.app",
  ]);
  assert.deepEqual(config.allowedOrigins, [
    "https://mcp.qyl.at",
    "https://railway.example",
  ]);
  assert.equal(config.authToken, "hosted-static-token");
  assert.equal(config.hosted, true);
});

test("hosted HTTP configuration fails closed without an incoming auth token", () => {
  assert.throws(
    () => readStreamableHTTPConfig({ MCP_BIND_HOST: "0.0.0.0" }),
    /MCP_AUTH_TOKEN must be configured/u,
  );
});
