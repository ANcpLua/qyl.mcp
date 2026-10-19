/**
 * Collector calls for the objects users create in qyl: annotations (notes on
 * a trace, span or session) and saved queries (named filters).
 *
 * They live in the caller's Collector project like telemetry does, and every
 * call reaches it with the options `runTool` resolved from the verified
 * subject; no argument names a project or a credential. Nothing here changes
 * telemetry: an annotation points at a trace, span or session and leaves it
 * as recorded, and the one delete operation removes only these objects.
 */

import type {
  Annotation,
  CreateAnnotationInput,
  CreateSavedQueryInput,
  DeletableKind,
  SavedQuery,
  UpdateAnnotationInput,
  UpdateSavedQueryInput,
} from "@ancplua/qyl-api-schema/types";
import {
  CollectorError,
  type CollectorRequestOptions,
  collectorDelete,
  collectorPatch,
  collectorPost,
  parseCollectorBody,
} from "./collector.js";
import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER } from "./contract-headers.js";
import { contractSchema } from "./contract-validation.js";
import { shortId } from "./summaries.js";
import { redactTelemetry } from "./telemetry-redaction.js";

const ANNOTATIONS_PATH = "/api/v1/annotations";
const SAVED_QUERIES_PATH = "/api/v1/saved-queries";

// The operations' own bodies, bound where they are used.
const AnnotationCreatedSchema = contractSchema("Operations.AnnotationsApi_create.Response.201");
const AnnotationUpdatedSchema = contractSchema("Operations.AnnotationsApi_update.Response.200");
const SavedQueryCreatedSchema = contractSchema("Operations.SavedQueriesApi_create.Response.201");
const SavedQueryUpdatedSchema = contractSchema("Operations.SavedQueriesApi_update.Response.200");


/** Where each deletable kind lives on the Collector API. */
const DELETE_PATHS: Readonly<Record<DeletableKind, string>> = {
  annotation: ANNOTATIONS_PATH,
  saved_query: SAVED_QUERIES_PATH,
};

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

/** Retry keys deduplicate for 24 hours; identical bodies get a deterministic default key. */
function idempotencyKey(options: CollectorRequestOptions, operation: string, body: object, suppliedKey?: string): Readonly<Record<string, string>> {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const key = suppliedKey ?? JSON.stringify(canonical(body));
  const digest = createHash("sha256")
    .update(`${options.access?.project ?? ""}\0${operation}\0${key}`)
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
export async function refusals<T>(
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
export function changeRefusals(kind: string, id: string, role: "write" | "delete"): Partial<Record<number, string>> {
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
      headers: { ...options.headers, ...idempotencyKey(options, ANNOTATIONS_PATH, create, input.idempotency_key) },
    }),
  );
  return redactTelemetry(parseCollectorBody(body, `POST ${ANNOTATIONS_PATH}`, AnnotationCreatedSchema));
}

export async function updateAnnotation(
  input: UpdateAnnotationInput,
  options: CollectorRequestOptions,
): Promise<Annotation> {
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
      headers: { ...options.headers, ...idempotencyKey(options, SAVED_QUERIES_PATH, create, input.idempotency_key) },
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

export async function deleteResource(
  kind: DeletableKind,
  id: string,
  etag: string,
  options: CollectorRequestOptions,
): Promise<void> {
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
