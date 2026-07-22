import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentRenderer } from "./ContentRenderer.js";
import { JsonCodeView, SchemaViewer } from "./JsonCodeView.js";
import {
  estimatedBase64Bytes,
  safeExternalHref,
  safeImageDataUrl,
} from "./content-safety.js";

test("malicious HTML in text, resources, schemas, and structured content remains escaped text", () => {
  const attack = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>';
  const result: CallToolResult = {
    content: [
      { type: "text", text: attack },
      {
        type: "resource",
        resource: { uri: "resource://attack", mimeType: "text/html", text: attack },
      },
    ],
    structuredContent: { attack },
  };
  const html = renderToStaticMarkup(<ContentRenderer result={result} />);
  assert.doesNotMatch(html, /<script>|<img src=x/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);

  const jsonHtml = renderToStaticMarkup(<JsonCodeView value={{ attack }} />);
  const schemaHtml = renderToStaticMarkup(<SchemaViewer schema={{ description: attack }} />);
  assert.doesNotMatch(jsonHtml, /<script>/u);
  assert.doesNotMatch(schemaHtml, /<script>/u);
});

test("unsafe resource URL schemes and credentials are blocked", () => {
  assert.equal(safeExternalHref("javascript:alert(1)"), null);
  assert.equal(safeExternalHref("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeExternalHref("https://user:secret@example.com/private"), null);
  assert.equal(safeExternalHref("https://example.com/path"), "https://example.com/path");

  const result: CallToolResult = {
    content: [{ type: "resource_link", uri: "javascript:alert(1)", name: "unsafe" }],
  };
  const html = renderToStaticMarkup(<ContentRenderer result={result} />);
  assert.doesNotMatch(html, /href=/u);
  assert.match(html, /data-link-blocked="true"/u);
});

test("only allowlisted raster image MIME types become data URLs", () => {
  const png = { type: "image", mimeType: "image/png", data: "aGVsbG8=" } as const;
  const svg = { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" } as const;
  assert.equal(safeImageDataUrl(png), "data:image/png;base64,aGVsbG8=");
  assert.equal(safeImageDataUrl(svg), null);
  assert.equal(safeImageDataUrl({ ...png, data: "not base64!" }), null);
  assert.equal(estimatedBase64Bytes(png.data), 5);
});

test("audio renders metadata without embedding its bytes", () => {
  const result: CallToolResult = {
    content: [{ type: "audio", mimeType: "audio/wav", data: "c2VjcmV0LWF1ZGlv" }],
  };
  const html = renderToStaticMarkup(<ContentRenderer result={result} />);
  assert.match(html, /Audio attachment/u);
  assert.doesNotMatch(html, /c2VjcmV0LWF1ZGlv/u);
  assert.doesNotMatch(html, /<audio/u);
});

test("safe HTTPS resource links render with opener protections", () => {
  const result: CallToolResult = {
    content: [{ type: "resource_link", uri: "https://example.com/report", name: "report" }],
  };
  const html = renderToStaticMarkup(<ContentRenderer result={result} />);
  assert.match(html, /href="https:\/\/example\.com\/report"/u);
  assert.match(html, /rel="noopener noreferrer"/u);
});
