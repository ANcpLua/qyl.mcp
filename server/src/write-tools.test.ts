import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  Client,
  InsufficientScopeError,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  InMemoryTransport,
  type AuthInfo,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { Annotation, SavedQuery } from "@ancplua/qyl-api-schema/types";
import { createResourceAuthorization } from "./authorization.js";
import { API_KEY_HEADER, IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER, PROJECT_HEADER } from "./contract-headers.js";
import { readContext, toolTrace } from "./analysis-context.test-helper.js";
import { getDemo } from "./demo.js";
import {
  QYL_MCP_DELETE_SCOPE,
  QYL_MCP_RESOURCE,
  QYL_MCP_SCOPE,
  QYL_MCP_WRITE_SCOPE,
} from "./oauth.js";
import { createServer } from "./server.js";
import { WWW_AUTHENTICATE_META_KEY } from "./tool-scopes.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS } from "./tools.js";
import {
  CREATE_TOOL_ANNOTATIONS,
  DELETE_TOOL_ANNOTATIONS,
  UPDATE_TOOL_ANNOTATIONS,
} from "./write-tools.js";

const RESOURCE = new URL(QYL_MCP_RESOURCE);
const METADATA_URL = getOAuthProtectedResourceMetadataUrl(RESOURCE);
const OWNER = "auth0|write-owner-test";
const REVIEWER = "auth0|write-reviewer-test";
const PROJECTS = [
  { project: "owner", apiKey: "owner-write-key", subjects: [OWNER] },
  { project: "review", apiKey: "review-write-key", subjects: [REVIEWER] },
];
const TRACE = getDemo().traces[0]!;
const SPAN_ID = TRACE.spans[0]!.span_id;
const SESSION_ID = getDemo().sessions[0]!.session_id;

const WRITE_TOOLS = {
  create_annotation: { annotations: CREATE_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] },
  update_annotation: { annotations: UPDATE_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] },
  create_saved_query: { annotations: CREATE_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] },
  update_saved_query: { annotations: UPDATE_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] },
  update_failure_status: { annotations: UPDATE_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE] },
  delete: { annotations: DELETE_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE, QYL_MCP_DELETE_SCOPE] },
  list_saved_queries: { annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE] },
  run_saved_query: { annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, scopes: [QYL_MCP_SCOPE] },
} as const;

function environment(context: TestContext, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function liveCollector(context: TestContext, projects = true): void {
  environment(context, {
    QYL_COLLECTOR_URL: "https://collector.example.test",
    QYL_DEMO: undefined,
    QYL_API_KEY: projects ? "default-must-not-be-used" : "local-write-key",
    QYL_PROJECT: projects ? "default-must-not-be-used" : undefined,
    MCP_COLLECTOR_PROJECTS: projects ? JSON.stringify(PROJECTS) : undefined,
  });
}

const STAMP = { created_at: "2026-10-11T14:00:00.000Z", updated_at: "2026-10-11T14:00:00.000Z" };

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    etag: "\"1\"",
    target: { kind: "span", trace_id: TRACE.trace_id, span_id: SPAN_ID },
    text: "The checkout retry loop starts here.",
    ...STAMP,
    ...overrides,
  } as Annotation;
}

function savedQuery(overrides: Partial<SavedQuery> = {}): SavedQuery {
  return {
    id: "sq-1",
    etag: "\"1\"",
    name: "checkout errors",
    filter: { signal: "traces", service_name: "checkout-api", errors_only: true, lookback_minutes: 60 },
    ...STAMP,
    ...overrides,
  } as SavedQuery;
}

// Contract 12.0.0 problems name their type URI and stable code; the collector picks both by status.
const PROBLEM_TYPES: Record<number, [string, string]> = {
  400: ["validation-failed", "validation_failed"],
  401: ["unauthorized", "unauthorized"],
  403: ["forbidden", "forbidden"],
  404: ["not-found", "not_found"],
  409: ["conflict", "conflict"],
  412: ["precondition-failed", "precondition_failed"],
  428: ["precondition-required", "precondition_required"],
  500: ["internal-error", "internal_error"],
  502: ["bad-gateway", "bad_gateway"],
  503: ["service-unavailable", "service_unavailable"],
};

