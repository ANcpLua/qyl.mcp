import { parentPort, workerData } from "node:worker_threads";

interface PatternWorkerInput {
    pattern: string;
    flags: string;
    input: string;
}

const request = workerData as PatternWorkerInput;
try {
    const passed = new RegExp(request.pattern, request.flags).test(request.input);
    parentPort?.postMessage({ kind: "result", passed });
} catch {
    parentPort?.postMessage({ kind: "invalid" });
}
