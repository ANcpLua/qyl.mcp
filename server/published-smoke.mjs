/** Verify the released CLI from a fresh consumer directory in both MCP eras. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

for (const era of ["modern", "legacy"]) {
  const cwd = await mkdtemp(join(tmpdir(), `qyl-npm-${era}-`));
  const client = new Client(
    { name: "qyl-published-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  const transport = new StdioClientTransport({
    command: entry === undefined ? "npx" : process.execPath,
    args: entry === undefined
      ? ["--yes", `qyl-mcp-server@${version}`, "--stdio"]
      : [entry, "--stdio"],
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      QYL_DEMO: "1",
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
    assert.ok(tools.some(({ name }) => name === "list_metrics"));
    const result = await client.callTool({ name: "list_metrics", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.items?.length, 3);
    console.log(`${era}: qyl.mcp ${version}, ${revision}, catalog and demo metrics passed`);
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
