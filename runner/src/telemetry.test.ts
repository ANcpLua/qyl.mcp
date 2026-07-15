import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SpanKind } from "@opentelemetry/api";
import {
    ATTR_CLIENT_ADDRESS,
    ATTR_CLIENT_PORT,
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_PROTOCOL_NAME,
    ATTR_NETWORK_TRANSPORT,
    ATTR_SERVER_ADDRESS,
    ATTR_SERVER_PORT,
    NETWORK_TRANSPORT_VALUE_PIPE,
    NETWORK_TRANSPORT_VALUE_TCP,
} from "@opentelemetry/semantic-conventions";
import {
    ATTR_GEN_AI_OPERATION_NAME,
    ATTR_GEN_AI_PROMPT_NAME,
    ATTR_GEN_AI_TOOL_NAME,
    ATTR_JSONRPC_PROTOCOL_VERSION,
    ATTR_JSONRPC_REQUEST_ID,
    ATTR_MCP_METHOD_NAME,
    ATTR_MCP_PROTOCOL_VERSION,
    ATTR_MCP_RESOURCE_URI,
    ATTR_MCP_SESSION_ID,
    ATTR_RPC_RESPONSE_STATUS_CODE,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    METRIC_MCP_CLIENT_OPERATION_DURATION,
    METRIC_MCP_CLIENT_SESSION_DURATION,
    METRIC_MCP_SERVER_OPERATION_DURATION,
    METRIC_MCP_SERVER_SESSION_DURATION,
} from "@opentelemetry/semantic-conventions/incubating";
import { MCP_WELL_KNOWN_METHODS } from "./mcp-semconv.js";
import {
    McpTelemetry,
    WorkbenchTelemetryAttributes,
    currentMcpTraceparent,
    describeMcpOperationMetric,
    describeMcpOperationSpan,
    describeMcpSessionMetric,
    runWithMcpTraceparent,
    signalEndpoint,
} from "./telemetry.js";

test("pinned registry exposes exactly 25 well-known MCP methods", () => {
    assert.equal(MCP_WELL_KNOWN_METHODS.length, 25);
    assert.equal(new Set(MCP_WELL_KNOWN_METHODS).size, 25);
    assert.ok(MCP_WELL_KNOWN_METHODS.includes("elicitation/create"));
});

test("telemetry defaults OTLP export to the same configured Qyl collector", () => {
    assert.equal(
        signalEndpoint({
            QYL_COLLECTOR_URL: "http://127.0.0.1:5100/",
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://ambient-collector.example",
        }, "traces"),
        "http://127.0.0.1:5100/v1/traces",
    );
    assert.equal(
        signalEndpoint({
            QYL_COLLECTOR_URL: "http://collector.example",
            QYL_OTLP_ENDPOINT: "http://otlp.example/",
        }, "metrics"),
        "http://otlp.example/v1/metrics",
    );
});

test("client tool span uses client conventions and bounded workbench correlation", () => {
    const descriptor = describeMcpOperationSpan({
        role: "client",
        method: "tools/call",
        serverId: "server-1",
        toolName: "probe",
        transport: "streamable-http",
        protocolVersion: "2025-11-25",
        jsonRpcProtocolVersion: "2.1",
        mcpSessionId: "mcp-session-1",
        jsonRpcRequestId: 17,
        peerAddress: "mcp.example.test",
        peerPort: 443,
        executionId: "execution-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
        startTimeMs: 1_000,
        endTimeMs: 1_025,
    });

    assert.equal(descriptor.name, "tools/call probe");
    assert.equal(descriptor.kind, SpanKind.CLIENT);
    assert.equal(descriptor.attributes[ATTR_MCP_METHOD_NAME], "tools/call");
    assert.equal(descriptor.attributes[ATTR_MCP_PROTOCOL_VERSION], "2025-11-25");
    assert.equal(descriptor.attributes[ATTR_MCP_SESSION_ID], "mcp-session-1");
    assert.equal(descriptor.attributes[ATTR_JSONRPC_PROTOCOL_VERSION], "2.1");
    assert.equal(descriptor.attributes[ATTR_JSONRPC_REQUEST_ID], "17");
    assert.equal(descriptor.attributes[ATTR_GEN_AI_TOOL_NAME], "probe");
    assert.equal(
        descriptor.attributes[ATTR_GEN_AI_OPERATION_NAME],
        GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    );
    assert.equal(descriptor.attributes[ATTR_NETWORK_PROTOCOL_NAME], "http");
    assert.equal(descriptor.attributes[ATTR_NETWORK_TRANSPORT], NETWORK_TRANSPORT_VALUE_TCP);
    assert.equal(descriptor.attributes[ATTR_SERVER_ADDRESS], "mcp.example.test");
    assert.equal(descriptor.attributes[ATTR_SERVER_PORT], 443);
    assert.equal(descriptor.attributes[ATTR_CLIENT_ADDRESS], undefined);
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.serverId], "server-1");
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.executionId], "execution-1");
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.evaluationRunId], "evaluation-1");
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.testCaseId], "test-1");
});

