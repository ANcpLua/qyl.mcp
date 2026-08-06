import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

test("serves the qyl.mcp product page at the site root", async () => {
  const response = await worker.fetch(new Request("https://qyl.example/"));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/u);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const html = await response.text();
  assert.match(html, /<title>qyl · MCP telemetry for coding agents<\/title>/u);
  assert.match(html, /mcp\.qyl\.at\/mcp/u);
});

test("supports HEAD without returning the page body", async () => {
  const response = await worker.fetch(new Request("https://qyl.example/", {
    method: "HEAD",
  }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

test("rejects unsupported routes and methods", async () => {
  const missing = await worker.fetch(new Request("https://qyl.example/workbench"));
  const mutation = await worker.fetch(new Request("https://qyl.example/", {
    method: "POST",
  }));

  assert.equal(missing.status, 404);
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET, HEAD");
});

test("packages the Sites project identity with the worker", async () => {
  const source = JSON.parse(await readFile(
    new URL("../.openai/hosting.json", import.meta.url),
    "utf8",
  ));
  const packaged = JSON.parse(await readFile(
    new URL("../dist/.openai/hosting.json", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(packaged, source);
});
