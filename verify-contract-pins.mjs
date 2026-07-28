/**
 * Verifier for the cross-repo contract pin.
 *
 * This repo and ANcpLua/qyl ride the same generated contract by lockstep bumps,
 * not by a pinned ref, so a skew between them breaks smoke:otlp at the spawned
 * server's startup handshake — on a push that changed nothing here.
 *
 * The check itself is older than this file; it lived as inline bash in
 * .github/workflows/ci.yml, which made it unrunnable before pushing. The
 * documented local gate (npm ci/build/test/smoke/smoke:otlp) was therefore a
 * strict subset of the real one, and the only way to learn you had skewed the
 * pin was to lose a CI run to it. Extracting it is what makes the two gates the
 * same gate: CI now invokes this script instead of carrying a second copy.
 *
 * The qyl checkout is found at $QYL_REPO, ./qyl (CI's checkout path), or ../qyl
 * (the qyl-workspace layout). Absent all three this fails rather than skips: a
 * pin check that silently passes when it cannot find the other side is worse
 * than no check, because it reports green for the one condition it exists to
 * catch.
 *
 * Run: npm run verify:pins
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  process.env.QYL_REPO,
  join(here, "qyl"),
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

const mcpPin = JSON.parse(readFileSync(join(here, "server", "package.json"), "utf8"))
  .dependencies?.["@ancplua/qyl-api-schema"];

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
      `ANcpLua/qyl pins Qyl.Api.Contracts ${qylPin} — smoke:otlp would fail its startup handshake. ` +
      "Land the lockstep bump on the lagging side first.",
  );
}

console.log(`verify:pins: contract pins agree (@ancplua/qyl-api-schema ${mcpPin} == Qyl.Api.Contracts ${qylPin}, via ${qylRepo})`);
