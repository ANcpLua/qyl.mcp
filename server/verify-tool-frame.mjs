/**
 * Verifier for the tool frame.
 *
 * Every tool this server registers runs inside `runTool` (src/request-scope.ts):
 * that frame is what carries the request's cancellation signal into the
 * collector fetch, sends progress to a client that asked, and logs one line per
 * call. A tool registered around the frame silently has none of the three, and
 * nothing at compile time notices — `registerTool` accepts any handler.
 *
 * Two checks, both mechanical, over the non-test sources under src/:
 *
 *   1. Every `server.registerTool("<name>", …)` site names `runTool(ctx, "<name>"`
 *      in the same registration, with the same name, so the log line and the
 *      manifest agree on what the tool is called.
 *   2. Every tool in the generated manifest has such a site. A tool that is
 *      registered somewhere the scan does not see is a scan defect, and this
 *      is what makes it fail loudly instead of passing by omission.
 *
 * Run: npm run verify:frame  (also runs as a step of npm test)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const srcDir = path.join(here, "src");
const manifest = JSON.parse(await readFile(path.join(here, "tool-manifest.snapshot.json"), "utf8"));

const files = (await readdir(srcDir))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes(".test-helper."))
  .sort();

const failures = [];
const framed = new Map(); // tool name -> file

for (const name of files) {
  const source = await readFile(path.join(srcDir, name), "utf8");
  // One registration spans from `registerTool(` to the next registration or
  // the end of the file; the frame call must sit inside that span.
  const sites = [...source.matchAll(/\.registerTool\(\s*"([^"]+)"/gu)];
  for (const [index, site] of sites.entries()) {
    const tool = site[1];
    const start = site.index;
    const end = index + 1 < sites.length ? sites[index + 1].index : source.length;
    const span = source.slice(start, end);
    const frame = span.match(/runTool\(\s*ctx,\s*"([^"]+)"/u);
    if (!frame) {
      failures.push(`${name}: tool "${tool}" is registered without runTool(ctx, "${tool}", …)`);
      continue;
    }
    if (frame[1] !== tool) {
      failures.push(`${name}: tool "${tool}" runs its frame under the name "${frame[1]}"`);
      continue;
    }
    framed.set(tool, name);
  }
}

const unframed = (manifest.tools ?? []).map((tool) => tool.name).filter((tool) => !framed.has(tool));
if (unframed.length > 0) {
  failures.push(
    `${unframed.length} tool(s) in the manifest have no framed registration under src/:\n` +
      unframed.map((tool) => `    ${tool}`).join("\n"),
  );
}

if (failures.length > 0) {
  throw new Error(
    `verify:frame failed (${failures.length} problem(s)):\n\n` +
      failures.map((failure) => `  ${failure}`).join("\n\n") +
      "\n\n  Every tool runs inside runTool (src/request-scope.ts): cancellation, " +
      "progress and the log line come from the frame, not from the handler.",
  );
}

console.log(`verify:frame ok — ${framed.size} tool(s) framed: ${[...framed.keys()].sort().join(", ")}`);
