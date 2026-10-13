/**
 * The tools that change something: annotations, saved queries and the one
 * delete tool, plus the two saved-query reads that belong with them.
 *
 * What they change is limited to objects users create in qyl, inside the
 * verified caller's Collector project: a note on a trace, span or session, and
 * a named filter. No tool here edits or deletes a trace, log or metric;
 * retention alone removes telemetry. Reading and writing stay separate tools,
 * so a host can approve them separately, and each write is its own tool:
 * create, update and delete are never one generic executor.
 *
 * Identical creates are deduplicated for 24 hours; a new explicit retry key
 * requests another object. Update and delete are destructive and idempotent (they
 * replace or remove a version named by its etag, and repeating them changes
 * nothing more). The create and update tools need `qyl:write`, delete needs
 * `qyl:delete`, and the saved-query reads keep `qyl:read` (tool-scopes.ts).
 */

import type {
  AnnotationOutput,
  CreateAnnotationInput,
  CreateSavedQueryInput,
  DeleteInput,
  DeleteOutput,
  SavedQuery,
  SavedQueryOutput,
  UpdateAnnotationInput,
  UpdateSavedQueryInput,
} from "@ancplua/qyl-api-schema/types";
import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { compactOutputSchema, contractSchema } from "./contract-validation.js";
import {
  annotationLine,
  createAnnotation,
  createSavedQuery,
  deleteResource,
  describeTarget,
  updateAnnotation,
  updateSavedQuery,
} from "./collector-resources.js";
import { QYL_MCP_DELETE_SCOPE, QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE } from "./oauth.js";
import { runTool } from "./request-scope.js";
import { queryAnalysis } from "./analysis-client.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import { toolScopeChallenge } from "./tool-scopes.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";

/** Adds an object; identical retries replay for 24 hours. */
export const CREATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/** Replaces the version an etag names; repeating it changes nothing more. */
export const UPDATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/** Removes the version an etag names; repeating it removes nothing more. */
export const DELETE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

export const WRITE_SCOPES = [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] as const;
const DELETE_SCOPES = [QYL_MCP_SCOPE, QYL_MCP_DELETE_SCOPE] as const;

/** OpenAI's per-tool `securitySchemes`, in the `_meta` form the read tools use. */
export function securityMeta(scopes: readonly string[]): { securitySchemes: { type: "oauth2"; scopes: string[] }[] } {
  return { securitySchemes: [{ type: "oauth2", scopes: [...scopes] }] };
}

const CreateAnnotationInputSchema = contractSchema("Mcp.Tools.CreateAnnotationInput");
const UpdateAnnotationInputSchema = contractSchema("Mcp.Tools.UpdateAnnotationInput");
const AnnotationOutputSchema = contractSchema("Mcp.Tools.AnnotationOutput");
const CreateSavedQueryInputSchema = contractSchema("Mcp.Tools.CreateSavedQueryInput");
const UpdateSavedQueryInputSchema = contractSchema("Mcp.Tools.UpdateSavedQueryInput");
const SavedQueryOutputSchema = contractSchema("Mcp.Tools.SavedQueryOutput");
const DeleteInputSchema = contractSchema("Mcp.Tools.DeleteInput");
const DeleteOutputSchema = contractSchema("Mcp.Tools.DeleteOutput");

function savedQueryLine(query: SavedQuery): string {
  const description = query.description ? ` — ${query.description.replace(/\s+/gu, " ").slice(0, 120)}` : "";
  return `- ${query.name} (${query.filter.signal}) · id ${query.id} · etag ${query.etag}${description}`;
}

