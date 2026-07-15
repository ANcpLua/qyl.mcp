export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchemaType =
  | "object"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "null";

export interface JsonSchema {
  $schema?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaType | readonly JsonSchemaType[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
}

export interface SchemaValidationIssue {
  pointer: string;
  keyword:
    | "type"
    | "enum"
    | "const"
    | "required"
    | "minimum"
    | "maximum"
    | "minLength"
    | "maxLength"
    | "pattern"
    | "additionalProperties";
  message: string;
}

export type JsonParseResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

export function parseJsonValue(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonValue(value)
      ? { ok: true, value }
      : { ok: false, error: "The input must be valid JSON with finite numeric values." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The input is not valid JSON.",
    };
  }
}

export function formatJson(value: unknown): string {
  try {
    const formatted = JSON.stringify(value, null, 2);
    return formatted === undefined ? "undefined" : formatted;
  } catch {
    return String(value);
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item as JsonValue)]),
    ) as T;
  }
  return value;
}

function schemaTypes(schema: JsonSchema): readonly JsonSchemaType[] {
  if (typeof schema.type === "string") return [schema.type];
  if (schema.type) return schema.type;
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  return [];
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Returns only values supplied by JSON Schema `default` keywords. Object and
 * array defaults are completed recursively without sharing mutable references.
 */
export function defaultsForSchema(schema: JsonSchema): JsonValue | undefined {
  const explicit = hasOwn(schema, "default") && schema.default !== undefined
    ? cloneJson(schema.default)
    : undefined;
  const types = schemaTypes(schema);

  if (types.includes("object") || schema.properties) {
    const objectDefault: Record<string, JsonValue> = isPlainObject(explicit)
      ? cloneJson(explicit as { [key: string]: JsonValue })
      : {};
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      const nested = defaultsForSchema(propertySchema);
      if (!hasOwn(objectDefault, key) && nested !== undefined) objectDefault[key] = nested;
    }
    return explicit !== undefined || Object.keys(objectDefault).length > 0
      ? objectDefault
      : undefined;
  }

  if ((types.includes("array") || schema.items) && Array.isArray(explicit)) {
    if (!schema.items) return explicit;
    return explicit.map((item) => mergeValueWithDefaults(schema.items!, item));
  }

  return explicit;
}

function mergeValueWithDefaults(schema: JsonSchema, value: JsonValue): JsonValue {
  if (isPlainObject(value) && (schemaTypes(schema).includes("object") || schema.properties)) {
    const merged = cloneJson(value as { [key: string]: JsonValue });
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (hasOwn(merged, key)) {
        merged[key] = mergeValueWithDefaults(propertySchema, merged[key]!);
      } else {
        const nested = defaultsForSchema(propertySchema);
        if (nested !== undefined) merged[key] = nested;
      }
    }
    return merged;
  }
  if (Array.isArray(value) && schema.items) {
    return value.map((item) => mergeValueWithDefaults(schema.items!, item));
  }
  return cloneJson(value);
}

/** Produces a new editable value, preferring default, const, and enum values. */
export function initialValueForSchema(schema: JsonSchema): JsonValue {
  const defaults = defaultsForSchema(schema);
  if (defaults !== undefined) return defaults;
  if (schema.const !== undefined) return cloneJson(schema.const);
  if (schema.enum && schema.enum.length > 0) return cloneJson(schema.enum[0]!);

  const type = schemaTypes(schema)[0];
  switch (type) {
    case "object":
      return {};
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return {};
  }
}

export function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

export function appendJsonPointer(pointer: string, token: string | number): string {
  return `${pointer}/${escapeJsonPointerToken(String(token))}`;
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

/** Resolves an RFC 6901 JSON Pointer, returning undefined for a missing path. */
export function getJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;

  let current: unknown = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = decodeJsonPointerToken(encoded);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isPlainObject(current) && hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEquals(item, right[index]!));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => hasOwn(right, key)
        && jsonEquals(left[key] as JsonValue, right[key] as JsonValue));
  }
  return false;
}

function valueType(value: unknown): JsonSchemaType | "undefined" | "non-json" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "non-json";
    return Number.isInteger(value) ? "integer" : "number";
  }
  return value === undefined ? "undefined" : "non-json";
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  const actual = valueType(value);
  return type === "number" ? actual === "number" || actual === "integer" : actual === type;
}

function issue(
  pointer: string,
  keyword: SchemaValidationIssue["keyword"],
  message: string,
): SchemaValidationIssue {
  return { pointer, keyword, message };
}

/** Validates the intentionally small JSON Schema subset used by the workbench. */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  pointer = "",
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];

  if (schema.const !== undefined && (!isJsonValue(value) || !jsonEquals(value, schema.const))) {
    issues.push(issue(pointer, "const", `Value must equal ${formatJson(schema.const)}.`));
  }
  if (schema.enum && (!isJsonValue(value) || !schema.enum.some((entry) => jsonEquals(value, entry)))) {
    issues.push(issue(pointer, "enum", "Value is not one of the allowed choices."));
  }

  const types = schemaTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    issues.push(issue(pointer, "type", `Expected ${types.join(" or ")}, received ${valueType(value)}.`));
    return issues;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push(issue(pointer, "minLength", `Must contain at least ${schema.minLength} characters.`));
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push(issue(pointer, "maxLength", `Must contain at most ${schema.maxLength} characters.`));
    }
    // A remote MCP server controls `pattern`. Browser-side evaluation could
    // freeze the UI through catastrophic backtracking; the runner validates
    // the complete schema in a deadline-bound worker before invocation.
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(issue(pointer, "minimum", `Must be greater than or equal to ${schema.minimum}.`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(issue(pointer, "maximum", `Must be less than or equal to ${schema.maximum}.`));
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      issues.push(...validateJsonSchema(schema.items!, item, appendJsonPointer(pointer, index)));
    });
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!hasOwn(value, key)) {
        issues.push(issue(appendJsonPointer(pointer, key), "required", `Property “${key}” is required.`));
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        issues.push(...validateJsonSchema(propertySchema, item, appendJsonPointer(pointer, key)));
      } else if (schema.additionalProperties === false) {
        issues.push(issue(
          appendJsonPointer(pointer, key),
          "additionalProperties",
          `Property “${key}” is not allowed.`,
        ));
      } else if (typeof schema.additionalProperties === "object") {
        issues.push(...validateJsonSchema(
          schema.additionalProperties,
          item,
          appendJsonPointer(pointer, key),
        ));
      }
    }
  }

  return issues;
}
