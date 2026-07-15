import assert from "node:assert/strict";
import test from "node:test";
import { assessToolRisk, confirmationCopyForTool } from "./risk.js";

test("missing annotations are unknown and require confirmation", () => {
  const risk = assessToolRisk(undefined);
  assert.equal(risk.category, "unknown");
  assert.equal(risk.requiresConfirmation, true);
  assert.match(confirmationCopyForTool("send_message").body, /assume it may change external state/u);
});

test("only explicit read-only, non-destructive, closed-world hints avoid confirmation", () => {
  const risk = assessToolRisk({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.equal(risk.category, "read-only");
  assert.equal(risk.requiresConfirmation, false);
  assert.equal(assessToolRisk({ readOnlyHint: true, openWorldHint: false }).requiresConfirmation, true);
  assert.equal(assessToolRisk({ readOnlyHint: true, destructiveHint: false }).requiresConfirmation, true);
});

test("conflicting read-only and destructive hints remain unsafe", () => {
  const risk = assessToolRisk({ readOnlyHint: true, destructiveHint: true });
  assert.equal(risk.category, "destructive");
  assert.equal(risk.tone, "danger");
  assert.equal(risk.requiresConfirmation, true);
});

test("mutating, open-world, and incomplete annotations require confirmation", () => {
  assert.equal(
    assessToolRisk({ readOnlyHint: false, destructiveHint: false, idempotentHint: true }).category,
    "mutating",
  );
  assert.equal(assessToolRisk({ openWorldHint: true }).category, "open-world");
  assert.equal(assessToolRisk({ title: "Sparse hints" }).category, "unknown");
  assert.match(
    confirmationCopyForTool("delete_data", { destructiveHint: true }).title,
    /potentially destructive/u,
  );
});
