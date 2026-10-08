import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { compactOutputSchema } from "./contract-validation.js";

const target = "draft-2020-12" as const;

function output(schema: z.ZodType): Record<string, unknown> {
  return compactOutputSchema(schema)["~standard"].jsonSchema.output({ target });
}

test("compact output spells unconstrained additional properties as true and preserves constraints", async () => {
  const schema = z.object({
    open: z.record(z.string(), z.unknown()),
    constrained: z.record(z.string(), z.string()),
  });
  const before = z.toJSONSchema(schema, { target, io: "output" });
  const emitted = output(schema);
  assert.equal(emitted.additionalProperties, false);
  assert.deepEqual(emitted.properties, {
    open: { type: "object", propertyNames: { type: "string" }, additionalProperties: true },
    constrained: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
  });
  const wrapped = compactOutputSchema(schema);
  for (const [value, valid] of [
    [{ open: { number: 2, nested: [null, true, {}] }, constrained: { label: "ok" } }, true],
    [{ open: {}, constrained: { label: 2 } }, false],
    [{ open: [], constrained: {} }, false],
    [{}, false],
  ] as const) {
    const original = await schema["~standard"].validate(value);
    assert.deepEqual(await wrapped["~standard"].validate(value), original);
    assert.equal(original.issues === undefined, valid);
  }
  assert.deepEqual(z.toJSONSchema(schema, { target, io: "output" }), before);
});

test("compact output spells nullable type arrays as anyOf without changing validation", async () => {
  const schema = z.number().nullable().describe("A recorded value or an empty bucket.");
  const before = z.toJSONSchema(schema, { target, io: "output" });
  const wrapped = compactOutputSchema(schema);
  const emitted = wrapped["~standard"].jsonSchema.output({ target });
  assert.deepEqual(emitted, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "A recorded value or an empty bucket.",
    anyOf: [{ type: "number" }, { type: "null" }],
  });
  for (const value of [null, 0, 1.5, "1", undefined, {}, Infinity]) {
    const original = await schema["~standard"].validate(value);
    assert.deepEqual(await wrapped["~standard"].validate(value), original);
    assert.equal(original.issues === undefined, value === null || typeof value === "number" && Number.isFinite(value));
  }
  assert.deepEqual(z.toJSONSchema(schema, { target, io: "output" }), before);
  assert.equal(compactOutputSchema(schema), wrapped);
  assert.equal(wrapped["~standard"].jsonSchema.input({ target }), emitted);
});

test("compact output normalizes hoisted definitions and retains their references", () => {
  const leaf = z.object({
    attributes: z.record(z.string(), z.unknown()),
    value: z.number().nullable(),
    note: z.string().describe("Repeated measurement metadata should remain in one shared definition."),
  });
  const emitted = output(z.object({ first: leaf, second: leaf, third: leaf }));
  assert.ok(emitted.$defs);
  const properties = emitted.properties as Record<string, unknown>;
  assert.deepEqual(properties.first, properties.second);
  assert.deepEqual(properties.first, properties.third);
  assert.match(JSON.stringify(properties.first), /"\$ref":"#\/\$defs\//u);
  assert.doesNotMatch(JSON.stringify(emitted), /"additionalProperties":\{\}|"type":\[/u);
  assert.match(JSON.stringify(emitted.$defs), /"anyOf":\[\{"type":"number"\},\{"type":"null"\}\]/u);
});

test("compact output preserves literal data and an existing anyOf conjunction", () => {
  const literal = { type: ["number", "null"], additionalProperties: {} };
  const schema = z.object({
    type: z.array(z.string()),
    additionalProperties: z.record(z.string(), z.unknown()),
  }).default(literal).meta({ examples: [literal] });
  const before = z.toJSONSchema(schema, { target, io: "output" });
  const emitted = output(schema);
  assert.deepEqual(emitted.default, literal);
  assert.deepEqual(emitted.examples, [literal]);
  assert.deepEqual(emitted.properties, {
    type: { type: "array", items: { type: "string" } },
    additionalProperties: { type: "object", propertyNames: { type: "string" }, additionalProperties: true },
  });
  assert.deepEqual(z.toJSONSchema(schema, { target, io: "output" }), before);

  const anyOf = [{ minimum: 0 }, { type: "null" }];
  const allOf = [{ maximum: 10 }];
  const withCombinators = output(z.unknown().meta({ type: ["number", "null"], anyOf, allOf, const: literal, enum: [literal] }));
  assert.equal(withCombinators.type, undefined);
  assert.deepEqual(withCombinators.anyOf, anyOf);
  assert.deepEqual(withCombinators.allOf, [...allOf, { anyOf: [{ type: "number" }, { type: "null" }] }]);
  assert.deepEqual(withCombinators.const, literal);
  assert.deepEqual(withCombinators.enum, [literal]);
});
