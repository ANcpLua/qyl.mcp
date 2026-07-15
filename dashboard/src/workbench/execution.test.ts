import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration } from "./execution.js";

test("duration formatting handles invalid, sub-second, and minute values", () => {
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatDuration(250), "250 ms");
  assert.equal(formatDuration(2_500), "2.50 s");
  assert.equal(formatDuration(60_500), "1m 0s");
});
