// Shared runner defaults and environment keys.

import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
    throw new Error("runner package metadata has no version");
}
const productVersion = packageMetadata.version;

export const Constants = {
    Product: {
        name: "qyl.mcp",
        version: productVersion,
    },

    Ports: {
        RunnerApi: 18888,
        Sandbox: 18889,
    },

    Network: {
        Loopback: "127.0.0.1",
        HttpScheme: "http",
    },

    Routes: {
        Runner: "/runner",
    },

    Orchestrator: {
        HealthPollIntervalMs: 500,
        HealthProbeAttemptTimeoutSeconds: 5,
        StartupTimeoutSeconds: 60,
        MaxRestarts: 3,
    },

    LogEvents: {
        OrchestratorStarted: 1100,
        ResourceStarting: 1101,
        ResourceReady: 1102,
        ResourceFailed: 1103,
        ResourceStopped: 1104,
        RunnerApiListening: 1107,
        RunnerApiBindFailed: 1108,
        RunnerApiRequestFailed: 1109,
        ResourceRestarting: 1113,
        ResourceUserRestart: 1114,
    },
} as const;