test("server prompt span uses server peer attributes and omits JSON-RPC 2.0", () => {
    const descriptor = describeMcpOperationSpan({
        role: "server",
        method: "prompts/get",
        promptName: "release-notes",
        transport: "sse",
        jsonRpcProtocolVersion: "2.0",
        peerAddress: "192.0.2.7",
        peerPort: 51999,
        errorType: "-32602",
        rpcResponseStatusCode: "-32602",
        startTimeMs: 2_000,
        endTimeMs: 2_250,
    });

    assert.equal(descriptor.name, "prompts/get release-notes");
    assert.equal(descriptor.kind, SpanKind.SERVER);
    assert.equal(descriptor.attributes[ATTR_GEN_AI_PROMPT_NAME], "release-notes");
    assert.equal(descriptor.attributes[ATTR_JSONRPC_PROTOCOL_VERSION], undefined);
    assert.equal(descriptor.attributes[ATTR_ERROR_TYPE], "-32602");
    assert.equal(descriptor.attributes[ATTR_RPC_RESPONSE_STATUS_CODE], "-32602");
    assert.equal(descriptor.attributes[ATTR_CLIENT_ADDRESS], "192.0.2.7");
    assert.equal(descriptor.attributes[ATTR_CLIENT_PORT], 51999);
    assert.equal(descriptor.attributes[ATTR_SERVER_ADDRESS], undefined);
});

test("operation metrics exclude span-only request, session, and workbench identifiers", () => {
    const client = describeMcpOperationMetric({
        role: "client",
        method: "resources/read",
        resourceUri: "https://example.test/item/1?token=secret",
        recordResourceUriOnMetric: false,
        transport: "stdio",
        protocolVersion: "2025-11-25",
        mcpSessionId: "session-1",
        jsonRpcRequestId: "request-1",
        peerAddress: "ignored-for-stdio.example",
        serverId: "server-1",
        executionId: "execution-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
        startTimeMs: 3_000,
        endTimeMs: 3_125,
    });
    assert.equal(client.name, METRIC_MCP_CLIENT_OPERATION_DURATION);
    assert.equal(client.unit, "s");
    assert.equal(client.value, 0.125);
    assert.equal(client.attributes[ATTR_NETWORK_TRANSPORT], NETWORK_TRANSPORT_VALUE_PIPE);
    assert.equal(client.attributes[ATTR_MCP_RESOURCE_URI], undefined);
    assert.equal(client.attributes[ATTR_MCP_SESSION_ID], undefined);
    assert.equal(client.attributes[ATTR_JSONRPC_REQUEST_ID], undefined);
    assert.equal(client.attributes[WorkbenchTelemetryAttributes.executionId], undefined);
    assert.equal(client.attributes[WorkbenchTelemetryAttributes.evaluationRunId], undefined);
    assert.equal(client.attributes[WorkbenchTelemetryAttributes.testCaseId], undefined);
    assert.equal(client.attributes[WorkbenchTelemetryAttributes.serverId], undefined);

    const server = describeMcpOperationMetric({
        role: "server",
        method: "ping",
        transport: "streamable_http",
        peerAddress: "client.example.test",
        peerPort: 49152,
        startTimeMs: 4_000,
        endTimeMs: 4_001,
    });
    assert.equal(server.name, METRIC_MCP_SERVER_OPERATION_DURATION);
    assert.equal(server.attributes[ATTR_CLIENT_ADDRESS], undefined);
    assert.equal(server.attributes[ATTR_CLIENT_PORT], undefined);
});

