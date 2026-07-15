import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

interface JsonSchemaWorkerInput {
    schema: unknown;
    value: unknown;
}

const request = workerData as JsonSchemaWorkerInput;

try {
    const validator = z.fromJSONSchema(
        request.schema as Parameters<typeof z.fromJSONSchema>[0],
    );
    const parsed = validator.safeParse(request.value);
    if (parsed.success) {
        parentPort?.postMessage({ kind: "valid", data: parsed.data });
    } else {
        parentPort?.postMessage({
            kind: "invalid",
            issues: parsed.error.issues.slice(0, 50).map((issue) => ({
                path: issue.path.map(String),
                message: issue.message.slice(0, 1_000),
            })),
        });
    }
} catch {
    // A discovered server schema is untrusted input. Do not reflect compiler
    // internals (which may include schema content) across the worker boundary.
    parentPort?.postMessage({ kind: "invalid_schema" });
}
