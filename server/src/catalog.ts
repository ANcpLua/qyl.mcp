/**
 * Catalog infrastructure tools: search_qyl_tools + execute_qyl_tool.
 *
 * Everything in CATALOG_TOOLS is reachable through these two instead of
 * occupying its own tools/list slot. Failures follow the error rule: clear
 * `isError: true` text, never a thrown exception.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CATALOG_TOOLS, findCatalogTool, toolError } from "./tools.js";

function catalogToolNames(): string {
  return CATALOG_TOOLS.map((tool) => tool.name).join(", ");
}

function toJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  try {
    // io: "input" — callers see the pre-parse shape, where defaulted
    // parameters are optional (the default io: "output" would mark them
    // required because parsing always materializes them).
    return z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  } catch {
    // A shape that resists JSON Schema conversion still deserves a listing.
    return { type: "object" };
  }
}

export function registerCatalogInfrastructure(server: McpServer): void {
  server.registerTool(
    "search_qyl_tools",
    {
      title: "Search qyl Tools",
      description:
        "Search the qyl tool catalog (tools not exposed in tools/list: " +
        `${catalogToolNames()}). Returns matching tool names, descriptions, and ` +
        "input schemas. Call execute_qyl_tool to run one. Omit the query to " +
        "list the whole catalog.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive keyword match on tool name/title/description; omit for all"),
      },
      outputSchema: {
        tools: z.array(
          z.object({
            name: z.string(),
            title: z.string(),
            description: z.string(),
            input_schema: z.record(z.string(), z.unknown()),
          }),
        ),
      },
    },
    async ({ query }): Promise<CallToolResult> => {
      try {
        const needle = query?.toLowerCase().trim();
        const matches = CATALOG_TOOLS.filter(
          (tool) =>
            !needle ||
            tool.name.toLowerCase().includes(needle) ||
            tool.title.toLowerCase().includes(needle) ||
            tool.description.toLowerCase().includes(needle),
        );
        const tools = matches.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          input_schema: toJsonSchema(tool.inputSchema),
        }));
        const text =
          tools.length === 0
            ? `No catalog tools matched "${query}". Available: ${catalogToolNames()}.`
            : tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { tools } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "execute_qyl_tool",
    {
      title: "Execute qyl Tool",
      description:
        "Execute a tool from the qyl tool catalog by name (discover names and " +
        "schemas with search_qyl_tools). Returns the tool's own result.",
      inputSchema: {
        name: z.string().min(1).describe("Catalog tool name (from search_qyl_tools)"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments matching the tool's input schema"),
      },
      // No outputSchema on purpose: results pass through with the executed
      // tool's own structuredContent shape.
    },
    async ({ name, arguments: args }): Promise<CallToolResult> => {
      const tool = findCatalogTool(name);
      if (!tool) {
        return toolError(
          new Error(`Unknown catalog tool '${name}'. Available: ${catalogToolNames()}.`),
        );
      }
      const parsed = z.object(tool.inputSchema).safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return toolError(new Error(`Invalid arguments for '${name}': ${issues}`));
      }
      try {
        const result = await tool.handler(parsed.data);
        // Catalog tools are not registered on the MCP server, so the SDK's
        // output validation never sees them — validate here against the def's
        // outputSchema (as isError text, never a throw) to keep the guarantee
        // the monolith had via registerTool.
        if (!result.isError && result.structuredContent) {
          const out = z.object(tool.outputSchema).safeParse(result.structuredContent);
          if (!out.success) {
            const issues = out.error.issues
              .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
              .join("; ");
            return toolError(new Error(`Output validation error for '${name}': ${issues}`));
          }
        }
        return result;
      } catch (err) {
        // Handlers return isError themselves; this is the belt to that brace.
        return toolError(err);
      }
    },
  );
}
