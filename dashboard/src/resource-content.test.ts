import assert from "node:assert/strict";
import test from "node:test";
import { decodeMcpAppHtml } from "./resource-content.js";

test("returned MCP App HTML cannot enter an executable production path", () => {
  assert.throws(
    () => decodeMcpAppHtml(),
    /Executable MCP App HTML is disabled/u,
  );
});
