// Bounded, per-resource log buffer with broadcast fan-out.
// Producers (the orchestrator's stderr followers) append lines; consumers take a snapshot of
// recent lines and subscribe for subsequent ones (the /runner API, and through it the dashboard).

import type { LogLine } from "./resources.js";
import { RunnerLogLineSchema } from "qyl-mcp-server/contract-validation";

const MaxLinesPerResource = 1000;

export class LogStore {
    private readonly buffers = new Map<string, LogLine[]>();
    private readonly subscribers = new Set<{ resource: string; push: (line: LogLine) => void }>();

    append(resource: string, stream: "out" | "err", line: string): void {
        const entry = RunnerLogLineSchema.parse({ resource, stream, line });
        let buffer = this.buffers.get(resource);
        if (!buffer) {
            buffer = [];
            this.buffers.set(resource, buffer);
        }
        buffer.push(entry);
        while (buffer.length > MaxLinesPerResource) buffer.shift();

        for (const subscriber of this.subscribers) {
            if (subscriber.resource === resource) subscriber.push(entry);
        }
    }

    snapshot(resource: string): readonly LogLine[] {
        return [...(this.buffers.get(resource) ?? [])];
    }

    // Subscribe first, THEN read snapshot: a line racing the subscription is still delivered,
    // and a duplicate replay is harmless for an append-only log tail.
    subscribe(resource: string, push: (line: LogLine) => void): () => void {
        const subscriber = { resource, push };
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }
}
