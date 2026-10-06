/**
 * Recheck the Auth0 account, explicit application grant, user consent and RBAC
 * permission without retaining the subscriber's OAuth tokens. Management
 * credentials come from the host's secret store; their access token lives only
 * in memory. API failures never authorize delivery.
 *
 * Auth0 Management API: users/{id}, users/{id}/permissions, client-grants, grants.
 */
import { z } from "zod";
import type { Principal } from "./events.js";
import { QYL_MCP_ISSUER, QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./oauth.js";

const REQUEST_TIMEOUT_MS = 10_000;
const ACCESS_CACHE_MS = 5_000;
const MAX_CACHE_ENTRIES = 1_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive(),
});
const UserSchema = z.object({ blocked: z.boolean().optional() });
const PermissionSchema = z.object({
  resource_server_identifier: z.string(), permission_name: z.string(),
});
const ClientGrantSchema = z.object({
  client_id: z.string().optional(), audience: z.string(),
  subject_type: z.string().optional(), scope: z.array(z.string()),
});
const UserGrantSchema = z.object({
  clientID: z.string(), user_id: z.string(), audience: z.string(),
  scope: z.array(z.string()), organization_id: z.string().optional(),
});

export interface EventsAuthorizationOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Thrown without response bodies, credentials or subscriber identifiers. */
class EventsAuthorizationUnavailable extends Error {
  override name = "EventsAuthorizationUnavailable";
  constructor() { super("Event authorization is temporarily unavailable"); }
}

export function createEventsAuthorization(options: EventsAuthorizationOptions): (principal: Principal) => Promise<boolean> {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let token: { value: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  const pending = new Map<string, Promise<boolean>>();
  const cache = new Map<string, { allowed: boolean; expiresAt: number }>();

  async function managementToken(): Promise<string> {
    if (token !== undefined && token.expiresAt > now()) return token.value;
    refreshing ??= (async () => {
      const response = await request(new URL("oauth/token", QYL_MCP_ISSUER), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials", client_id: options.clientId,
          client_secret: options.clientSecret, audience: `${QYL_MCP_ISSUER}api/v2/`,
        }),
      });
      if (!response.ok) throw new EventsAuthorizationUnavailable();
      const result = TokenSchema.parse(await response.json());
      token = { value: result.access_token, expiresAt: now() + Math.max(0, result.expires_in - 60) * 1_000 };
      return token.value;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  async function get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`api/v2/${path}`, QYL_MCP_ISSUER);
    url.search = new URLSearchParams(query).toString();
    const response = await request(url, {
      redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${await managementToken()}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      if (response.status === 401) token = undefined;
      throw new EventsAuthorizationUnavailable();
    }
    return response.json();
  }

  async function any<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>, predicate: (entry: T) => boolean): Promise<boolean> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await get(path, { ...query, per_page: String(PAGE_SIZE), page: String(page) });
      if (body === undefined) return false;
      const entries = z.array(schema).parse(body);
      if (entries.some(predicate)) return true;
      if (entries.length < PAGE_SIZE) return false;
    }
    // An incomplete permission listing is not evidence of revocation.
    throw new EventsAuthorizationUnavailable();
  }

  async function check(principal: Principal): Promise<boolean> {
    const userPath = `users/${encodeURIComponent(principal.subject)}`;
    const body = await get(userPath, { fields: "blocked", include_fields: "true" });
    if (body === undefined || UserSchema.parse(body).blocked === true) return false;
    const [permission, application, consent] = await Promise.all([
      any(`${userPath}/permissions`, {}, PermissionSchema, (entry) =>
        entry.resource_server_identifier === QYL_MCP_RESOURCE && entry.permission_name === QYL_MCP_SCOPE),
      any("client-grants", { client_id: principal.clientId, audience: QYL_MCP_RESOURCE, subject_type: "user" }, ClientGrantSchema, (entry) =>
        entry.client_id === principal.clientId && entry.audience === QYL_MCP_RESOURCE
        && entry.subject_type === "user" && entry.scope.includes(QYL_MCP_SCOPE)),
      any("grants", { user_id: principal.subject, client_id: principal.clientId, audience: QYL_MCP_RESOURCE }, UserGrantSchema, (entry) =>
        entry.user_id === principal.subject && entry.clientID === principal.clientId
        && entry.audience === QYL_MCP_RESOURCE && entry.organization_id === undefined
        && entry.scope.includes(QYL_MCP_SCOPE)),
    ]);
    return permission && application && consent;
  }

  return (principal) => {
    const key = JSON.stringify([principal.subject, principal.clientId]);
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return Promise.resolve(cached.allowed);
    let checking = pending.get(key);
    if (checking === undefined) {
      checking = check(principal).then((allowed) => {
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
        cache.set(key, { allowed, expiresAt: now() + ACCESS_CACHE_MS });
        return allowed;
      }).catch(() => {
        throw new EventsAuthorizationUnavailable();
      }).finally(() => { pending.delete(key); });
      pending.set(key, checking);
    }
    return checking;
  };
}

export function hostedEventsAuthorization(environment: Readonly<Record<string, string | undefined>>): (principal: Principal) => Promise<boolean> {
  const clientId = environment["MCP_EVENTS_AUTH0_CLIENT_ID"]?.trim();
  const clientSecret = environment["MCP_EVENTS_AUTH0_CLIENT_SECRET"]?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("MCP_EVENTS_STORE requires MCP_EVENTS_AUTH0_CLIENT_ID and MCP_EVENTS_AUTH0_CLIENT_SECRET for ongoing access checks");
  }
  return createEventsAuthorization({ clientId, clientSecret });
}
