import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createResourceAuthorization } from "./authorization.js";
import { CollectorAccessError, collectorAccessForSubject, readCollectorProjects } from "./collector-access.js";
import { collectorGet } from "./collector.js";
import { API_KEY_HEADER, PROJECT_HEADER } from "./contract-headers.js";
import { getDemo } from "./demo.js";
import { EventsRuntime, createEventStore, type Principal, type SubscribeParams } from "./events.js";
import { hostedAuth } from "./main.js";
import { QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";
import { createServer } from "./server.js";
import type { QylTrace } from "./wire.js";

const OWNER = "auth0|project-owner-test";
const REVIEWER = "auth0|project-reviewer-test";
const PROJECTS = [
  { project: "owner", apiKey: "owner-test-key", subjects: [OWNER] },
  { project: "review", apiKey: "review-test-key", subjects: [REVIEWER] },
];

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

test("project configuration rejects ambiguity and malformed secrets without disclosing values", () => {
  assert.equal(readCollectorProjects({}), undefined);
  const configured = { MCP_COLLECTOR_PROJECTS: JSON.stringify(PROJECTS) };
  assert.deepEqual(collectorAccessForSubject(REVIEWER, configured), {
    project: "review", apiKey: "review-test-key",
  });
  assert.throws(() => collectorAccessForSubject("auth0|unknown", configured), CollectorAccessError);
  assert.throws(() => collectorAccessForSubject(undefined, configured), CollectorAccessError);
  for (const raw of [
    "", "null", "[]", "{}", "{invalid sensitive-value}",
    JSON.stringify([{ ...PROJECTS[0], apiKey: "sensitive-value\r\ninjected: header" }]),
    JSON.stringify([{ ...PROJECTS[0], subjects: [] }]),
    JSON.stringify([PROJECTS[0], { ...PROJECTS[1], subjects: [OWNER] }]),
    JSON.stringify([PROJECTS[0], { ...PROJECTS[1], apiKey: PROJECTS[0]!.apiKey }]),
    JSON.stringify([PROJECTS[0], { ...PROJECTS[1], project: PROJECTS[0]!.project }]),
  ]) {
    assert.throws(() => readCollectorProjects({ MCP_COLLECTOR_PROJECTS: raw }), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /^MCP_COLLECTOR_PROJECTS/u);
      assert.doesNotMatch(error.message, /sensitive-value|owner-test-key|project-owner-test/u);
      return true;
    });
  }
});

test("project access configuration requires hosted Auth0", async () => {
  await assert.rejects(
    hostedAuth({ port: 3001, bindHost: "127.0.0.1" }, { MCP_COLLECTOR_PROJECTS: JSON.stringify(PROJECTS) }),
    /requires hosted Auth0/u,
  );
});

test("stdio rejects project mappings before accepting a connection", () => {
  for (const mapping of [JSON.stringify(PROJECTS), "{invalid}"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), "--stdio"], {
      env: { ...process.env, QYL_DEMO: "1", MCP_COLLECTOR_PROJECTS: mapping },
      input: "", encoding: "utf8", timeout: 5_000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /Standalone MCP startup/u);
  }
});