test("session metrics use the distinct client and server session inventories", () => {
    const client = describeMcpSessionMetric({
        role: "client",
        transport: "streamable-http",
        protocolVersion: "2025-11-25",
        peerAddress: "mcp.example.test",
        peerPort: 443,
        startTimeMs: 5_000,
        endTimeMs: 7_500,
    });
    assert.equal(client.name, METRIC_MCP_CLIENT_SESSION_DURATION);
    assert.equal(client.value, 2.5);
    assert.equal(client.attributes[ATTR_SERVER_ADDRESS], "mcp.example.test");
    assert.equal(client.attributes[ATTR_SERVER_PORT], 443);
    assert.equal(client.attributes[ATTR_MCP_METHOD_NAME], undefined);
    assert.equal(client.attributes[ATTR_MCP_SESSION_ID], undefined);

    const server = describeMcpSessionMetric({
        role: "server",
        transport: "inproc",
        startTimeMs: 8_000,
        endTimeMs: 9_000,
    });
    assert.equal(server.name, METRIC_MCP_SERVER_SESSION_DURATION);
    assert.deepEqual(server.attributes, {});
});

test("resource spans sanitize URIs and only attach them to URI-bearing methods", () => {
    const read = describeMcpOperationSpan({
        role: "client",
        method: "resources/read",
        resourceUri: "https://user:password@example.test/resource?api_key=secret#secret",
        transport: "builtin",
        startTimeMs: 10_000,
        endTimeMs: 10_010,
        errorType: "resource_not_found",
    });
    assert.equal(read.attributes[ATTR_MCP_RESOURCE_URI], "https://example.test/resource");
    assert.equal(read.attributes[ATTR_NETWORK_TRANSPORT], undefined);
    assert.equal(read.attributes[ATTR_ERROR_TYPE], "resource_not_found");
    assert.equal(JSON.stringify(read).includes("password"), false);
    assert.equal(JSON.stringify(read).includes("api_key"), false);

    const list = describeMcpOperationSpan({
        role: "client",
        method: "resources/list",
        resourceUri: "https://example.test/must-not-appear",
        transport: "builtin",
        startTimeMs: 11_000,
        endTimeMs: 11_001,
    });
    assert.equal(list.attributes[ATTR_MCP_RESOURCE_URI], undefined);
});

test("disabled self-telemetry remains a no-op for operations and sessions", async () => {
    const telemetry = new McpTelemetry({ QYL_MCP_TELEMETRY: "0" });
    assert.equal(telemetry.recordOperation({
        role: "client",
        method: "ping",
        transport: "inproc",
        startTimeMs: 1,
        endTimeMs: 2,
    }), undefined);
    telemetry.recordSession({
        role: "server",
        transport: "inproc",
        startTimeMs: 1,
        endTimeMs: 2,
    });
    await telemetry.close();
});

test("a live pre-call operation exposes its non-global W3C trace context until completion", async () => {
    const receivedPaths: string[] = [];
    const receiver = createServer((request, response) => {
        receivedPaths.push(request.url ?? "");
        request.resume();
        request.once("end", () => {
            response.statusCode = 200;
            response.end();
        });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    assert(address && typeof address === "object");
    const telemetry = new McpTelemetry({
        QYL_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });

    try {
        const operation = telemetry.startOperation({
            role: "client",
            method: "tools/call",
            serverId: "server-1",
            executionId: "execution-1",
            toolName: "probe",
            transport: "streamable-http",
            startTimeMs: 1_000,
        });
        assert(operation.correlation);
        assert.match(
            operation.traceparent ?? "",
            /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u,
        );
        const [, traceId, spanId] = (operation.traceparent ?? "").split("-");
        assert.equal(traceId, operation.correlation.traceId);
        assert.equal(spanId, operation.correlation.spanId);
        assert.equal(currentMcpTraceparent(), undefined);
        assert.equal(
            runWithMcpTraceparent(operation.traceparent, currentMcpTraceparent),
            operation.traceparent,
        );
        const completed = operation.end({
            endTimeMs: 1_025,
            errorType: "tool_error",
            rpcResponseStatusCode: "-32602",
            jsonRpcRequestId: 7,
        });
        assert.deepEqual(completed, operation.correlation);
        assert.deepEqual(operation.end({ endTimeMs: 1_030 }), operation.correlation);
    } finally {
        await telemetry.close();
        await new Promise<void>((resolve, reject) => receiver.close((error) => {
            if (error) reject(error);
            else resolve();
        }));
    }
    assert(receivedPaths.includes("/v1/traces"));
    assert(receivedPaths.includes("/v1/metrics"));
});
