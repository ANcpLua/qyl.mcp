import type { Prompt, Resource, ResourceTemplateType as ResourceTemplateDescriptor, Tool } from "@modelcontextprotocol/server";
import * as z from "zod";

export const FIXTURE_PAGE_SIZE = 2;

export const SAFE_LOOKUP_INPUT = z.object({
  query: z.string().min(1).max(200).describe("Text to look up in the deterministic fixture catalog"),
});

export const SAFE_LOOKUP_OUTPUT = z.object({
  query: z.string(),
  matches: z.array(z.string()),
});

export const EVIDENCE_INPUT = z.object({
  query: z.string().min(1).max(200),
});

export const EVIDENCE_OUTPUT = z.object({
  query: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimated: z.boolean(),
  }),
  cost: z.object({
    amount_usd: z.number().nonnegative(),
    estimated: z.boolean(),
    source: z.string(),
  }),
});

export const RICH_RESULT_INPUT = z.object({
  reportId: z.string().min(1).max(80).default("example"),
});

export const RICH_RESULT_OUTPUT = z.object({
  reportId: z.string(),
  status: z.literal("ready"),
  itemCount: z.number().int().nonnegative(),
});

export const DELETE_RECORD_INPUT = z.object({
  recordId: z.string().min(1).max(80),
  confirmation: z.string().describe("Must exactly match `DELETE <recordId>`"),
});

export const DELETE_RECORD_OUTPUT = z.object({
  deleted: z.boolean(),
  recordId: z.string(),
});

export const DELAYED_INPUT = z.object({
  delayMs: z.number().int().min(10).max(5_000).default(250),
});

export const DELAYED_OUTPUT = z.object({
  completed: z.literal(true),
  delayMs: z.number().int(),
});

export const TOOL_ERROR_INPUT = z.object({
  message: z.string().min(1).max(200).default("intentional fixture failure"),
});

// `registerTool` advertises the INPUT projection of an input schema and the
// OUTPUT projection of an output schema. zod's own default is `io: "output"` for
// both, which for an input schema marks a `.default()` field `required` and adds
// `additionalProperties: false` — a stricter contract than the registered
// z.object actually enforces. This catalog backs the fixture's `tools/list`
// override, so the projection has to match what the SDK would have advertised.
function objectJsonSchema(schema: z.ZodType, io: "input" | "output"): Tool["inputSchema"] {
  return z.toJSONSchema(schema, { io }) as Tool["inputSchema"];
}

