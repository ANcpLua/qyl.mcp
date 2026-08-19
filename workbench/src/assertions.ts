import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";
import type {
    WorkbenchAssertionResult,
    WorkbenchExactAssertion,
    WorkbenchExecutionStatus,
    WorkbenchPartialAssertion,
    WorkbenchPatternAssertion,
    WorkbenchSchemaAssertion,
    WorkbenchTestAssertion,
} from "@ancplua/qyl-api-schema/types";
import { validateJsonSchemaIsolated } from "./json-schema-validator.js";

export type ExecutionOutcome =
    | "succeeded"
    | "tool_error"
    | "schema_error"
    | "protocol_error"
    | "transport_error"
    | "authentication_error"
    | "timed_out"
    | "cancelled"
    | "internal_error";

export interface AssertionEvidence {
    status: WorkbenchExecutionStatus;
    outcome: ExecutionOutcome;
    durationMs: number;
    result?: unknown;
}

const MAX_PATTERN_LENGTH = 1_000;
const MAX_PATTERN_INPUT_LENGTH = 100_000;
const PATTERN_DEADLINE_MS = 250;
const PATTERN_WORKER_STARTUP_DEADLINE_MS = 5_000;
const PATTERN_WORKER_CONCURRENCY = 4;
const ALLOWED_PATTERN_FLAGS = new Set(["i", "m", "s", "u"]);

export async function evaluateAssertions(
    assertions: readonly WorkbenchTestAssertion[],
    evidence: AssertionEvidence,
): Promise<WorkbenchAssertionResult[]> {
    const results = new Array<WorkbenchAssertionResult>(assertions.length);
    let nextIndex = 0;
    const workerCount = Math.min(PATTERN_WORKER_CONCURRENCY, assertions.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < assertions.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await evaluateAssertion(assertions[index], evidence);
        }
    }));
    return results;
}

export async function evaluateAssertion(
    assertion: WorkbenchTestAssertion,
    evidence: AssertionEvidence,
): Promise<WorkbenchAssertionResult> {
    switch (assertion.kind) {
        case "status":
            return result(
                assertion,
                assertion.expected.includes(evidence.status),
                assertion.expected.includes(evidence.status)
                    ? `Execution status is ${evidence.status}.`
                    : `Expected one of ${assertion.expected.join(", ")}, received ${evidence.status}.`,
                evidence.status,
            );
        case "latency": {
            if (!Number.isFinite(assertion.max_duration_ms) || assertion.max_duration_ms < 0) {
                return result(assertion, false, "Latency threshold must be a finite non-negative number.");
            }
            return result(
                assertion,
                evidence.durationMs <= assertion.max_duration_ms,
                evidence.durationMs <= assertion.max_duration_ms
                    ? `Duration ${formatMs(evidence.durationMs)} is within ${formatMs(assertion.max_duration_ms)}.`
                    : `Duration ${formatMs(evidence.durationMs)} exceeded ${formatMs(assertion.max_duration_ms)}.`,
                evidence.durationMs,
            );
        }
        case "exact":
        case "partial":
        case "schema":
        case "pattern":
            return evaluateValueAssertion(assertion, evidence.result);
    }
}

