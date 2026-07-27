/**
 * Tool-manifest snapshot (architecture gate G10b).
 *
 * The manifest is what an agent actually sees: names, titles, descriptions,
 * annotations, UI metadata, and the input/output JSON Schemas the SDK derives
 * from the generated contract schemas. Pinning it means a contract change that
 * is not regenerated here fails as a diff instead of reaching clients unnoticed,
 * and the recorded contract revision ties the snapshot to the contract it came
 * from rather than to the day someone last looked at it.
 *
 * Regenerate deliberately: `npm run snapshot:tools`.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { generatedContractRevision } from "./contract-handshake.js";
import { createServer } from "./server.js";

const snapshotUrl = new URL("../tool-manifest.snapshot.json", import.meta.url);

async function toolManifest(): Promise<unknown> {
  const server = createServer({ nativeExecution: false });
  const client = new Client({ name: "tool-manifest-snapshot", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();

    return {
      // Null until the pinned @ancplua/qyl-api-schema carries the revision
      // export; regenerating after the pin bump is what records the real one.
      contract_revision: generatedContractRevision() ?? null,
      tools: [...tools]
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          annotations: tool.annotations ?? null,
          meta: tool._meta ?? null,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
        })),
    };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

test("the published tool manifest matches its committed snapshot", async () => {
  const manifest = `${JSON.stringify(await toolManifest(), null, 2)}\n`;

  if (process.env.UPDATE_SNAPSHOT === "1") {
    await writeFile(snapshotUrl, manifest);
    return;
  }

  const committed = await readFile(snapshotUrl, "utf8").catch(() => undefined);
  assert.notEqual(
    committed,
    undefined,
    "tool-manifest.snapshot.json is missing — regenerate it with `npm run snapshot:tools`",
  );
  assert.equal(
    manifest,
    committed,
    "the tool manifest changed: review the diff, then regenerate with `npm run snapshot:tools`",
  );
});
