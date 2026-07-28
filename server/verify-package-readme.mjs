/**
 * Verifier for the published package README.
 *
 * npmjs.com renders server/README.md out of the tarball, so it is the surface
 * description most consumers ever read, and nothing about shipping a tool forces
 * it to move. It drifted for five days and an entire feature: it documented 8 of
 * 13 tools, omitting every workflow tool, and asserted that "all" of them carry
 * read-only safety annotations — after control_workflow_run landed. Read-only
 * annotations are precisely what an MCP client consults to decide a call is safe
 * to run without asking, so an over-broad claim on the public page is a safety
 * defect and not a documentation nit.
 *
 * Two checks, both mechanical:
 *
 *   1. Every tool in the generated manifest is named in the README. This is what
 *      would have caught the drift at the commit that introduced it — an author
 *      adding a tool has to confront the page rather than forget it.
 *   2. No sentence may claim ALL tools are read-only while a mutating tool
 *      exists, unless it carves out the exception. "All are read-only except
 *      control_workflow_run" passes; "all published with read-only safety
 *      annotations" does not.
 *
 * Scope is deliberately the published README only. The root README states that
 * the manifest is authoritative and defers to it, which is a legitimate choice
 * for a page nobody installs from; gating it too would punish that.
 *
 * Run: npm run verify:readme  (also runs as a step of npm test)
 */
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("tool-manifest.snapshot.json", import.meta.url);
const readmeUrl = new URL("README.md", import.meta.url);

const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const readme = await readFile(readmeUrl, "utf8");

const tools = manifest.tools ?? [];
if (tools.length === 0) {
  throw new Error(
    "verify:readme: the tool manifest declares no tools. An empty manifest is a " +
      "generation failure, not a surface with nothing to document.",
  );
}

// A tool is mutating when it does not carry readOnlyHint. That is the same
// signal a client reads, so the check and the client agree by construction.
const mutating = tools
  .filter((tool) => tool.annotations?.readOnlyHint !== true)
  .map((tool) => tool.name);

// Match the name as a whole word so `get_trace` is not satisfied by a mention of
// `get_traces`, and a name inside a longer identifier does not count as coverage.
const names = (haystack, name) =>
  new RegExp(String.raw`(?<![\w-])${name}(?![\w-])`, "u").test(haystack);

const failures = [];

const undocumented = tools.map((tool) => tool.name).filter((name) => !names(readme, name));
if (undocumented.length > 0) {
  failures.push(
    `${undocumented.length} tool(s) in the manifest are not named in server/README.md:\n` +
      undocumented.map((name) => `    ${name}`).join("\n") +
      "\n  The published page would under-report the surface consumers get.",
  );
}

if (mutating.length > 0) {
  // Sentence-level so an accurate carve-out elsewhere on the page cannot excuse
  // a blanket claim here.
  const overBroad = readme
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter(
      (sentence) =>
        /\ball\b/iu.test(sentence) &&
        /read[- ]only/iu.test(sentence) &&
        !/\bexcept\b/iu.test(sentence) &&
        !mutating.some((name) => names(sentence, name)),
    );

  if (overBroad.length > 0) {
    failures.push(
      `server/README.md claims every tool is read-only while ${mutating.join(", ")} ` +
        "mutate(s):\n" +
        overBroad.map((sentence) => `    "${sentence}"`).join("\n") +
        "\n  Name the exception, or say 'except <tool>'. Clients auto-approve on " +
        "read-only annotations.",
    );
  }
}

if (failures.length > 0) {
  throw new Error(
    `verify:readme failed (${failures.length} problem(s)):\n\n` +
      failures.map((failure) => `  ${failure}`).join("\n\n") +
      "\n\n  The manifest is the source of truth. Regenerate it with " +
      "`npm run snapshot:tools`, then document what changed.",
  );
}

console.log(
  `verify:readme: ${tools.length} tools documented; ` +
    `${mutating.length} mutating (${mutating.join(", ") || "none"}) named with its exception.`,
);
