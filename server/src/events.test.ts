import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, ProtocolError, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CALLBACK_ENDPOINT_ERROR,
  DEFAULT_TTL_MS,
  EventsRuntime,
  MAX_SUBSCRIPTIONS_PER_PRINCIPAL,
  MAX_TTL_MS,
  MIN_TTL_MS,
  TRACE_ERROR_EVENT_NAME,
  canonicalJson,
  createEventStore,
  grantedTtlMs,
  type Principal,
  type SubscribeParams,
} from "./events.js";
import { createServer } from "./server.js";
import type { WebhookPost, WebhookResponse } from "./webhook.js";
import type { QylTrace } from "./wire.js";

const SECRET = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const NEXT_SECRET = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const CALLBACK = "https://receiver.example.com/mcp-events/callback_123";
const ALICE: Principal = { subject: "auth0|alice", clientId: "chatgpt" };
const NOW = Date.parse("2026-10-01T12:00:00Z");

interface Posted {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
}

/** A callback receiver: echoes verification challenges, answers deliveries from a queue. */
function receiver(deliveryStatuses: number[] = [], options: { echo?: boolean } = {}) {
  const posted: Posted[] = [];
  const post: WebhookPost = async (url, body, headers): Promise<WebhookResponse> => {
    posted.push({ url: url.href, body, headers });
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") {
      return {
        status: 200,
        body: JSON.stringify({ challenge: options.echo === false ? "wrong" : parsed.challenge }),
      };
    }
    return { status: deliveryStatuses.shift() ?? 200, body: "" };
  };
  return { posted, post };
}

function verifies(secret: string, message: Posted): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key)
    .update(`${message.headers["webhook-id"]}.${message.headers["webhook-timestamp"]}.${message.body}`)
    .digest("base64");
  return message.headers["webhook-signature"]!.split(" ").includes(`v1,${expected}`);
}

function trace(id: string, services: string[], hasError: boolean): QylTrace {
  return {
    trace_id: id.padEnd(32, "0"),
    root_span: { name: `GET /${id}` },
    span_count: 3,
    duration_ns: "12500000",
    start_time: "2026-10-01T11:59:30.000Z",
    end_time: "2026-10-01T11:59:30.012Z",
    services,
    has_error: hasError,
  } as unknown as QylTrace;
}

async function fixture(
  post: WebhookPost,
  traces: () => readonly QylTrace[] = () => [],
) {
  const dir = await mkdtemp(join(tmpdir(), "qyl-events-"));
  const storePath = join(dir, "events.json");
  const store = createEventStore(storePath);
  const runtime = new EventsRuntime({
    store,
    post,
    recentTraces: async () => traces(),
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
  });
  return {
    runtime,
    store,
    storePath,
    cleanup: async (): Promise<void> => {
      await runtime.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function subscribeParams(overrides: Partial<SubscribeParams> = {}): SubscribeParams {
  return {
    name: TRACE_ERROR_EVENT_NAME,
    arguments: { service_name: "checkout" },
    delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
    cursor: null,
    ...overrides,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: number, reason?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProtocolError, String(error));
    assert.equal(error.code, code);
    if (reason !== undefined) assert.deepEqual(error.data, { reason });
    return true;
  });
}

test("events/list describes trace.error for webhook delivery", async () => {
  const { runtime, cleanup } = await fixture(receiver().post);
  try {
    const [event] = runtime.list().events;
    assert.equal(event?.name, "trace.error");
    assert.deepEqual(event?.delivery, ["webhook"]);
    assert.equal(event?.inputSchema.additionalProperties, false);
  } finally {
    await cleanup();
  }
});

test("subscribe verifies the callback with a signed challenge, then stores the subscription", async () => {
  const { posted, post } = receiver();
  const { runtime, store, storePath, cleanup } = await fixture(post);
  try {
    const result = await runtime.subscribe(subscribeParams(), ALICE);
    assert.match(result.id, /^sub_[A-Za-z0-9_-]{32}$/u);
    assert.equal(result.refreshBefore, new Date(NOW + DEFAULT_TTL_MS).toISOString());
    assert.equal(result.cursor, null);
    assert.equal(result.truncated, false);

    assert.equal(posted.length, 1);
    const verification = posted[0]!;
    assert.equal(verification.url, CALLBACK);
    assert.equal(JSON.parse(verification.body).type, "verification");
    assert.match(verification.headers["webhook-id"]!, /^msg_verification_/u);
    assert.equal(verification.headers["x-mcp-subscription-id"], result.id);
    assert.ok(verifies(SECRET, verification));

    const state = await store.read();
    assert.equal(state.subscriptions.length, 1);
    assert.equal(state.subscriptions[0]?.url, CALLBACK);
    assert.equal((await stat(storePath)).mode & 0o077, 0, "the store holds secrets: owner-only");
  } finally {
    await cleanup();
  }
});

test("a repeated subscribe updates one subscription and reuses the cached verification", async () => {
  const { posted, post } = receiver();
  const { runtime, store, cleanup } = await fixture(post);
  try {
    const first = await runtime.subscribe(subscribeParams(), ALICE);
    const again = await runtime.subscribe(subscribeParams({ ttlMs: 10 * 60_000 }), ALICE);
    assert.equal(again.id, first.id);
    assert.equal(posted.length, 1, "verification is cached per principal and callback URL");
    assert.equal((await store.read()).subscriptions.length, 1);

    const other = await runtime.subscribe(subscribeParams(), { ...ALICE, clientId: "claude" });
    assert.notEqual(other.id, first.id, "the principal is part of the identity");
  } finally {
    await cleanup();
  }
});

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }), canonicalJson({ a: { c: null, d: [2, { e: 0, f: 1 }] }, b: 1 }));
});

