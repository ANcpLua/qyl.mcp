import assert from "node:assert/strict";
import { test } from "node:test";
import {
  abortableFixtureDelay,
  FIXTURE_TOOLS,
  FixtureCursorError,
  paginateFixture,
} from "./fixture-catalog.js";
import { hasExpectedBearer } from "./fixture-http.js";

test("fixture pagination uses opaque, surface-bound cursors", () => {
  const first = paginateFixture("tools", FIXTURE_TOOLS, undefined, 2);
  assert.deepEqual(
    first.items.map((tool) => tool.name),
    ["fixture.safe_lookup", "fixture.rich_result"],
  );
  assert.equal(typeof first.nextCursor, "string");

  const second = paginateFixture("tools", FIXTURE_TOOLS, first.nextCursor, 2);
  assert.deepEqual(
    second.items.map((tool) => tool.name),
    ["fixture.evidence", "fixture.delete_record"],
  );

  assert.throws(
    () => paginateFixture("resources", FIXTURE_TOOLS, first.nextCursor, 2),
    FixtureCursorError,
  );
  assert.throws(() => paginateFixture("tools", FIXTURE_TOOLS, "not-a-cursor", 2), FixtureCursorError);
});

test("fixture bearer matching is exact and rejects empty credentials", () => {
  assert.equal(hasExpectedBearer("Bearer test-secret", "test-secret"), true);
  assert.equal(hasExpectedBearer("bearer test-secret", "test-secret"), false);
  assert.equal(hasExpectedBearer("Bearer test-secret ", "test-secret"), false);
  assert.equal(hasExpectedBearer(undefined, "test-secret"), false);
  assert.equal(hasExpectedBearer("Bearer ", ""), false);
});

test("fixture delay observes an AbortSignal", async () => {
  const controller = new AbortController();
  const delayed = abortableFixtureDelay(5_000, controller.signal);
  controller.abort(new DOMException("cancelled by test", "AbortError"));
  await assert.rejects(delayed, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
