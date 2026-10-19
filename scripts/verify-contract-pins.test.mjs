import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const conventionsPackage = "@ancplua/qyl-semantic-conventions";

function verify({ runtime = "13.0.0", development, server = "13.0.0", contract = "14.0.0", lockedVersion = "10.0.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qyl-pin-contract-"));
  try {
    copyFileSync(new URL("../verify-contract-pins.mjs", import.meta.url), join(root, "verify-contract-pins.mjs"));
    for (const workspace of ["server", "workbench", "dashboard", "qyl"]) mkdirSync(join(root, workspace));
    for (const workspace of ["server", "workbench", "dashboard"]) {
      const metadata = { version: "10.0.0", dependencies: { "@ancplua/qyl-api-schema": "14.0.0" } };
      if (workspace !== "server") metadata.dependencies["qyl-mcp-server"] = "10.0.0";
      if (workspace === "server" && server !== null) metadata.dependencies[conventionsPackage] = server;
      if (workspace === "workbench" && runtime !== null) metadata.dependencies[conventionsPackage] = runtime;
      if (workspace === "workbench" && development !== undefined) metadata.devDependencies = { [conventionsPackage]: development };
      writeFileSync(join(root, workspace, "package.json"), JSON.stringify(metadata));
    }
    writeFileSync(join(root, "qyl", "Version.props"),
      `<Project><PropertyGroup><QylApiContractsVersion>${contract}</QylApiContractsVersion></PropertyGroup></Project>`);
    writeFileSync(join(root, "bun.lock"), JSON.stringify({ workspaces: {
      server: { version: "10.0.0" },
      workbench: { dependencies: { "qyl-mcp-server": "10.0.0" } },
      dashboard: { dependencies: { "qyl-mcp-server": lockedVersion } },
    } }));
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

test("one matching runtime dependency passes without duplicating it for tests", () => {
  const result = verify();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("a matching development pin cannot hide a stale runtime dependency", () => {
  const result = verify({ runtime: "12.0.0", development: "13.0.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Workbench runtime and server must use the same/u);
});

test("an optional development pin cannot disagree with the runtime", () => {
  const result = verify({ development: "12.0.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /optional development pin must also agree/u);
});

test("missing conventions on both sides cannot count as agreement", () => {
  const result = verify({ runtime: null, server: null });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Workbench runtime and server must use the same/u);
});

test("matching conventions do not bypass the Collector API contract check", () => {
  const result = verify({ contract: "13.0.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cross-repo contract skew/u);
});

test("matching manifests cannot hide a stale workspace server pin in the lockfile", () => {
  const result = verify({ lockedVersion: "9.0.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /dashboard bun\.lock must pin qyl-mcp-server/u);
});
