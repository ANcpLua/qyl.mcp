import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConnectionManager, type ConnectionProtocolOperation } from "./connection-manager.js";
import { startFixtureHttpServer, type FixtureHttpRequest } from "./fixture-http.js";
import { runWithMcpPropagation } from "./telemetry.js";

test("connection manager owns a real stdio MCP lifecycle and exhaustive discovery", { timeout: 15_000 }, async () => {
    const scriptPath = fileURLToPath(
        new URL("../../fixtures/mcp-conformance-stdio.mjs", import.meta.url),
    );
    const operations: ConnectionProtocolOperation[] = [];
    const manager = new ConnectionManager({
        onOperation: (operation) => operations.push(operation),
    });
    manager.register({
        id: "stdio-fixture",
        kind: "stdio",
        command: process.execPath,
        args: [scriptPath],
    });

    try {
        const connected = await manager.connect("stdio-fixture");
        assert.equal(connected.lifecycle, "connected");
        assert.deepEqual(
            connected.initialization?.discovery.tools.map(({ name }) => name),
            [
                "fixture.safe_lookup",
                "fixture.rich_result",
                "fixture.evidence",
                "fixture.delete_record",
                "fixture.delayed",
                "fixture.tool_error",
            ],
        );
        assert.equal(connected.initialization?.discovery.resources.length, 3);
        assert.equal(connected.initialization?.discovery.resourceTemplates.length, 3);
        assert.equal(connected.initialization?.discovery.prompts.length, 3);

        const result = await manager.getClient("stdio-fixture").callTool({
            name: "fixture.safe_lookup",
            arguments: { query: "stdio" },
        });
        assert.equal(result.isError, undefined);
        assert(operations.some((operation) => operation.method === "tools/call"));
        const discover = operations.find((candidate) => candidate.method === "server/discover");
        assert(discover, "missing server/discover operation");
        assert.equal(operations.some((operation) => operation.method === "initialize"), false);
    } finally {
        if (manager.get("stdio-fixture").lifecycle !== "disconnected") {
            await manager.disconnect("stdio-fixture");
        }
    }
});