test("unscoped data requests cannot use the default credential when project access is enabled", async (context) => {
  environment(context, {
    MCP_COLLECTOR_PROJECTS: JSON.stringify(PROJECTS),
    QYL_API_KEY: "default-must-not-be-used",
  });
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("unscoped request reached the network");
  });
  await assert.rejects(collectorGet("/api/v1/traces"), CollectorAccessError);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const revision of ["2026-07-28", "2025-11-25"] as const) {
  test(`verified account scope reaches model and viewer tools over ${revision}`, async (context) => {
    environment(context, {
      MCP_COLLECTOR_PROJECTS: JSON.stringify(PROJECTS),
      QYL_COLLECTOR_URL: "https://collector.example.test",
      QYL_API_KEY: "default-must-not-be-used",
      QYL_PROJECT: "default-must-not-be-used",
      QYL_DEMO: undefined,
    });
    const traces = getDemo().traces;
    const ownerTrace = traces[0]!;
    const reviewerTrace = traces[1]!;
    assert.notEqual(ownerTrace.trace_id, reviewerTrace.trace_id);
    const calls: Array<{ project: string; path: string }> = [];
    context.mock.method(globalThis, "fetch", async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, "https://collector.example.test");
      const project = request.headers.get(PROJECT_HEADER)!;
      const expected = PROJECTS.find((entry) => entry.project === project);
      assert(expected, "unknown or default project reached the Collector");
      assert.equal(request.headers.get(API_KEY_HEADER), expected.apiKey);
      const selected = project === "owner" ? ownerTrace : reviewerTrace;
      const pathname = new URL(request.url).pathname;
      calls.push({ project, path: pathname });
      // Overlap calls to expose any process-global credential switching.
      await new Promise((resolve) => setTimeout(resolve, project === "owner" ? 5 : 1));
      if (pathname === "/api/v1/traces") return Response.json({ items: [selected], has_more: false });
      if (pathname === `/api/v1/traces/${selected.trace_id}`) return Response.json(selected);
      return Response.json({ type: "about:blank", title: "Not Found", status: 404 }, {
        status: 404, headers: { "content-type": "application/problem+json" },
      });
    });

    const handler = createMcpHandler(() => createServer({ nativeExecution: false }));
    context.after(() => handler.close());
    const gate = createResourceAuthorization({
      verifier: {
        async verifyAccessToken(token): Promise<AuthInfo> {
          return {
            token, clientId: "project-access-test", scopes: [QYL_MCP_SCOPE],
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            resource: new URL(QYL_MCP_RESOURCE),
            extra: { subject: Buffer.from(token, "base64url").toString("utf8") },
          };
        },
      },
      requiredScopes: [QYL_MCP_SCOPE],
      resourceMetadataUrl: "https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp",
    });
    const serve: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      const auth = await gate(request);
      return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
    };
    async function connect(subject: string): Promise<Client> {
      const client = new Client(
        { name: "project-test", version: "1.0.0" },
        { versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" } },
      );
      context.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(QYL_MCP_RESOURCE), {
        fetch: serve, requestInit: { headers: { authorization: `Bearer ${Buffer.from(subject).toString("base64url")}` } },
      }));
      assert.equal(client.getNegotiatedProtocolVersion(), revision);
      return client;
    }
    const [owner, reviewer, unassigned] = await Promise.all([
      connect(OWNER), connect(REVIEWER), connect("auth0|unassigned-test"),
    ]);
    for (const tool of ["list_traces", "display_traces", "fetch_telemetry"]) {
      const args = tool === "fetch_telemetry" ? { view: "traces", limit: 2 } : { limit: 2 };
      const [ownerResult, reviewResult] = await Promise.all([
        owner.callTool({ name: tool, arguments: args }),
        reviewer.callTool({ name: tool, arguments: args, _meta: { subject: OWNER, project: "owner" } }),
      ]);
      assert.equal(ownerResult.isError, undefined, JSON.stringify(ownerResult));
      assert.equal(reviewResult.isError, undefined, JSON.stringify(reviewResult));
      assert(JSON.stringify(ownerResult).includes(ownerTrace.trace_id));
      assert(!JSON.stringify(ownerResult).includes(reviewerTrace.trace_id));
      assert(JSON.stringify(reviewResult).includes(reviewerTrace.trace_id));
      assert(!JSON.stringify(reviewResult).includes(ownerTrace.trace_id));
      assert.doesNotMatch(JSON.stringify([ownerResult, reviewResult]), /owner-test-key|review-test-key/u);
    }
    const own = await reviewer.callTool({ name: "get_trace", arguments: { trace_id: reviewerTrace.trace_id } });
    assert.equal(own.isError, undefined);
    const foreign = await reviewer.callTool({ name: "get_trace", arguments: { trace_id: ownerTrace.trace_id } });
    assert.equal(foreign.isError, true);
    assert(!JSON.stringify(foreign).includes(ownerTrace.root_span!.name));
    assert.equal(calls.at(-1)!.project, "review", "foreign IDs must still use reviewer credentials");
    const beforeDenied = calls.length;
    const denied = await unassigned.callTool({ name: "list_traces", arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /No Collector project is assigned/u);
    assert.equal(calls.length, beforeDenied);
  });
}

