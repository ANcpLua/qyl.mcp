/**
 * MCP Events for ChatGPT: `events/list`, `events/subscribe` and
 * `events/unsubscribe` on the authenticated MCP endpoint, with signed webhook
 * delivery of one event type, `trace.error`.
 *
 * Contract: developers.openai.com/plugins/build/mcp-events (ChatGPT supports
 * webhook delivery with callback verification only) and the draft MCP Events
 * design sketch in modelcontextprotocol/experimental-ext-triggers-events.
 * `@modelcontextprotocol/server` 2.3.1 ships no `events/*` methods, so the
 * three are custom request handlers and the capability is added by hand.
 *
 * Delivery source: the collector's recent-trace list, polled only while a
 * subscription is live. The first poll sets a baseline, so a subscription
 * never receives a backlog. Events carry `cursor: null` — there is no replay;
 * traces that arrive while the server is down are not delivered.
 *
 * Access: subscribing, refreshing and unsubscribing each pass the same OAuth
 * gate as every tool call. The required authorization callback rechecks the
 * owner's current access while polling and before delivery, including retries.
 * Authorization outages suspend delivery; revoked access removes the record.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer, ServerCapabilities, ServerContext } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { fetchTraces } from "./data.js";
import { CollectorAccessError, collectorAccessForSubject } from "./collector-access.js";
import { collectorUrl } from "./config.js";
import { rootSpanName } from "./summaries.js";
import type { QylTrace } from "./wire.js";
import {
  CallbackAddressError,
  WEBHOOK_MAX_BODY_BYTES,
  WebhookSecretError,
  decodeWebhookSecret,
  parseCallbackUrl,
  postWebhook,
  randomId,
  signWebhook,
  type WebhookPost,
} from "./webhook.js";

export const TRACE_ERROR_EVENT_NAME = "trace.error";

/** JSON-RPC error for a callback that failed validation or verification. */
export const CALLBACK_ENDPOINT_ERROR = -32015;

const MINUTE_MS = 60_000;
export const DEFAULT_TTL_MS = 60 * MINUTE_MS;
export const MIN_TTL_MS = 5 * MINUTE_MS;
export const MAX_TTL_MS = 24 * 60 * MINUTE_MS;
const VERIFICATION_CACHE_MS = 60 * MINUTE_MS;
const SECRET_ROTATION_WINDOW_MS = 10 * MINUTE_MS;
const CALLBACK_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const TRACES_PER_POLL = 100;
const MAX_SEEN_TRACES = 5_000;
const DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
/**
 * Live subscriptions one caller may hold. Every subscription is a stored
 * entry, a delivery fan-out target and, for a new callback, an outbound
 * verification POST; without a cap one account grows all three at will.
 */
export const MAX_SUBSCRIPTIONS_PER_PRINCIPAL = 20;

/** The one event definition `events/list` returns. */
export const TRACE_ERROR_EVENT = {
  name: TRACE_ERROR_EVENT_NAME,
  description:
    "A trace containing at least one error span reached the qyl collector. " +
    "Pass service_name to watch one service; omit it to watch every service.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      service_name: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Only traces that involve this service.",
      },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      trace_id: { type: "string", description: "Trace identifier; pass it to get_trace or display_traces." },
      root_span: { type: "string", description: "Name of the trace's root span." },
      services: { type: "array", items: { type: "string" }, description: "Services involved in the trace." },
      span_count: { type: "integer", description: "Total span count." },
      duration_ms: { type: "number", description: "Trace duration in milliseconds." },
      start_time: { type: "string", format: "date-time", description: "Trace start time." },
    },
    required: ["trace_id", "root_span", "services", "span_count", "duration_ms", "start_time"],
    additionalProperties: false,
  },
} as const;

const TraceErrorArgumentsSchema = z
  .object({ service_name: z.string().min(1).max(128).optional() })
  .strict();
type TraceErrorArguments = z.infer<typeof TraceErrorArgumentsSchema>;

const ListParamsSchema = z.object({ cursor: z.string().optional() }).passthrough();

const SubscribeParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: z
      .object({ mode: z.string(), url: z.string(), secret: z.string().optional() })
      .passthrough(),
    cursor: z.string().nullable().optional(),
    ttlMs: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
export type SubscribeParams = z.infer<typeof SubscribeParamsSchema>;

const UnsubscribeParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: z.object({ mode: z.string().optional(), url: z.string() }).passthrough(),
  })
  .passthrough();
export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;

/** The authenticated caller a subscription belongs to. */
export interface Principal {
  subject: string;
  clientId: string;
}

const StoredSubscriptionSchema = z.object({
  id: z.string(),
  subject: z.string(),
  clientId: z.string(),
  name: z.literal(TRACE_ERROR_EVENT_NAME),
  arguments: TraceErrorArgumentsSchema,
  url: z.string(),
  secret: z.string(),
  previousSecret: z.string().optional(),
  previousSecretUntil: z.string().optional(),
  refreshBefore: z.string(),
  updatedAt: z.string(),
});
export type StoredSubscription = z.infer<typeof StoredSubscriptionSchema>;

const EventStoreStateSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(StoredSubscriptionSchema),
});
export type EventStoreState = z.infer<typeof EventStoreStateSchema>;

/** Subscription storage that survives restarts: an atomic JSON file (0600). */
export function createEventStore(filePath: string): AtomicJsonStore<EventStoreState> {
  return new AtomicJsonStore<EventStoreState>(filePath, {
    initial: () => ({ version: 1, subscriptions: [] }),
    parse: (value) => EventStoreStateSchema.parse(value),
    prepareForWrite: (value) => value,
  });
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` name one subscription. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic ID over principal, callback URL, event name and arguments. */
export function subscriptionId(
  principal: Principal,
  url: string,
  name: string,
  args: unknown,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson([principal.clientId, principal.subject, url, name, args ?? {}]))
    .digest("base64url");
  return `sub_${digest.slice(0, 32)}`;
}

/** The lifetime granted for a requested `ttlMs`: bounded, and never unbounded. */
export function grantedTtlMs(ttlMs: number | null | undefined): number {
  if (ttlMs === undefined) return DEFAULT_TTL_MS;
  if (ttlMs === null) return MAX_TTL_MS;
  return Math.min(Math.max(ttlMs, MIN_TTL_MS), MAX_TTL_MS);
}

/** The principal of a verified request, or a JSON-RPC error without one. */
export function principalOf(ctx: Pick<ServerContext, "http">): Principal {
  const authInfo = ctx.http?.authInfo;
  const subject = authInfo?.extra?.["subject"];
  if (authInfo === undefined || typeof subject !== "string" || subject.length === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      "MCP Events requires an authenticated caller",
    );
  }
  return { subject, clientId: authInfo.clientId };
}

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function callbackError(message: string, reason: string): ProtocolError {
  return new ProtocolError(CALLBACK_ENDPOINT_ERROR, message, { reason });
}

function parseArguments(name: string, args: unknown): TraceErrorArguments {
  if (name !== TRACE_ERROR_EVENT_NAME) throw invalidParams(`unknown event "${name}"`);
  const parsed = TraceErrorArgumentsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    throw invalidParams(`invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? "rejected"}`);
  }
  return parsed.data;
}

function checkedCallbackUrl(value: string): URL {
  try {
    return parseCallbackUrl(value);
  } catch (error) {
    if (error instanceof CallbackAddressError) throw callbackError(error.message, "invalid_url");
    throw error;
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The `data` of a `trace.error` delivery; matches `payloadSchema`. */
export function traceErrorPayload(trace: QylTrace): Record<string, unknown> {
  return {
    trace_id: trace.trace_id,
    root_span: rootSpanName(trace),
    services: [...trace.services],
    span_count: trace.span_count,
    duration_ms: Math.round(Number(trace.duration_ns) / 1_000) / 1_000,
    start_time: new Date(trace.start_time).toISOString(),
  };
}

function matches(subscription: StoredSubscription, trace: QylTrace): boolean {
  const service = subscription.arguments.service_name;
  return service === undefined || trace.services.includes(service);
}

export interface EventsRuntimeOptions {
  store: AtomicJsonStore<EventStoreState>;
  /** Live access check. False revokes; errors suspend delivery without deleting state. */
  isAuthorized: (principal: Principal) => Promise<boolean>;
  /** Network seam; defaults to the public-HTTPS-only `postWebhook`. */
  post?: WebhookPost;
  /** Trace source scoped to the authenticated subscriber's project. */
  recentTraces?: (principal: Principal) => Promise<readonly QylTrace[]>;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * One per process: owns the subscription store, the verification cache and the
 * poller. `register` wires the three methods into each per-request McpServer.
 */
export class EventsRuntime {
  private readonly store: AtomicJsonStore<EventStoreState>;
  private readonly isAuthorized: EventsRuntimeOptions["isAuthorized"];
  private readonly post: WebhookPost;
  private readonly recentTraces: NonNullable<EventsRuntimeOptions["recentTraces"]>;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: NonNullable<EventsRuntimeOptions["sleep"]>;
  private readonly log: (message: string) => void;
  private readonly verified = new Map<string, number>();
  private readonly seen = new Map<string, { source: string; traces: Set<string> }>();
  private ready: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private stopped = false;
  private readonly deliveries = new Map<string, Set<{ controller: AbortController; done: Promise<void> }>>();

  constructor(options: EventsRuntimeOptions) {
    this.store = options.store;
    this.isAuthorized = options.isAuthorized;
    this.post = options.post ?? postWebhook;
    this.recentTraces = options.recentTraces
      ?? (async (principal) => {
        const access = collectorAccessForSubject(principal.subject);
        return (await fetchTraces(TRACES_PER_POLL, access === undefined ? {} : { access })).traces;
      });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.log = options.log ?? ((message) => process.stderr.write(`qyl.mcp events: ${message}\n`));
  }

  /** Advertise `events` and answer the three methods on this server instance. */
  register(server: McpServer): void {
    // ServerCapabilities has no `events` key yet; `server/discover` passes it through.
    server.server.registerCapabilities({ events: {} } as unknown as ServerCapabilities);
    server.server.setRequestHandler("events/list", { params: ListParamsSchema }, () => this.list());
    server.server.setRequestHandler(
      "events/subscribe",
      { params: SubscribeParamsSchema },
      (params, ctx) => this.subscribe(params, principalOf(ctx)),
    );
    server.server.setRequestHandler(
      "events/unsubscribe",
      { params: UnsubscribeParamsSchema },
      (params, ctx) => this.unsubscribe(params, principalOf(ctx)),
    );
  }

  list(): { events: (typeof TRACE_ERROR_EVENT)[] } {
    return { events: [TRACE_ERROR_EVENT] };
  }

  async subscribe(
    params: SubscribeParams,
    principal: Principal,
  ): Promise<{ id: string; refreshBefore: string; cursor: null; truncated: false }> {
    const args = parseArguments(params.name, params.arguments);
    if (params.delivery.mode !== "webhook") {
      throw invalidParams(`delivery mode "${params.delivery.mode}" is not supported; use "webhook"`);
    }
    const secret = params.delivery.secret;
    if (secret === undefined) throw invalidParams("webhook delivery requires a whsec_ secret");
    try {
      decodeWebhookSecret(secret);
    } catch (error) {
      if (error instanceof WebhookSecretError) throw invalidParams(error.message);
      throw error;
    }
    const url = checkedCallbackUrl(params.delivery.url);
    const id = subscriptionId(principal, url.href, params.name, args);

    let allowed: boolean;
    try {
      collectorAccessForSubject(principal.subject);
      allowed = await this.isAuthorized(principal);
    } catch (error) {
      if (error instanceof CollectorAccessError) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, error.message);
      }
      throw new ProtocolError(ProtocolErrorCode.InternalError, "Event authorization is temporarily unavailable");
    }
    if (!allowed) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Event access has been revoked");
    }

    // Checked before the verification POST, and again atomically below.
    await this.initialized();
    this.assertCapacity(await this.store.read(), principal, id);
    await this.verifyCallback(principal, url, id, secret);

    const now = this.now();
    const refreshBefore = new Date(now + grantedTtlMs(params.ttlMs)).toISOString();
    await this.store.transact((state) => {
      this.pruneState(state);
      this.assertCapacity(state, principal, id);
      const existing = state.subscriptions.find((entry) => entry.id === id);
      const rotated = existing !== undefined && existing.secret !== secret;
      const next: StoredSubscription = {
        id,
        subject: principal.subject,
        clientId: principal.clientId,
        name: TRACE_ERROR_EVENT_NAME,
        arguments: args,
        url: url.href,
        secret,
        ...(rotated
          ? {
            previousSecret: existing.secret,
            previousSecretUntil: new Date(now + SECRET_ROTATION_WINDOW_MS).toISOString(),
          }
          : existing?.previousSecret !== undefined && existing.previousSecretUntil !== undefined
            ? { previousSecret: existing.previousSecret, previousSecretUntil: existing.previousSecretUntil }
            : {}),
        refreshBefore,
        updatedAt: new Date(now).toISOString(),
      };
      state.subscriptions = [...state.subscriptions.filter((entry) => entry.id !== id), next];
    });
    this.ensurePolling();
    return { id, refreshBefore, cursor: null, truncated: false };
  }

  async unsubscribe(params: UnsubscribeParams, principal: Principal): Promise<Record<string, never>> {
    const args = parseArguments(params.name, params.arguments);
    const url = checkedCallbackUrl(params.delivery.url);
    const id = subscriptionId(principal, url.href, params.name, args);
    await this.initialized();
    await this.store.transact((state) => {
      state.subscriptions = state.subscriptions.filter((entry) => entry.id !== id);
    });
    const active = this.deliveries.get(id);
    for (const delivery of active ?? []) delivery.controller.abort();
    await Promise.allSettled([...(active ?? [])].map((delivery) => delivery.done));
    return {};
  }

  /** A refresh always passes; a new subscription needs a free slot for its caller. */
  private assertCapacity(state: EventStoreState, principal: Principal, id: string): void {
    if (state.subscriptions.some((entry) => entry.id === id)) return;
    const held = state.subscriptions.filter((entry) =>
      entry.subject === principal.subject
      && entry.clientId === principal.clientId
      && this.isLive(entry)).length;
    if (held >= MAX_SUBSCRIPTIONS_PER_PRINCIPAL) {
      throw invalidParams(
        `at most ${MAX_SUBSCRIPTIONS_PER_PRINCIPAL} live subscriptions per caller; unsubscribe one first`,
      );
    }
  }

  /**
   * A signed, single-use challenge before any application data; a success is
   * cached per principal and callback URL for a bounded period.
   */
  private async verifyCallback(principal: Principal, url: URL, id: string, secret: string): Promise<void> {
    const key = canonicalJson([principal.clientId, principal.subject, url.href]);
    const cachedUntil = this.verified.get(key);
    if (cachedUntil !== undefined && cachedUntil > this.now()) return;

    const challenge = randomId("chl");
    const body = JSON.stringify({ type: "verification", challenge });
    const msgId = randomId("msg_verification");
    const timestamp = Math.floor(this.now() / 1000);
    let response;
    try {
      response = await this.post(url, body, {
        "content-type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook([secret], msgId, timestamp, body),
        "x-mcp-subscription-id": id,
      }, CALLBACK_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CallbackAddressError) throw callbackError(error.message, "invalid_url");
      const timedOut = error instanceof Error && /timed out/u.test(error.message);
      throw callbackError(
        "callback verification request failed",
        timedOut ? "timeout" : "unreachable",
      );
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(response.body) as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    if (response.status < 200 || response.status > 299 || typeof echoed !== "string" || !sameText(echoed, challenge)) {
      throw callbackError("callback did not echo the verification challenge", "challenge_failed");
    }
    if (this.verified.size >= 10_000) this.verified.clear();
    this.verified.set(key, this.now() + VERIFICATION_CACHE_MS);
  }

  /** Loads the store once; every store access waits for it. */
  private initialized(): Promise<void> {
    this.ready ??= this.store.initialize();
    return this.ready;
  }

  /** Start the poller if a live subscription exists; `stop` ends it. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.initialized();
    const { state } = await this.store.transact((draft) => this.pruneState(draft));
    if (state.subscriptions.some((entry) => this.isLive(entry))) this.ensurePolling();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const active of this.deliveries.values()) {
      for (const delivery of active) delivery.controller.abort();
    }
    await this.polling;
  }

  private ensurePolling(): void {
    if (this.stopped || this.timer !== undefined) return;
    // A failed store write rejects; an unhandled rejection would end the process.
    this.timer = setInterval(() => {
      this.poll().catch((error: unknown) => {
        this.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  private isLive(entry: StoredSubscription): boolean {
    return Date.parse(entry.refreshBefore) > this.now();
  }

  private pruneState(state: EventStoreState): void {
    state.subscriptions = state.subscriptions.filter((entry) => this.isLive(entry));
    for (const entry of state.subscriptions) {
      if (entry.previousSecretUntil === undefined || Date.parse(entry.previousSecretUntil) <= this.now()) {
        delete entry.previousSecret;
        delete entry.previousSecretUntil;
      }
    }
  }

  private async authorized(subscription: StoredSubscription): Promise<boolean> {
    let allowed: boolean;
    try {
      collectorAccessForSubject(subscription.subject);
      allowed = await this.isAuthorized(subscription);
    } catch (error) {
      if (error instanceof CollectorAccessError) {
        allowed = false;
      } else {
        this.log(`authorization unavailable for ${subscription.id}; delivery suspended`);
        return false;
      }
    }
    if (!allowed) {
      await this.store.transact((state) => {
        state.subscriptions = state.subscriptions.filter((entry) => entry.id !== subscription.id);
      });
    }
    return allowed;
  }

  /** One poll: drop lapsed subscriptions, then deliver each new error trace. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    await this.initialized();
    const { state } = await this.store.transact((draft) => {
      this.pruneState(draft);
    });
    if (state.subscriptions.length === 0) {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
      this.seen.clear();
      return;
    }

    const subscriptions: StoredSubscription[] = [];
    for (const subscription of state.subscriptions) {
      if (await this.authorized(subscription)) subscriptions.push(subscription);
    }
    const groups = new Map<string, StoredSubscription[]>();
    for (const subscription of subscriptions) {
      const key = this.sourceKey(subscription);
      const group = groups.get(key) ?? [];
      group.push(subscription);
      groups.set(key, group);
    }
    // An authorization outage suspends a live subscription; retain its baseline
    // so recovery can still deliver errors that arrived during the outage.
    const retainedKeys = new Set<string>();
    for (const subscription of state.subscriptions) {
      try {
        this.sourceKey(subscription);
        retainedKeys.add(subscription.id);
      } catch (error) {
        if (!(error instanceof CollectorAccessError)) throw error;
      }
    }
    for (const key of this.seen.keys()) {
      if (!retainedKeys.has(key)) this.seen.delete(key);
    }
    const results = (await Promise.all([...groups].map(async ([key, group]) => {
      let traces: readonly QylTrace[];
      try {
        traces = await this.recentTraces(group[0]!);
      } catch {
        this.log("collector poll failed; delivery suspended for this account");
        return [];
      }

      const deliveries: Promise<void>[] = [];
      for (const subscription of group) {
        const previous = this.seen.get(subscription.id);
        if (previous === undefined || previous.source !== key) {
          this.seen.set(subscription.id, {
            source: key,
            traces: new Set(traces.filter((trace) => trace.has_error).map((trace) => trace.trace_id)),
          });
          continue;
        }
        // Fetch once per project; authorization outages must not advance the
        // delivery baseline belonging to a different subscription.
        const fresh = traces.filter((trace) => trace.has_error && !previous.traces.has(trace.trace_id));
        for (const trace of fresh) previous.traces.add(trace.trace_id);
        if (previous.traces.size > MAX_SEEN_TRACES) {
          previous.traces = new Set([...previous.traces].slice(-MAX_SEEN_TRACES));
        }
        for (const trace of fresh) {
          if (matches(subscription, trace)) deliveries.push(this.deliver(subscription, trace, key));
        }
      }
      return Promise.allSettled(deliveries);
    }))).flat();
    for (const result of results) {
      if (result.status === "rejected") this.log("event delivery failed");
    }
  }

  private sourceKey(principal: Principal): string {
    const project = collectorAccessForSubject(principal.subject)?.project
      ?? (process.env.QYL_PROJECT?.trim() || "default");
    return canonicalJson([collectorUrl(), project]);
  }

  private deliver(subscription: StoredSubscription, trace: QylTrace, sourceKey: string): Promise<void> {
    const controller = new AbortController();
    const done = this.deliverWhileActive(subscription, trace, sourceKey, controller.signal);
    const active = this.deliveries.get(subscription.id) ?? new Set();
    this.deliveries.set(subscription.id, active);
    const delivery = { controller, done };
    active.add(delivery);
    return done.finally(() => {
      active.delete(delivery);
      if (active.size === 0) this.deliveries.delete(subscription.id);
    });
  }

  /** POST one signed event, retrying transient failures with backoff. */
  private async deliverWhileActive(
    subscription: StoredSubscription, trace: QylTrace, sourceKey: string, signal: AbortSignal,
  ): Promise<void> {
    const event = {
      eventId: `evt_${trace.trace_id}`,
      name: subscription.name,
      timestamp: new Date(trace.start_time).toISOString(),
      data: traceErrorPayload(trace),
      cursor: null,
    };
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, "utf8") > WEBHOOK_MAX_BODY_BYTES) {
      this.log(`dropped ${event.eventId}: body exceeds 256 KiB`);
      return;
    }

    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
      if (this.stopped || signal.aborted || !await this.authorized(subscription)) return;
      // Re-read after the async access check: unsubscribe, expiry and key
      // rotation must also take effect during retries and in-flight polls.
      const current = (await this.store.read()).subscriptions.find((entry) => entry.id === subscription.id);
      if (this.stopped || signal.aborted || current === undefined || !this.isLive(current)) return;
      subscription = current;
      if (this.sourceKey(subscription) !== sourceKey) return;
      const timestamp = Math.floor(this.now() / 1000);
      const secrets = subscription.previousSecret !== undefined
        && subscription.previousSecretUntil !== undefined
        && Date.parse(subscription.previousSecretUntil) > this.now()
        ? [subscription.secret, subscription.previousSecret]
        : [subscription.secret];
      let status: number | undefined;
      try {
        status = (await this.post(new URL(subscription.url), body, {
          "content-type": "application/json",
          "webhook-id": event.eventId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signWebhook(secrets, event.eventId, timestamp, body),
          "x-mcp-subscription-id": subscription.id,
        }, CALLBACK_TIMEOUT_MS, signal)).status;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CallbackAddressError) {
          this.log(`dropped ${event.eventId} for ${subscription.id}: ${error.message}`);
          return;
        }
      }
      if (status !== undefined && status >= 200 && status <= 299) return;
      if (status === 410) {
        // Standard Webhooks: 410 Gone disables the endpoint.
        await this.store.transact((state) => {
          state.subscriptions = state.subscriptions.filter((entry) => entry.id !== subscription.id);
        });
        return;
      }
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient) {
        this.log(`dropped ${event.eventId} for ${subscription.id}: HTTP ${status}`);
        return;
      }
      if (attempt < DELIVERY_ATTEMPTS) {
        try {
          await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
      }
    }
    this.log(`gave up on ${event.eventId} for ${subscription.id} after ${DELIVERY_ATTEMPTS} attempts`);
  }
}
