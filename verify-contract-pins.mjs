/**
 * Keep this repository's API package pin aligned with ANcpLua/qyl.
 * The runtime startup handshake compares contract revisions. Patch releases can
 * share a revision, so a version mismatch alone does not prove wire incompatibility.
 *
 * `mise run check` runs it first.
 *
 * The qyl checkout is found at $QYL_REPO or ../qyl (the qyl-workspace
 * layout). Absent both this fails rather than skips: a
 * pin check that silently passes when it cannot find the other side is worse
 * than no check, because it reports green for the one condition it exists to
 * catch.
 *
 * Run: bun run verify:pins
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  process.env.QYL_REPO,
  resolve(here, "..", "qyl"),
].filter(Boolean);

const qylRepo = candidates.find((candidate) => existsSync(join(candidate, "Version.props")));

if (!qylRepo) {
  throw new Error(
    "verify:pins could not find an ANcpLua/qyl checkout containing Version.props.\n" +
      `  Looked in: ${candidates.join(", ")}\n` +
      "  Set QYL_REPO to the checkout, or clone it beside this repo as ../qyl.",
  );
}

const server = JSON.parse(readFileSync(join(here, "server", "package.json"), "utf8"));
const mcpPin = server.dependencies?.["@ancplua/qyl-api-schema"];

if (!mcpPin) {
  throw new Error("verify:pins: server/package.json declares no @ancplua/qyl-api-schema dependency.");
}

const versionProps = readFileSync(join(qylRepo, "Version.props"), "utf8");
const match = versionProps.match(/<QylApiContractsVersion[^>]*>([^<]*)<\/QylApiContractsVersion>/u);

if (!match) {
  throw new Error(`verify:pins: no <QylApiContractsVersion> in ${join(qylRepo, "Version.props")}.`);
}

const qylPin = match[1].trim();
// npm ranges ("^3.1.0") never equal a bare MSBuild version ("3.1.0"), so compare
// the versions rather than the spellings — otherwise this fails on every caret
// pin and gets disabled for being wrong.
const mcpVersion = mcpPin.replace(/^[\^~>=<\s]+/u, "").trim();

if (mcpVersion !== qylPin) {
  throw new Error(
    `cross-repo contract skew: this repo pins @ancplua/qyl-api-schema ${mcpPin}, ` +
      `ANcpLua/qyl pins Qyl.Api.Contracts ${qylPin}. Align the package pins. ` +
      "When the contract revision changes, update this deployment only after the Collector serves it; patch releases may retain the same revision.",
  );
}

console.log(`verify:pins: contract pins agree (@ancplua/qyl-api-schema ${mcpPin} == Qyl.Api.Contracts ${qylPin}, via ${qylRepo})`);

const lock = JSON.parse(execFileSync("bun", ["-e",
  'process.stdout.write(JSON.stringify({ workspaces: Bun.JSONC.parse(await Bun.file("bun.lock").text()).workspaces }))',
], { cwd: here, encoding: "utf8" }));
if (lock.workspaces?.server?.version !== server.version) {
  throw new Error(`server bun.lock must name qyl-mcp-server ${server.version}; run bun install again`);
}
