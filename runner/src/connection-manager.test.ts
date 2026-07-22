import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import {
    ConnectionManager,
    ConnectionManagerError,
    resolveEnvironmentHeaders,
    type CompletedConnectionSession,
    type ConnectionProtocolOperation,
} from "./connection-manager.js";

function fullFixtureServer(): McpServer {
    const server = new McpServer(
        { name: "connection-fixture", version: "2.0.0" },
        { instructions: "Use fixture capabilities for connection tests." },
    );
    server.registerTool(
        "probe",
        {
            description: "Test-only probe",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    server.registerResource(
        "static",
        "test://static",
        { description: "Static fixture resource", mimeType: "text/plain" },
        async (uri) => ({ contents: [{ uri: uri.toString(), text: "static" }] }),
    );
    server.registerResource(
        "item",
        new ResourceTemplate("test://items/{id}", { list: undefined }),
        { description: "Fixture resource template", mimeType: "text/plain" },
        async (uri) => ({ contents: [{ uri: uri.toString(), text: "item" }] }),
    );
    server.registerPrompt(
        "review",
        { description: "Fixture prompt" },
        async () => ({
            messages: [{ role: "user", content: { type: "text", text: "review" } }],
        }),
    );
    return server;
}

test("connection manager initializes an in-process SDK client and discovers every capability", async () => {
    const operations: ConnectionProtocolOperation[] = [];
    const sessions: CompletedConnectionSession[] = [];
    const manager = new ConnectionManager({
        clientInfo: { name: "connection-test-client", version: "1.0.0" },
        correlation: (connectionId) => ({ executionId: `execution-${connectionId}` }),
        onOperation: (operation) => operations.push(operation),
        onSession: (session) => sessions.push(session),
    });
    const lifecycles: string[] = [];
    manager.subscribe((snapshot) => lifecycles.push(snapshot.lifecycle));
    manager.register({
        id: "local",
        kind: "inproc",
        serverFactory: fullFixtureServer,
    });

    const connected = await manager.connect("local");
    assert.equal(connected.lifecycle, "connected");
    assert.deepEqual(connected.initialization?.serverInfo, {
        name: "connection-fixture",
        version: "2.0.0",
    });
    assert.equal(
        connected.initialization?.instructions,
        "Use fixture capabilities for connection tests.",
    );
    assert.equal(typeof connected.initialization?.protocolVersion, "string");
    assert.deepEqual(
        connected.initialization?.discovery.tools.map((tool) => tool.name),
        ["probe"],
    );
    assert.deepEqual(
        connected.initialization?.discovery.resources.map((resource) => resource.name),
        ["static"],
    );
    assert.deepEqual(
        connected.initialization?.discovery.resourceTemplates.map((resource) => resource.name),
        ["item"],
    );
    assert.deepEqual(
        connected.initialization?.discovery.prompts.map((prompt) => prompt.name),
        ["review"],
    );

    const callResult = await manager.getClient("local").callTool({
        name: "probe",
        arguments: {},
    });
    assert.deepEqual(callResult.content, [{ type: "text", text: "ok" }]);

    const journal = manager.getJournal("local");
    assert(journal);
    const messageEntries = journal.snapshot().filter((entry) => entry.kind === "message");
    assert(messageEntries.some((entry) => entry.method === "initialize"));
    assert(messageEntries.some((entry) => entry.method === "tools/list"));
    assert(messageEntries.some((entry) => entry.method === "resources/list"));
    assert(messageEntries.some((entry) => entry.method === "resources/templates/list"));
    assert(messageEntries.some((entry) => entry.method === "prompts/list"));
    assert(messageEntries.some((entry) => entry.method === "tools/call"));
    assert.deepEqual(messageEntries[0]?.correlation, { executionId: "execution-local" });

    const disconnected = await manager.disconnect("local");
    assert.equal(disconnected.lifecycle, "disconnected");
    assert.equal(disconnected.initialization, undefined);
    assert.deepEqual(lifecycles.slice(0, 4), [
        "disconnected",
        "connecting",
        "connected",
        "disconnecting",
    ]);
    assert.equal(lifecycles.at(-1), "disconnected");
    assert(operations.some((operation) => operation.method === "initialize" && operation.role === "client"));
    assert(operations.some((operation) => operation.method === "initialize" && operation.role === "server"));
    const initializeOperations = operations.filter((operation) => operation.method === "initialize");
    const initializedOperations = operations.filter(
        (operation) => operation.method === "notifications/initialized",
    );
    assert.equal(initializeOperations.length, 2);
    assert.equal(initializedOperations.length, 2);
    assert(initializeOperations.every((operation) => typeof operation.protocolVersion === "string"));
    assert(initializedOperations.every((operation) => typeof operation.protocolVersion === "string"));
    assert(operations.some((operation) => operation.method === "tools/call"
        && operation.role === "client" && operation.toolName === "probe"));
    assert(operations.some((operation) => operation.method === "tools/call"
        && operation.role === "server" && operation.toolName === "probe"));
    assert.deepEqual(sessions.map((session) => session.role).sort(), ["client", "server"]);
    assert(sessions.every((session) => session.connectionId === "local"));
    assert(sessions.every((session) => session.endTimeMs >= session.startTimeMs));
});

test("connection manager supports builtin registration and reconnects with a fresh server", async () => {
    let factoryCalls = 0;
    const manager = new ConnectionManager();
    manager.registerBuiltin("fixture", () => {
        factoryCalls += 1;
        const server = new McpServer({ name: "builtin", version: String(factoryCalls) });
        server.registerTool(
            "probe",
            {},
            async () => ({ content: [{ type: "text", text: String(factoryCalls) }] }),
        );
        return server;
    });
    manager.register({ id: "builtin-connection", kind: "builtin", builtin: "fixture" });

    const first = await manager.connect("builtin-connection");
    assert.equal(first.initialization?.serverInfo?.version, "1");
    const firstJournal = manager.getJournal("builtin-connection");
    assert(firstJournal);
    const second = await manager.reconnect("builtin-connection");
    assert.equal(second.initialization?.serverInfo?.version, "2");
    assert.equal(factoryCalls, 2);
    const secondJournal = manager.getJournal("builtin-connection");
    assert(secondJournal);
    assert.notEqual(secondJournal, firstJournal);
    assert(secondJournal.snapshot().every((entry) => entry.sequence > firstJournal.highWaterMark()));

    await manager.disconnect("builtin-connection");
});

test("remote headers resolve only environment references and endpoint credentials are rejected", () => {
    const resolved = resolveEnvironmentHeaders(
        [
            {
                header: "Authorization",
                environmentVariable: "MCP_TOKEN",
                scheme: "bearer",
            },
            { header: "X-Api-Key", environmentVariable: "MCP_API_KEY" },
        ],
        { MCP_TOKEN: "token-secret", MCP_API_KEY: "key-secret" },
    );
    assert.equal(resolved.headers.get("authorization"), "Bearer token-secret");
    assert.equal(resolved.headers.get("x-api-key"), "key-secret");
    assert.deepEqual(resolved.secretValues, [
        "token-secret",
        "Bearer token-secret",
        "key-secret",
        "key-secret",
    ]);

    assert.throws(
        () => resolveEnvironmentHeaders(
            [{ header: "Authorization", environmentVariable: "MISSING" }],
            {},
        ),
        /MISSING.*not set/u,
    );
    assert.throws(
        () => resolveEnvironmentHeaders(
            [{ header: "Authorization", environmentVariable: "MCP_TOKEN" }],
            { MCP_TOKEN: "value\r\ninjected: true" },
        ),
        /line breaks/u,
    );

    const manager = new ConnectionManager();
    assert.throws(
        () => manager.register({
            id: "userinfo",
            kind: "streamable-http",
            endpoint: "https://user:password@example.test/mcp",
        }),
        /userinfo/u,
    );
    assert.throws(
        () => manager.register({
            id: "query",
            kind: "streamable-http",
            endpoint: "https://example.test/mcp?api_key=secret",
        }),
        /query parameters/u,
    );
});

test("connection timeout and failures leave a sanitized failed snapshot", async () => {
    let closeCalls = 0;
    const manager = new ConnectionManager({ connectTimeoutMs: 20 });
    manager.register({
        id: "timeout",
        kind: "inproc",
        serverFactory: () => ({
            connect: () => new Promise<void>(() => {}),
            close: async () => {
                closeCalls += 1;
            },
        }),
    });

    await assert.rejects(
        manager.connect("timeout"),
        (error: unknown) => error instanceof ConnectionManagerError && error.code === "timeout",
    );
    assert.equal(manager.get("timeout").lifecycle, "failed");
    assert(closeCalls >= 1);

    manager.register({
        id: "factory-timeout",
        kind: "inproc",
        serverFactory: () => new Promise(() => {}),
    });
    await assert.rejects(
        manager.connect("factory-timeout"),
        (error: unknown) => error instanceof ConnectionManagerError && error.code === "timeout",
    );

    manager.register({
        id: "secret-failure",
        kind: "inproc",
        serverFactory: () => {
            throw new Error("Authorization: Bearer top-secret");
        },
    });
    await assert.rejects(
        manager.connect("secret-failure"),
        (error: unknown) => {
            assert(error instanceof ConnectionManagerError);
            assert.equal(error.code, "connect_failed");
            assert.equal(error.message.includes("top-secret"), false);
            assert(error.cause instanceof Error);
            assert.equal(error.cause.message.includes("top-secret"), false);
            return true;
        },
    );
    assert.equal(manager.get("secret-failure").lastError?.includes("top-secret"), false);
});

test("missing environment references become typed configuration failures", async () => {
    const manager = new ConnectionManager({ environment: {} });
    manager.register({
        id: "missing-environment",
        kind: "stdio",
        command: process.execPath,
        environment: [
            { variable: "MCP_TOKEN", environmentVariable: "UNSET_MCP_TOKEN" },
        ],
    });

    await assert.rejects(
        manager.connect("missing-environment"),
        (error: unknown) => (
            error instanceof ConnectionManagerError && error.code === "invalid_configuration"
        ),
    );
    assert.equal(manager.get("missing-environment").lifecycle, "failed");
});

test("throwing connection observers are isolated and retained as sanitized diagnostics", async () => {
    const manager = new ConnectionManager();
    manager.subscribe(() => {
        throw new Error("Authorization: Bearer observer-secret");
    });
    manager.register({
        id: "observer",
        kind: "inproc",
        serverFactory: () => {
            const server = new McpServer({ name: "observer", version: "1.0.0" });
            server.registerTool(
                "probe",
                {},
                async () => ({ content: [{ type: "text", text: "ok" }] }),
            );
            return server;
        },
    });

    assert.equal((await manager.connect("observer")).lifecycle, "connected");
    assert(manager.getObserverErrors().length >= 3);
    assert.equal(
        manager.getObserverErrors().some((error) => error.message.includes("observer-secret")),
        false,
    );
    await manager.disconnect("observer");
});

test("an aborted late in-process factory is closed when it eventually resolves", async () => {
    let resolveFactory: ((server: { connect(): Promise<void>; close(): Promise<void> }) => void) | undefined;
    let closeCalls = 0;
    const manager = new ConnectionManager();
    manager.register({
        id: "aborted-factory",
        kind: "inproc",
        serverFactory: () => new Promise((resolve) => {
            resolveFactory = resolve;
        }),
    });
    const controller = new AbortController();
    const connecting = manager.connect("aborted-factory", { signal: controller.signal });
    controller.abort();
    await assert.rejects(connecting, /cancelled/u);

    assert(resolveFactory);
    resolveFactory({
        async connect() {},
        async close() {
            closeCalls += 1;
        },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeCalls, 1);
});
