import assert from "node:assert/strict";
import test from "node:test";
import type {
  RunnerMcpBlobResourceContent,
  RunnerMcpTextResourceContent,
} from "@ancplua/qyl-api-schema/types";
import { decodeMcpAppHtml } from "./resource-content.js";

test("MCP App resources decode both generated resource-content variants", () => {
  const text: RunnerMcpTextResourceContent = {
    uri: "ui://qyl/text",
    mimeType: "text/html;profile=mcp-app",
    text: "<main>text</main>",
  };
  const blobHtml = "<main>Grüße</main>";
  const blob: RunnerMcpBlobResourceContent = {
    uri: "ui://qyl/blob",
    mimeType: "text/html;profile=mcp-app",
    blob: Buffer.from(blobHtml, "utf8").toString("base64"),
  };

  assert.equal(decodeMcpAppHtml(text), text.text);
  assert.equal(decodeMcpAppHtml(blob), blobHtml);
});
