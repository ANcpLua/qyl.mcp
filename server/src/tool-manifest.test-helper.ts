/**
 * Builds the G10b manifest — the full tool AND resource surface an agent sees,
 * plus the contract revision it was generated from. Shared by the snapshot
 * test (which only compares) and update-tool-manifest-snapshot.mjs (which
 * writes): regeneration is an explicit script run, never a side effect of
 * `bun test` in an environment that happens to carry a variable.
 */
import { generatedContractRevision } from "./contract-handshake.js";
import { connectModernTestClient } from "./modern-test-client.test-helper.js";
import { createServer } from "./server.js";

export const snapshotUrl = new URL("../tool-manifest.snapshot.json", import.meta.url);

export async function buildToolManifest(): Promise<string> {
  const connection = await connectModernTestClient(
    { name: "tool-manifest-snapshot", version: "1.0.0" },
    () => createServer({ nativeExecution: false }),
  );

  try {
    const { tools } = await connection.client.listTools();
    const { resources } = await connection.client.listResources();

    const manifest = {
      contract_revision: generatedContractRevision(),
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
      // The ui:// resources tools advertise through _meta.ui.resourceUri are part
      // of the surface an agent resolves: a tool pointing at a resource the server
      // no longer registers must fail as a snapshot diff, not a client 404.
      resources: [...resources]
        .sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0))
        .map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          title: resource.title ?? null,
          description: resource.description ?? null,
          mimeType: resource.mimeType ?? null,
        })),
    };
    return `${JSON.stringify(manifest, null, 2)}\n`;
  } finally {
    await connection.close();
  }
}
