/** Verify the released CLI from a fresh consumer directory in both MCP eras. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { CONTRACT_REVISION } from "@ancplua/qyl-api-schema/types";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [version, localFlag, localEntry] = process.argv.slice(2);
assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.ok(
  (localFlag === undefined && localEntry === undefined) ||
    (localFlag === "--local" && localEntry !== undefined),
  "Usage: node published-smoke.mjs VERSION [--local MAIN_JS]",
);
const entry = localEntry === undefined ? undefined : resolve(localEntry);

const collector = createServer((request, response) => {
  request.resume();
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ status: "healthy", contract_revision: CONTRACT_REVISION }));
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/v1/analysis/list_metrics");
  const end = new Date().toISOString();
  response.end(JSON.stringify({ items: [], has_more: false,
    window: { start_time: new Date(Date.now() - 60_000).toISOString(), end_time: end },
    coverage: { examined: 0, matched: 0, returned: 0, truncated: false, scan_complete: true, as_of: end },
  }));
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
try {
for (const era of ["modern", "legacy"]) {
  const cwd = await mkdtemp(join(tmpdir(), `qyl-npm-${era}-`));
  const client = new Client(
    { name: "qyl-published-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  const transport = new StdioClientTransport({
    command: entry === undefined ? "bunx" : "bun",
    args: entry === undefined
      ? [`qyl-mcp-server@${version}`, "--stdio"]
      : [entry, "--stdio"],
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
        value !== undefined && !["QYL_API_KEY", "QYL_PROJECT", "MCP_COLLECTOR_PROJECTS"].includes(key))),
      QYL_COLLECTOR_URL: `http://127.0.0.1:${collector.address().port}`,
      QYL_MCP_TELEMETRY: "0",
      QYL_MCP_NATIVE_STATE_PATH: join(cwd, "native.json"),
    },
  });
  try {
    await client.connect(transport, { timeout: 120_000 });
    assert.equal(client.getProtocolEra(), era);
    assert.equal(client.getServerVersion()?.name, "qyl.mcp");
    assert.equal(client.getServerVersion()?.version, version);
    const revision = client.getNegotiatedProtocolVersion();
    if (era === "modern") assert.equal(revision, "2026-07-28");
    else assert.match(revision ?? "", /^2025-/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 32);
    assert.ok(tools.some(({ name }) => name === "list_metrics"));
    const result = await client.callTool({ name: "list_metrics", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.items?.length, 0);
    console.log(`${era}: qyl.mcp ${version}, ${revision}, 32-tool catalog and live collector read passed`);
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

} finally {
  collector.closeAllConnections();
  await new Promise(resolve => collector.close(resolve));
}
