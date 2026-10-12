// Exercises the shipped executable: a quiet tool response must survive the SDK's
// first 15-second keep-alive, rather than Bun's default 10-second idle timeout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CONTRACT_REVISION } from "@ancplua/qyl-api-schema/types";

const temp = await mkdtemp(join(tmpdir(), "qyl-quiet-stream-"));
let calls = 0;
const collector = createServer((request, response) => {
  void (async () => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "healthy", contract_revision: CONTRACT_REVISION }));
      return;
    }
    calls++;
    for await (const chunk of request) { void chunk; }
    await delay(18_000);
    const end = new Date().toISOString();
    response.end(JSON.stringify({ items: [], has_more: false,
      window: { start_time: new Date(Date.now() - 60_000).toISOString(), end_time: end },
      coverage: { examined: 0, matched: 0, returned: 0, truncated: false, scan_complete: true, as_of: end },
    }));
  })().catch(error => response.destroy(error));
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, PORT: String(port), MCP_BIND_HOST: "127.0.0.1",
  QYL_COLLECTOR_URL: `http://127.0.0.1:${collector.address().port}`, QYL_MCP_TELEMETRY: "0",
  QYL_MCP_NATIVE_STATE_PATH: join(temp, "native.json") };
for (const key of ["MCP_PUBLIC_URL", "MCP_COLLECTOR_PROJECTS", "MCP_EVENTS_STORE"]) delete env[key];
const child = spawn("bun", ["dist/main.js"], { cwd: new URL(".", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", data => { stderr += data; });
const client = new Client({ name: "qyl-quiet-stream-proof", version: "1.0.0" });
try {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`Bun entry exited: ${stderr}`);
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok).catch(() => false)) break;
    await delay(100);
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const start = performance.now();
  const result = await client.callTool({ name: "list_metrics", arguments: {} });
  const elapsed = performance.now() - start;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(calls, 1, "a disconnected request must not be hidden by a retry");
  assert.ok(elapsed >= 18_000, `quiet stream ended after ${elapsed}ms`);
  assert.deepEqual(result.structuredContent.items, []);
  for (const file of await readdir(new URL("dist/", import.meta.url))) {
    if (!file.endsWith(".d.ts")) continue;
    assert.doesNotMatch(await readFile(new URL(`dist/${file}`, import.meta.url), "utf8"), /\bBun\b|(?:from|import\()\s*["']bun(?:["']|:)/u, `${file} leaks Bun types`);
  }
  console.log(`Quiet SSE stayed open ${Math.round(elapsed)}ms on bun dist/main.js; one request; library declarations are Node-clean.`);
} finally {
  await client.close().catch(() => {});
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([exited, delay(3000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); })]);
  collector.closeAllConnections();
  await new Promise(resolve => collector.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
