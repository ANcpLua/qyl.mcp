import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionSafetyReview,
  normalizeRemoteEndpoint,
} from "./connection-safety.js";

test("remote MCP endpoints are limited to credential-free HTTP URLs", () => {
  assert.equal(normalizeRemoteEndpoint(" https://mcp.example.test/api#fragment "), "https://mcp.example.test/api");
  assert.equal(normalizeRemoteEndpoint("http://127.0.0.1:3000/mcp"), "http://127.0.0.1:3000/mcp");
  assert.throws(() => normalizeRemoteEndpoint("file:///tmp/server"), /HTTP or HTTPS/u);
  assert.throws(() => normalizeRemoteEndpoint("https://token@mcp.example.test/mcp"), /environment-backed/u);
  assert.throws(() => normalizeRemoteEndpoint("not a URL"), /absolute HTTP or HTTPS/u);
});

test("local executable connection modes require an exact safety review", () => {
  const stdio = connectionSafetyReview({
    transport: "stdio",
    command: "node",
    arguments: ["server.mjs", "--write"],
    workingDirectory: "/workspace",
    environment: [{ name: "TOKEN", secret: { source: "environment", environmentVariable: "MCP_TOKEN" } }],
  });
  assert.match(stdio?.body ?? "", /node server\.mjs --write/u);
  assert.match(stdio?.body ?? "", /\/workspace/u);
  assert.doesNotMatch(stdio?.body ?? "", /MCP_TOKEN/u);

  assert.match(connectionSafetyReview({ transport: "inproc", implementation: "fixture" })?.body ?? "", /fixture/u);
  assert.equal(connectionSafetyReview({ transport: "builtin", name: "qyl" }), null);
  assert.equal(connectionSafetyReview({ transport: "sse", endpoint: "https://example.test/sse" }), null);
});
