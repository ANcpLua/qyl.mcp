import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type PersistenceErrorKind = "invalid_json" | "invalid_state" | "write_failed";

export class PersistenceError extends Error {
    constructor(
        readonly kind: PersistenceErrorKind,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "PersistenceError";
    }
}

export interface AtomicJsonStoreOptions<T> {
    initial: () => T;
    /** Validates untrusted data loaded from disk and returns its normalized representation. */
    parse: (value: unknown) => T;
    /** Redacts or rejects sensitive state before it can reach disk. */
    prepareForWrite: (value: T) => T;
}

/**
 * A single-process, serialized JSON store with restrictive permissions and atomic replacement.
 * Domain services remain responsible for workspace scoping; this class guarantees that a failed
 * validation or write never replaces the last known-good document.
 */
export class AtomicJsonStore<T> {
    private state: T | undefined;
    private initialization: Promise<void> | undefined;
    private tail: Promise<void> = Promise.resolve();

    constructor(
        private readonly filePath: string,
        private readonly options: AtomicJsonStoreOptions<T>,
    ) {}

    async initialize(): Promise<void> {
        this.initialization ??= this.load();
        return this.initialization;
    }

    async read(): Promise<T> {
        await this.initialize();
        // Reads participate in the same happens-before order as writes. This is
        // required for deletion guards and idempotency lookups: returning the
        // cached document while an earlier transaction is still pending can
        // expose stale ownership or active-work state.
        await this.tail;
        return clone(this.requireState());
    }

    async replace(value: T): Promise<T> {
        return this.enqueue(async () => this.commit(value));
    }

    async transact<R>(mutate: (draft: T) => R | Promise<R>): Promise<{ state: T; result: R }> {
        return this.enqueue(async () => {
            const draft = clone(this.requireState());
            const result = await mutate(draft);
            const state = await this.commit(draft);
            return { state, result };
        });
    }

    private async load(): Promise<void> {
        let text: string;
        try {
            text = await readFile(this.filePath, "utf8");
        } catch (error) {
            if (isNodeError(error, "ENOENT")) {
                this.state = await this.writePrepared(this.options.initial());
                return;
            }
            throw error;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text) as unknown;
        } catch (error) {
            throw new PersistenceError(
                "invalid_json",
                `Persisted qyl.mcp state at '${this.filePath}' is not valid JSON.`,
                { cause: error },
            );
        }

        try {
            this.state = clone(this.options.parse(parsed));
        } catch (error) {
            throw new PersistenceError(
                "invalid_state",
                `Persisted qyl.mcp state at '${this.filePath}' does not satisfy the current schema.`,
                { cause: error },
            );
        }
    }

    private async commit(value: T): Promise<T> {
        await this.initialize();
        const normalized = await this.writePrepared(value);
        this.state = normalized;
        return clone(normalized);
    }

    private async writePrepared(value: T): Promise<T> {
        let normalized: T;
        try {
            const prepared = this.options.prepareForWrite(clone(value));
            normalized = this.options.parse(prepared);
        } catch (error) {
            throw new PersistenceError(
                "invalid_state",
                "qyl.mcp refused to persist state that is invalid or contains unsupported sensitive data.",
                { cause: error },
            );
        }

        const json = JSON.stringify(normalized, null, 2);
        if (json === undefined) {
            throw new PersistenceError("invalid_state", "qyl.mcp state cannot be represented as JSON.");
        }

        try {
            await writeAtomically(this.filePath, `${json}\n`);
        } catch (error) {
            throw new PersistenceError(
                "write_failed",
                `qyl.mcp could not persist state at '${this.filePath}'.`,
                { cause: error },
            );
        }
        return clone(normalized);
    }

    private enqueue<R>(operation: () => Promise<R>): Promise<R> {
        const queued = this.tail.then(operation, operation);
        this.tail = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    }

    private requireState(): T {
        if (this.state === undefined) {
            throw new Error("AtomicJsonStore must be initialized before accessing state.");
        }
        return this.state;
    }
}

async function writeAtomically(filePath: string, contents: string): Promise<void> {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
    );
    let renamed = false;
    try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporaryPath, filePath);
        renamed = true;
        await chmod(filePath, 0o600);
    } finally {
        await handle.close().catch(() => undefined);
        if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function isNodeError(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}
