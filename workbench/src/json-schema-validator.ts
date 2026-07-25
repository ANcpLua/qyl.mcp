import { Worker } from "node:worker_threads";

const JSON_SCHEMA_PATTERN_DEADLINE_MS = 500;
const JSON_SCHEMA_GENERAL_DEADLINE_MS = 2_000;
const MAX_SCHEMA_CHARACTERS = 1_000_000;
const MAX_VALUE_CHARACTERS = 2_000_000;

export interface JsonSchemaIssue {
    path: readonly string[];
    message: string;
}

export type JsonSchemaValidationResult =
    | { kind: "valid"; data: unknown }
    | { kind: "invalid"; issues: readonly JsonSchemaIssue[] }
    | { kind: "invalid_schema" }
    | { kind: "too_large"; subject: "schema" | "value" }
    | { kind: "timeout" }
    | { kind: "worker_error" };

/**
 * Compile and evaluate untrusted JSON Schema in a disposable worker. JSON
 * Schema `pattern` values are regular expressions, so running z.fromJSONSchema
 * or safeParse on the workbench host event loop would let a remote MCP server block all
 * sessions with catastrophic backtracking.
 */
export function validateJsonSchemaIsolated(
    schema: unknown,
    value: unknown,
): Promise<JsonSchemaValidationResult> {
    const schemaSize = serializedLength(schema);
    if (schemaSize === undefined || schemaSize > MAX_SCHEMA_CHARACTERS) {
        return Promise.resolve({ kind: "too_large", subject: "schema" });
    }
    const valueSize = serializedLength(value);
    if (valueSize === undefined || valueSize > MAX_VALUE_CHARACTERS) {
        return Promise.resolve({ kind: "too_large", subject: "value" });
    }
    const deadlineMs = containsPatternKeyword(schema)
        ? JSON_SCHEMA_PATTERN_DEADLINE_MS
        : JSON_SCHEMA_GENERAL_DEADLINE_MS;

    return new Promise((resolveResult) => {
        let worker: Worker;
        try {
            worker = new Worker(new URL("./json-schema-worker.js", import.meta.url), {
                workerData: { schema, value },
                resourceLimits: {
                    maxOldGenerationSizeMb: 64,
                    maxYoungGenerationSizeMb: 16,
                    stackSizeMb: 2,
                },
            });
        } catch {
            resolveResult({ kind: "worker_error" });
            return;
        }

        let settled = false;
        const finish = (result: JsonSchemaValidationResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            worker.removeAllListeners();
            void worker.terminate();
            resolveResult(result);
        };
        const deadline = setTimeout(() => finish({ kind: "timeout" }), deadlineMs);

        worker.once("message", (message: unknown) => {
            finish(isWorkerResult(message) ? message : { kind: "worker_error" });
        });
        worker.once("error", () => finish({ kind: "worker_error" }));
        worker.once("exit", () => finish({ kind: "worker_error" }));
    });
}

function containsPatternKeyword(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const stack: unknown[] = [value];
    const seen = new WeakSet<object>();
    while (stack.length > 0) {
        const current = stack.pop();
        if (typeof current !== "object" || current === null || seen.has(current)) continue;
        seen.add(current);
        if (!Array.isArray(current) && Object.hasOwn(current, "pattern")) return true;
        stack.push(...(Array.isArray(current) ? current : Object.values(current)));
    }
    return false;
}

function serializedLength(value: unknown): number | undefined {
    try {
        return JSON.stringify(value)?.length;
    } catch {
        return undefined;
    }
}

function isWorkerResult(value: unknown): value is Extract<
    JsonSchemaValidationResult,
    { kind: "valid" | "invalid" | "invalid_schema" }
> {
    if (!isRecord(value) || typeof value.kind !== "string") return false;
    if (value.kind === "valid") return "data" in value;
    if (value.kind === "invalid_schema") return true;
    if (value.kind !== "invalid" || !Array.isArray(value.issues)) return false;
    return value.issues.every((issue) => isRecord(issue)
        && Array.isArray(issue.path)
        && issue.path.every((part) => typeof part === "string")
        && typeof issue.message === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
