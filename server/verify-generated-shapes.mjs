/**
 * Verifier for architecture gate G10a: zero hand-declared request, response, or
 * tool-input shapes in the closed-world MCP server.
 *
 * Every tool shape must come from the generated contract artifacts through
 * contract-validation.ts. The check is textual on purpose — it is the same
 * check a reviewer would run, it cannot be satisfied by a type that merely
 * looks right, and it fails on the construct that starts a shadow contract
 * (`z.object(`) rather than on its consequences.
 *
 * The workbench is deliberately out of scope: it is the open-world client and
 * validates servers it did not write, at runtime, by design.
 *
 * Run: npm run verify:shapes  (also runs as the first step of npm test)
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceRoot = new URL("src/", import.meta.url);

// Each exemption states why the file may declare a shape, and is itself
// verified: an entry whose file no longer declares one is a stale exemption and
// fails, so the list shrinks when the reason disappears.
const shapeExemptions = {
  "native-execution.ts":
    "durable local execution evidence — persisted process state that never crosses an " +
    "MCP, HTTP, SSE, or generated-client boundary",
};

// Registering a tool without importing the generated validators means the tool's
// shapes came from somewhere else.
const registrationExemptions = {};

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) found.push(...await sourceFiles(child));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push([entry.name, child]);
    }
  }
  return found;
}

const violations = [];
const staleExemptions = new Set([
  ...Object.keys(shapeExemptions),
  ...Object.keys(registrationExemptions),
]);

for (const [name, url] of await sourceFiles(sourceRoot)) {
  const source = await readFile(url, "utf8");
  const declaresShape = source.includes("z.object(");
  const registersTool = source.includes("registerTool(");
  const importsGeneratedShapes = source.includes('from "./contract-validation.js"');

  if (declaresShape && !(name in shapeExemptions)) {
    violations.push(
      `${name}: declares a shape with z.object( — tool and API shapes come from the ` +
        "generated contract through contract-validation.ts",
    );
  }
  if (registersTool && !importsGeneratedShapes && !(name in registrationExemptions)) {
    violations.push(
      `${name}: registers a tool without importing generated schemas from ./contract-validation.js`,
    );
  }

  if (declaresShape && name in shapeExemptions) staleExemptions.delete(name);
  if (registersTool && !importsGeneratedShapes && name in registrationExemptions) {
    staleExemptions.delete(name);
  }
}

for (const name of staleExemptions) {
  violations.push(`${name}: exempted but no longer needs the exemption — delete the entry`);
}

if (violations.length > 0) {
  console.error(`G10a: ${violations.length} hand-declared shape violation(s) in ${fileURLToPath(sourceRoot)}`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `G10a: no hand-declared API shapes in server/src (${Object.keys(shapeExemptions).length} documented exemption(s))`,
);
for (const [name, reason] of Object.entries(shapeExemptions)) {
  console.log(`  - ${name}: ${reason}`);
}
