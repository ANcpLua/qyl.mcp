import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { UNTRUSTED_HTML } from "./fixture-catalog.js";
import { createFixtureMcpServer } from "./fixture-server.js";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fixture state");
    }
    await delay(5);
  }
}

test("official SDK fixture paginates discovery and exercises tool and content behavior", { timeout: 10_000 }, async () => {
  const fixture = createFixtureMcpServer();
  const client = new Client({ name: "fixture-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fixture.server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const toolNames: string[] = [];
    let toolCursor: string | undefined;
    do {
      const result = await client.listTools(toolCursor === undefined ? undefined : { cursor: toolCursor });
      toolNames.push(...result.tools.map((tool) => tool.name));
      toolCursor = result.nextCursor;
    } while (toolCursor !== undefined);

    assert.deepEqual(toolNames, [
      "fixture.safe_lookup",
      "fixture.rich_result",
      "fixture.delete_record",
      "fixture.delayed",
      "fixture.tool_error",
    ]);

    const firstToolPage = await client.listTools();
    assert.equal(firstToolPage.tools[0]?.annotations?.readOnlyHint, true);
    const destructivePage = await client.listTools({ cursor: firstToolPage.nextCursor });
    assert.equal(destructivePage.tools[0]?.name, "fixture.delete_record");
    assert.equal(destructivePage.tools[0]?.annotations?.destructiveHint, true);

    const lookup = await client.callTool({
      name: "fixture.safe_lookup",
      arguments: { query: "Protocol" },
    });
    const lookupResult = CallToolResultSchema.parse(lookup);
    assert.deepEqual(lookupResult.structuredContent, {
      query: "Protocol",
      matches: ["fixture:protocol", "fixture:deterministic"],
    });

    const rich = await client.callTool({
      name: "fixture.rich_result",
      arguments: { reportId: "report-7" },
    });
    const richResult = CallToolResultSchema.parse(rich);
    assert.deepEqual(
      richResult.content.map((content) => content.type),
      ["text", "image", "resource", "resource_link"],
    );
    const embeddedResource = richResult.content.find((content) => content.type === "resource");
    assert.equal(embeddedResource?.resource.mimeType, "text/html");
    assert.ok(embeddedResource !== undefined && "text" in embeddedResource.resource);
    assert.equal(embeddedResource.resource.text, UNTRUSTED_HTML);

    const toolError = await client.callTool({
      name: "fixture.tool_error",
      arguments: { message: "expected failure" },
    });
    const toolErrorResult = CallToolResultSchema.parse(toolError);
    assert.equal(toolErrorResult.isError, true);
    assert.equal(toolErrorResult.content[0]?.type, "text");

    const refusedDelete = await client.callTool({
      name: "fixture.delete_record",
      arguments: { recordId: "alpha", confirmation: "yes" },
    });
    const refusedDeleteResult = CallToolResultSchema.parse(refusedDelete);
    assert.equal(refusedDeleteResult.isError, true);
    assert.deepEqual(fixture.state.deletedRecordIds, []);

    const acceptedDelete = await client.callTool({
      name: "fixture.delete_record",
      arguments: { recordId: "alpha", confirmation: "DELETE alpha" },
    });
    const acceptedDeleteResult = CallToolResultSchema.parse(acceptedDelete);
    assert.equal(acceptedDeleteResult.isError, undefined);
    assert.deepEqual(fixture.state.deletedRecordIds, ["alpha"]);

    const resourceNames: string[] = [];
    let resourceCursor: string | undefined;
    do {
      const result = await client.listResources(
        resourceCursor === undefined ? undefined : { cursor: resourceCursor },
      );
      resourceNames.push(...result.resources.map((resource) => resource.name));
      resourceCursor = result.nextCursor;
    } while (resourceCursor !== undefined);
    assert.deepEqual(resourceNames, ["fixture-summary", "untrusted-html", "fixture-blob"]);

    const templateNames: string[] = [];
    let templateCursor: string | undefined;
    do {
      const result = await client.listResourceTemplates(
        templateCursor === undefined ? undefined : { cursor: templateCursor },
      );
      templateNames.push(...result.resourceTemplates.map((template) => template.name));
      templateCursor = result.nextCursor;
    } while (templateCursor !== undefined);
    assert.deepEqual(templateNames, ["fixture-item", "fixture-report", "fixture-log"]);

    const promptNames: string[] = [];
    let promptCursor: string | undefined;
    do {
      const result = await client.listPrompts(promptCursor === undefined ? undefined : { cursor: promptCursor });
      promptNames.push(...result.prompts.map((prompt) => prompt.name));
      promptCursor = result.nextCursor;
    } while (promptCursor !== undefined);
    assert.deepEqual(promptNames, ["fixture.safe_summary", "fixture.review_record", "fixture.rich_context"]);

    const untrustedResource = await client.readResource({ uri: "fixture://catalog/untrusted-html" });
    assert.equal(untrustedResource.contents[0]?.mimeType, "text/html");
    const untrustedContent = untrustedResource.contents[0];
    assert.ok(untrustedContent !== undefined && "text" in untrustedContent);
    assert.equal(untrustedContent.text, UNTRUSTED_HTML);

    const templatedResource = await client.readResource({ uri: "fixture://items/item-9" });
    const templatedContent = templatedResource.contents[0];
    assert.ok(templatedContent !== undefined && "text" in templatedContent);
    assert.equal(templatedContent.text, JSON.stringify({ id: "item-9", source: "fixture" }));

    const prompt = await client.getPrompt({
      name: "fixture.review_record",
      arguments: { recordId: "record-3" },
    });
    assert.equal(prompt.messages[0]?.content.type, "text");

    await assert.rejects(client.listTools({ cursor: "invalid" }), /cursor/i);

    const controller = new AbortController();
    const delayedCall = client.callTool(
      {
        name: "fixture.delayed",
        arguments: { delayMs: 2_000 },
      },
      undefined,
      { signal: controller.signal },
    );
    const rejectedCall = assert.rejects(delayedCall);
    await waitFor(() => fixture.state.delayedStarted === 1);
    controller.abort();
    await rejectedCall;
    await waitFor(() => fixture.state.delayedCancelled === 1);
    assert.equal(fixture.state.delayedCompleted, 0);
  } finally {
    await client.close();
  }
});