test("stdio drains chatty child stderr without retaining its raw output", { timeout: 15_000 }, async () => {
    const scriptPath = fileURLToPath(
        new URL("../../fixtures/mcp-chatty-stdio.mjs", import.meta.url),
    );
    const manager = new ConnectionManager();
    manager.register({
        id: "chatty-stdio-fixture",
        kind: "stdio",
        command: process.execPath,
        args: [scriptPath],
    });

    try {
        const connected = await manager.connect("chatty-stdio-fixture");
        assert.equal(connected.lifecycle, "connected");
        const result = await runWithMcpPropagation(
            { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
            () => manager.getClient("chatty-stdio-fixture").callTool({
                name: "fixture.safe_lookup",
                arguments: { query: "chatty-stdio" },
            }),
        );
        assert.equal(result.isError, undefined);
        assert.doesNotMatch(
            JSON.stringify(manager.getJournal("chatty-stdio-fixture")?.snapshot()),
            /QYL_CHATTY_STDERR_MUST_NOT_PERSIST/u,
        );
    } finally {
        if (manager.get("chatty-stdio-fixture").lifecycle !== "disconnected") {
            await manager.disconnect("chatty-stdio-fixture");
        }
    }
});

for (const transport of ["streamable-http"] as const) {
    test(`connection manager owns an authenticated ${transport} MCP lifecycle`, { timeout: 15_000 }, async () => {
        const secret = `${transport}-arbitrary-env-secret`;
        const fixture = await startFixtureHttpServer({ bearerToken: secret });
        const operations: ConnectionProtocolOperation[] = [];
        const manager = new ConnectionManager({
            environment: { MCP_AUTH: secret },
            onOperation: (operation) => operations.push(operation),
        });
        manager.register({
            id: transport,
            kind: transport,
            endpoint: fixture.streamableUrl.toString(),
            headers: [{
                header: "Authorization",
                scheme: "bearer",
                environmentVariable: "MCP_AUTH",
            }],
        });

        try {
            const connected = await manager.connect(transport);
            assert.equal(connected.lifecycle, "connected");
            const expectedCounts = { tools: 6, resources: 3, resourceTemplates: 3, prompts: 3 };
            assert.equal(connected.initialization?.discovery.tools.length, expectedCounts.tools);
            assert.equal(connected.initialization?.discovery.resources.length, expectedCounts.resources);
            assert.equal(
                connected.initialization?.discovery.resourceTemplates.length,
                expectedCounts.resourceTemplates,
            );
            assert.equal(connected.initialization?.discovery.prompts.length, expectedCounts.prompts);

            const firstTraceparent = "00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01";
            const secondTraceparent = "00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-00";
            const firstCarrier = {
                traceparent: firstTraceparent,
                tracestate: "qyl=first",
                baggage: "tenant=first",
            };
            const secondCarrier = {
                traceparent: secondTraceparent,
                tracestate: "qyl=second",
                baggage: "tenant=second",
            };
            const client = manager.getClient(transport);
            const [first, second] = await Promise.all([
                runWithMcpPropagation(firstCarrier, () => client.callTool({
                    name: "fixture.safe_lookup",
                    arguments: { query: `${transport}-first` },
                })),
                runWithMcpPropagation(secondCarrier, () => client.callTool({
                    name: "fixture.safe_lookup",
                    arguments: { query: `${transport}-second` },
                })),
            ]);
            assert.equal(first.isError, undefined);
            assert.equal(second.isError, undefined);
            const propagated = new Map(
                fixture.requests
                    .map(toolCallRequest)
                    .filter((request): request is ToolCallRequest => request !== undefined)
                    .map((request) => [request.query, request]),
            );
            assert.deepEqual(propagated.get(`${transport}-first`), {
                query: `${transport}-first`,
                ...firstCarrier,
            });
            assert.deepEqual(propagated.get(`${transport}-second`), {
                query: `${transport}-second`,
                ...secondCarrier,
            });
            assert.equal(fixture.requests.some((request) => request.traceparent !== undefined), false);
            assert(operations.some((operation) => operation.method === "tools/call"
                && operation.role === "client"));
            assert.equal(operations.some((operation) => operation.role === "server"), false);
            assert.equal(connected.initialization?.sessionId, undefined);
            const discover = operations.find((candidate) => candidate.method === "server/discover");
            assert(discover, "missing server/discover operation");
            assert.equal(operations.some((operation) => operation.method === "initialize"), false);
            assert.doesNotMatch(
                JSON.stringify({ connected, journal: manager.getJournal(transport)?.snapshot() }),
                new RegExp(secret, "u"),
            );
        } finally {
            if (manager.get(transport).lifecycle !== "disconnected") {
                await manager.disconnect(transport);
            }
            await fixture.close();
        }
    });
}

test("connection manager pins Streamable HTTP to protocol revision 2026-07-28", { timeout: 15_000 }, async () => {
    const secret = "modern-protocol-arbitrary-env-secret";
    const fixture = await startFixtureHttpServer({ bearerToken: secret });
    const manager = new ConnectionManager({
        environment: { MCP_AUTH: secret },
    });
    manager.register({
        id: "modern-http",
        kind: "streamable-http",
        endpoint: fixture.streamableUrl.toString(),
        headers: [{
            header: "Authorization",
            scheme: "bearer",
            environmentVariable: "MCP_AUTH",
        }],
    });

    try {
        const connected = await manager.connect("modern-http");
        assert.equal(connected.initialization?.protocolVersion, "2026-07-28");
        assert.equal(connected.initialization?.sessionId, undefined);
        assert.equal(manager.getClient("modern-http").getProtocolEra(), "modern");
        assert.equal(connected.initialization?.serverInfo?.name, "qyl-mcp-conformance-fixture");
        assert.equal(connected.initialization?.discovery.tools.length, 6);

        const result = await manager.getClient("modern-http").callTool({
            name: "fixture.safe_lookup",
            arguments: { query: "modern" },
        });
        assert.equal(result.isError, undefined);

        const methods = manager.getJournal("modern-http")?.snapshot()
            .filter((entry) => entry.kind === "message")
            .map((entry) => entry.method);
        assert(methods?.includes("server/discover"));
        assert.equal(methods?.includes("initialize"), false);
    } finally {
        if (manager.get("modern-http").lifecycle !== "disconnected") {
            await manager.disconnect("modern-http");
        }
        await fixture.close();
    }
});

interface ToolCallRequest {
    query: string;
    traceparent?: string;
    tracestate?: string;
    baggage?: string;
}

function toolCallRequest(request: FixtureHttpRequest): ToolCallRequest | undefined {
    if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return undefined;
    const message = request.body as Record<string, unknown>;
    if (message.method !== "tools/call") return undefined;
    const params = message.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
    const parameters = params as Record<string, unknown>;
    const args = parameters.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
    const query = (args as Record<string, unknown>).query;
    if (typeof query !== "string") return undefined;
    const meta = typeof parameters._meta === "object"
        && parameters._meta !== null
        && !Array.isArray(parameters._meta)
        ? parameters._meta as Record<string, unknown>
        : {};
    return {
        query,
        ...(typeof meta.traceparent === "string" ? { traceparent: meta.traceparent } : {}),
        ...(typeof meta.tracestate === "string" ? { tracestate: meta.tracestate } : {}),
        ...(typeof meta.baggage === "string" ? { baggage: meta.baggage } : {}),
    };
}
