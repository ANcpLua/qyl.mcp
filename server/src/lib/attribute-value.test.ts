import assert from "node:assert/strict";
import test from "node:test";
import type { AttributeValue } from "@ancplua/qyl-api-schema/types";
import {
  attributeNumber,
  attributeString,
  decodeAttributeValue,
  formatAttributeValue,
} from "./attribute-value.js";

test("preserves int64 text and refuses unsafe numeric coercion", () => {
  const maximum = { type: "int", value: "9223372036854775807" } as AttributeValue;
  const safe = { type: "int", value: "42" } as AttributeValue;
  assert.equal(formatAttributeValue(maximum), "9223372036854775807");
  assert.equal(attributeNumber(maximum), undefined);
  assert.equal(attributeNumber(safe), 42);
});

test("decodes finite and canonical named doubles", () => {
  assert.equal(attributeNumber({ type: "double", value: 1.5 } as AttributeValue), 1.5);
  assert.equal(attributeNumber({ type: "double", value: "Infinity" } as AttributeValue), Infinity);
  assert.equal(attributeNumber({ type: "double", value: "-Infinity" } as AttributeValue), -Infinity);
  assert.ok(Number.isNaN(attributeNumber({ type: "double", value: "NaN" } as AttributeValue)));
});

test("formats every wire variant without [object Object]", () => {
  assert.equal(formatAttributeValue(null), "null");
  assert.equal(formatAttributeValue("text"), "text");
  assert.equal(formatAttributeValue(true), "true");
  assert.equal(formatAttributeValue({ type: "bytes", base64: "AQI=" } as AttributeValue), '{"type":"bytes","base64":"AQI="}');
  assert.equal(
    formatAttributeValue({ type: "kvlist", values: { a: { type: "int", value: "1" }, b: "x" } } as AttributeValue),
    '{"a":"1","b":"x"}',
  );
  assert.equal(formatAttributeValue(["a", { type: "int", value: "2" }] as AttributeValue), '["a","2"]');
  assert.equal(attributeString("s"), "s");
  assert.equal(attributeString({ type: "int", value: "1" } as AttributeValue), undefined);
});

test("kvlist decodes recursively", () => {
  const nested = { type: "kvlist", values: { inner: { type: "kvlist", values: { n: { type: "double", value: 2 } } } } } as AttributeValue;
  assert.deepEqual(decodeAttributeValue(nested), { inner: { n: 2 } });
});
