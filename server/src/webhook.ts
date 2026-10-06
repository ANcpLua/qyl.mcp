/**
 * Outbound webhooks for MCP Events: Standard Webhooks signing and a callback
 * POST that only ever reaches a public HTTPS address.
 *
 * ChatGPT's MCP Events integration (developers.openai.com/plugins/build/mcp-events)
 * requires HTTPS callbacks, destination addresses resolved and validated at
 * connection time, the original hostname kept for TLS, non-public addresses
 * blocked, and no redirects — for verification requests and deliveries alike.
 * `node:https` gives each of those directly: a custom `lookup` validates the
 * address the socket actually connects to, `servername` stays the URL host,
 * and a redirect is just a 3xx status that is never followed.
 */

import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOneOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/** A complete delivery body may not exceed 256 KiB (ChatGPT MCP Events). */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** Verification echoes are tiny; anything past this is not a valid answer. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const SECRET_PREFIX = "whsec_";

export class WebhookSecretError extends Error {
  override name = "WebhookSecretError";
}

export class CallbackAddressError extends Error {
  override name = "CallbackAddressError";
}

/**
 * Decodes a Standard Webhooks symmetric secret: `whsec_` followed by the base64
 * of a 24–64 byte key (Standard Webhooks; ChatGPT MCP Events).
 */
export function decodeWebhookSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) {
    throw new WebhookSecretError("the signing secret must start with whsec_");
  }
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new WebhookSecretError("the signing secret is not base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64) {
    throw new WebhookSecretError(
      `the signing key must decode to 24–64 bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * The `webhook-signature` header: one `v1,<base64 HMAC-SHA256>` per secret over
 * `msgId.timestamp.body`, space-separated so a receiver accepts either key
 * during a secret rotation.
 */
export function signWebhook(
  secrets: readonly string[],
  msgId: string,
  timestampSeconds: number,
  body: string,
): string {
  const content = `${msgId}.${timestampSeconds}.${body}`;
  return secrets
    .map((secret) =>
      `v1,${createHmac("sha256", decodeWebhookSecret(secret)).update(content).digest("base64")}`,
    )
    .join(" ");
}

/** A fresh, unguessable identifier with a readable prefix. */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

/**
 * Every range that is not a public unicast destination: loopback, private,
 * shared, link-local, multicast, reserved, documentation and benchmarking
 * space, plus the IPv6 translation prefixes that can smuggle an IPv4 target.
 * `BlockList` applies the IPv4 rules to IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * itself; a `::ffff:0:0/96` rule would block every IPv4 address.
 */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Whether a literal IP address is a public unicast destination. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Parses a callback URL and rejects anything but an https URL to a public host. */
export function parseCallbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackAddressError("the callback URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new CallbackAddressError("the callback URL must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CallbackAddressError("the callback URL must not carry credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new CallbackAddressError("the callback URL points at a non-public address");
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new CallbackAddressError("the callback URL points at localhost");
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `lookup` for the callback socket: resolves the host and hands the socket
 * only a public address, so a name that resolves (or re-resolves) to a
 * private one never gets a connection.
 */
function publicOnlyLookup(
  hostname: string,
  options: LookupOneOptions,
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const allowed = addresses.filter((entry) => isPublicAddress(entry.address));
    if (allowed.length === 0 || allowed.length !== addresses.length) {
      callback(
        Object.assign(
          new CallbackAddressError(`${hostname} resolves to a non-public address`),
          { code: "ENOTPUBLIC" },
        ),
        "",
      );
      return;
    }
    if ((options as { all?: boolean }).all === true) {
      callback(null, allowed);
      return;
    }
    const first = allowed[0]!;
    callback(null, first.address, first.family);
  });
}

export interface WebhookResponse {
  status: number;
  body: string;
}

/** POSTs one signed body; a seam so tests can replace the network. */
export type WebhookPost = (
  url: URL,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<WebhookResponse>;

/** The production `WebhookPost`: HTTPS only, public addresses only, no redirects. */
export const postWebhook: WebhookPost = (url, body, headers, timeoutMs, signal) =>
  new Promise<WebhookResponse>((resolve, reject) => {
    let checked: URL;
    try {
      checked = parseCallbackUrl(url.href);
    } catch (error) {
      reject(error);
      return;
    }
    const host = checked.hostname.replace(/^\[|\]$/gu, "");
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: host,
        port: checked.port === "" ? 443 : Number(checked.port),
        path: `${checked.pathname}${checked.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup: publicOnlyLookup as never,
        ...(isIP(host) === 0 ? { servername: host } : {}),
        timeout: timeoutMs,
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`callback timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end(body);
  });
