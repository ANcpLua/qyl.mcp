// Shared runner defaults and environment keys.

import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
    throw new Error("runner package metadata has no version");
}
const productVersion = packageMetadata.version;
const defaultRunnerApiPort = 18888;

function configuredRunnerApiPort(value: string | undefined): number {
    if (value === undefined) return defaultRunnerApiPort;
    if (!/^\d+$/u.test(value)) {
        throw new Error("QYL_MCP_RUNNER_PORT must be an integer between 1 and 65535");
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("QYL_MCP_RUNNER_PORT must be an integer between 1 and 65535");
    }
    return port;
}

export const Constants = {
    Product: {
        name: "qyl.mcp",
        version: productVersion,
    },

    Ports: {
        RunnerApi: configuredRunnerApiPort(process.env.QYL_MCP_RUNNER_PORT),
    },

    Network: {
        Loopback: "127.0.0.1",
        HttpScheme: "http",
    },

    Routes: {
        Runner: "/runner",
    },

    LogEvents: {
        RunnerApiListening: 1107,
        RunnerApiBindFailed: 1108,
        RunnerApiRequestFailed: 1109,
    },
} as const;