test("a callback that does not echo the challenge fails with -32015 and stores nothing", async () => {
  const { post } = receiver([], { echo: false });
  const { runtime, store, cleanup } = await fixture(post);
  try {
    await rejectsWith(runtime.subscribe(subscribeParams(), ALICE), CALLBACK_ENDPOINT_ERROR, "challenge_failed");
    assert.equal((await store.read()).subscriptions.length, 0);
  } finally {
    await cleanup();
  }
});

test("subscribe rejects bad names, arguments, modes, secrets and callbacks", async () => {
  const { posted, post } = receiver();
  const { runtime, cleanup } = await fixture(post);
  try {
    await rejectsWith(runtime.subscribe(subscribeParams({ name: "trace.created" }), ALICE), -32602);
    await rejectsWith(runtime.subscribe(subscribeParams({ arguments: { service: "x" } }), ALICE), -32602);
    await rejectsWith(runtime.subscribe(subscribeParams({ delivery: { mode: "poll", url: CALLBACK, secret: SECRET } }), ALICE), -32602);
    await rejectsWith(runtime.subscribe(subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: "whsec_c2hvcnQ=" } }), ALICE), -32602);
    await rejectsWith(runtime.subscribe(subscribeParams({ delivery: { mode: "webhook", url: CALLBACK } }), ALICE), -32602);
    await rejectsWith(
      runtime.subscribe(subscribeParams({ delivery: { mode: "webhook", url: "http://receiver.example.com/cb", secret: SECRET } }), ALICE),
      CALLBACK_ENDPOINT_ERROR,
      "invalid_url",
    );
    await rejectsWith(
      runtime.subscribe(subscribeParams({ delivery: { mode: "webhook", url: "https://169.254.169.254/latest", secret: SECRET } }), ALICE),
      CALLBACK_ENDPOINT_ERROR,
      "invalid_url",
    );
    assert.equal(posted.length, 0, "nothing is sent for a rejected request");
  } finally {
    await cleanup();
  }
});

test("a caller holds a bounded number of live subscriptions; refreshes still pass at the cap", async () => {
  const { posted, post } = receiver();
  const { runtime, store, cleanup } = await fixture(post);
  try {
    for (let index = 0; index < MAX_SUBSCRIPTIONS_PER_PRINCIPAL; index++) {
      await runtime.subscribe(subscribeParams({ arguments: { service_name: `svc-${index}` } }), ALICE);
    }
    const sent = posted.length;
    await rejectsWith(
      runtime.subscribe(subscribeParams({ arguments: { service_name: "one-too-many" } }), ALICE),
      -32602,
    );
    await rejectsWith(
      runtime.subscribe(subscribeParams({
        arguments: { service_name: "elsewhere" },
        delivery: { mode: "webhook", url: "https://other.example.com/cb", secret: SECRET },
      }), ALICE),
      -32602,
    );
    assert.equal(posted.length, sent, "a rejected subscription sends no verification POST");

    await runtime.subscribe(subscribeParams({ arguments: { service_name: "svc-0" }, ttlMs: 10 * 60_000 }), ALICE);
    await runtime.subscribe(subscribeParams({ arguments: { service_name: "one-too-many" } }), { ...ALICE, subject: "auth0|bob" });
    assert.equal((await store.read()).subscriptions.length, MAX_SUBSCRIPTIONS_PER_PRINCIPAL + 1);
  } finally {
    await cleanup();
  }
});

