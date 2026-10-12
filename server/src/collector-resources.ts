/**
 * Collector calls for the objects users create in qyl: annotations (notes on
 * a trace, span or session) and saved queries (named filters).
 *
 * They live in the caller's Collector project like telemetry does, and every
 * call reaches it with the options `runTool` resolved from the verified
 * subject; no argument names a project or a credential. Nothing here changes
 * telemetry: an annotation points at a trace, span or session and leaves it
 * as recorded, and the one delete operation removes only these objects.
 *
 * Demo mode has no Collector and therefore no such objects. A call there is
 * refused rather than answered from an invented store.
 */

import type {
  Annotation,
  CreateAnnotationInput,
  CreateSavedQueryInput,
  DeletableKind,
  ListSavedQueriesInput,
  RunSavedQueryInput,
  SavedQuery,
  SavedQueryRunResult,
  SessionId,
  TraceId,
  UpdateAnnotationInput,
  UpdateSavedQueryInput,
} from "@ancplua/qyl-api-schema/types";
import {
  CollectorError,
  type CollectorRequestOptions,
  collectorDelete,
  collectorGet,
  collectorPatch,
  collectorPost,
  parseCollectorBody,
  parseCollectorPage,
  resolveMode,
} from "./collector.js";
import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER } from "./contract-headers.js";
import { contractSchema } from "./contract-validation.js";
import { describeToolError, type ToolScope } from "./request-scope.js";
import { shortId } from "./summaries.js";
import { redactTelemetry } from "./telemetry-redaction.js";

const ANNOTATIONS_PATH = "/api/v1/annotations";
const SAVED_QUERIES_PATH = "/api/v1/saved-queries";

// The operations' own bodies. They are bound here rather than in
// contract-validation.ts, which the dashboard and workbench bundles import.
const AnnotationCreatedSchema = contractSchema("Operations.AnnotationsApi_create.Response.201");
const AnnotationUpdatedSchema = contractSchema("Operations.AnnotationsApi_update.Response.200");
const AnnotationsPageSchema = contractSchema("Operations.AnnotationsApi_list.Response.200");
const SavedQueryCreatedSchema = contractSchema("Operations.SavedQueriesApi_create.Response.201");
const SavedQueryUpdatedSchema = contractSchema("Operations.SavedQueriesApi_update.Response.200");
const SavedQueriesPageSchema = contractSchema("Operations.SavedQueriesApi_list.Response.200");
const SavedQueryRunSchema = contractSchema("Operations.SavedQueriesApi_run.Response.200");

/** One page of the Collector's annotation listing per read-back. */
const ANNOTATIONS_PER_READ = 100;
/** Parallel annotation reads for one list_sessions page. */
const SESSION_READ_CONCURRENCY = 8;

/** Where each deletable kind lives on the Collector API. */
const DELETE_PATHS: Readonly<Record<DeletableKind, string>> = {
  annotation: ANNOTATIONS_PATH,
  saved_query: SAVED_QUERIES_PATH,
};

/** Refuses demo mode: its generated dataset has no project to keep these objects in. */
async function requireLiveCollector(tool: string): Promise<void> {
  if (await resolveMode() === "live") return;
  throw new CollectorError(
    `${tool} needs a live qyl Collector: annotations and saved queries are kept in a Collector ` +
      "project, and demo mode (QYL_DEMO=1) has none. Set QYL_COLLECTOR_URL and unset QYL_DEMO.",
    false,
    undefined,
    "invalid_argument",
  );
}

/**
 * The If-Match value for a change. An etag is opaque, but it travels as an
 * HTTP field value, so one that could not be sent is refused here instead of
 * failing inside fetch as if the Collector were unreachable.
 */
export function ifMatch(etag: string): Readonly<Record<string, string>> {
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u.test(etag)) {
    throw new CollectorError("etag is not a valid HTTP field value; pass the etag a qyl tool returned");
  }
  return { [IF_MATCH_HEADER]: etag };
}

