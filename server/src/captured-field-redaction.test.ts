import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactor, isCredentialKey } from "./secret-redactor.js";

const roots = ["http.request.header", "http.response.header", "rpc.request.metadata", "rpc.response.metadata"];
const denied = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key",
  "www-authenticate", "proxy-authenticate", "x-auth-token", "x-token-count", "client-secret", "x-password",
  "x-passwd", "x-apikey", "x-api_key", "x-credential", "x-private_key", "x-private-key", "x-privatekey",
  "x-client_secret", "x-jwt"];

for (const root of roots) {
  test(`${root}: opaque credential arrays retain their published shape`, () => {
    const redactor = new SecretRedactor({ environment: {}, replacement: "hidden" });
    for (const suffix of denied) {
      const key = `${root}.${suffix}`.toUpperCase();
      assert.equal(isCredentialKey(key), true, key);
      assert.deepEqual(redactor.redact({ [key]: ["opaque-a", "opaque-b", ""] }), { [key]: ["hidden", "hidden", "hidden"] });
      for (const field of ["key", "name", "header"]) {
        assert.deepEqual(redactor.redact({ [field]: key, value: ["opaque-a", "opaque-b"] }),
          { [field]: key, value: ["hidden", "hidden"] });
      }
      assert.deepEqual(redactor.redact({ key, value: { nested: "opaque-a" } }), { key, value: "hidden" });
      assert.deepEqual(redactor.redact({ [key]: ["opaque-a", 1] }), { [key]: "hidden" });
    }
  });

  test(`${root}: benign arrays and punctuation survive; value protection still runs`, () => {
    const redactor = new SecretRedactor({ environment: {}, secretValues: ["registered-value"] });
    for (const suffix of ["x-request-id", "x_request_id", "x.request.id", "x-message-id", "content-type", "x-auth", "key"]) {
      const key = `${root}.${suffix}`;
      assert.equal(isCredentialKey(key), false, key);
      const value = ["ordinary-a", "ordinary-a", "", "comma,kept"];
      assert.deepEqual(redactor.redact({ key, value }), { key, value });
      assert.deepEqual(redactor.redact({ [key]: value }), { [key]: value });
      assert.deepEqual(redactor.redact({ [key]: ["registered-value"] }), { [key]: ["[REDACTED]"] });
    }
  });
}

test("captured names do not override unrelated safe counters or generic credential redaction", () => {
  const redactor = new SecretRedactor({ environment: {} });
  assert.equal(isCredentialKey("gen_ai.usage.input_tokens"), false);
  assert.equal(isCredentialKey("http.request.headers.input_tokens"), false);
  assert.equal(isCredentialKey("http.request.header.input_tokens"), true);
  assert.deepEqual(redactor.redact({ key: "authorization", value: ["a", "b"] }),
    { key: "authorization", value: "[REDACTED]" });
});
