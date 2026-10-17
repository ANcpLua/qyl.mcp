import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactor } from "./secret-redactor.js";

const roots = ["http.request.header", "http.response.header", "rpc.request.metadata", "rpc.response.metadata"];
const names = ["authorization", "cookie", "x-api-key", "x-token-count", "mcp-param-secret", "trace-bin", "x_request_id"];
const values = ["registered-value", "Bearer opaque-token", "https://user:password@example.com/?token=kept", "", "duplicate", "duplicate"];

for (const root of roots) {
  for (const name of names) {
    test(`${root}.${name} preserves explicitly captured arrays`, () => {
      const redactor = new SecretRedactor({ environment: {}, secretValues: ["registered-value"] });
      const key = `${root}.${name}`.toUpperCase();
      assert.deepEqual(redactor.redact({ [key]: values }), { [key]: values });
      for (const field of ["key", "name", "header"]) {
        assert.deepEqual(redactor.redact({ [field]: key, value: values, other: "registered-value" }),
          { [field]: key, value: values, other: "[REDACTED]" });
      }
    });
  }
}

test("the capture exception does not bypass redaction outside a valid captured array", () => {
  const redactor = new SecretRedactor({ environment: {}, secretValues: ["registered-value"] });
  for (const key of ["authorization", "custom.http.request.header.authorization", "http.request.headers.authorization",
    "http.request.header.authorization bad", "rpc.request.metadata.authorization bad"]) {
    assert.notDeepEqual(redactor.redact({ [key]: ["registered-value"] }), { [key]: ["registered-value"] });
  }
  assert.deepEqual(redactor.redact({ "http.request.header.authorization": "registered-value" }),
    { "http.request.header.authorization": "[REDACTED]" });
  assert.deepEqual(redactor.redact({ "http.request.header.authorization": ["registered-value", 1] }),
    { "http.request.header.authorization": ["[REDACTED]", 1] });
  assert.deepEqual(redactor.redact({ "http.request.header.authorization": { nested: "registered-value" } }),
    { "http.request.header.authorization": { nested: "[REDACTED]" } });
  assert.deepEqual(redactor.redact({ message: "registered-value", authorization: ["a", "b"] }),
    { message: "[REDACTED]", authorization: "[REDACTED]" });
});

test("registry classification retains MCP array and attribute-record shape checks", () => {
  const redactor = new SecretRedactor({ environment: {}, secretValues: ["registered-value"] });
  for (const key of ["http.request.header", "http.request.header.", "rpc.request.metadata.x+feature",
    "http.request.header.Key", "http.requeſt.header.key"]) {
    assert.notDeepEqual(redactor.redact({ [key]: values }), { [key]: values });
    for (const field of ["key", "name", "header"]) {
      assert.notDeepEqual(redactor.redact({ [field]: key, value: values }), { [field]: key, value: values });
    }
  }
  assert.deepEqual(redactor.redact({ "http.request.header.x+feature": values }), { "http.request.header.x+feature": values });
  for (const field of ["key", "name", "header"]) {
    const key = "rpc.request.metadata.authorization";
    assert.deepEqual(redactor.redact({ [field]: key, value: ["registered-value", 1] }),
      { [field]: key, value: ["[REDACTED]", 1] });
    assert.deepEqual(redactor.redact({ [field]: key, value: "registered-value" }),
      { [field]: key, value: "[REDACTED]" });
    assert.deepEqual(redactor.redact({ [field]: key, value: [] }), { [field]: key, value: [] });
  }
});
