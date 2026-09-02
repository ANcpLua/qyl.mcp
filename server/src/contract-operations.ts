/**
 * Tool INPUT shapes derived from the published operation parameters.
 *
 * contract-validation.ts binds every response body and every `Mcp.Tools.*`
 * shape the contract publishes. The metrics read API arrived in
 * @ancplua/qyl-api-schema 8.0.0 with its response bodies but without
 * `Mcp.Tools.*Metric*` input shapes, so there is nothing there to bind for the
 * arguments of `list_metrics`, `get_metric_series`, and `query_metric`.
 *
 * Hand-writing those three objects is exactly what architecture gate G10a
 * exists to prevent, and an exemption would carve the hole in the one place the
 * gate names first ("request, response, or tool-input shapes"). So the inputs
 * are generated too — from the other artifact the contract package publishes,
 * its OpenAPI document. Every name, type, bound, default, enum, and description
 * a metrics tool advertises is read out of `@ancplua/qyl-api-schema/openapi` at
 * startup; nothing here is typed by hand except which operation a tool wraps,
 * which is the same standing as `Operations.TracesApi_list.Response.200` being
 * named in contract-validation.ts. A parameter added, retyped, or re-bounded on
 * the collector side therefore moves the tool's advertised input and fails the
 * G10b manifest snapshot, instead of drifting silently.
 *
 * This module is deliberately NOT re-exported through contract-validation.ts:
 * the OpenAPI document is ~730 KB and that module is also imported by the
 * dashboard and workbench browser bundles.
 *
 * When the contract publishes `Mcp.Tools.ListMetricsInput` and friends, delete
 * this file and bind them in contract-validation.ts like every other tool.
 */

import { createRequire } from "node:module";
import { z } from "zod";

const COMPONENT_SCHEMA_PREFIX = "#/components/schemas/";

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
  $ref?: string;
}

interface OpenApiDocument {
  paths: Record<string, { get?: { parameters?: OpenApiParameter[] } }>;
  components: { schemas: Record<string, unknown> };
}

// require() rather than an import attribute: the package's "./openapi" export
// declares no "types" condition, so a static JSON import has no type to resolve
// and `verbatimModuleSyntax` would have to be worked around at every call site.
const publishedOpenApi = createRequire(import.meta.url)(
  "@ancplua/qyl-api-schema/openapi",
) as OpenApiDocument;

/**
 * Rewrite a published parameter schema into the subset `z.fromJSONSchema`
 * accepts, resolving component references as it goes.
 *
 * Two published constructs need it, for the same reasons the contract package's
 * own zod adapter documents: `unevaluatedProperties` is rejected outright by
 * `z.fromJSONSchema` and is only ever used to seal an object, and a
 * `#/components/schemas/...` reference has no meaning once the parameter is
 * lifted out of the OpenAPI document. Resolution is by inlining, which is exact
 * for the enums and scalars parameters actually use and would need a `$defs`
 * carrier if a parameter ever referenced a recursive model.
 */
function resolvePublishedSchema(node: unknown, seen: readonly string[] = []): unknown {
  if (Array.isArray(node)) return node.map((item) => resolvePublishedSchema(item, seen));
  if (typeof node !== "object" || node === null) return node;

  const source = node as Record<string, unknown>;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "unevaluatedProperties" || key === "$ref") continue;
    resolved[key] = resolvePublishedSchema(value, seen);
  }

  const reference = source.$ref;
  if (typeof reference !== "string") return resolved;

  if (!reference.startsWith(COMPONENT_SCHEMA_PREFIX)) {
    throw new Error(`contract-operations: unsupported parameter reference ${reference}`);
  }
  const name = reference.slice(COMPONENT_SCHEMA_PREFIX.length);
  if (seen.includes(name)) {
    throw new Error(
      `contract-operations: ${name} is recursive; a parameter referencing it needs a ` +
        "$defs carrier rather than inlining",
    );
  }
  const target = publishedOpenApi.components.schemas[name];
  if (target === undefined) {
    throw new Error(`contract-operations: ${reference} is not a published component schema`);
  }

  // A `$ref` with siblings is how the contract spells "this published model,
  // with this default" — `aggregation` is `MetricAggregation` plus
  // `default: "avg"`. Dropping the siblings would silently drop the default and
  // leave the tool advertising a required-looking enum with no fallback, so the
  // resolved target is merged UNDER them: the local keywords win.
  return { ...(resolvePublishedSchema(target, [...seen, name]) as object), ...resolved };
}

/**
 * The tool-input schema for one published GET operation.
 *
 * Header parameters are excluded: `ProjectScopeHeader` is the server-owned
 * collector project scope, which QYL_PROJECT sets and a model never supplies —
 * the same boundary the root README states for every other tool.
 */
export function operationInputSchema<TInput>(pathname: string): z.ZodType<TInput> {
  const operation = publishedOpenApi.paths[pathname]?.get;
  if (operation === undefined) {
    throw new Error(`contract-operations: the contract publishes no GET ${pathname}`);
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of operation.parameters ?? []) {
    // A $ref parameter is a shared component; the only one the metrics
    // operations use is the project-scope header.
    if (parameter.$ref !== undefined || parameter.name === undefined) continue;
    if (parameter.in === "header") continue;

    const schema = resolvePublishedSchema(parameter.schema);
    properties[parameter.name] = parameter.description === undefined
      ? schema
      : { ...(schema as Record<string, unknown>), description: parameter.description };
    if (parameter.required === true) required.push(parameter.name);
  }

  if (Object.keys(properties).length === 0) {
    throw new Error(`contract-operations: GET ${pathname} publishes no model-supplied parameters`);
  }

  // The assembled document is JSON Schema by construction — every property came
  // out of the published parameter list — but it is built as plain data, so the
  // cast is what tells the compiler that.
  const assembled = {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  } as Parameters<typeof z.fromJSONSchema>[0];

  return z.fromJSONSchema(assembled) as z.ZodType<TInput>;
}
