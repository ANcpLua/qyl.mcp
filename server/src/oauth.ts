import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

/**
 * Anonymous OAuth 2.1 provider for the hosted MCP endpoint.
 *
 * The MCP SDK owns the wire protocol (metadata, dynamic registration, authorize,
 * token, PKCE validation); this provider supplies the policy: every client that
 * completes the standard flow is approved immediately — no account, no login UI.
 * The value of the ceremony is that stock MCP clients connect unattended via
 * discovery, and every issued credential is scoped, expiring, and revocable by
 * secret rotation.
 *
 * Everything is stateless: client identities, authorization codes, and tokens are
 * HMAC-signed payloads, so a redeploy or restart never invalidates the fleet by
 * losing a store — only rotating the signing secret does.
 */

const CLIENT_PREFIX = "qylci";
const CODE_PREFIX = "qylac";
const ACCESS_PREFIX = "qylat";
const REFRESH_PREFIX = "qylrt";

const CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const SCOPE = "qyl";

interface ClientPayload {
  redirectUris: string[];
  issuedAt: number;
}

interface CodePayload {
  clientDigest: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

interface TokenPayload {
  clientDigest: string;
  expiresAt: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function clientDigest(clientId: string): string {
  return createHash("sha256").update(clientId, "utf8").digest("base64url").slice(0, 22);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class AnonymousOAuthProvider implements OAuthServerProvider {
  readonly #secret: Buffer;
  readonly #staticToken: string | undefined;

  /**
   * @param signingSecret - HMAC key for all issued material. Deployments derive it
   *   from `MCP_AUTH_TOKEN` so no second secret convention exists; rotating the
   *   token invalidates every issued credential at once.
   * @param staticToken - The pre-OAuth operator bearer token, still accepted so
   *   existing configured connectors keep working.
   */
  constructor(signingSecret: string, staticToken?: string) {
    this.#secret = createHash("sha256").update(`qyl-oauth:${signingSecret}`, "utf8").digest();
    this.#staticToken = staticToken;
  }

  #sign(prefix: string, body: string): string {
    const signature = createHmac("sha256", this.#secret)
      .update(`${prefix}.${body}`, "utf8")
      .digest("base64url");
    return `${prefix}.${body}.${signature}`;
  }

  #open(prefix: string, value: string): string | undefined {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== prefix) return undefined;
    const [, body, signature] = parts;
    const expected = createHmac("sha256", this.#secret)
      .update(`${prefix}.${body}`, "utf8")
      .digest("base64url");
    if (!constantTimeEquals(signature ?? "", expected)) return undefined;
    try {
      return base64UrlDecode(body ?? "");
    } catch {
      return undefined;
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const provider = this;
    return {
      getClient(clientId: string): OAuthClientInformationFull | undefined {
        const decoded = provider.#open(CLIENT_PREFIX, clientId);
        if (decoded === undefined) return undefined;
        let payload: ClientPayload;
        try {
          payload = JSON.parse(decoded) as ClientPayload;
        } catch {
          return undefined;
        }
        if (!Array.isArray(payload.redirectUris) || payload.redirectUris.length === 0) {
          return undefined;
        }
        return {
          client_id: clientId,
          client_id_issued_at: payload.issuedAt,
          redirect_uris: payload.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
      },
      registerClient(
        client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
      ): OAuthClientInformationFull {
        const payload: ClientPayload = {
          redirectUris: client.redirect_uris,
          issuedAt: Math.floor(Date.now() / 1000),
        };
        const clientId = provider.#sign(CLIENT_PREFIX, base64UrlEncode(JSON.stringify(payload)));
        return {
          ...client,
          client_id: clientId,
          client_id_issued_at: payload.issuedAt,
          // Public client with PKCE: no secret exists, so nothing can leak.
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
      },
    };
  }

  // Anonymous policy: the flow's consent step is a no-op redirect. Every client
  // that speaks OAuth 2.1 + PKCE gets a code immediately.
  authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const payload: CodePayload = {
      clientDigest: clientDigest(client.client_id),
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      ...(params.resource === undefined ? {} : { resource: params.resource.href }),
      expiresAt: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS,
    };
    const code = this.#sign(CODE_PREFIX, base64UrlEncode(JSON.stringify(payload)));
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(target.href);
    return Promise.resolve();
  }

  #openCode(client: OAuthClientInformationFull, authorizationCode: string): CodePayload {
    const decoded = this.#open(CODE_PREFIX, authorizationCode);
    if (decoded === undefined) throw new InvalidGrantError("Invalid authorization code");
    const payload = JSON.parse(decoded) as CodePayload;
    if (payload.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Authorization code expired");
    }
    if (payload.clientDigest !== clientDigest(client.client_id)) {
      throw new InvalidGrantError("Authorization code was issued to a different client");
    }
    return payload;
  }

  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return Promise.resolve(this.#openCode(client, authorizationCode).codeChallenge);
  }

  #issueTokens(digest: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const access: TokenPayload = { clientDigest: digest, expiresAt: now + ACCESS_TTL_SECONDS };
    const refresh: TokenPayload = { clientDigest: digest, expiresAt: now + REFRESH_TTL_SECONDS };
    return {
      access_token: this.#sign(ACCESS_PREFIX, base64UrlEncode(JSON.stringify(access))),
      token_type: "bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope: SCOPE,
      refresh_token: this.#sign(REFRESH_PREFIX, base64UrlEncode(JSON.stringify(refresh))),
    };
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const payload = this.#openCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== payload.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return Promise.resolve(this.#issueTokens(payload.clientDigest));
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const decoded = this.#open(REFRESH_PREFIX, refreshToken);
    if (decoded === undefined) throw new InvalidGrantError("Invalid refresh token");
    const payload = JSON.parse(decoded) as TokenPayload;
    if (payload.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Refresh token expired");
    }
    if (payload.clientDigest !== clientDigest(client.client_id)) {
      throw new InvalidGrantError("Refresh token was issued to a different client");
    }
    return Promise.resolve(this.#issueTokens(payload.clientDigest));
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.#staticToken !== undefined && constantTimeEquals(token, this.#staticToken)) {
      return Promise.resolve({
        token,
        clientId: "qyl-operator",
        scopes: [SCOPE],
        // The SDK middleware requires an expiry; the operator token itself never
        // expires, so give each verification a rolling one-hour horizon.
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    const decoded = this.#open(ACCESS_PREFIX, token);
    if (decoded === undefined) {
      return Promise.reject(new InvalidTokenError("Invalid access token"));
    }
    const payload = JSON.parse(decoded) as TokenPayload;
    if (payload.expiresAt < Math.floor(Date.now() / 1000)) {
      return Promise.reject(new InvalidTokenError("Access token expired"));
    }
    return Promise.resolve({
      token,
      clientId: payload.clientDigest,
      scopes: [SCOPE],
      expiresAt: payload.expiresAt,
    });
  }
}
