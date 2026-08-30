import { parentPort } from "node:worker_threads";
import { z } from "zod";

interface JsonSchemaWorkerInput {
    schema: unknown;
    value: unknown;
}

const port = parentPort;
if (port !== null) {
    port.once("message", (request: JsonSchemaWorkerInput) => {
        try {
            // A foreign schema's `$id`/`id` is copied into the registry that
            // fromJSONSchema writes to, and zod's global registry indexes those ids
            // in a strong Map. Hand it a throwaway registry so an untrusted schema
            // cannot reach process-global state at all.
            const validator = z.fromJSONSchema(
                request.schema as Parameters<typeof z.fromJSONSchema>[0],
                { registry: z.registry() },
            );
            const parsed = validator.safeParse(request.value);
            if (parsed.success) {
                port.postMessage({ kind: "valid", data: parsed.data });
            } else {
                port.postMessage({
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
            port.postMessage({ kind: "invalid_schema" });
        }
    });
    port.postMessage({ kind: "ready" });
}
