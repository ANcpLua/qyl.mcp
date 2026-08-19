import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
    evaluateAssertions,
    isPartialMatch,
    readJsonPointer,
    testPatternIsolated,
} from "./assertions.js";
import { validateJsonSchemaIsolated } from "./json-schema-validator.js";
import type { WorkbenchTestAssertion } from "@ancplua/qyl-api-schema/types";

class FakeWorker extends EventEmitter {
    readonly postedMessages: unknown[] = [];
    terminationCount = 0;

    constructor(private readonly eventLog?: string[]) {
        super();
    }

    postMessage(message: unknown): void {
        this.eventLog?.push("post");
        this.postedMessages.push(message);
    }

    terminate(): Promise<number> {
        this.terminationCount += 1;
        return Promise.resolve(0);
    }
}

class ManualDeadlines {
    readonly deadlines: Array<{
        delayMs: number;
        onDeadline: () => void;
        active: boolean;
    }> = [];

    constructor(private readonly eventLog?: string[]) {}

    readonly arm = (delayMs: number, onDeadline: () => void): (() => void) => {
        const deadline = { delayMs, onDeadline, active: true };
        this.eventLog?.push(`arm:${delayMs}`);
        this.deadlines.push(deadline);
        return () => {
            if (!deadline.active) return;
            deadline.active = false;
            this.eventLog?.push(`cancel:${delayMs}`);
        };
    };

    activeDelays(): number[] {
        return this.deadlines
            .filter((deadline) => deadline.active)
            .map((deadline) => deadline.delayMs);
    }

    fire(delayMs: number): void {
        const deadline = this.deadlines.find(
            (candidate) => candidate.active && candidate.delayMs === delayMs,
        );
        if (deadline === undefined) throw new Error(`No active ${delayMs} ms deadline.`);
        deadline.active = false;
        deadline.onDeadline();
    }
}

test("JSON Pointer selects escaped object keys and bounded array indices", () => {
    const value = { "a/b": { "~key": ["zero", { ok: true }] } };
    assert.deepEqual(readJsonPointer(value, "/a~1b/~0key/1"), {
        found: true,
        value: { ok: true },
    });
    assert.equal(readJsonPointer(value, "/a~2b").found, false);
    assert.equal(readJsonPointer(value, "/a~1b/~0key/3").found, false);
    assert.equal(readJsonPointer(value, "a").error, "A JSON Pointer must be empty or begin with '/'.");
});

test("partial matching recursively checks object subsets and array prefixes", () => {
    assert.equal(
        isPartialMatch(
            { status: "ok", nested: { count: 3, extra: true }, rows: [{ id: 1 }, { id: 2 }] },
            { nested: { count: 3 }, rows: [{ id: 1 }] },
        ),
        true,
    );
    assert.equal(isPartialMatch({ nested: { count: 2 } }, { nested: { count: 3 } }), false);
});

test("assertion engine differentiates status, exact, partial, schema, pattern, and latency", async () => {
    const assertions: WorkbenchTestAssertion[] = [
        { id: "status", kind: "status", expected: ["succeeded", "failed"] },
        { id: "exact", kind: "exact", path: "/structured/answer", expected: 42 },
        { id: "partial", kind: "partial", path: "/structured", expected: { ok: true } },
        {
            id: "schema",
            kind: "schema",
            path: "/structured",
            schema: {
                type: "object",
                required: ["answer"],
                properties: { answer: { type: "integer", minimum: 40 } },
            },
        },
        { id: "pattern", kind: "pattern", path: "/text", pattern: "hello\\s+world", flags: "iu" },
        { id: "latency", kind: "latency", max_duration_ms: 250 },
    ];

    const results = await evaluateAssertions(assertions, {
        status: "succeeded",
        outcome: "succeeded",
        durationMs: 125.4,
        result: { text: "Hello world", structured: { ok: true, answer: 42 } },
    });

    assert.equal(results.length, assertions.length);
    assert.equal(results.every((entry) => entry.status === "passed"), true);
});

