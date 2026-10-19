import { contractSchema, publishedContractSchema } from "@ancplua/qyl-api-schema/zod";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

// The JSON-Schema-to-Zod adapter that produced these validators is published by
// the contract package itself, so this module is the output-schema spelling plus
// the named bindings shared by the server and its tests. Every binding below is
// `contractSchema("<definition>")`, whose result type the contract package binds
// to the name, so a shape cannot be paired with the wrong type.
export { contractSchema, publishedContractSchema };

const JSON_SCHEMA_TARGET = "draft-2020-12" as const;

const compacted = new WeakMap<object, StandardSchemaWithJSON<never, never>>();

/** Normalize schema nodes only; defaults, examples and enum/const values are data. */
function normalizeOutputSpelling(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  // zod spells `z.iso.datetime()` as `format: "date-time"` plus a 300-character
  // regex that says the same thing; the format alone is the portable spelling.
  if (schema.format === "date-time" && typeof schema.pattern === "string") delete schema.pattern;
  const additional = schema.additionalProperties;
  if (additional !== null && typeof additional === "object" &&
      !Array.isArray(additional) && Object.keys(additional).length === 0) {
    schema.additionalProperties = true;
  }
  if (Array.isArray(schema.type)) {
    const anyOf = schema.type.map((type) => ({ type }));
    delete schema.type;
    if (schema.anyOf === undefined) {
      schema.anyOf = anyOf;
    } else {
      // A type constraint and an existing anyOf both apply; keep that conjunction.
      schema.allOf = [...(Array.isArray(schema.allOf) ? schema.allOf : []), { anyOf }];
    }
  }
  for (const key of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas", "dependencies"]) {
    const children = schema[key];
    if (children !== null && typeof children === "object" && !Array.isArray(children)) {
      for (const child of Object.values(children)) normalizeOutputSpelling(child);
    }
  }
  for (const key of [
    "additionalProperties", "unevaluatedProperties", "propertyNames", "items", "additionalItems",
    "unevaluatedItems", "contains", "contentSchema", "not", "if", "then", "else",
    "allOf", "anyOf", "oneOf", "prefixItems",
  ]) {
    const child = schema[key];
    if (Array.isArray(child)) child.forEach(normalizeOutputSpelling);
    else normalizeOutputSpelling(child);
  }
}

/**
 * Emits a tool's output JSON Schema in the spelling every host reads: every
 * subschema inlined where it is used, and no redundant date-time regex.
 *
 * Until 8.1.0 this hoisted repeated subschemas into `$defs` whenever that was
 * smaller, which it was for the nested telemetry shapes. ChatGPT's tool
 * conversion does not resolve `$ref`, so a hoisted field reached the model as
 * `unknown`: `verify_fix.verdict`, a four-value enum, and most of
 * `get_failure_context` lost their types in the one directory the hoisting
 * was meant to serve. Inlining costs about six percent more catalog bytes
 * than the hoisted form once the date-time patterns are gone; the types are
 * worth it. zod still emits `$defs` for the two genuinely recursive attribute
 * shapes, which no inlining can remove.
 *
 * Validation is unchanged — `validate` still runs the generated zod schema, so
 * structured content is checked against the contract exactly as before. Only
 * the advertised spelling of the same schema differs, and the conversion is
 * deferred to the first tools/list and memoised.
 */
export function compactOutputSchema<T>(schema: z.ZodType<T>): StandardSchemaWithJSON<T, T> {
  // createServer() runs per hosted request, so the wrapper is cached on the
  // generated schema: registering every tool must not re-derive the same
  // JSON Schema on every connection.
  const cachedWrapper = compacted.get(schema);
  if (cachedWrapper !== undefined) return cachedWrapper as StandardSchemaWithJSON<T, T>;

  let emitted: Record<string, unknown> | undefined;
  const jsonSchema = (): Record<string, unknown> => {
    if (emitted === undefined) {
      // Zod compacts unions after its override hook; normalize its finished JSON object.
      emitted = z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io: "output" });
      normalizeOutputSpelling(emitted);
    }
    return emitted;
  };
  const standard = schema["~standard"];
  const wrapper = {
    "~standard": {
      version: 1,
      vendor: standard.vendor,
      jsonSchema: { input: jsonSchema, output: jsonSchema },
      validate: (value: unknown) => standard.validate(value),
    },
  } as StandardSchemaWithJSON<T, T>;
  compacted.set(schema, wrapper as unknown as StandardSchemaWithJSON<never, never>);
  return wrapper;
}

// Named bindings shared by the server and its tests; a tool's own schemas are bound beside its registration.
export const SpanSchema = contractSchema("OTel.Traces.Span");
export const TraceSchema = contractSchema("OTel.Traces.Trace");

export const ProblemDetailsSchema = contractSchema("Common.Errors.ProblemDetails");
export const ValidationErrorSchema = contractSchema("Common.Errors.ValidationError");
export const ToolErrorSchema = contractSchema("Mcp.Tools.ToolError");

export const ListTracesInputSchema = contractSchema("Mcp.Tools.ListTracesInput");
export const ListTracesOutputSchema = contractSchema("Mcp.Tools.ListTracesOutput");
export const GetTraceInputSchema = contractSchema("Mcp.Tools.GetTraceInput");
export const GetTraceOutputSchema = contractSchema("Mcp.Tools.GetTraceOutput");
export const ListSessionsInputSchema = contractSchema("Mcp.Tools.ListSessionsInput");
export const ListSessionsOutputSchema = contractSchema("Mcp.Tools.ListSessionsOutput");
export const SearchLogsInputSchema = contractSchema("Mcp.Tools.SearchLogsInput");
export const SearchLogsOutputSchema = contractSchema("Mcp.Tools.SearchLogsOutput");
export const CiLogOutputSchema = contractSchema("Mcp.Tools.CiLogOutput");