/** Registers the seven tools; every handler runs inside runTool. */
export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "create_annotation",
    {
      title: "Create Annotation",
      description: "Create a labeled note on a trace, span, session or failure when recording a finding; get_trace, list_sessions or list_failures returns it.",
      inputSchema: CreateAnnotationInputSchema,
      outputSchema: compactOutputSchema(AnnotationOutputSchema),
      annotations: CREATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("create_annotation", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: CreateAnnotationInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const annotation = await createAnnotation(args, scope.collector);
        await scope.step(`Created annotation ${annotation.id}`);
        const output: AnnotationOutput = { annotation };
        return telemetryToolResult(
          `Created annotation ${annotation.id} on ${describeTarget(annotation.target)} (etag ${annotation.etag}).`,
          output,
        );
      }),
  );

  server.registerTool(
    "update_annotation",
    {
      title: "Update Annotation",
      description: "Update annotation text, labels or class with its current etag when revising a finding; get_trace, list_sessions or list_failures returns it.",
      inputSchema: UpdateAnnotationInputSchema,
      outputSchema: compactOutputSchema(AnnotationOutputSchema),
      annotations: UPDATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("update_annotation", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: UpdateAnnotationInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const annotation = await updateAnnotation(args, scope.collector);
        await scope.step(`Updated annotation ${annotation.id}`);
        const output: AnnotationOutput = { annotation };
        return telemetryToolResult(
          `Updated annotation ${annotation.id}; its etag is now ${annotation.etag}.\n${annotationLine(annotation)}`,
          output,
        );
      }),
  );

  server.registerTool(
    "create_saved_query",
    {
      title: "Create Saved Query",
      description: "Store a named telemetry filter when saving a reusable question; list_saved_queries returns it.",
      inputSchema: CreateSavedQueryInputSchema,
      outputSchema: compactOutputSchema(SavedQueryOutputSchema),
      annotations: CREATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("create_saved_query", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: CreateSavedQueryInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const savedQuery = await createSavedQuery(args, scope.collector);
        await scope.step(`Created saved query ${savedQuery.id}`);
        const output: SavedQueryOutput = { saved_query: savedQuery };
        return telemetryToolResult(
          `Created saved query ${savedQuery.name} (${savedQuery.filter.signal}), id ${savedQuery.id}, ` +
            `etag ${savedQuery.etag}.`,
          output,
        );
      }),
  );

  server.registerTool(
    "update_saved_query",
    {
      title: "Update Saved Query",
      description: "Update a saved filter with its current etag when revising a question; list_saved_queries returns it.",
      inputSchema: UpdateSavedQueryInputSchema,
      outputSchema: compactOutputSchema(SavedQueryOutputSchema),
      annotations: UPDATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("update_saved_query", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: UpdateSavedQueryInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const savedQuery = await updateSavedQuery(args, scope.collector);
        await scope.step(`Updated saved query ${savedQuery.id}`);
        const output: SavedQueryOutput = { saved_query: savedQuery };
        return telemetryToolResult(
          `Updated saved query ${savedQuery.id}; its etag is now ${savedQuery.etag}.\n${savedQueryLine(savedQuery)}`,
          output,
        );
      }),
  );

  server.registerTool(
    "list_saved_queries",
    {
      title: "List Saved Queries",
      description: "List saved filters with their current etags when choosing a question to run or edit.",
      inputSchema: contractSchema("Mcp.Tools.ListSavedQueriesInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.ListSavedQueriesOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("list_saved_queries", args, contractSchema("Mcp.Tools.ListSavedQueriesOutput"), scope)),
  );

  server.registerTool(
    "run_saved_query",
    {
      title: "Run Saved Query",
      description: "Evaluate a saved filter against current telemetry when answering a previously saved question.",
      inputSchema: contractSchema("Mcp.Tools.RunSavedQueryInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.RunSavedQueryOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("run_saved_query", args, contractSchema("Mcp.Tools.RunSavedQueryOutput"), scope)),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete Annotation or Saved Query",
      description: "Delete an annotation or saved query with its current etag when removing a stored note or question, never traces, logs or metrics.",
      inputSchema: DeleteInputSchema,
      outputSchema: compactOutputSchema(DeleteOutputSchema),
      annotations: DELETE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("delete", DELETE_SCOPES),
      _meta: securityMeta(DELETE_SCOPES),
    },
    (args: DeleteInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        await deleteResource(args.kind, args.id, args.etag, scope.collector);
        await scope.step(`Deleted ${args.kind} ${args.id}`);
        const output: DeleteOutput = { deleted: true };
        return telemetryToolResult(
          `Deleted ${args.kind === "annotation" ? "annotation" : "saved query"} ${args.id}.`,
          output,
        );
      }),
  );
}
