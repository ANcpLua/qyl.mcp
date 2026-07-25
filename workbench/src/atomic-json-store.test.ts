import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomicJsonStore, PersistenceError } from "./atomic-json-store.js";

interface FixtureState {
    version: 1;
    count: number;
    note?: string;
    secret?: string;
}

function parseFixture(value: unknown): FixtureState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("state must be an object");
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.count !== "number" || !Number.isInteger(record.count)) {
        throw new Error("invalid fixture state");
    }
    if (record.note !== undefined && typeof record.note !== "string") throw new Error("invalid note");
    if (record.secret !== undefined && typeof record.secret !== "string") throw new Error("invalid secret");
    return {
        version: 1,
        count: record.count,
        ...(record.note === undefined ? {} : { note: record.note }),
        ...(record.secret === undefined ? {} : { secret: record.secret }),
    };
}

const redact = (value: FixtureState): FixtureState => ({
    ...value,
    ...(value.secret === undefined ? {} : { secret: "[REDACTED]" }),
});

test("atomic store creates private state and round-trips prepared data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-store-"));
    const filePath = join(directory, "nested", "workbench.json");
    const store = new AtomicJsonStore<FixtureState>(filePath, {
        initial: () => ({ version: 1, count: 0 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });

    assert.deepEqual(await store.read(), { version: 1, count: 0 });
    const committed = await store.replace({ version: 1, count: 2, secret: "do-not-persist" });
    assert.deepEqual(committed, { version: 1, count: 2, secret: "[REDACTED]" });

    const directoryMode = (await stat(join(directory, "nested"))).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    const mode = (await stat(filePath)).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.doesNotMatch(await readFile(filePath, "utf8"), /do-not-persist/u);

    const reloaded = new AtomicJsonStore<FixtureState>(filePath, {
        initial: () => ({ version: 1, count: -1 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });
    assert.deepEqual(await reloaded.read(), { version: 1, count: 2, secret: "[REDACTED]" });
});

test("atomic store never tightens permissions on a caller-owned parent directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-store-parent-"));
    await chmod(directory, 0o755);
    const filePath = join(directory, "state.json");
    const store = new AtomicJsonStore<FixtureState>(filePath, {
        initial: () => ({ version: 1, count: 0 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });

    await store.initialize();

    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("transactions serialize concurrent mutations without lost updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-store-"));
    const store = new AtomicJsonStore<FixtureState>(join(directory, "state.json"), {
        initial: () => ({ version: 1, count: 0 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });
    await store.initialize();

    await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
            store.transact(async (draft) => {
                await Promise.resolve(index);
                draft.count += 1;
            }),
        ),
    );

    assert.equal((await store.read()).count, 20);
});

test("reads wait for earlier queued transactions instead of returning stale state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-store-read-order-"));
    const store = new AtomicJsonStore<FixtureState>(join(directory, "state.json"), {
        initial: () => ({ version: 1, count: 0 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });
    await store.initialize();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transaction = store.transact(async (draft) => {
        await gate;
        draft.count = 1;
    });
    const read = store.read();
    let settled = false;
    void read.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);

    release();
    await transaction;
    assert.equal((await read).count, 1);
});

test("invalid mutations do not replace the last known-good document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-store-"));
    const filePath = join(directory, "state.json");
    const store = new AtomicJsonStore<FixtureState>(filePath, {
        initial: () => ({ version: 1, count: 4 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });
    await store.initialize();
    const before = await readFile(filePath, "utf8");

    await assert.rejects(
        store.transact((draft) => {
            draft.count = Number.NaN;
        }),
        (error: unknown) => error instanceof PersistenceError && error.kind === "invalid_state",
    );
    assert.equal(await readFile(filePath, "utf8"), before);
    assert.equal((await store.read()).count, 4);
});

test("corrupt persisted state fails clearly and is never overwritten", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qyl-mcp-store-"));
    const filePath = join(directory, "state.json");
    await writeFile(filePath, "{ definitely-not-json", { mode: 0o600 });
    const store = new AtomicJsonStore<FixtureState>(filePath, {
        initial: () => ({ version: 1, count: 0 }),
        parse: parseFixture,
        prepareForWrite: redact,
    });

    await assert.rejects(
        store.read(),
        (error: unknown) => error instanceof PersistenceError && error.kind === "invalid_json",
    );
    assert.equal(await readFile(filePath, "utf8"), "{ definitely-not-json");
});
