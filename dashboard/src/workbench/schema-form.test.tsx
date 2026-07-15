import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SchemaForm, SynchronizedSchemaForm } from "./SchemaForm.js";
import type { JsonSchema } from "./schema.js";

const formSchema: JsonSchema = {
  type: "object",
  title: "Tool arguments",
  required: ["query", "enabled"],
  additionalProperties: false,
  properties: {
    query: { type: "string", title: "Search query", minLength: 2 },
    enabled: { type: "boolean", title: "Enabled" },
    mode: { title: "Mode", enum: ["fast", "safe"] },
    limit: { type: "integer", title: "Limit", minimum: 1, maximum: 10 },
    nested: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
  },
};

test("SchemaForm renders accessible typed recursive controls and validation errors", () => {
  const html = renderToStaticMarkup(
    <SchemaForm
      schema={formSchema}
      value={{ query: "x", enabled: true, mode: "fast", nested: { tags: ["one"] } }}
      onChange={() => {}}
    />,
  );
  assert.match(html, /type="text"/u);
  assert.match(html, /type="checkbox"/u);
  assert.match(html, /type="number"/u);
  assert.match(html, /<select/u);
  assert.match(html, /<fieldset/u);
  assert.match(html, /aria-invalid="true"/u);
  assert.match(html, /Must contain at least 2 characters/u);
  assert.match(html, /<label[^>]+for=/u);
});

test("SynchronizedSchemaForm exposes form and raw JSON modes", () => {
  const formHtml = renderToStaticMarkup(
    <SynchronizedSchemaForm schema={formSchema} defaultMode="form" />,
  );
  const rawHtml = renderToStaticMarkup(
    <SynchronizedSchemaForm schema={formSchema} defaultMode="raw" />,
  );
  assert.match(formHtml, /role="tablist"/u);
  assert.match(formHtml, /aria-selected="true"[^>]*>Form/u);
  assert.match(rawHtml, /<textarea/u);
  assert.match(rawHtml, /Raw JSON/u);
});