/** Explicit retry keys deduplicate creates for 24 hours; absent keys create new objects. */
function idempotencyKey(options: CollectorRequestOptions, suppliedKey?: string): Readonly<Record<string, string>> {
  if (suppliedKey === undefined) return {};
  const digest = createHash("sha256")
    .update(`${options.access?.project ?? ""}\0${suppliedKey}`)
    .digest("hex");
  return { [IDEMPOTENCY_KEY_HEADER]: digest };
}

function resourcePath(base: string, id: string, suffix = ""): string {
  return `${base}/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Runs one Collector call and names its refusals for what the caller tried:
 * a status listed in `messages` becomes that message, keeping the code the
 * status decides (`not_found`, `conflict`, `precondition_failed`,
 * `collector_unauthorized`). A body that breaks the contract stays a
 * contract mismatch, and every other failure passes through unchanged.
 */
async function refusals<T>(
  messages: Readonly<Partial<Record<number, string>>>,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof CollectorError) || error.status === undefined || error.code === "contract_mismatch") {
      throw error;
    }
    const message = messages[error.status];
    if (message === undefined) throw error;
    throw new CollectorError(message, false, error.status);
  }
}

/** The refusals every change to an existing object shares. */
function changeRefusals(kind: string, id: string, role: "write" | "delete"): Partial<Record<number, string>> {
  return {
    403: `the Collector refused the change: the server's Collector key needs the ${role} role`,
    404: `${kind} not found: ${id}`,
    412: `${kind} ${id} changed since that etag was read; read it again for its current etag`,
  };
}

export async function createAnnotation(
  input: CreateAnnotationInput,
  options: CollectorRequestOptions,
): Promise<Annotation> {
  await requireLiveCollector("create_annotation");
  // The create's 404 is its target: nothing by that id is recorded in this
  // project, so there is nothing to attach the note to.
  const create = {
    target: input.target, text: input.text,
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.classification === undefined ? {} : { classification: input.classification }),
  };
  const body = await refusals(
    {
      403: "the Collector refused the change: the server's Collector key needs the write role",
      404: `${describeTarget(input.target)} is not recorded in this project`,
    },
    () => collectorPost(ANNOTATIONS_PATH, create, {
      ...options,
      headers: { ...options.headers, ...idempotencyKey(options, input.idempotency_key) },
    }),
  );
  return redactTelemetry(parseCollectorBody(body, `POST ${ANNOTATIONS_PATH}`, AnnotationCreatedSchema));
}

export async function updateAnnotation(
  input: UpdateAnnotationInput,
  options: CollectorRequestOptions,
): Promise<Annotation> {
  await requireLiveCollector("update_annotation");
  const path = resourcePath(ANNOTATIONS_PATH, input.id);
  const changes = {
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.classification === undefined ? {} : { classification: input.classification }),
  };
  if (Object.keys(changes).length === 0) {
    throw new CollectorError("update_annotation changes nothing: pass text, labels or classification");
  }
  const body = await refusals(changeRefusals("annotation", input.id, "write"), () =>
    collectorPatch(path, changes, { ...options, headers: ifMatch(input.etag) }));
  return redactTelemetry(parseCollectorBody(body, `PATCH ${path}`, AnnotationUpdatedSchema));
}

export async function createSavedQuery(
  input: CreateSavedQueryInput,
  options: CollectorRequestOptions,
): Promise<SavedQuery> {
  await requireLiveCollector("create_saved_query");
  const create = {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    filter: input.filter,
  };
  const body = await refusals(
    {
      403: "the Collector refused the change: the server's Collector key needs the write role",
      409: `a saved query named "${input.name}" already exists in this project`,
    },
    () => collectorPost(SAVED_QUERIES_PATH, create, {
      ...options,
      headers: { ...options.headers, ...idempotencyKey(options, input.idempotency_key) },
    }),
  );
  return redactTelemetry(parseCollectorBody(body, `POST ${SAVED_QUERIES_PATH}`, SavedQueryCreatedSchema));
}

