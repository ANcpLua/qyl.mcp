import { parentPort } from "node:worker_threads";

interface PatternWorkerInput {
    pattern: string;
    flags: string;
    input: string;
}

const port = parentPort;
if (port !== null) {
    port.once("message", (request: PatternWorkerInput) => {
        try {
            const passed = new RegExp(request.pattern, request.flags).test(request.input);
            port.postMessage({ kind: "result", passed });
        } catch {
            port.postMessage({ kind: "invalid" });
        }
    });
    port.postMessage({ kind: "ready" });
}