function problem(status: number, title: string): Response {
  const [name, code] = PROBLEM_TYPES[status] ?? ["internal-error", "internal_error"];
  return Response.json({ type: `https://qyl.at/problems/${name}`, code, title, status }, {
    status, headers: { "content-type": "application/problem+json" },
  });
}

interface CollectorCall {
  method: string;
  path: string;
  search: URLSearchParams;
  project: string | null;
  apiKey: string | null;
  ifMatch: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

type Route = (call: CollectorCall) => Response | Promise<Response>;

/** A Collector stand-in: records every request, answers from `route`. */
function mockCollector(context: TestContext, route: Route): CollectorCall[] {
  const calls: CollectorCall[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://collector.example.test");
    const text = await request.text();
    const call: CollectorCall = {
      method: request.method,
      path: url.pathname,
      search: url.searchParams,
      project: request.headers.get(PROJECT_HEADER),
      apiKey: request.headers.get(API_KEY_HEADER),
      ifMatch: request.headers.get(IF_MATCH_HEADER),
      idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
      body: text === "" ? undefined : JSON.parse(text),
    };
    calls.push(call);
    return route(call);
  });
  return calls;
}

function verifier() {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const { subject, scopes } = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
        subject: string;
        scopes: string[];
      };
      return {
        token, clientId: "write-tools-test", scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        resource: RESOURCE,
        extra: { subject },
      };
    },
  };
}

function token(subject: string, scopes: readonly string[]): string {
  return Buffer.from(JSON.stringify({ subject, scopes })).toString("base64url");
}

/** The hosted composition: bearer gate in front of the SDK handler, in either era. */
async function hostedClient(
  context: TestContext,
  subject: string,
  scopes: readonly string[],
  era: "modern" | "legacy" = "modern",
): Promise<Client> {
  const handler = createMcpHandler(() => createServer({ nativeExecution: false }));
  context.after(() => handler.close());
  const gate = createResourceAuthorization({
    verifier: verifier(),
    requiredScopes: [QYL_MCP_SCOPE],
    resourceMetadataUrl: METADATA_URL,
  });
  const serve: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const auth = await gate(request);
    return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
  };
  const client = new Client(
    { name: "write-tools-test", version: "1.0.0" },
    { versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  context.after(() => client.close().catch(() => undefined));
  await client.connect(new StreamableHTTPClientTransport(RESOURCE, {
    fetch: serve,
    requestInit: { headers: { authorization: `Bearer ${token(subject, scopes)}` } },
  }));
  return client;
}

/** A transport that delivers verified auth but runs no SDK scope challenge. */
async function inMemoryClient(context: TestContext, authInfo?: AuthInfo): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ nativeExecution: false });
  await server.connect(serverTransport);
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, { ...options, ...(authInfo === undefined ? {} : { authInfo }) });
  const client = new Client({ name: "write-tools-in-memory", version: "1.0.0" });
  context.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await client.connect(clientTransport);
  return client;
}

function structured<T>(result: CallToolResult): T {
  return result.structuredContent as T;
}

function errorOf(result: CallToolResult): { code: string; message: string; retryable: boolean } {
  assert.equal(result.isError, true, JSON.stringify(result));
  return structured<{ error: { code: string; message: string; retryable: boolean } }>(result).error;
}

test("the write tools carry the contract's annotations and scopes; the eleven reads are unchanged", async (context) => {
  const client = await inMemoryClient(context);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 32);
  for (const tool of tools) {
    const expected = WRITE_TOOLS[tool.name as keyof typeof WRITE_TOOLS];
    assert.ok(tool.title, tool.name);
    assert.match(tool.description ?? "", /when/u, tool.name);
    if (expected === undefined) {
      assert.deepEqual(tool.annotations, READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, tool.name);
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: [QYL_MCP_SCOPE] }], tool.name);
      continue;
    }
    assert.deepEqual(tool.annotations, expected.annotations, tool.name);
    assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: [...expected.scopes] }], tool.name);
  }
  const remove = tools.find((tool) => tool.name === "delete");
  assert.ok(remove);
  assert.deepEqual(
    (remove.inputSchema.properties as { kind: { enum: string[] } }).kind.enum,
    ["annotation", "saved_query"],
    "alert rules arrive with Contract 11.7.0; telemetry is never a kind",
  );
  assert.match(remove.description ?? "", /never traces, logs or metrics/u);
});

