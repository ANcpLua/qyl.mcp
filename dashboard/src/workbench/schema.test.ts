import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultsForSchema,
  getJsonPointer,
  parseJsonValue,
  validateJsonSchema,
  type JsonSchema,
} from "./schema.js";

test("defaultsForSchema completes nested object and array defaults without sharing values", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      limit: { type: "integer", default: 20 },
      options: {
        type: "object",
        default: { enabled: true },
        properties: {
          enabled: { type: "boolean" },
          label: { type: "string", default: "primary" },
        },
      },
      entries: {
        type: "array",
        default: [{}],
        items: {
          type: "object",
          properties: { retries: { type: "integer", default: 2 } },
        },
      },
    },
  };

  const first = defaultsForSchema(schema);
  const second = defaultsForSchema(schema);
  assert.deepEqual(first, {
    limit: 20,
    options: { enabled: true, label: "primary" },
    entries: [{ retries: 2 }],
  });
  assert.deepEqual(second, first);
  assert.notEqual(first, second);
  assert.notEqual((first as { options: object }).options, (second as { options: object }).options);
});

test("getJsonPointer resolves escaped object keys and array indexes", () => {
  const value = { "a/b": { "~key": [{ ok: true }] } };
  assert.equal(getJsonPointer(value, "/a~1b/~0key/0/ok"), true);
  assert.equal(getJsonPointer(value, ""), value);
  assert.equal(getJsonPointer(value, "/missing"), undefined);
  assert.equal(getJsonPointer(value, "not-a-pointer"), undefined);
});

test("validateJsonSchema enforces supported recursive constraints", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["name", "count", "flags"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 3, maxLength: 5, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 1, maximum: 4 },
      flags: { type: "array", items: { type: "boolean" } },
      mode: { enum: ["fast", "safe"] },
      fixed: { const: null },
    },
  };

  const issues = validateJsonSchema(schema, {
    name: "A!",
    count: 4.5,
    flags: [true, "no"],
    mode: "other",
    fixed: false,
    extra: 1,
  });
  assert.deepEqual(
    new Set(issues.map((entry) => `${entry.pointer}:${entry.keyword}`)),
    new Set([
      "/name:minLength",
      "/count:type",
      "/flags/1:type",
      "/mode:enum",
      "/fixed:const",
      "/extra:additionalProperties",
    ]),
  );
});

test("validateJsonSchema defers untrusted schema patterns to the isolated runner", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["missing"],
    properties: {
      low: { type: "number", minimum: 2 },
      high: { type: "number", maximum: 3 },
      nothing: { type: "null" },
      invalidPattern: { type: "string", pattern: "[" },
    },
  };
  const issues = validateJsonSchema(schema, {
    low: 1,
    high: 4,
    nothing: "value",
    invalidPattern: "anything",
  });
  assert.deepEqual(
    issues.map((entry) => entry.keyword).sort(),
    ["maximum", "minimum", "required", "type"],
  );
});

test("additionalProperties schemas validate unknown keys", () => {
  const issues = validateJsonSchema(
    { type: "object", additionalProperties: { type: "string", minLength: 2 } },
    { valid: "ok", invalid: "x" },
  );
  assert.deepEqual(issues.map((entry) => [entry.pointer, entry.keyword]), [["/invalid", "minLength"]]);
});

test("parseJsonValue rejects malformed and non-finite JSON values", () => {
  assert.deepEqual(parseJsonValue('{"ok":true}'), { ok: true, value: { ok: true } });
  assert.equal(parseJsonValue("{").ok, false);
  assert.equal(parseJsonValue("1e400").ok, false);
});
