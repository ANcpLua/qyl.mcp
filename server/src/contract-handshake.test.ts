import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCollectorContractRevision,
  generatedContractRevision,
  type HealthProbeResult,
} from "./contract-handshake.js";

const revision = "sha256:0f1e2d3c4b5a6978";
const foreign = "sha256:aaaabbbbccccdddd";

const advertised = (rev: string, healthy = true): HealthProbeResult => ({
  kind: "advertised",
  healthy,
  revision: rev,
});
const unreachable: HealthProbeResult = {
  kind: "unreachable",
  detail: "connect ECONNREFUSED 127.0.0.1:5100",
};
const preRevision: HealthProbeResult = {
  kind: "pre-revision",
  detail: "the 200 health body carries no contract_revision",
};

const noSleep = () => Promise.resolve();

test("a matching collector revision passes on both transports", async () => {
  for (const transport of ["http", "stdio"] as const) {
    await assertCollectorContractRevision({
      expected: revision,
      transport,
      probe: () => Promise.resolve(advertised(revision)),
    });
  }
});

test("a differing revision is fatal on both transports", async () => {
  for (const transport of ["http", "stdio"] as const) {
    await assert.rejects(
      assertCollectorContractRevision({
        expected: revision,
        transport,
        probe: () => Promise.resolve(advertised(foreign)),
      }),
      /does not match this server's sha256:0f1e2d3c4b5a6978/u,
    );
  }
});

test("a 200 health body without a revision is skew and fatal on both transports", async () => {
  for (const transport of ["http", "stdio"] as const) {
    await assert.rejects(
      assertCollectorContractRevision({
        expected: revision,
        transport,
        probe: () => Promise.resolve(preRevision),
      }),
      /serves a contract older than the one this server was generated from/u,
    );
  }
});

test("an unhealthy collector that advertises the matching revision passes", async () => {
  await assertCollectorContractRevision({
    expected: revision,
    transport: "http",
    probe: () => Promise.resolve(advertised(revision, false)),
  });
});

test("hosted HTTP retries an unreachable collector, then refuses to serve", async () => {
  let probes = 0;
  await assert.rejects(
    assertCollectorContractRevision({
      expected: revision,
      transport: "http",
      probe: () => {
        probes += 1;
        return Promise.resolve(unreachable);
      },
      attempts: 3,
      sleep: noSleep,
    }),
    /refusing to serve the hosted transport/u,
  );
  assert.equal(probes, 3);
});

test("hosted HTTP survives a collector that becomes reachable within the retries", async () => {
  let probes = 0;
  await assertCollectorContractRevision({
    expected: revision,
    transport: "http",
    probe: () => {
      probes += 1;
      return Promise.resolve(probes === 1 ? unreachable : advertised(revision));
    },
    attempts: 4,
    sleep: noSleep,
  });
  assert.equal(probes, 2);
});

test("stdio degrades with a warning when the collector is unreachable", async () => {
  // Resolves: a local install without a running collector is a normal state,
  // and every tool call surfaces an actionable collector error instead.
  await assertCollectorContractRevision({
    expected: revision,
    transport: "stdio",
    probe: () => Promise.resolve(unreachable),
    sleep: noSleep,
  });
});

test("a mismatch is fatal immediately, without burning the retry budget", async () => {
  let probes = 0;
  await assert.rejects(
    assertCollectorContractRevision({
      expected: revision,
      transport: "http",
      probe: () => {
        probes += 1;
        return Promise.resolve(advertised(foreign));
      },
      attempts: 4,
      sleep: noSleep,
    }),
    /does not match/u,
  );
  assert.equal(probes, 1);
});

test("demo mode has no collector to handshake with", async (context) => {
  const previous = process.env.QYL_DEMO;
  process.env.QYL_DEMO = "1";
  context.after(() => {
    if (previous === undefined) delete process.env.QYL_DEMO;
    else process.env.QYL_DEMO = previous;
  });

  // Resolves without probing anything.
  await assertCollectorContractRevision({
    probe: () => Promise.reject(new Error("must not be probed in demo mode")),
  });
});

test("the generated revision is present and well formed", () => {
  // A named import of CONTRACT_REVISION makes a pin without the export a
  // compile error; this asserts the value behind it is a real revision.
  assert.match(generatedContractRevision(), /^sha256:[a-f0-9]{16}$/u);
});
