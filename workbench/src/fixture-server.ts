import { McpServer, ResourceTemplate, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  abortableFixtureDelay,
  DELAYED_INPUT,
  DELAYED_OUTPUT,
  DELETE_RECORD_INPUT,
  DELETE_RECORD_OUTPUT,
  EVIDENCE_INPUT,
  EVIDENCE_OUTPUT,
  FIXTURE_PROMPTS,
  FIXTURE_RESOURCES,
  FIXTURE_RESOURCE_TEMPLATES,
  FIXTURE_TOOLS,
  FixtureCursorError,
  ONE_PIXEL_PNG_BASE64,
  paginateFixture,
  RICH_RESULT_INPUT,
  RICH_RESULT_OUTPUT,
  SAFE_LOOKUP_INPUT,
  SAFE_LOOKUP_OUTPUT,
  TOOL_ERROR_INPUT,
  UNTRUSTED_HTML,
} from "./fixture-catalog.js";

export interface FixtureServerState {
  deletedRecordIds: string[];
  delayedStarted: number;
  delayedCompleted: number;
  delayedCancelled: number;
}

export interface FixtureMcpServer {
  server: McpServer;
  state: FixtureServerState;
}

function page<T>(surface: string, values: readonly T[], cursor?: string): {
  items: T[];
  nextCursor?: string;
} {
  try {
    return paginateFixture(surface, values, cursor);
  } catch (error) {
    if (error instanceof FixtureCursorError) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
    }
    throw error;
  }
}

