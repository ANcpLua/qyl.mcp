/**
 * Deliberate G10b regeneration: writes tool-manifest.snapshot.json from the
 * live server surface. `npm test` only compares — regeneration is this
 * explicit script, so an exported UPDATE_SNAPSHOT in a shell, a workflow, or
 * a .envrc can no longer rewrite the pinned surface as a test side effect.
 *
 * Run through `npm run snapshot:tools`, then review the diff before
 * committing — never to make a red test green.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildToolManifest, snapshotUrl } from "./dist-test/tool-manifest.test-helper.js";

await writeFile(snapshotUrl, await buildToolManifest());
console.log(`wrote ${fileURLToPath(snapshotUrl)}`);
