import { createHash, randomBytes, randomUUID } from "node:crypto";

export const RUNNER_SESSION_COOKIE = "qyl-mcp-session";

export interface RunnerSessionIdentity {
    id: string;
    userId: string;
    defaultWorkspaceId: string;
    createdAt: string;
    expiresAt: string;
}

interface StoredSession extends RunnerSessionIdentity {
    tokenHash: string;
    lastSeenMs: number;
    absoluteExpiryMs: number;
}

export interface CreatedRunnerSession {
    identity: RunnerSessionIdentity;
    setCookie: string;
}

export interface RunnerSessionManagerOptions {
    userId?: string;
    defaultWorkspaceId?: string;
    idleTimeoutMs?: number;
    absoluteTimeoutMs?: number;
    secureCookies?: boolean;
    now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

/** In-memory HttpOnly session owner. Tokens never appear in public session metadata. */
export class RunnerSessionManager {
    private readonly sessions = new Map<string, StoredSession>();
    private readonly userId: string;
    private readonly defaultWorkspaceId: string;
    private readonly idleTimeoutMs: number;
    private readonly absoluteTimeoutMs: number;
    private readonly secureCookies: boolean;
    private readonly now: () => number;

    constructor(options: RunnerSessionManagerOptions = {}) {
        this.userId = options.userId ?? "local-user";
        this.defaultWorkspaceId = options.defaultWorkspaceId ?? "default";
        this.idleTimeoutMs = boundedTimeout(
            options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
            "idle timeout",
        );
        this.absoluteTimeoutMs = boundedTimeout(
            options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS,
            "absolute timeout",
        );
        if (this.idleTimeoutMs > this.absoluteTimeoutMs) {
            throw new Error("Runner session idle timeout cannot exceed its absolute timeout.");
        }
        this.secureCookies = options.secureCookies ?? false;
        this.now = options.now ?? Date.now;
    }

    create(): CreatedRunnerSession {
        this.prune();
        const now = this.now();
        const token = randomBytes(32).toString("base64url");
        const tokenHash = hashToken(token);
        const absoluteExpiryMs = now + this.absoluteTimeoutMs;
        const stored: StoredSession = {
            id: randomUUID(),
            userId: this.userId,
            defaultWorkspaceId: this.defaultWorkspaceId,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(Math.min(now + this.idleTimeoutMs, absoluteExpiryMs)).toISOString(),
            tokenHash,
            lastSeenMs: now,
            absoluteExpiryMs,
        };
        this.sessions.set(tokenHash, stored);
        return {
            identity: publicIdentity(stored),
            setCookie: sessionCookie(token, this.absoluteTimeoutMs, this.secureCookies),
        };
    }

    authenticate(cookieHeader: string | undefined): RunnerSessionIdentity | null {
        const token = readCookie(cookieHeader, RUNNER_SESSION_COOKIE);
        if (!token || token.length > 256) return null;
        const tokenHash = hashToken(token);
        const session = this.sessions.get(tokenHash);
        if (!session) return null;

        const now = this.now();
        if (isExpired(session, now, this.idleTimeoutMs)) {
            this.sessions.delete(tokenHash);
            return null;
        }

        session.lastSeenMs = now;
        session.expiresAt = new Date(
            Math.min(now + this.idleTimeoutMs, session.absoluteExpiryMs),
        ).toISOString();
        return publicIdentity(session);
    }

    revoke(cookieHeader: string | undefined): string {
        const token = readCookie(cookieHeader, RUNNER_SESSION_COOKIE);
        if (token && token.length <= 256) this.sessions.delete(hashToken(token));
        return clearSessionCookie(this.secureCookies);
    }

    prune(): number {
        const now = this.now();
        let removed = 0;
        for (const [tokenHash, session] of this.sessions) {
            if (!isExpired(session, now, this.idleTimeoutMs)) continue;
            this.sessions.delete(tokenHash);
            removed += 1;
        }
        return removed;
    }

    get size(): number {
        return this.sessions.size;
    }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header || !name) return undefined;
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;
        const key = part.slice(0, separator).trim();
        if (key !== name) continue;
        const value = part.slice(separator + 1).trim();
        if (!value) return undefined;
        try {
            return decodeURIComponent(value);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function publicIdentity(session: StoredSession): RunnerSessionIdentity {
    return {
        id: session.id,
        userId: session.userId,
        defaultWorkspaceId: session.defaultWorkspaceId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
    };
}

function sessionCookie(token: string, absoluteTimeoutMs: number, secure: boolean): string {
    const maxAge = Math.max(1, Math.floor(absoluteTimeoutMs / 1_000));
    return [
        `${RUNNER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "HttpOnly",
        "SameSite=Strict",
        "Path=/runner",
        `Max-Age=${maxAge}`,
        ...(secure ? ["Secure"] : []),
    ].join("; ");
}

function clearSessionCookie(secure: boolean): string {
    return [
        `${RUNNER_SESSION_COOKIE}=`,
        "HttpOnly",
        "SameSite=Strict",
        "Path=/runner",
        "Max-Age=0",
        ...(secure ? ["Secure"] : []),
    ].join("; ");
}

function isExpired(session: StoredSession, now: number, idleTimeoutMs: number): boolean {
    return now >= session.absoluteExpiryMs || now - session.lastSeenMs >= idleTimeoutMs;
}

function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

function boundedTimeout(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 31 * 24 * 60 * 60 * 1_000) {
        throw new Error(`Runner session ${name} must be between one second and 31 days.`);
    }
    return value;
}
