// ≈ Qyl.Run/QylConstants.cs — same nesting, same values where qyl defines them.

export const Constants = {
    Product: {
        name: "qyl.mcp",
        banner: "qyl",
        version: "0.1.0",
        userAgent: "qyl.mcp/0.1.0",
        tagline: "qyl mcp app host",
    },

    Ports: {
        RunnerApi: 18888,
        Sandbox: 18889,
        DynamicAllocation: 0,
    },

    ResourceKinds: {
        Stdio: "stdio",
        Http: "http",
        // In-process MCP server over an in-memory transport — no child process,
        // no socket; the qyl telemetry tools are hosted inside the runner itself.
        InProc: "inproc",
    },

    Environments: {
        Dev: "dev",
        Staging: "staging",
        Prod: "prod",
    },

    Network: {
        Loopback: "127.0.0.1",
        HttpScheme: "http",
    },

    Env: {
        // Env-based service discovery: MCP_ENDPOINT_<NAME_UPPER_SNAKE>=<runner proxy url>
        // is injected into a resource's child environment for each of its references.
        McpEndpointPrefix: "MCP_ENDPOINT_",
    },

    Routes: {
        Health: "/health",
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
        ChildStdout: 1105,
        ChildStderr: 1106,
        RunnerApiListening: 1107,
        RunnerApiBindFailed: 1108,
        RunnerApiRequestFailed: 1109,
        ContainerStarted: 1110,
        ContainerStopped: 1111,
        ContainerLogFollowerFailed: 1112,
        ResourceRestarting: 1113,
        ResourceUserRestart: 1114,
    },
} as const;
