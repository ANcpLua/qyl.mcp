import assert from "node:assert/strict";
import test from "node:test";
import type { QylSession, QylTrace } from "./wire.js";
import {
  collectCiPhases,
  filterCiSessions,
  summarizeCiRun,
  summarizeCiRuns,
} from "./ci.js";

function session(id: string, services: string[]): QylSession {
  return {
    "session.id": id,
    start_time: "2026-07-17T00:00:00Z",
    trace_count: 1,
    span_count: 3,
    error_count: 0,
    services,
    state: "ended",
  } as QylSession;
}

function ciTrace(): QylTrace {
  const base = {
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    resource: { "service.name": "qyl-ci-smoke" },
    kind: 1,
    start_time_unix_nano: 1_000_000_000,
  };
  return {
    trace_id: base.trace_id,
    span_count: 3,
    duration_ns: 5_000_000_000,
    start_time: "2026-07-17T00:00:00Z",
    end_time: "2026-07-17T00:00:05Z",
    services: ["qyl-ci-smoke"],
    has_error: true,
    spans: [
      {
        ...base,
        span_id: "b7ad6b7169203331",
        name: "install",
        end_time_unix_nano: 2_000_000_000,
        status: { code: 1 },
        attributes: [{ key: "ci.leg", value: "ubuntu-latest" }],
      },
      {
        ...base,
        span_id: "b7ad6b7169203332",
        name: "live up",
        end_time_unix_nano: 31_000_000_000,
        status: { code: 2, message: "collectors did not become ready" },
        attributes: [{ key: "ci.leg", value: "macos-latest" }],
      },
      {
        ...base,
        span_id: "b7ad6b7169203333",
        name: "install",
        end_time_unix_nano: 3_000_000_000,
        status: { code: 1 },
        attributes: [{ key: "ci.leg", value: "macos-latest" }],
      },
    ],
  } as QylTrace;
}

test("filterCiSessions keeps only qyl-ci sessions", () => {
  const kept = filterCiSessions([
    session("nuget-publish-1", ["qyl-ci-smoke"]),
    session("user-app", ["checkout", "payments"]),
  ]);
  assert.deepEqual(kept.map((entry) => entry["session.id"]), ["nuget-publish-1"]);
});

test("collectCiPhases sorts failures first and reads ci.leg", () => {
  const phases = collectCiPhases([ciTrace()]);
  assert.equal(phases[0]?.status, "error");
  assert.equal(phases[0]?.leg, "macos-latest");
  assert.equal(phases[0]?.phase, "live up");
  assert.equal(phases[0]?.duration_ms, 30_000);
  assert.equal(phases[0]?.message, "collectors did not become ready");
  assert.equal(phases.length, 3);
  assert.ok(phases.slice(1).every((phase) => phase.status === "ok"));
});

test("summaries name the failing leg and phase", () => {
  const phases = collectCiPhases([ciTrace()]);
  const text = summarizeCiRun("nuget-publish-1", phases, "live");
  assert.match(text, /✗ macos-latest/);
  assert.match(text, /live up \(30000ms\) — collectors did not become ready/);
  assert.match(text, /✓ ubuntu-latest/);
});

test("empty run list explains the emitter convention", () => {
  const text = summarizeCiRuns([], "live");
  assert.match(text, /No CI runs found/);
  assert.match(text, /qyl-ci/);
});
