import assert from "node:assert/strict";
import test from "node:test";
import {
  advertisedContractRevision,
  assertCollectorContractRevision,
  generatedContractRevision,
  verifyContractRevision,
} from "./contract-handshake.js";

const revision = "sha256:0f1e2d3c4b5a6978";

function healthBody(contractRevision?: string): unknown {
  return {
    status: "healthy",
    total_duration_ms: 1,
    entries: {},
    ...(contractRevision === undefined ? {} : { contract_revision: contractRevision }),
  };
}

test("a matching collector revision passes the handshake", async () => {
  assert.equal(
    await verifyContractRevision({
      expected: revision,
      fetchHealth: () => Promise.resolve(healthBody(revision)),
    }),
    revision,
  );
});

test("a differing collector revision fails the handshake", async () => {
  await assert.rejects(
    verifyContractRevision({
      expected: revision,
      fetchHealth: () => Promise.resolve(healthBody("sha256:aaaabbbbccccdddd")),
    }),
    /does not match this server's sha256:0f1e2d3c4b5a6978/u,
  );
});

test("a health surface without a contract revision fails the handshake", async () => {
  await assert.rejects(
    verifyContractRevision({
      expected: revision,
      fetchHealth: () => Promise.resolve(healthBody()),
    }),
    /advertises no contract_revision/u,
  );
});

test("a non-object health surface fails the handshake", () => {
  assert.throws(() => advertisedContractRevision("healthy"), /did not return an object/u);
  assert.throws(() => advertisedContractRevision(null), /did not return an object/u);
  assert.throws(() => advertisedContractRevision([healthBody(revision)]), /did not return an object/u);
});

test("an empty contract revision is not a revision", () => {
  assert.throws(() => advertisedContractRevision(healthBody("")), /advertises no contract_revision/u);
});

test("a collector that cannot be reached fails startup", async () => {
  await assert.rejects(
    verifyContractRevision({
      expected: revision,
      fetchHealth: () => Promise.reject(new Error("collector unreachable")),
    }),
    /collector unreachable/u,
  );
});

test("demo mode has no collector to handshake with", async (context) => {
  const previous = process.env.QYL_DEMO;
  process.env.QYL_DEMO = "1";
  context.after(() => {
    if (previous === undefined) delete process.env.QYL_DEMO;
    else process.env.QYL_DEMO = previous;
  });

  // Resolves rather than attempting a collector fetch that would throw.
  await assertCollectorContractRevision();
});

// The revision export lands with the next @ancplua/qyl-api-schema publish; the
// pin still points at a package emitted before it existed. This asserts the
// reader tolerates both states, so the gate activates on the pin bump alone.
test("the generated revision is either absent or well formed", () => {
  const generated = generatedContractRevision();
  if (generated !== undefined) assert.match(generated, /^sha256:[a-f0-9]{16}$/u);
});
