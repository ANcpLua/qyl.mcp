import assert from "node:assert/strict";
import test from "node:test";
import {
  closeMcpRequestResources,
  sanitizedErrorType,
} from "./main.js";

test("server-owned cleanup closes the transport only as a failure fallback", async () => {
  let transportCloses = 0;
  const success = await closeMcpRequestResources(
    { close: async () => undefined },
    { close: async () => { transportCloses += 1; } },
  );
  assert.deepEqual(success, []);
  assert.equal(transportCloses, 0);

  const failures = await closeMcpRequestResources(
    { close: async () => { throw new TypeError("authorization=do-not-log"); } },
    { close: async () => { transportCloses += 1; throw new RangeError("token=do-not-log"); } },
  );
  assert.deepEqual(failures, [
    { resource: "server", errorType: "TypeError" },
    { resource: "transport", errorType: "RangeError" },
  ]);
  assert.equal(transportCloses, 1);
  assert.doesNotMatch(JSON.stringify(failures), /authorization|token|do-not-log/);
});

test("sanitized errors expose only a safe error class", () => {
  assert.equal(sanitizedErrorType(new Error("api_key=secret")), "Error");
  const unusual = new Error("secret");
  unusual.name = "Bad Name: secret";
  assert.equal(sanitizedErrorType(unusual), "Error");
  assert.equal(sanitizedErrorType("bearer secret"), "UnknownError");
});