test("Events poll and deduplicate within each account's Collector scope", { timeout: 5_000 }, async (context) => {
  environment(context, {
    MCP_COLLECTOR_PROJECTS: JSON.stringify(PROJECTS),
    QYL_COLLECTOR_URL: "https://collector.example.test",
    QYL_API_KEY: "default-must-not-be-used", QYL_DEMO: undefined,
  });
  const dir = await mkdtemp(join(tmpdir(), "qyl-project-events-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const store = createEventStore(join(dir, "events.json"));
  let phase = 0;
  let ownerUnavailable = false;
  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
  context.after(() => releaseOwner());
  let markReviewDelivered!: () => void;
  const reviewDelivered = new Promise<void>((resolve) => { markReviewDelivered = resolve; });
  const sharedId = getDemo().traces[0]!.trace_id;
  const traces = new Map<string, QylTrace>(PROJECTS.map((entry) => [entry.project, {
    ...getDemo().traces[0]!, trace_id: sharedId, has_error: true,
    services: [entry.project], root_span: { ...getDemo().traces[0]!.root_span!, name: `${entry.project}-sample` },
  }]));
  context.mock.method(globalThis, "fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const project = request.headers.get(PROJECT_HEADER)!;
    const expected = PROJECTS.find((entry) => entry.project === project)!;
    assert.equal(request.headers.get(API_KEY_HEADER), expected.apiKey);
    if (ownerUnavailable && project === "owner") {
      await ownerGate;
      throw new Error("upstream unavailable");
    }
    return Response.json({ items: phase === 0 ? [] : [traces.get(project)], has_more: false });
  });
  const deliveries: Array<{ url: string; body: string }> = [];
  const runtime = new EventsRuntime({
    store, isAuthorized: async () => true, log: () => {},
    post: async (url, body) => {
      const value = JSON.parse(body) as { type?: string; challenge?: string };
      if (value.type === "verification") return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
      deliveries.push({ url: url.href, body });
      if (url.pathname === "/review") markReviewDelivered();
      return { status: 200, body: "" };
    },
  });
  context.after(() => runtime.stop());
  function params(project: string): SubscribeParams {
    return {
      name: "trace.error", arguments: {},
      delivery: { mode: "webhook", url: `https://receiver.example.test/${project}`, secret: `whsec_${Buffer.alloc(32, 3).toString("base64")}` },
    };
  }
  const owner: Principal = { subject: OWNER, clientId: "client" };
  const reviewer: Principal = { subject: REVIEWER, clientId: "client" };
  await runtime.subscribe(params("owner"), owner);
  await runtime.subscribe(params("review"), reviewer);
  await runtime.poll();
  phase = 1;
  ownerUnavailable = true;
  const stalledPoll = runtime.poll();
  await reviewDelivered;
  assert.equal(deliveries.length, 1, "one account's upstream failure must not block another");
  releaseOwner();
  await stalledPoll;
  assert.equal(deliveries[0]!.url, "https://receiver.example.test/review");
  assert.match(deliveries[0]!.body, /review-sample/u);
  assert.doesNotMatch(deliveries[0]!.body, /owner-sample|owner-test-key|review-test-key/u);
  ownerUnavailable = false;
  await runtime.poll();
  assert.equal(deliveries.length, 2, "the same trace ID in another project is a distinct observation");
  assert.equal(deliveries[1]!.url, "https://receiver.example.test/owner");
  assert.match(deliveries[1]!.body, /owner-sample/u);
  await runtime.poll();
  assert.equal(deliveries.length, 2);
  assert.doesNotMatch(JSON.stringify(await store.read()), /owner-test-key|review-test-key/u);
  await runtime.unsubscribe(params("review"), reviewer);
  process.env.MCP_COLLECTOR_PROJECTS = JSON.stringify([PROJECTS[1]]);
  await runtime.poll();
  assert.equal((await store.read()).subscriptions.length, 0, "removed project access revokes the subscription");
  const before = deliveries.length;
  await assert.rejects(runtime.subscribe(params("owner"), owner), /No Collector project is assigned/u);
  assert.equal(deliveries.length, before);
});

for (const configured of [false, true]) {
  test(`Events share one poll for accounts reading the same ${configured ? "assigned" : "default"} project`, async (context) => {
    environment(context, {
      MCP_COLLECTOR_PROJECTS: configured
        ? JSON.stringify([{ ...PROJECTS[0], subjects: [OWNER, REVIEWER] }]) : undefined,
    });
    const dir = await mkdtemp(join(tmpdir(), "qyl-shared-project-events-"));
    context.after(() => rm(dir, { recursive: true, force: true }));
    let reads = 0;
    let phase = 0;
    const deliveries: string[] = [];
    const runtime = new EventsRuntime({
      store: createEventStore(join(dir, "events.json")), isAuthorized: async () => true, log: () => {},
      recentTraces: async () => {
        reads++;
        return phase === 0 ? [] : [{ ...getDemo().traces[0]!, has_error: true }];
      },
      post: async (url, body) => {
        const event = JSON.parse(body) as { type?: string; challenge?: string };
        if (event.type === "verification") return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
        deliveries.push(url.pathname);
        return { status: 200, body: "" };
      },
    });
    context.after(() => runtime.stop());
    for (const [index, subject] of [OWNER, REVIEWER].entries()) {
      await runtime.subscribe({ name: "trace.error", arguments: {}, delivery: {
        mode: "webhook", url: `https://receiver.example.test/${index}`,
        secret: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
      } }, { subject, clientId: "shared-project-test" });
    }
    await runtime.poll();
    assert.equal(reads, 1);
    phase = 1;
    await runtime.poll();
    assert.equal(reads, 2);
    assert.deepEqual(deliveries.sort(), ["/0", "/1"]);
  });
}
