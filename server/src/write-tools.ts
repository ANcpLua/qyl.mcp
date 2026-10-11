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
 * Annotations follow the contract's tool table: create is not idempotent (each
 * call adds a note), update and delete are destructive and idempotent (they
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
  ListSavedQueriesInput,
  ListSavedQueriesOutput,
  RunSavedQueryInput,
  RunSavedQueryOutput,
  SavedQuery,
  SavedQueryOutput,
  SavedQueryRunResult,
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
  listSavedQueries,
  runSavedQuery,
  updateAnnotation,
  updateSavedQuery,
} from "./collector-resources.js";
import { QYL_MCP_DELETE_SCOPE, QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE } from "./oauth.js";
import { runTool } from "./request-scope.js";
import { humanizeNs, pageNote, shortId } from "./summaries.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import { assertToolScopes, toolScopeChallenge } from "./tool-scopes.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";

/** Adds an object; a repeated call adds another. */
export const CREATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
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

const WRITE_SCOPES = [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] as const;
const DELETE_SCOPES = [QYL_MCP_SCOPE, QYL_MCP_DELETE_SCOPE] as const;

/** OpenAI's per-tool `securitySchemes`, in the `_meta` form the read tools use. */
function securityMeta(scopes: readonly string[]): { securitySchemes: { type: "oauth2"; scopes: string[] }[] } {
  return { securitySchemes: [{ type: "oauth2", scopes: [...scopes] }] };
}

const CreateAnnotationInputSchema = contractSchema("Mcp.Tools.CreateAnnotationInput");
const UpdateAnnotationInputSchema = contractSchema("Mcp.Tools.UpdateAnnotationInput");
const AnnotationOutputSchema = contractSchema("Mcp.Tools.AnnotationOutput");
const CreateSavedQueryInputSchema = contractSchema("Mcp.Tools.CreateSavedQueryInput");
const UpdateSavedQueryInputSchema = contractSchema("Mcp.Tools.UpdateSavedQueryInput");
const SavedQueryOutputSchema = contractSchema("Mcp.Tools.SavedQueryOutput");
const ListSavedQueriesInputSchema = contractSchema("Mcp.Tools.ListSavedQueriesInput");
const ListSavedQueriesOutputSchema = contractSchema("Mcp.Tools.ListSavedQueriesOutput");
const RunSavedQueryInputSchema = contractSchema("Mcp.Tools.RunSavedQueryInput");
const RunSavedQueryOutputSchema = contractSchema("Mcp.Tools.RunSavedQueryOutput");
const DeleteInputSchema = contractSchema("Mcp.Tools.DeleteInput");
const DeleteOutputSchema = contractSchema("Mcp.Tools.DeleteOutput");

function savedQueryLine(query: SavedQuery): string {
  const description = query.description ? ` — ${query.description.replace(/\s+/gu, " ").slice(0, 120)}` : "";
  return `- ${query.name} (${query.filter.signal}) · id ${query.id} · etag ${query.etag}${description}`;
}

function summarizeRun(id: string, result: SavedQueryRunResult): string {
  switch (result.signal) {
    case "traces": {
      const rows = result.items.map((trace) =>
        `- ${shortId(trace.trace_id)} ${trace.root_span?.name ?? "unknown root"} · ${humanizeNs(trace.duration_ns)} · ` +
          `${trace.span_count} spans · ${trace.has_error ? "ERROR" : "OK"} · ${trace.services.slice(0, 3).join(", ")}`);
      return `Saved query ${id}: ${result.items.length} trace(s)` +
        (rows.length === 0 ? "." : `\n${rows.join("\n")}`) + pageNote({ hasMore: result.has_more });
    }
    case "logs":
      return `Saved query ${id}: ${result.items.length} log record(s); the records are in the structured result.` +
        pageNote({ hasMore: result.has_more });
    case "metrics":
      return `Saved query ${id}: ${result.result.name} ${result.result.aggregation} over ` +
        `${result.result.start_time}..${result.result.end_time}, ${result.result.series.length} series` +
        (result.result.truncated ? " (truncated at the series limit)" : "") + ".";
  }
}