async function evaluateValueAssertion(
    assertion: WorkbenchExactAssertion | WorkbenchPartialAssertion | WorkbenchSchemaAssertion | WorkbenchPatternAssertion,
    root: unknown,
): Promise<WorkbenchAssertionResult> {
    const path = assertion.path ?? "";
    const selected = readJsonPointer(root, path);
    if (!selected.found) {
        return result(assertion, false, selected.error ?? `JSON Pointer '${path}' was not found.`);
    }

    const actual = selected.value;
    switch (assertion.kind) {
        case "exact": {
            const passed = isDeepStrictEqual(actual, assertion.expected);
            return result(
                assertion,
                passed,
                passed ? "Value exactly matched." : "Value did not exactly match the expectation.",
                actual,
            );
        }
        case "partial": {
            const passed = isPartialMatch(actual, assertion.expected);
            return result(
                assertion,
                passed,
                passed ? "Value contains the expected subset." : "Value does not contain the expected subset.",
                actual,
            );
        }
        case "schema": {
            if (!isRecord(assertion.schema)) {
                return result(assertion, false, "Invalid JSON Schema: expected an object.");
            }
            const parsed = await validateJsonSchemaIsolated(assertion.schema, actual);
            switch (parsed.kind) {
                case "valid":
                    return result(assertion, true, "Value satisfies the JSON Schema.", actual);
                case "invalid":
                    return result(
                        assertion,
                        false,
                        `Value failed JSON Schema validation: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
                        actual,
                    );
                case "invalid_schema":
                    return result(assertion, false, "Invalid JSON Schema.");
                case "too_large":
                    return result(assertion, false, `JSON Schema ${parsed.subject} exceeds the safety limit.`);
                case "timeout":
                    return result(assertion, false, "JSON Schema evaluation exceeded the safety deadline.");
                case "worker_error":
                    return result(
                        assertion,
                        false,
                        parsed.phase === "startup"
                            ? parsed.reason === "timeout"
                                ? "JSON Schema worker did not become ready before its startup deadline."
                                : "JSON Schema worker failed before becoming ready."
                            : "JSON Schema evaluation failed in its isolated worker.",
                    );
            }
        }
        case "pattern": {
            if (typeof actual !== "string") {
                return result(assertion, false, "Pattern assertions require a string value.", actual);
            }
            if (assertion.pattern.length > MAX_PATTERN_LENGTH) {
                return result(
                    assertion,
                    false,
                    `Pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit.`,
                );
            }
            if (actual.length > MAX_PATTERN_INPUT_LENGTH) {
                return result(
                    assertion,
                    false,
                    `Pattern input exceeds the ${MAX_PATTERN_INPUT_LENGTH}-character limit.`,
                );
            }
            const flags = assertion.flags ?? "u";
            if ([...flags].some((flag) => !ALLOWED_PATTERN_FLAGS.has(flag))) {
                return result(assertion, false, "Pattern flags may contain only i, m, s, and u.");
            }
            if (new Set(flags).size !== flags.length) {
                return result(assertion, false, "Pattern flags must not contain duplicates.");
            }
            const outcome = await testPatternIsolated(assertion.pattern, flags, actual);
            if (outcome.kind === "invalid") {
                return result(assertion, false, "Invalid regular expression.");
            }
            if (outcome.kind === "timeout") {
                return result(
                    assertion,
                    false,
                    `Pattern evaluation exceeded the ${PATTERN_DEADLINE_MS} ms safety deadline.`,
                );
            }
            if (outcome.kind === "startup_timeout") {
                return result(assertion, false, "Pattern worker did not become ready before its startup deadline.");
            }
            if (outcome.kind === "startup_error") {
                return result(assertion, false, "Pattern worker failed before becoming ready.");
            }
            if (outcome.kind === "worker_error") {
                return result(assertion, false, "Pattern evaluation failed in its isolated worker.");
            }
            return result(
                assertion,
                outcome.passed,
                outcome.passed
                    ? "String matched the expected pattern."
                    : "String did not match the expected pattern.",
                actual,
            );
        }
    }
}

type PatternWorkerOutcome =
    | { kind: "result"; passed: boolean }
    | { kind: "invalid" }
    | { kind: "timeout" }
    | { kind: "startup_timeout" }
    | { kind: "startup_error" }
    | { kind: "worker_error" };

interface PatternWorkerHandle {
    on(event: "message", listener: (message: unknown) => void): PatternWorkerHandle;
    once(event: "error" | "messageerror" | "exit", listener: () => void): PatternWorkerHandle;
    removeAllListeners(): PatternWorkerHandle;
    postMessage(message: unknown): void;
    terminate(): Promise<number>;
}

interface PatternWorkerOptions {
    createWorker?: () => PatternWorkerHandle;
    armDeadline?: (delayMs: number, onDeadline: () => void) => () => void;
}

export function testPatternIsolated(
    pattern: string,
    flags: string,
    input: string,
    options: PatternWorkerOptions = {},
): Promise<PatternWorkerOutcome> {
    return new Promise((resolveOutcome) => {
        let worker: PatternWorkerHandle;
        try {
            worker = options.createWorker?.() ?? new Worker(
                new URL("./pattern-worker.js", import.meta.url),
                {
                    resourceLimits: {
                        maxOldGenerationSizeMb: 32,
                        maxYoungGenerationSizeMb: 8,
                        stackSizeMb: 1,
                    },
                },
            );
        } catch {
            resolveOutcome({ kind: "startup_error" });
            return;
        }
        const armDeadline = options.armDeadline ?? setWorkerDeadline;
        let settled = false;
        let phase: "starting" | "executing" = "starting";
        let cancelStartupDeadline: (() => void) | undefined;
        let cancelExecutionDeadline: (() => void) | undefined;
        const finish = (outcome: PatternWorkerOutcome) => {
            if (settled) return;
            settled = true;
            cancelStartupDeadline?.();
            cancelExecutionDeadline?.();
            worker.removeAllListeners();
            void worker.terminate();
            resolveOutcome(outcome);
        };

        worker.on("message", (message: unknown) => {
            if (phase === "starting") {
                if (!isWorkerReady(message)) {
                    finish({ kind: "startup_error" });
                    return;
                }
                phase = "executing";
                cancelStartupDeadline?.();
                cancelStartupDeadline = undefined;
                cancelExecutionDeadline = armDeadline(
                    PATTERN_DEADLINE_MS,
                    () => finish({ kind: "timeout" }),
                );
                try {
                    worker.postMessage({ pattern, flags, input });
                } catch {
                    finish({ kind: "worker_error" });
                }
                return;
            }
            finish(isPatternWorkerOutcome(message) ? message : { kind: "worker_error" });
        });
        worker.once("error", () => finish(
            phase === "starting" ? { kind: "startup_error" } : { kind: "worker_error" },
        ));
        worker.once("messageerror", () => finish(
            phase === "starting" ? { kind: "startup_error" } : { kind: "worker_error" },
        ));
        worker.once("exit", () => finish(
            phase === "starting" ? { kind: "startup_error" } : { kind: "worker_error" },
        ));
        cancelStartupDeadline = armDeadline(
            PATTERN_WORKER_STARTUP_DEADLINE_MS,
            () => finish({ kind: "startup_timeout" }),
        );
    });
}

function setWorkerDeadline(delayMs: number, onDeadline: () => void): () => void {
    const deadline = setTimeout(onDeadline, delayMs);
    return () => clearTimeout(deadline);
}

function isWorkerReady(value: unknown): boolean {
    return isRecord(value) && value.kind === "ready";
}

function isPatternWorkerOutcome(value: unknown): value is PatternWorkerOutcome {
    if (!isRecord(value) || typeof value.kind !== "string") return false;
    if (value.kind === "result") return typeof value.passed === "boolean";
    return value.kind === "invalid";
}

export interface JsonPointerResult {
    found: boolean;
    value?: unknown;
    error?: string;
}

export function readJsonPointer(root: unknown, pointer: string): JsonPointerResult {
    if (pointer === "") return { found: true, value: root };
    if (!pointer.startsWith("/")) {
        return { found: false, error: "A JSON Pointer must be empty or begin with '/'." };
    }

    let current = root;
    for (const encoded of pointer.slice(1).split("/")) {
        let token: string;
        try {
            token = decodePointerToken(encoded);
        } catch (error) {
            return { found: false, error: error instanceof Error ? error.message : String(error) };
        }

        if (Array.isArray(current)) {
            if (!/^(0|[1-9][0-9]*)$/u.test(token)) return { found: false };
            const index = Number(token);
            if (index >= current.length) return { found: false };
            current = current[index];
            continue;
        }

        if (!isRecord(current) || !Object.hasOwn(current, token)) return { found: false };
        current = current[token];
    }
    return { found: true, value: current };
}

function decodePointerToken(value: string): string {
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "~" && value[index + 1] !== "0" && value[index + 1] !== "1") {
            throw new Error("JSON Pointer escape sequences must be '~0' or '~1'.");
        }
    }
    return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function isPartialMatch(actual: unknown, expected: unknown): boolean {
    if (isDeepStrictEqual(actual, expected)) return true;

    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length < expected.length) return false;
        return expected.every((value, index) => isPartialMatch(actual[index], value));
    }

    if (isRecord(expected)) {
        if (!isRecord(actual)) return false;
        return Object.entries(expected).every(
            ([key, value]) => Object.hasOwn(actual, key) && isPartialMatch(actual[key], value),
        );
    }

    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function result(
    assertion: WorkbenchTestAssertion,
    passed: boolean,
    message: string,
    actual?: unknown,
): WorkbenchAssertionResult {
    return {
        assertion_id: assertion.id,
        kind: assertion.kind,
        status: passed ? "passed" : "failed",
        message,
        ...(actual === undefined ? {} : { actual }),
    };
}

function formatMs(value: number): string {
    return `${Math.round(value * 100) / 100} ms`;
}
