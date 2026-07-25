import assert from "node:assert/strict";
import test from "node:test";
import { initializeWorkbenchAndListeners } from "./workbench-host.js";

test("workbench listeners become available before background auto-connect completes", async () => {
    const events: string[] = [];
    let finishAutoConnect: (() => void) | undefined;
    const autoConnect = new Promise<void>((resolve) => {
        finishAutoConnect = resolve;
    });

    await initializeWorkbenchAndListeners(
        {
            async initialize() {
                events.push("restored");
            },
            async startAutoConnect() {
                events.push("auto-connect-started");
                await autoConnect;
                events.push("auto-connect-completed");
            },
        },
        [
            async () => {
                events.push("main-listening");
            },
        ],
    );

    assert.deepEqual(events, [
        "restored",
        "main-listening",
        "auto-connect-started",
    ]);
    finishAutoConnect?.();
    await autoConnect;
});