export const FIXTURE_TOOLS = [
  {
    name: "fixture.safe_lookup",
    title: "Safe catalog lookup",
    description: "Reads deterministic fixture data without external side effects.",
    inputSchema: objectJsonSchema(SAFE_LOOKUP_INPUT, "input"),
    outputSchema: objectJsonSchema(SAFE_LOOKUP_OUTPUT, "output"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fixture.rich_result",
    title: "Structured and multimodal result",
    description: "Returns structured data, an image, a resource link, and untrusted markup as inert data.",
    inputSchema: objectJsonSchema(RICH_RESULT_INPUT, "input"),
    outputSchema: objectJsonSchema(RICH_RESULT_OUTPUT, "output"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fixture.evidence",
    title: "Explicit usage and cost evidence",
    description: "Returns observed usage and cost metadata without requiring qyl.mcp to estimate it.",
    inputSchema: objectJsonSchema(EVIDENCE_INPUT, "input"),
    outputSchema: objectJsonSchema(EVIDENCE_OUTPUT, "output"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fixture.delete_record",
    title: "Delete fixture record",
    description: "Exercises an explicitly consequential and destructive operation.",
    inputSchema: objectJsonSchema(DELETE_RECORD_INPUT, "input"),
    outputSchema: objectJsonSchema(DELETE_RECORD_OUTPUT, "output"),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "fixture.delayed",
    title: "Cancellable delayed operation",
    description: "Waits for a bounded duration and observes MCP request cancellation.",
    inputSchema: objectJsonSchema(DELAYED_INPUT, "input"),
    outputSchema: objectJsonSchema(DELAYED_OUTPUT, "output"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fixture.tool_error",
    title: "Intentional tool error",
    description: "Returns a standard MCP tool result with isError set for error-path tests.",
    inputSchema: objectJsonSchema(TOOL_ERROR_INPUT, "input"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] satisfies Tool[];

export const FIXTURE_RESOURCES = [
  {
    uri: "fixture://catalog/summary",
    name: "fixture-summary",
    title: "Fixture summary",
    description: "Plain-text fixture catalog summary.",
    mimeType: "text/plain",
  },
  {
    uri: "fixture://catalog/untrusted-html",
    name: "untrusted-html",
    title: "Untrusted HTML-shaped data",
    description: "Markup used to verify that clients do not execute arbitrary resource content.",
    mimeType: "text/html",
  },
  {
    uri: "fixture://catalog/blob",
    name: "fixture-blob",
    title: "Binary fixture blob",
    description: "Small base64-encoded binary resource.",
    mimeType: "application/octet-stream",
    size: 4,
  },
] satisfies Resource[];

export const FIXTURE_RESOURCE_TEMPLATES = [
  {
    uriTemplate: "fixture://items/{id}",
    name: "fixture-item",
    title: "Fixture item",
    description: "Reads a deterministic item by identifier.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "fixture://reports/{name}",
    name: "fixture-report",
    title: "Fixture report",
    description: "Reads a deterministic report by name.",
    mimeType: "text/plain",
  },
  {
    uriTemplate: "fixture://logs/{scope}",
    name: "fixture-log",
    title: "Fixture log",
    description: "Reads a deterministic log excerpt by scope.",
    mimeType: "text/plain",
  },
] satisfies ResourceTemplateDescriptor[];

export const FIXTURE_PROMPTS = [
  {
    name: "fixture.safe_summary",
    title: "Safe summary",
    description: "Requests a concise summary of fixture data.",
  },
  {
    name: "fixture.review_record",
    title: "Review record",
    description: "Requests a review of a named fixture record.",
    arguments: [
      {
        name: "recordId",
        description: "Fixture record identifier",
        required: true,
      },
    ],
  },
  {
    name: "fixture.rich_context",
    title: "Rich context",
    description: "Returns text plus embedded resource context for prompt rendering tests.",
  },
] satisfies Prompt[];

export const UNTRUSTED_HTML =
  '<section><h1>Fixture markup</h1><script>globalThis.__qylFixtureExecuted = true</script><img src="x" onerror="globalThis.__qylFixtureExecuted = true"></section>';

export const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export class FixtureCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureCursorError";
  }
}

export interface FixturePage<T> {
  items: T[];
  nextCursor?: string;
}

function encodeCursor(surface: string, offset: number): string {
  return Buffer.from(`${surface}:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(surface: string, cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new FixtureCursorError("Malformed fixture pagination cursor");
  }

  const match = /^([a-z-]+):(\d+)$/.exec(decoded);
  if (match === null || match[1] !== surface) {
    throw new FixtureCursorError("Fixture pagination cursor belongs to a different surface");
  }

  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new FixtureCursorError("Invalid fixture pagination offset");
  }

  return offset;
}

export function paginateFixture<T>(
  surface: string,
  values: readonly T[],
  cursor?: string,
  pageSize = FIXTURE_PAGE_SIZE,
): FixturePage<T> {
  if (!/^[a-z-]+$/.test(surface)) {
    throw new TypeError("Fixture pagination surface must use lowercase letters and hyphens");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("Fixture page size must be a positive integer");
  }

  const offset = decodeCursor(surface, cursor);
  if (offset > values.length) {
    throw new FixtureCursorError("Fixture pagination cursor is beyond the available results");
  }

  const items = values.slice(offset, offset + pageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < values.length ? { nextCursor: encodeCursor(surface, nextOffset) } : {}),
  };
}

export function abortableFixtureDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The fixture operation was aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The fixture operation was aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
