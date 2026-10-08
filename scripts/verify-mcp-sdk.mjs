import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkPackages = new Set(["core", "server", "client", "node", "express", "hono"]
  .map((name) => `@modelcontextprotocol/${name}`));
const exactV2 = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function checkPackage(name, version, location, failures) {
  if (name === "@modelcontextprotocol/sdk") {
    failures.push(`${location}: SDK v1 package ${name} is forbidden; use the split v2 SDK.`);
  } else if (sdkPackages.has(name) && !exactV2.test(version)) {
    failures.push(`${location}: ${name} must use an exact v2 version, found ${JSON.stringify(version)}.`);
  }
}

export function checkManifest(manifest, location = "package.json") {
  const failures = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      checkPackage(name, spec, `${location} ${section}`, failures);
      const alias = typeof spec === "string" && spec.match(/^npm:(@modelcontextprotocol\/[^@/]+)@(.+)$/u);
      if (alias) checkPackage(alias[1], alias[2], `${location} alias ${name}`, failures);
    }
  }
  return failures;
}

export function checkLock(lock, location = "bun.lock") {
  if (!lock.packages || !lock.workspaces) throw new Error(`${location}: unsupported Bun lockfile shape`);
  const failures = Object.entries(lock.workspaces)
    .flatMap(([name, manifest]) => checkManifest(manifest, `${location} workspace ${name || "."}`));
  for (const [name, resolution] of Object.entries(lock.packages)) {
    const resolvedPackage = Array.isArray(resolution) && typeof resolution[0] === "string"
      && resolution[0].match(/^(@modelcontextprotocol\/[^@/]+)@(.+)$/u);
    if (resolvedPackage) checkPackage(resolvedPackage[1], resolvedPackage[2], `${location} ${name}`, failures);
  }
  return failures;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [...new Set(execFileSync("git", [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "package.json", "**/package.json", "bun.lock", "**/bun.lock",
  ], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))];
  const failures = files.flatMap((file) => {
    const source = readFileSync(resolve(root, file), "utf8");
    return file.endsWith("bun.lock")
      ? checkLock(Bun.JSONC.parse(source), file)
      : checkManifest(JSON.parse(source), file);
  });
  if (failures.length) throw new Error(`MCP SDK boundary failed:\n${failures.join("\n")}`);
  console.log(`MCP SDK boundary passed for ${files.length} manifests/lockfiles (SDK v2; exact pins).`);
}