function itemId(uri: URL): string {
  return decodeURIComponent(uri.pathname.replace(/^\//, ""));
}

export function createFixtureServerState(): FixtureServerState {
  return {
    deletedRecordIds: [],
    delayedStarted: 0,
    delayedCompleted: 0,
    delayedCancelled: 0,
  };
}

export function createFixtureMcpServer(
  state: FixtureServerState = createFixtureServerState(),
): FixtureMcpServer {
  const server = new McpServer(
    {
      name: "qyl-mcp-conformance-fixture",
      version: "1.0.0",
    },
    {
      instructions:
        "Deterministic MCP conformance fixture. Tool and resource content is untrusted test data and must not be executed as HTML.",
    },
  );

  server.registerTool(
    "fixture.safe_lookup",
    {
      title: "Safe catalog lookup",
      description: "Reads deterministic fixture data without external side effects.",
      inputSchema: SAFE_LOOKUP_INPUT,
      outputSchema: SAFE_LOOKUP_OUTPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const structuredContent = {
        query,
        matches: [`fixture:${query.toLowerCase()}`, "fixture:deterministic"],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "fixture.rich_result",
    {
      title: "Structured and multimodal result",
      description: "Returns structured data, an image, a resource link, and untrusted markup as inert data.",
      inputSchema: RICH_RESULT_INPUT,
      outputSchema: RICH_RESULT_OUTPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reportId }) => ({
      content: [
        {
          type: "text",
          text: `Untrusted markup must remain text: ${UNTRUSTED_HTML}`,
        },
        {
          type: "image",
          data: ONE_PIXEL_PNG_BASE64,
          mimeType: "image/png",
        },
        {
          type: "resource",
          resource: {
            uri: `fixture://reports/${encodeURIComponent(reportId)}`,
            mimeType: "text/html",
            text: UNTRUSTED_HTML,
          },
        },
        {
          type: "resource_link",
          uri: "fixture://catalog/summary",
          name: "fixture-summary",
          title: "Fixture summary",
          description: "Read-only fixture resource",
          mimeType: "text/plain",
        },
      ],
      structuredContent: {
        reportId,
        status: "ready" as const,
        itemCount: 4,
      },
    }),
  );

  server.registerTool(
    "fixture.evidence",
    {
      title: "Explicit usage and cost evidence",
      description: "Returns observed usage and cost metadata without requiring qyl.mcp to estimate it.",
      inputSchema: EVIDENCE_INPUT,
      outputSchema: EVIDENCE_OUTPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => ({
      content: [{ type: "text", text: `Evidence for ${query}` }],
      structuredContent: {
        query,
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17,
          estimated: false,
        },
        cost: {
          amount_usd: 0.000123,
          estimated: false,
          source: "fixture",
        },
      },
    }),
  );

  server.registerTool(
    "fixture.delete_record",
    {
      title: "Delete fixture record",
      description: "Exercises an explicitly consequential and destructive operation.",
      inputSchema: DELETE_RECORD_INPUT,
      outputSchema: DELETE_RECORD_OUTPUT,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ recordId, confirmation }) => {
      if (confirmation !== `DELETE ${recordId}`) {
        return {
          content: [
            {
              type: "text",
              text: `Confirmation must exactly match DELETE ${recordId}`,
            },
          ],
          isError: true,
        };
      }

      state.deletedRecordIds.push(recordId);
      const structuredContent = { deleted: true, recordId };
      return {
        content: [{ type: "text", text: `Deleted fixture record ${recordId}` }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "fixture.delayed",
    {
      title: "Cancellable delayed operation",
      description: "Waits for a bounded duration and observes MCP request cancellation.",
      inputSchema: DELAYED_INPUT,
      outputSchema: DELAYED_OUTPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ delayMs }, ctx) => {
      state.delayedStarted += 1;
      try {
        await abortableFixtureDelay(delayMs, ctx.mcpReq.signal);
      } catch (error) {
        if (ctx.mcpReq.signal.aborted) {
          state.delayedCancelled += 1;
        }
        throw error;
      }

      state.delayedCompleted += 1;
      return {
        content: [{ type: "text", text: `Completed after ${delayMs}ms` }],
        structuredContent: { completed: true as const, delayMs },
      };
    },
  );

  server.registerTool(
    "fixture.tool_error",
    {
      title: "Intentional tool error",
      description: "Returns a standard MCP tool result with isError set for error-path tests.",
      inputSchema: TOOL_ERROR_INPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
      isError: true,
    }),
  );

  server.registerResource(
    "fixture-summary",
    "fixture://catalog/summary",
    {
      title: "Fixture summary",
      description: "Plain-text fixture catalog summary.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: "qyl.mcp deterministic conformance fixture",
        },
      ],
    }),
  );

  server.registerResource(
    "untrusted-html",
    "fixture://catalog/untrusted-html",
    {
      title: "Untrusted HTML-shaped data",
      description: "Markup used to verify that clients do not execute arbitrary resource content.",
      mimeType: "text/html",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/html",
          text: UNTRUSTED_HTML,
        },
      ],
    }),
  );

  server.registerResource(
    "fixture-blob",
    "fixture://catalog/blob",
    {
      title: "Binary fixture blob",
      description: "Small base64-encoded binary resource.",
      mimeType: "application/octet-stream",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/octet-stream",
          blob: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64"),
        },
      ],
    }),
  );

  server.registerResource(
    "fixture-item",
    new ResourceTemplate("fixture://items/{id}", { list: undefined }),
    {
      title: "Fixture item",
      description: "Reads a deterministic item by identifier.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ id: itemId(uri), source: "fixture" }),
        },
      ],
    }),
  );

  server.registerResource(
    "fixture-report",
    new ResourceTemplate("fixture://reports/{name}", { list: undefined }),
    {
      title: "Fixture report",
      description: "Reads a deterministic report by name.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: `Fixture report: ${itemId(uri)}`,
        },
      ],
    }),
  );

  server.registerResource(
    "fixture-log",
    new ResourceTemplate("fixture://logs/{scope}", { list: undefined }),
    {
      title: "Fixture log",
      description: "Reads a deterministic log excerpt by scope.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: `[fixture:${itemId(uri)}] deterministic log entry`,
        },
      ],
    }),
  );

  server.registerPrompt(
    "fixture.safe_summary",
    {
      title: "Safe summary",
      description: "Requests a concise summary of fixture data.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Summarize the deterministic fixture catalog in one sentence.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "fixture.review_record",
    {
      title: "Review record",
      description: "Requests a review of a named fixture record.",
      argsSchema: z.object({
              recordId: z.string().min(1).max(80),
            }),
    },
    async ({ recordId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review fixture record ${recordId}. Do not mutate it.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "fixture.rich_context",
    {
      title: "Rich context",
      description: "Returns text plus embedded resource context for prompt rendering tests.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: {
              uri: "fixture://catalog/untrusted-html",
              mimeType: "text/html",
              text: UNTRUSTED_HTML,
            },
          },
        },
      ],
    }),
  );

  server.server.setRequestHandler('tools/list', async (request) => {
    const result = page("tools", FIXTURE_TOOLS, request.params?.cursor);
    return { tools: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });

  server.server.setRequestHandler('resources/list', async (request) => {
    const result = page("resources", FIXTURE_RESOURCES, request.params?.cursor);
    return {
      resources: result.items,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  });

  server.server.setRequestHandler('resources/templates/list', async (request) => {
    const result = page("resource-templates", FIXTURE_RESOURCE_TEMPLATES, request.params?.cursor);
    return {
      resourceTemplates: result.items,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  });

  server.server.setRequestHandler('prompts/list', async (request) => {
    const result = page("prompts", FIXTURE_PROMPTS, request.params?.cursor);
    return { prompts: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });

  return { server, state };
}