/** Registers the seven tools; every handler runs inside runTool. */
export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "create_annotation",
    {
      title: "Create Annotation",
      description:
        "Attach a plain-text note of at most 2000 characters to a trace, a span or a session " +
        "in the user's qyl project when the user wants to record a finding next to the telemetry. " +
        "The note leaves the telemetry it points at unchanged; get_trace and list_sessions return " +
        "it with its id and etag. Each call adds a new annotation.",
      inputSchema: CreateAnnotationInputSchema,
      outputSchema: compactOutputSchema(AnnotationOutputSchema),
      annotations: CREATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("create_annotation", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: CreateAnnotationInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        assertToolScopes("create_annotation", WRITE_SCOPES, ctx.http?.authInfo);
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
      description:
        "Replace the text of one annotation when the user wants to correct or extend a note. " +
        "Pass its id and current etag from get_trace, list_sessions or create_annotation; a stale " +
        "etag is refused instead of overwriting a newer version. What the note is attached to stays fixed.",
      inputSchema: UpdateAnnotationInputSchema,
      outputSchema: compactOutputSchema(AnnotationOutputSchema),
      annotations: UPDATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("update_annotation", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: UpdateAnnotationInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        assertToolScopes("update_annotation", WRITE_SCOPES, ctx.http?.authInfo);
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
      description:
        "Save a named filter for traces, logs or metrics in the user's qyl project when the user " +
        "wants to ask the same question again later. Names are unique per project. Only the filter " +
        "is stored, never results; run_saved_query evaluates it against the telemetry of that moment.",
      inputSchema: CreateSavedQueryInputSchema,
      outputSchema: compactOutputSchema(SavedQueryOutputSchema),
      annotations: CREATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("create_saved_query", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: CreateSavedQueryInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        assertToolScopes("create_saved_query", WRITE_SCOPES, ctx.http?.authInfo);
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
      description:
        "Rename a saved query or change its description or filter when the user wants to adjust a " +
        "stored question. Pass its id and current etag from list_saved_queries or create_saved_query; " +
        "omitted fields keep their value, and a stale etag is refused instead of overwriting a newer version.",
      inputSchema: UpdateSavedQueryInputSchema,
      outputSchema: compactOutputSchema(SavedQueryOutputSchema),
      annotations: UPDATE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("update_saved_query", WRITE_SCOPES),
      _meta: securityMeta(WRITE_SCOPES),
    },
    (args: UpdateSavedQueryInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        assertToolScopes("update_saved_query", WRITE_SCOPES, ctx.http?.authInfo);
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
      description:
        "List the saved queries in the user's qyl project by name when the user wants to find a " +
        "stored question to run, change or delete, optionally only those for traces, logs or metrics. " +
        "Each entry carries its id, etag and filter; pass next_cursor as cursor for the next page.",
      inputSchema: ListSavedQueriesInputSchema,
      outputSchema: compactOutputSchema(ListSavedQueriesOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: ListSavedQueriesInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const page = await listSavedQueries(args, scope.collector);
        await scope.step(`Fetched ${page.savedQueries.length} saved query(s)`);
        const output: ListSavedQueriesOutput = {
          saved_queries: page.savedQueries,
          has_more: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
        };
        const text = page.savedQueries.length === 0
          ? `No saved queries${args.signal === undefined ? "" : ` for ${args.signal}`} in this project.`
          : `Saved queries (${page.savedQueries.length}):\n${page.savedQueries.map(savedQueryLine).join("\n")}`;
        return telemetryToolResult(text + pageNote(page), output);
      }),
  );

  server.registerTool(
    "run_saved_query",
    {
      title: "Run Saved Query",
      description:
        "Run one saved query against the current telemetry when the user wants the stored question's " +
        "answer now: trace summaries, log records or a metric range result, depending on its signal. " +
        "It only reads. start_time and end_time replace the saved look-back window, and next_cursor " +
        "pages trace and log results.",
      inputSchema: RunSavedQueryInputSchema,
      outputSchema: compactOutputSchema(RunSavedQueryOutputSchema),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args: RunSavedQueryInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        const result = await runSavedQuery(args, scope.collector);
        await scope.step(`Ran saved query ${args.id}`);
        const output: RunSavedQueryOutput = { result, mode: "live" };
        return telemetryToolResult(summarizeRun(args.id, result), output);
      }),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete Annotation or Saved Query",
      description:
        "Delete one annotation or saved query by id when the user asks to remove it. Pass its current " +
        "etag; a stale etag is refused instead of deleting a newer version. It deletes only objects users " +
        "created in qyl, never traces, logs or metrics: retention removes telemetry.",
      inputSchema: DeleteInputSchema,
      outputSchema: compactOutputSchema(DeleteOutputSchema),
      annotations: DELETE_TOOL_ANNOTATIONS,
      scopeChallenge: toolScopeChallenge("delete", DELETE_SCOPES),
      _meta: securityMeta(DELETE_SCOPES),
    },
    (args: DeleteInput, ctx: ServerContext): Promise<CallToolResult> =>
      runTool(ctx, 1, async (scope) => {
        assertToolScopes("delete", DELETE_SCOPES, ctx.http?.authInfo);
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
