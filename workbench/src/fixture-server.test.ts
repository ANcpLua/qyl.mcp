import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { UNTRUSTED_HTML } from "./fixture-catalog.js";
import {
  createFixtureMcpServer,
  createFixtureServerState,
} from "./fixture-server.js";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fixture state");
    }
    await delay(5);
  }
}

test("official SDK fixture aggregates discovery and exercises tool and content behavior", { timeout: 10_000 }, async () => {
  const state = createFixtureServerState();
  const handler = createMcpHandler(
    () => createFixtureMcpServer(state).server,
    { legacy: "reject" },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://qyl-fixture-test.invalid/mcp"),
    { fetch: (url, init) => handler.fetch(new Request(url, init)) },
  );
  const client = new Client(
    { name: "fixture-test-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    assert.deepEqual(toolNames, [
      "fixture.safe_lookup",
      "fixture.rich_result",
      "fixture.evidence",
      "fixture.delete_record",
      "fixture.delayed",
      "fixture.tool_error",
    ]);

    assert.equal(tools.tools[0]?.annotations?.readOnlyHint, true);
    const destructive = tools.tools.find((tool) => tool.name === "fixture.delete_record");
    assert.equal(destructive?.annotations?.destructiveHint, true);

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
    assert.deepEqual(state.deletedRecordIds, []);

    const acceptedDelete = await client.callTool({
      name: "fixture.delete_record",
      arguments: { recordId: "alpha", confirmation: "DELETE alpha" },
    });
    const acceptedDeleteResult = CallToolResultSchema.parse(acceptedDelete);
    assert.equal(acceptedDeleteResult.isError, undefined);
    assert.deepEqual(state.deletedRecordIds, ["alpha"]);

    const resourceNames = (await client.listResources()).resources.map((resource) => resource.name);
    assert.deepEqual(resourceNames, ["fixture-summary", "untrusted-html", "fixture-blob"]);

    const templateNames = (await client.listResourceTemplates()).resourceTemplates
      .map((template) => template.name);
    assert.deepEqual(templateNames, ["fixture-item", "fixture-report", "fixture-log"]);

    const promptNames = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
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
      { signal: controller.signal },
    );
    const rejectedCall = assert.rejects(delayedCall);
    await waitFor(() => state.delayedStarted === 1);
    controller.abort();
    await rejectedCall;
    await waitFor(() => state.delayedCancelled === 1);
    assert.equal(state.delayedCompleted, 0);
  } finally {
    const results = await Promise.allSettled([client.close(), handler.close()]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Fixture cleanup failed.");
  }
});