test("invalid and unsafe pattern assertions fail without throwing", async () => {
    const [duplicateFlags, unsupportedFlags, invalidPattern, nonString] = await evaluateAssertions(
        [
            { id: "duplicate", kind: "pattern", path: "/value", pattern: "a", flags: "ii" },
            { id: "unsupported", kind: "pattern", path: "/value", pattern: "a", flags: "g" },
            { id: "invalid", kind: "pattern", path: "/value", pattern: "[", flags: "u" },
            { id: "number", kind: "pattern", path: "/number", pattern: "1" },
        ],
        { status: "succeeded", outcome: "succeeded", durationMs: 1, result: { value: "a", number: 1 } },
    );

    assert(duplicateFlags && unsupportedFlags && invalidPattern && nonString);
    assert.match(duplicateFlags.message ?? "", /duplicates/u);
    assert.match(unsupportedFlags.message ?? "", /only i, m, s, and u/u);
    assert.match(invalidPattern.message ?? "", /Invalid regular expression/u);
    assert.match(nonString.message ?? "", /require a string/u);
    assert.equal([duplicateFlags, unsupportedFlags, invalidPattern, nonString].every((entry) => entry.status === "failed"), true);
});

test("pattern workers distinguish ready, startup, and execution phases", { timeout: 2_000 }, async () => {
    assert.deepEqual(await testPatternIsolated("^ready$", "u", "ready"), {
        kind: "result",
        passed: true,
    });
    assert.deepEqual(await testPatternIsolated("[", "u", "value"), { kind: "invalid" });

    const startupWorker = new FakeWorker();
    const startupDeadlines = new ManualDeadlines();
    const startupResult = testPatternIsolated("a", "u", "a", {
        createWorker: () => startupWorker,
        armDeadline: startupDeadlines.arm,
    });
    assert.deepEqual(startupDeadlines.activeDelays(), [5_000]);
    assert.deepEqual(startupWorker.postedMessages, []);
    startupDeadlines.fire(5_000);
    assert.deepEqual(await startupResult, { kind: "startup_timeout" });
    assert.equal(startupWorker.terminationCount, 1);

    assert.deepEqual(await testPatternIsolated("a", "u", "a", {
        createWorker: () => {
            throw new Error("startup failed");
        },
    }), { kind: "startup_error" });

    const executionEvents: string[] = [];
    const executionWorker = new FakeWorker(executionEvents);
    const executionDeadlines = new ManualDeadlines(executionEvents);
    const executionResult = testPatternIsolated("a", "u", "a", {
        createWorker: () => executionWorker,
        armDeadline: executionDeadlines.arm,
    });
    executionWorker.emit("message", { kind: "ready" });
    assert.deepEqual(executionEvents, ["arm:5000", "cancel:5000", "arm:250", "post"]);
    assert.deepEqual(executionDeadlines.activeDelays(), [250]);
    assert.deepEqual(executionWorker.postedMessages, [{ pattern: "a", flags: "u", input: "a" }]);
    executionDeadlines.fire(250);
    assert.deepEqual(await executionResult, { kind: "timeout" });
    assert.equal(executionWorker.terminationCount, 1);
});

test("JSON Schema workers distinguish ready, startup, and execution phases", { timeout: 2_000 }, async () => {
    assert.deepEqual(await validateJsonSchemaIsolated({ type: "string" }, "ready"), {
        kind: "valid",
        data: "ready",
    });

    const startupWorker = new FakeWorker();
    const startupDeadlines = new ManualDeadlines();
    const startupResult = validateJsonSchemaIsolated({ type: "string" }, "value", {
        createWorker: () => startupWorker,
        armDeadline: startupDeadlines.arm,
    });
    assert.deepEqual(startupDeadlines.activeDelays(), [5_000]);
    assert.deepEqual(startupWorker.postedMessages, []);
    startupDeadlines.fire(5_000);
    assert.deepEqual(await startupResult, {
        kind: "worker_error",
        phase: "startup",
        reason: "timeout",
    });
    assert.equal(startupWorker.terminationCount, 1);

    assert.deepEqual(await validateJsonSchemaIsolated({ type: "string" }, "value", {
        createWorker: () => {
            throw new Error("startup failed");
        },
    }), { kind: "worker_error", phase: "startup", reason: "error" });

    const patternEvents: string[] = [];
    const patternWorker = new FakeWorker(patternEvents);
    const patternDeadlines = new ManualDeadlines(patternEvents);
    const patternResult = validateJsonSchemaIsolated(
        { type: "string", pattern: "a" },
        "a",
        {
            createWorker: () => patternWorker,
            armDeadline: patternDeadlines.arm,
        },
    );
    patternWorker.emit("message", { kind: "ready" });
    assert.deepEqual(patternEvents, ["arm:5000", "cancel:5000", "arm:500", "post"]);
    assert.deepEqual(patternDeadlines.activeDelays(), [500]);
    assert.deepEqual(patternWorker.postedMessages, [{
        schema: { type: "string", pattern: "a" },
        value: "a",
    }]);
    patternDeadlines.fire(500);
    assert.deepEqual(await patternResult, { kind: "timeout" });

    const generalWorker = new FakeWorker();
    const generalDeadlines = new ManualDeadlines();
    const generalResult = validateJsonSchemaIsolated({ type: "string" }, "a", {
        createWorker: () => generalWorker,
        armDeadline: generalDeadlines.arm,
    });
    generalWorker.emit("message", { kind: "ready" });
    assert.deepEqual(generalDeadlines.activeDelays(), [2_000]);
    generalDeadlines.fire(2_000);
    assert.deepEqual(await generalResult, { kind: "timeout" });
});

