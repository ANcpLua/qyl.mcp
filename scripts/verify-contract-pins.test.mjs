import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function verify({ contract = "14.0.0", lockedVersion = "10.0.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qyl-pin-contract-"));
  try {
    copyFileSync(new URL("../verify-contract-pins.mjs", import.meta.url), join(root, "verify-contract-pins.mjs"));
    for (const directory of ["server", "qyl"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "server", "package.json"), JSON.stringify({
      version: "10.0.0",
      dependencies: { "@ancplua/qyl-api-schema": "14.0.0" },
    }));
    writeFileSync(join(root, "qyl", "Version.props"),
      `<Project><PropertyGroup><QylApiContractsVersion>${contract}</QylApiContractsVersion></PropertyGroup></Project>`);
    writeFileSync(join(root, "bun.lock"), JSON.stringify({ workspaces: { server: { version: lockedVersion } } }));
    return spawnSync(process.execPath, [join(root, "verify-contract-pins.mjs")], {
      cwd: root,
      env: { ...process.env, QYL_REPO: join(root, "qyl") },
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a matching contract pin and lockfile pass", () => {
  const result = verify();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("a contract pin the Collector does not use is skew", () => {
  const result = verify({ contract: "13.0.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cross-repo contract skew/u);
});

test("a stale server version in the lockfile fails even when the manifest moved on", () => {
  const result = verify({ lockedVersion: "9.0.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /server bun\.lock must name qyl-mcp-server 10\.0\.0/u);
});