export async function updateSavedQuery(
  input: UpdateSavedQueryInput,
  options: CollectorRequestOptions,
): Promise<SavedQuery> {
  const { id, etag, ...changes } = input;
  if (changes.name === undefined && changes.description === undefined && changes.filter === undefined) {
    throw new CollectorError("update_saved_query changes nothing: pass a name, description or filter");
  }
  await requireLiveCollector("update_saved_query");
  const path = resourcePath(SAVED_QUERIES_PATH, id);
  const body = await refusals(
    {
      ...changeRefusals("saved query", id, "write"),
      409: `a saved query named "${changes.name ?? ""}" already exists in this project`,
    },
    () => collectorPatch(path, changes, { ...options, headers: ifMatch(etag) }),
  );
  return redactTelemetry(parseCollectorBody(body, `PATCH ${path}`, SavedQueryUpdatedSchema));
}

export interface SavedQueryPage {
  savedQueries: SavedQuery[];
  hasMore: boolean;
  nextCursor?: string;
}

export async function listSavedQueries(
  input: ListSavedQueriesInput,
  options: CollectorRequestOptions,
): Promise<SavedQueryPage> {
  await requireLiveCollector("list_saved_queries");
  const body = await collectorGet(
    SAVED_QUERIES_PATH,
    { signal: input.signal, limit: input.limit ?? 20, cursor: input.cursor },
    options,
  );
  const page = parseCollectorPage(body, SAVED_QUERIES_PATH, SavedQueriesPageSchema, (item) => item as SavedQuery);
  return redactTelemetry({
    savedQueries: page.items,
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}

export async function runSavedQuery(
  input: RunSavedQueryInput,
  options: CollectorRequestOptions,
): Promise<SavedQueryRunResult> {
  const { id, ...run } = input;
  await requireLiveCollector("run_saved_query");
  const path = resourcePath(SAVED_QUERIES_PATH, id, ":run");
  const body = await refusals({ 404: `saved query not found: ${id}` }, () => collectorPost(path, run, options));
  return redactTelemetry(parseCollectorBody(body, `POST ${path}`, SavedQueryRunSchema));
}

export async function deleteResource(
  kind: DeletableKind,
  id: string,
  etag: string,
  options: CollectorRequestOptions,
): Promise<void> {
  await requireLiveCollector("delete");
  const path = resourcePath(DELETE_PATHS[kind], id);
  const body = await refusals(
    changeRefusals(kind === "annotation" ? "annotation" : "saved query", id, "delete"),
    () => collectorDelete(path, { ...options, headers: ifMatch(etag) }),
  );
  if (body !== undefined) {
    throw new CollectorError(
      `collector contract mismatch for DELETE ${path}: expected 204 No Content`,
      false,
      undefined,
      "contract_mismatch",
    );
  }
}

// -----------------------------------------------------------------------------
// Read-back: get_trace and list_sessions return the annotations on what they
// read, so there is no annotation listing tool.
// -----------------------------------------------------------------------------

/** What a read tool adds to its result: the annotations and one text line. */
export interface AnnotationReadBack {
  /** Present when the read succeeded; absent in demo mode and when it failed. */
  annotations?: Annotation[];
  /** Appended to the tool's text summary; empty when there is nothing to say. */
  text: string;
}

/** The telemetry object an annotation names, in full. */
export function describeTarget(target: Annotation["target"]): string {
  switch (target.kind) {
    case "trace":
      return `trace ${target.trace_id}`;
    case "span":
      return `span ${target.span_id} of trace ${target.trace_id}`;
    case "session":
      return `session ${target.session_id}`;
    case "failure":
      return `failure ${target.failure_id}`;
  }
}

function targetLabel(target: Annotation["target"]): string {
  switch (target.kind) {
    case "trace":
      return `trace ${shortId(target.trace_id)}`;
    case "span":
      return `span ${target.span_id}`;
    case "session":
      return `session ${target.session_id}`;
    case "failure":
      return `failure ${target.failure_id}`;
  }
}

/** One text line per annotation: what it is on, how to change it, and the note. */
export function annotationLine(annotation: Annotation): string {
  const note = annotation.text.replace(/\s+/gu, " ");
  const text = note.length > 200 ? `${note.slice(0, 200)}…` : note;
  return `- ${targetLabel(annotation.target)} · id ${annotation.id} · etag ${annotation.etag}: ${text}`;
}

/** The text block for a list of annotations, newest first. */
export function summarizeAnnotations(annotations: readonly Annotation[], truncated: boolean): string {
  if (annotations.length === 0) return "\nAnnotations: none.";
  return (
    `\nAnnotations (${annotations.length}, newest first${truncated ? `; the newest ${ANNOTATIONS_PER_READ} per object` : ""}):\n` +
    annotations.map(annotationLine).join("\n")
  );
}

async function readAnnotationPage(
  params: { trace_id?: TraceId; session_id?: SessionId },
  options: CollectorRequestOptions,
): Promise<{ annotations: Annotation[]; hasMore: boolean }> {
  const body = await collectorGet(ANNOTATIONS_PATH, { ...params, limit: ANNOTATIONS_PER_READ }, options);
  const page = parseCollectorPage(body, ANNOTATIONS_PATH, AnnotationsPageSchema, (item) => item as Annotation);
  return { annotations: page.items, hasMore: page.hasMore };
}

/**
 * An annotation read that fails leaves the telemetry result standing: the
 * field is omitted and the text says why, instead of failing a trace read
 * that succeeded or reporting "no annotations" that were never read.
 */
function unavailable(error: unknown): AnnotationReadBack {
  return { text: `\nAnnotations could not be read: ${describeToolError(error).message}` };
}

/** The annotations on one trace and its spans, for get_trace. */
export async function readTraceAnnotations(traceId: TraceId, scope: ToolScope): Promise<AnnotationReadBack> {
  if (await resolveMode() === "demo") {
    await scope.step("Demo data carries no annotations");
    return { text: "" };
  }
  try {
    const { annotations, hasMore } = await readAnnotationPage({ trace_id: traceId }, scope.collector);
    await scope.step(`Read ${annotations.length} annotation(s) for trace ${traceId}`);
    const safe = redactTelemetry(annotations);
    return { annotations: safe, text: summarizeAnnotations(safe, hasMore) };
  } catch (error) {
    await scope.step("Annotations unavailable");
    return unavailable(error);
  }
}

/** The annotations on the listed sessions, newest first, for list_sessions. */
export async function readSessionAnnotations(
  sessionIds: readonly SessionId[],
  scope: ToolScope,
): Promise<AnnotationReadBack> {
  if (await resolveMode() === "demo") {
    await scope.step("Demo data carries no annotations");
    return { text: "" };
  }
  if (sessionIds.length === 0) {
    await scope.step("No sessions to read annotations for");
    return { annotations: [], text: "" };
  }
  try {
    // One session's failed page costs that session's notes, not every session's.
    const pages: Array<{ annotations: Annotation[]; hasMore: boolean }> = [];
    let failed = 0;
    let firstFailure: unknown;
    for (let start = 0; start < sessionIds.length; start += SESSION_READ_CONCURRENCY) {
      const settled = await Promise.allSettled(sessionIds
        .slice(start, start + SESSION_READ_CONCURRENCY)
        .map((sessionId) => readAnnotationPage({ session_id: sessionId }, scope.collector)));
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") pages.push(outcome.value);
        else {
          failed += 1;
          firstFailure ??= outcome.reason;
        }
      }
    }
    if (pages.length === 0) throw firstFailure;
    const annotations = pages
      .flatMap((page) => page.annotations)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    await scope.step(`Read ${annotations.length} annotation(s) for ${sessionIds.length} session(s)`);
    const safe = redactTelemetry(annotations);
    const partial = failed === 0
      ? ""
      : `\nAnnotations of ${failed} session(s) could not be read: ${describeToolError(firstFailure).message}`;
    return { annotations: safe, text: summarizeAnnotations(safe, pages.some((page) => page.hasMore)) + partial };
  } catch (error) {
    await scope.step("Annotations unavailable");
    return unavailable(error);
  }
}