test("missing values and invalid schemas are evidence-backed failures", async () => {
    const results = await evaluateAssertions(
        [
            { id: "missing", kind: "exact", path: "/missing", expected: true },
            { id: "schema", kind: "schema", schema: { type: "not-a-json-schema-type" } },
            { id: "latency", kind: "latency", max_duration_ms: -1 },
        ],
        { status: "succeeded", outcome: "succeeded", durationMs: 2, result: { present: true } },
    );

    assert(results[0] && results[1] && results[2]);
    assert.equal(results.every((entry) => entry.status === "failed"), true);
    assert.match(results[0].message ?? "", /was not found/u);
    assert.match(results[1].message ?? "", /Invalid JSON Schema/u);
    assert.match(results[2].message ?? "", /non-negative/u);
});

test("status assertions retain multiple accepted generated statuses and match every failed category", async () => {
    const assertion: WorkbenchTestAssertion = {
        id: "terminal",
        kind: "status",
        expected: ["failed", "timed_out"],
    };

    for (const outcome of [
        "tool_error",
        "schema_error",
        "protocol_error",
        "transport_error",
        "authentication_error",
        "internal_error",
    ] as const) {
        const assertionResult: Awaited<ReturnType<typeof evaluateAssertions>>[number] = (await evaluateAssertions([assertion], {
            status: "failed",
            outcome,
            durationMs: 1,
        }))[0];
        assert.equal(assertionResult.status, "passed", outcome);
        assert.equal(assertionResult.actual, "failed");
    }
});

test("catastrophic patterns hit a hard deadline without blocking the event loop", { timeout: 2_000 }, async () => {
    let heartbeatObserved = false;
    const heartbeat = setTimeout(() => {
        heartbeatObserved = true;
    }, 10);
    const startedAt = performance.now();

    const [assertionResult] = await evaluateAssertions(
        [{ id: "redos", kind: "pattern", path: "/value", pattern: "(a+)+$", flags: "u" }],
        {
            status: "succeeded",
            outcome: "succeeded",
            durationMs: 1,
            result: { value: `${"a".repeat(50_000)}!` },
        },
    );

    clearTimeout(heartbeat);
    assert(assertionResult);
    assert.equal(heartbeatObserved, true, "the main event loop remained responsive");
    assert.equal(assertionResult.status, "failed");
    assert.match(assertionResult.message ?? "", /safety deadline/u);
    assert(performance.now() - startedAt < 1_000, "the isolated worker respected its deadline");
});

test("catastrophic JSON Schema patterns are isolated from the workbench host event loop", { timeout: 2_000 }, async () => {
    let heartbeatObserved = false;
    const heartbeat = setTimeout(() => {
        heartbeatObserved = true;
    }, 10);
    const startedAt = performance.now();

    const [assertionResult] = await evaluateAssertions(
        [{
            id: "schema-redos",
            kind: "schema",
            schema: { type: "string", pattern: "(a+)+$" },
        }],
        {
            status: "succeeded",
            outcome: "succeeded",
            durationMs: 1,
            result: `${"a".repeat(50_000)}!`,
        },
    );

    clearTimeout(heartbeat);
    assert(assertionResult);
    assert.equal(heartbeatObserved, true, "the main event loop remained responsive");
    assert.equal(assertionResult.status, "failed");
    assert.match(assertionResult.message ?? "", /safety deadline/u);
    assert(performance.now() - startedAt < 1_500, "the schema worker respected its deadline");
});