for (const era of ["modern", "legacy"] as const) {
  test(`a ${era} call without qyl:write gets a 403 insufficient_scope challenge before any Collector request`, async (context) => {
    liveCollector(context);
    const calls = mockCollector(context, () => Response.json(annotation(), { status: 201 }));
    const reader = await hostedClient(context, OWNER, [QYL_MCP_SCOPE], era);
    await assert.rejects(
      reader.callTool({
        name: "create_annotation",
        arguments: { target: { kind: "trace", trace_id: TRACE.trace_id }, text: "note" },
      }),
      (error: unknown) => {
        assert(error instanceof InsufficientScopeError, String(error));
        assert.equal(error.requiredScope, "qyl:read qyl:write");
        assert.equal(error.resourceMetadataUrl?.href, METADATA_URL);
        assert.equal(error.errorDescription, "create_annotation needs the qyl:write scope");
        return true;
      },
    );
    assert.equal(calls.length, 0);

    // Re-authorizing for delete keeps the write grant the token already has.
    const writer = await hostedClient(context, OWNER, [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE], era);
    await assert.rejects(
      writer.callTool({ name: "delete", arguments: { kind: "annotation", id: "ann-1", etag: "\"1\"" } }),
      (error: unknown) => {
        assert(error instanceof InsufficientScopeError, String(error));
        assert.equal(error.requiredScope, "qyl:delete qyl:read qyl:write");
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
}

test("qyl:read alone keeps the read surface, saved-query reads included", async (context) => {
  liveCollector(context);
  mockCollector(context, (call) => {
    if (call.path === "/api/v1/analysis/list_saved_queries") return Response.json({ ...readContext(1), saved_queries: [savedQuery()], has_more: false });
    return problem(404, "Not Found");
  });
  const reader = await hostedClient(context, OWNER, [QYL_MCP_SCOPE]);
  const listed = await reader.callTool({ name: "list_saved_queries", arguments: {} });
  assert.equal(listed.isError, undefined, JSON.stringify(listed));
});

test("a transport without scope challenges still refuses, in band, with the challenge in _meta", async (context) => {
  liveCollector(context, false);
  const calls = mockCollector(context, () => Response.json(annotation(), { status: 201 }));
  const client = await inMemoryClient(context, {
    token: "t", clientId: "in-memory", scopes: [QYL_MCP_SCOPE], resource: RESOURCE,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const result = await client.callTool({
    name: "update_annotation",
    arguments: { id: "ann-1", etag: "\"1\"", text: "edited" },
  }) as CallToolResult;
  assert.deepEqual(errorOf(result), {
    code: "insufficient_scope",
    message: "update_annotation needs the qyl:write scope, which this sign-in does not grant. " +
      "Reconnect qyl and allow qyl:write to use it.",
    retryable: false,
  });
  assert.deepEqual(result._meta?.[WWW_AUTHENTICATE_META_KEY], [
    `Bearer error="insufficient_scope", error_description="update_annotation needs the qyl:write scope", ` +
      `scope="qyl:read qyl:write", resource_metadata="${METADATA_URL}"`,
  ]);
  assert.equal(calls.length, 0);
});

test("writes reach only the verified subject's project, with its key and the etag as If-Match", async (context) => {
  liveCollector(context);
  const calls = mockCollector(context, (call) => {
    if (call.method === "POST" && call.path === "/api/v1/annotations") {
      return Response.json(annotation({ target: (call.body as Annotation).target, text: (call.body as Annotation).text }), { status: 201 });
    }
    if (call.method === "PATCH" && call.path === "/api/v1/annotations/ann-1") {
      return call.ifMatch === "\"1\""
        ? Response.json(annotation({ etag: "\"2\"", text: (call.body as { text: string }).text }))
        : problem(412, "Precondition Failed");
    }
    if (call.method === "DELETE" && call.path === "/api/v1/annotations/ann-1") {
      return call.ifMatch === "\"2\"" ? new Response(null, { status: 204 }) : problem(412, "Precondition Failed");
    }
    return problem(404, "Not Found");
  });
  const scopes = [QYL_MCP_SCOPE, QYL_MCP_WRITE_SCOPE, QYL_MCP_DELETE_SCOPE];
  const [owner, reviewer] = await Promise.all([
    hostedClient(context, OWNER, scopes),
    hostedClient(context, REVIEWER, scopes),
  ]);

  const target = { kind: "span", trace_id: TRACE.trace_id, span_id: SPAN_ID };
  const created = await owner.callTool({
    name: "create_annotation",
    arguments: { target, text: "The checkout retry loop starts here.", idempotency_key: "repeat-note" },
    _meta: { project: "review", subject: REVIEWER },
  }) as CallToolResult;
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.deepEqual(structured<{ annotation: Annotation }>(created).annotation.target, target);
  assert.match(JSON.stringify(created.content), /Created annotation ann-1 on span/u);
  const firstCreate = calls.at(-1);
  assert.ok(firstCreate);
  assert.match(firstCreate.idempotencyKey ?? "", /^[a-f0-9]{64}$/u, "a create carries a derived Idempotency-Key");
  assert.deepEqual(firstCreate, {
    method: "POST", path: "/api/v1/annotations", search: new URLSearchParams(),
    project: "owner", apiKey: "owner-write-key", ifMatch: null, idempotencyKey: firstCreate.idempotencyKey,
    body: { target, text: "The checkout retry loop starts here." },
  });
  // No argument can name a project: the published input is sealed.
  const smuggled = await reviewer.callTool({
    name: "create_annotation",
    arguments: { target, text: "x", project: "owner" },
  }) as CallToolResult;
  assert.equal(smuggled.isError, true);
  assert.equal(calls.length, 1);

  const stale = await reviewer.callTool({
    name: "update_annotation",
    arguments: { id: "ann-1", etag: "\"0\"", text: "edited" },
  }) as CallToolResult;
  assert.deepEqual(errorOf(stale), {
    code: "precondition_failed",
    message: "annotation ann-1 changed since that etag was read; read it again for its current etag",
    retryable: false,
  });
  assert.equal(calls.at(-1)!.project, "review");
  assert.equal(calls.at(-1)!.apiKey, "review-write-key");

  const updated = await owner.callTool({
    name: "update_annotation",
    arguments: { id: "ann-1", etag: "\"1\"", text: "edited" },
  }) as CallToolResult;
  assert.equal(updated.isError, undefined, JSON.stringify(updated));
  assert.equal(structured<{ annotation: Annotation }>(updated).annotation.etag, "\"2\"");
  assert.deepEqual(calls.at(-1)!.body, { text: "edited" }, "the target is fixed at creation");
  assert.equal(calls.at(-1)!.ifMatch, "\"1\"");

  const deleted = await owner.callTool({
    name: "delete",
    arguments: { kind: "annotation", id: "ann-1", etag: "\"2\"" },
  }) as CallToolResult;
  assert.equal(deleted.isError, undefined, JSON.stringify(deleted));
  assert.deepEqual(structured(deleted), { deleted: true });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path} ${call.project}`),
    [
      "POST /api/v1/annotations owner",
      "PATCH /api/v1/annotations/ann-1 review",
      "PATCH /api/v1/annotations/ann-1 owner",
      "DELETE /api/v1/annotations/ann-1 owner",
    ],
  );
  assert.doesNotMatch(JSON.stringify([created, updated, deleted, stale]), /owner-write-key|review-write-key/u);

  // The same intended create repeats the same key, so a retry after a lost
  // answer returns the first object; a different note is a different key.
  await owner.callTool({ name: "create_annotation", arguments: { target, text: "The checkout retry loop starts here.", idempotency_key: "repeat-note" } });
  assert.equal(calls.at(-1)?.idempotencyKey, firstCreate.idempotencyKey);
  await owner.callTool({ name: "create_annotation", arguments: { target, text: "A different note.", idempotency_key: "different-note" } });
  assert.notEqual(calls.at(-1)?.idempotencyKey, firstCreate.idempotencyKey);
});

test("saved queries: create, conflict, update, list with paging, run and delete", async (context) => {
  liveCollector(context, false);
  const calls = mockCollector(context, (call) => {
    if (call.method === "POST" && call.path === "/api/v1/saved-queries") {
      const body = call.body as { name: string; filter: SavedQuery["filter"] };
      return body.name === "taken"
        ? problem(409, "Conflict")
        : Response.json(savedQuery({ name: body.name, filter: body.filter }), { status: 201 });
    }
    if (call.method === "PATCH" && call.path === "/api/v1/saved-queries/sq-1") {
      return Response.json(savedQuery({ etag: "\"2\"", name: (call.body as { name: string }).name }));
    }
    if (call.method === "POST" && call.path === "/api/v1/analysis/list_saved_queries") {
      return Response.json({ ...readContext(1), saved_queries: [savedQuery()], has_more: true, next_cursor: "page-2" });
    }
    if (call.method === "POST" && call.path === "/api/v1/analysis/run_saved_query") {
      const { spans: _spans, ...summary } = TRACE;
      return Response.json({ ...readContext(1), result: { signal: "traces", items: [summary], has_more: false }, mode: "live" });
    }
    if (call.method === "DELETE" && call.path === "/api/v1/saved-queries/sq-1") {
      return new Response(null, { status: 204 });
    }
    return problem(404, "Not Found");
  });
  // Local stdio-style serving: no verified auth, the Collector key decides.
  const client = await inMemoryClient(context);
  const filter = { signal: "traces", service_name: "checkout-api", errors_only: true, lookback_minutes: 60 };

  const created = await client.callTool({ name: "create_saved_query", arguments: { name: "checkout errors", filter } }) as CallToolResult;
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.equal(structured<{ saved_query: SavedQuery }>(created).saved_query.id, "sq-1");
  assert.equal(calls.at(-1)!.apiKey, "local-write-key");
  assert.equal(calls.at(-1)!.project, null, "unset QYL_PROJECT sends no project header");

  const taken = await client.callTool({ name: "create_saved_query", arguments: { name: "taken", filter } }) as CallToolResult;
  assert.deepEqual(errorOf(taken), {
    code: "conflict",
    message: 'a saved query named "taken" already exists in this project',
    retryable: false,
  });

  const nothing = await client.callTool({ name: "update_saved_query", arguments: { id: "sq-1", etag: "\"1\"" } }) as CallToolResult;
  assert.equal(errorOf(nothing).code, "invalid_argument");
  const before = calls.length;
  const badTag = await client.callTool({
    name: "update_saved_query",
    arguments: { id: "sq-1", etag: "\"1\"\r\nX-Injected: 1", name: "renamed" },
  }) as CallToolResult;
  assert.equal(errorOf(badTag).code, "invalid_argument");
  assert.equal(calls.length, before, "an etag that is no HTTP field value never reaches the Collector");

  const renamed = await client.callTool({ name: "update_saved_query", arguments: { id: "sq-1", etag: "\"1\"", name: "renamed" } }) as CallToolResult;
  assert.equal(renamed.isError, undefined, JSON.stringify(renamed));
  assert.deepEqual(calls.at(-1)!.body, { name: "renamed" }, "omitted fields keep their value");

  const listed = await client.callTool({ name: "list_saved_queries", arguments: { signal: "traces", limit: 5, cursor: "page-1" } }) as CallToolResult;
  assert.equal(listed.isError, undefined, JSON.stringify(listed));
  assert.deepEqual(
    calls.at(-1)!.body,
    { signal: "traces", limit: 5, cursor: "page-1" },
  );
  const page = structured<{ saved_queries: SavedQuery[]; has_more: boolean; next_cursor?: string }>(listed);
  assert.equal(page.saved_queries.length, 1);
  assert.equal(page.has_more, true);
  assert.equal(page.next_cursor, "page-2");
  assert.equal(calls.at(-1)!.path, "/api/v1/analysis/list_saved_queries");

  const ran = await client.callTool({ name: "run_saved_query", arguments: { id: "sq-1" } }) as CallToolResult;
  assert.equal(ran.isError, undefined, JSON.stringify(ran));
  const run = structured<{ result: { signal: string; items: unknown[] }; mode: string }>(ran);
  assert.equal(run.mode, "live");
  assert.equal(run.result.signal, "traces");
  assert.equal(run.result.items.length, 1);
  assert.deepEqual(calls.at(-1)!.body, { id: "sq-1", limit: 100 }, "the contract's default page size travels");

  const deleted = await client.callTool({ name: "delete", arguments: { kind: "saved_query", id: "sq-1", etag: "\"2\"" } }) as CallToolResult;
  assert.equal(deleted.isError, undefined, JSON.stringify(deleted));
  assert.equal(calls.at(-1)!.path, "/api/v1/saved-queries/sq-1");
  assert.equal(calls.at(-1)!.ifMatch, "\"2\"");

  const missing = await client.callTool({ name: "delete", arguments: { kind: "saved_query", id: "gone", etag: "\"2\"" } }) as CallToolResult;
  assert.deepEqual(errorOf(missing), { code: "not_found", message: "saved query not found: gone", retryable: false });
});

test("a Collector key without the write or delete role surfaces as collector_unauthorized", async (context) => {
  liveCollector(context, false);
  mockCollector(context, () => problem(403, "Forbidden"));
  const client = await inMemoryClient(context);
  const created = await client.callTool({
    name: "create_annotation",
    arguments: { target: { kind: "session", session_id: SESSION_ID }, text: "note" },
  }) as CallToolResult;
  assert.deepEqual(errorOf(created), {
    code: "collector_unauthorized",
    message: "the Collector refused the change: the server's Collector key needs the write role",
    retryable: false,
  });
  const deleted = await client.callTool({
    name: "delete",
    arguments: { kind: "annotation", id: "ann-1", etag: "\"1\"" },
  }) as CallToolResult;
  assert.match(errorOf(deleted).message, /needs the delete role/u);
});

test("demo mode refuses every annotation and saved-query tool instead of inventing a store", async (context) => {
  environment(context, { QYL_DEMO: "1", MCP_COLLECTOR_PROJECTS: undefined });
  const calls = mockCollector(context, () => problem(500, "Internal Server Error"));
  const client = await inMemoryClient(context);
  for (const [name, args] of [
    ["create_annotation", { target: { kind: "trace", trace_id: TRACE.trace_id }, text: "note" }],
    ["list_saved_queries", {}],
    ["run_saved_query", { id: "sq-1" }],
    ["delete", { kind: "annotation", id: "ann-1", etag: "\"1\"" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    const error = errorOf(result);
    assert.equal(error.code, "invalid_argument", name);
    assert.match(error.message, /needs a live qyl Collector/u, name);
  }
  assert.equal(calls.length, 0);

  const trace = await client.callTool({ name: "get_trace", arguments: { trace_id: TRACE.trace_id } }) as CallToolResult;
  assert.equal(errorOf(trace).code, "invalid_argument", "analysis requires a real collector");
});

test("get_trace and list_sessions read the annotations back; a failed read leaves the telemetry result", async (context) => {
  liveCollector(context, false);
  const sessions = getDemo().sessions.slice(0, 2);
  let annotationsUp = true;
  const calls = mockCollector(context, (call) => {
    if (call.path === "/api/v1/analysis/get_trace") return Response.json({ ...readContext(1), trace: toolTrace(TRACE), mode: "live", ...(annotationsUp ? { annotations: [annotation()] } : {}) });
    if (call.path === "/api/v1/analysis/list_sessions") return Response.json({ ...readContext(sessions.length), sessions, mode: "live", has_more: false, annotations: [...sessions].reverse().map(session => annotation({ id: `ann-${session.session_id}`, target: { kind: "session", session_id: session.session_id } })) });
    return problem(404, "Not Found");
  });
  const client = await inMemoryClient(context);

  const trace = await client.callTool({ name: "get_trace", arguments: { trace_id: TRACE.trace_id } }) as CallToolResult;
  assert.equal(trace.isError, undefined, JSON.stringify(trace));
  assert.deepEqual(structured<{ annotations: Annotation[] }>(trace).annotations, [annotation()]);
  assert.equal((calls.at(-1)!.body as { trace_id: string }).trace_id, TRACE.trace_id);

  const listed = await client.callTool({ name: "list_sessions", arguments: {} }) as CallToolResult;
  assert.equal(listed.isError, undefined, JSON.stringify(listed));
  assert.deepEqual(
    structured<{ annotations: Annotation[] }>(listed).annotations.map((note) => note.id),
    [`ann-${sessions[1]!.session_id}`, `ann-${sessions[0]!.session_id}`],
    "merged newest first across sessions",
  );

  annotationsUp = false;
  const degraded = await client.callTool({ name: "get_trace", arguments: { trace_id: TRACE.trace_id } }) as CallToolResult;
  assert.equal(degraded.isError, undefined, "the trace read itself succeeded");
  assert.equal(Object.hasOwn(degraded.structuredContent ?? {}, "annotations"), false);
  assert.equal(calls.at(-1)!.path, "/api/v1/analysis/get_trace");
});
