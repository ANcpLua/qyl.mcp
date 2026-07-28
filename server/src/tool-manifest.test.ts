/**
 * Tool-manifest snapshot (architecture gate G10b).
 *
 * The manifest is what an agent actually sees: names, titles, descriptions,
 * annotations, UI metadata, the input/output JSON Schemas the SDK derives
 * from the generated contract schemas, and the ui:// resources those tools
 * point at. Pinning it means a contract change that is not regenerated here
 * fails as a diff instead of reaching clients unnoticed, and the recorded
 * contract revision ties the snapshot to the contract it came from rather
 * than to the day someone last looked at it.
 *
 * This test only compares. Regenerate deliberately with
 * `npm run snapshot:tools` — a plain script run, so no ambient environment
 * variable can turn the assertion into a self-approving rewrite.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildToolManifest, snapshotUrl } from "./tool-manifest.test-helper.js";

test("the published tool manifest matches its committed snapshot", async () => {
  const manifest = await buildToolManifest();

  const committed = await readFile(snapshotUrl, "utf8").catch(() => undefined);
  assert.ok(
    committed !== undefined,
    "tool-manifest.snapshot.json is missing — regenerate it with `npm run snapshot:tools`",
  );
  assert.match(
    committed,
    /"contract_revision": "sha256:[a-f0-9]{16}"/u,
    "the committed snapshot pins no real contract revision — G10b would no longer tie " +
      "the tool surface to a contract",
  );
  assert.equal(
    manifest,
    committed,
    "the tool manifest changed: review the diff, then regenerate with `npm run snapshot:tools`",
  );
});