test("a failing poll on the timer is logged, not an unhandled rejection", async () => {
  const logged: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const failing = {
    initialize: async () => {},
    read: async () => ({ version: 1 as const, subscriptions: [] }),
    transact: async () => {
      throw new Error("write_failed");
    },
  };
  const runtime = new EventsRuntime({
    store: failing as unknown as ReturnType<typeof createEventStore>,
    post: receiver().post,
    recentTraces: async () => [],
    pollIntervalMs: 5,
    log: (message) => logged.push(message),
  });
  try {
    (runtime as unknown as { ensurePolling(): void }).ensurePolling();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runtime.stop().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.ok(logged.some((message) => message.includes("poll failed: write_failed")), logged.join("\n"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("granted lifetimes are bounded and never unbounded", () => {
  assert.equal(grantedTtlMs(undefined), DEFAULT_TTL_MS);
  assert.equal(grantedTtlMs(null), MAX_TTL_MS);
  assert.equal(grantedTtlMs(1_000), MIN_TTL_MS);
  assert.equal(grantedTtlMs(10 * 24 * 60 * 60_000), MAX_TTL_MS);
  assert.equal(grantedTtlMs(30 * 60_000), 30 * 60_000);
});

test("a poll delivers each new matching error trace once, signed, after a baseline", async () => {
  const { posted, post } = receiver();
  let traces = [trace("a1", ["checkout"], true)];
  const { runtime, cleanup } = await fixture(post, () => traces);
  try {
    const { id } = await runtime.subscribe(subscribeParams(), ALICE);
    posted.length = 0;

    await runtime.poll();
    assert.equal(posted.length, 0, "the first poll is a baseline, not a backlog");

    traces = [
      trace("b2", ["checkout", "payments"], true),
      trace("c3", ["checkout"], false),
      trace("d4", ["inventory"], true),
      ...traces,
    ];
    await runtime.poll();
    assert.equal(posted.length, 1);
    const delivery = posted[0]!;
    const event = JSON.parse(delivery.body);
    assert.equal(event.eventId, `evt_${"b2".padEnd(32, "0")}`);
    assert.equal(event.name, "trace.error");
    assert.equal(event.cursor, null);
    assert.equal(event.timestamp, "2026-10-01T11:59:30.000Z");
    assert.deepEqual(event.data, {
      trace_id: "b2".padEnd(32, "0"),
      root_span: "GET /b2",
      services: ["checkout", "payments"],
      span_count: 3,
      duration_ms: 12.5,
      start_time: "2026-10-01T11:59:30.000Z",
    });
    assert.equal(delivery.headers["webhook-id"], event.eventId);
    assert.equal(delivery.headers["x-mcp-subscription-id"], id);
    assert.equal(delivery.headers["content-type"], "application/json");
    assert.ok(verifies(SECRET, delivery));

    await runtime.poll();
    assert.equal(posted.length, 1, "a delivered trace is not delivered again");
  } finally {
    await cleanup();
  }
});

test("transient failures retry with the same event ID; 410 ends the subscription", async () => {
  const { posted, post } = receiver([503, 500, 200]);
  let traces: QylTrace[] = [];
  const { runtime, store, cleanup } = await fixture(post, () => traces);
  try {
    await runtime.subscribe(subscribeParams({ arguments: {} }), ALICE);
    posted.length = 0;
    await runtime.poll();
    traces = [trace("e5", ["checkout"], true)];
    await runtime.poll();
    assert.equal(posted.length, 3);
    assert.equal(new Set(posted.map((entry) => entry.headers["webhook-id"])).size, 1);

    const gone = receiver([410]);
    const second = await fixture(gone.post, () => traces);
    try {
      await second.runtime.subscribe(subscribeParams(), ALICE);
      await second.runtime.poll();
      traces = [trace("f6", ["checkout"], true), ...traces];
      await second.runtime.poll();
      assert.equal(gone.posted.filter((entry) => JSON.parse(entry.body).eventId !== undefined).length, 1);
      assert.equal((await second.store.read()).subscriptions.length, 0, "410 disables the endpoint");
    } finally {
      await second.cleanup();
    }
    assert.equal((await store.read()).subscriptions.length, 1);
  } finally {
    await cleanup();
  }
});

test("a refresh with a new secret signs with both keys during rotation", async () => {
  const { posted, post } = receiver();
  let traces: QylTrace[] = [];
  const { runtime, cleanup } = await fixture(post, () => traces);
  try {
    await runtime.subscribe(subscribeParams(), ALICE);
    await runtime.subscribe(subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: NEXT_SECRET } }), ALICE);
    posted.length = 0;
    await runtime.poll();
    traces = [trace("g7", ["checkout"], true)];
    await runtime.poll();
    assert.equal(posted.length, 1);
    assert.ok(verifies(NEXT_SECRET, posted[0]!));
    assert.ok(verifies(SECRET, posted[0]!));
  } finally {
    await cleanup();
  }
});

test("unsubscribe stops delivery and is idempotent", async () => {
  const { post } = receiver();
  const { runtime, store, cleanup } = await fixture(post);
  try {
    await runtime.subscribe(subscribeParams(), ALICE);
    const params = {
      name: TRACE_ERROR_EVENT_NAME,
      arguments: { service_name: "checkout" },
      delivery: { mode: "webhook", url: CALLBACK },
    };
    await runtime.unsubscribe({ ...params, arguments: { service_name: "other" } }, ALICE);
    assert.equal((await store.read()).subscriptions.length, 1, "a different identity is untouched");
    assert.deepEqual(await runtime.unsubscribe(params, { ...ALICE, subject: "auth0|mallory" }), {});
    assert.equal((await store.read()).subscriptions.length, 1, "another principal cannot remove it");
    assert.deepEqual(await runtime.unsubscribe(params, ALICE), {});
    assert.deepEqual(await runtime.unsubscribe(params, ALICE), {});
    assert.equal((await store.read()).subscriptions.length, 0);
  } finally {
    await cleanup();
  }
});

test("over MCP: server/discover advertises events and the three methods answer", async () => {
  const { post } = receiver();
  const { runtime, cleanup } = await fixture(post);
  const authInfo: AuthInfo = { token: "t", clientId: "chatgpt", scopes: ["qyl:read"], extra: { subject: "auth0|alice" } };
  const handler = createMcpHandler(() => createServer({ nativeExecution: false, events: runtime }), { legacy: "reject" });
  const client = new Client({ name: "events-test", version: "0.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("http://qyl-events-test.invalid/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
    }));
    // The SDK client drops capability keys it has no schema for, so read the wire.
    const discovered = await handler.fetch(new Request("http://qyl-events-test.invalid/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "events-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }), { authInfo });
    const body = (await discovered.json()) as { result: { capabilities: Record<string, unknown> } };
    assert.deepEqual(body.result.capabilities["events"], {});

    const listed = await client.request(
      { method: "events/list", params: {} },
      z.object({ events: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough(),
    );
    assert.deepEqual(listed.events.map((event) => event.name), ["trace.error"]);

    const subscribed = await client.request(
      { method: "events/subscribe", params: subscribeParams() },
      z.object({ id: z.string(), refreshBefore: z.string(), cursor: z.null(), truncated: z.boolean() }).passthrough(),
    );
    assert.match(subscribed.id, /^sub_/u);

    const removed = await client.request(
      {
        method: "events/unsubscribe",
        params: { name: TRACE_ERROR_EVENT_NAME, arguments: { service_name: "checkout" }, delivery: { mode: "webhook", url: CALLBACK } },
      },
      z.object({}).passthrough(),
    );
    assert.deepEqual(Object.keys(removed).filter((key) => key !== "_meta"), []);
  } finally {
    await client.close();
    await handler.close();
    await cleanup();
  }
});
