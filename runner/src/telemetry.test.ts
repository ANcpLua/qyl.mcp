import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
    InMemoryLogRecordExporter,
    LoggerProvider,
    SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
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
    ATTR_RPC_RESPONSE_STATUS_CODE,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    METRIC_MCP_CLIENT_OPERATION_DURATION,
    METRIC_MCP_SERVER_OPERATION_DURATION,
} from "@opentelemetry/semantic-conventions/incubating";
import {
    EVENT_QYL_MCP_OPERATION,
    describeMcpOperationLog,
    describeMcpOperationMetric,
    describeMcpOperationSpan,
} from "./mcp-semconv.js";
import {
    MCP_DURATION_EXPLICIT_BUCKET_BOUNDARIES,
    McpTelemetry,
    WorkbenchTelemetryAttributes,
    currentMcpPropagation,
    runWithMcpPropagation,
    signalEndpoint,
} from "./telemetry.js";
import { SecretRedactor } from "./secret-redactor.js";

const baseInput = {
    role: "client" as const,
    method: "tools/call",
    toolName: "weather.lookup",
    transport: "streamable-http" as const,
    protocolVersion: "2026-07-28",
    jsonRpcProtocolVersion: "2.0",
    jsonRpcRequestId: 7,
    startTimeMs: 1_000,
    endTimeMs: 1_025,
};

test("MCP operation telemetry uses the upstream duration boundaries", () => {
    assert.deepEqual(MCP_DURATION_EXPLICIT_BUCKET_BOUNDARIES, [
        0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
    ]);

    const notification = describeMcpOperationSpan({
        role: "server",
        method: "notifications/resources/updated",
        resourceUri: "fixture://item/1",
        transport: "streamable-http",
        protocolVersion: "2026-07-28",
        startTimeMs: 1_000,
        endTimeMs: 1_001,
    });
    assert.equal(notification.name, "notifications/resources/updated");
    assert.equal(notification.kind, SpanKind.SERVER);
    assert.equal(
        notification.attributes[ATTR_MCP_RESOURCE_URI],
        "fixture://item/1",
    );
});

test("spans and histograms use the upstream MCP operation conventions", () => {
    const input = {
        ...baseInput,
        errorType: "-32602",
        errorMessage: "Invalid params",
        rpcResponseStatusCode: "-32602",
    };
    const span = describeMcpOperationSpan(input);
    assert.equal(span.name, "tools/call weather.lookup");
    assert.equal(span.kind, SpanKind.CLIENT);
    assert.equal(span.attributes[ATTR_MCP_METHOD_NAME], "tools/call");
    assert.equal(span.attributes[ATTR_GEN_AI_TOOL_NAME], "weather.lookup");
    assert.equal(
        span.attributes[ATTR_GEN_AI_OPERATION_NAME],
        GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    );
    assert.equal(span.attributes[ATTR_MCP_PROTOCOL_VERSION], "2026-07-28");
    assert.equal(span.attributes[ATTR_JSONRPC_PROTOCOL_VERSION], undefined);
    assert.equal(span.attributes[ATTR_JSONRPC_REQUEST_ID], "7");
    assert.equal(span.attributes[ATTR_RPC_RESPONSE_STATUS_CODE], "-32602");
    assert.equal(span.attributes[ATTR_ERROR_TYPE], "-32602");

    const duration = describeMcpOperationMetric(input);
    assert.equal(duration.name, METRIC_MCP_CLIENT_OPERATION_DURATION);
    assert.equal(duration.unit, "s");
    assert.equal(duration.value, 0.025);
    assert.equal(duration.attributes[ATTR_MCP_METHOD_NAME], "tools/call");
    assert.equal(duration.attributes[ATTR_GEN_AI_TOOL_NAME], "weather.lookup");
    assert.equal(
        duration.attributes[ATTR_GEN_AI_OPERATION_NAME],
        GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    );
    assert.equal(duration.attributes[ATTR_ERROR_TYPE], "-32602");
    assert.equal(duration.attributes[ATTR_JSONRPC_REQUEST_ID], undefined);
});

test("operation logs capture redacted content only after explicit opt-in", async () => {
    const secret = "request-secret";
    const redactor = new SecretRedactor({ environment: { API_KEY: secret } });
    const spanExporter = new InMemorySpanExporter();
    const traceProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const logExporter = new InMemoryLogRecordExporter();
    const logProvider = new LoggerProvider({
        processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
    });
    const telemetry = new McpTelemetry(
        { QYL_MCP_TELEMETRY: "0", QYL_MCP_CAPTURE_CONTENT: "1" },
        redactor,
        {
            tracer: traceProvider.getTracer("test"),
            logger: logProvider.getLogger("test"),
        },
    );

    try {
        const operation = telemetry.startOperation({
            role: "server",
            method: "tools/call",
            toolName: "weather.lookup",
            transport: "inproc",
            protocolVersion: "2026-07-28",
            requestBody: {
                jsonrpc: "2.0",
                method: "tools/call",
                params: { authorization: `Bearer ${secret}` },
            },
            remotePropagation: {
                traceparent: "00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01",
            },
            startTimeMs: 2_000,
        });
        assert(operation.correlation);
        operation.end({
            endTimeMs: 2_040,
            jsonRpcRequestId: 9,
            errorType: "-32021",
            errorMessage: "Missing required client capability",
            rpcResponseStatusCode: "-32021",
            responseBody: {
                jsonrpc: "2.0",
                id: 9,
                error: { code: -32021, message: "Missing required client capability" },
            },
        });
        await Promise.all([traceProvider.forceFlush(), logProvider.forceFlush()]);

        const span = assertSingle(spanExporter.getFinishedSpans());
        const log = assertSingle(logExporter.getFinishedLogRecords());
        assert.equal(span.status.code, SpanStatusCode.ERROR);
        assert.equal(span.status.message, "Missing required client capability");
        assert.equal(span.parentSpanContext?.traceId, "22222222222222222222222222222222");
        assert.equal(log.eventName, EVENT_QYL_MCP_OPERATION);
        assert.equal(log.severityText, "ERROR");
        assert.equal(log.spanContext?.traceId, span.spanContext().traceId);
        assert.equal(log.spanContext?.spanId, span.spanContext().spanId);
        assert.equal(log.attributes[ATTR_MCP_METHOD_NAME], "tools/call");
        assert.equal(JSON.stringify(log.body).includes(secret), false);
        assert.match(JSON.stringify(log.body), /\[REDACTED\]/u);
    } finally {
        await telemetry.close();
        await Promise.all([traceProvider.shutdown(), logProvider.shutdown()]);
    }
});

test("local operation-log descriptors and signal endpoints cover all OTel signals", () => {
    const requestBody = { params: { arguments: { city: "Vienna" } } };
    const responseBody = { result: { content: "sunny" } };
    const log = describeMcpOperationLog({ ...baseInput, requestBody, responseBody });
    assert.equal(log.eventName, EVENT_QYL_MCP_OPERATION);
    assert.equal(log.severityText, "INFO");
    assert.equal("request" in (log.body as Record<string, unknown>), false);
    assert.equal("response" in (log.body as Record<string, unknown>), false);
    const contentLog = describeMcpOperationLog(
        { ...baseInput, requestBody, responseBody },
        new SecretRedactor(),
        true,
    );
    assert.deepEqual((contentLog.body as Record<string, unknown>).request, requestBody);
    assert.deepEqual((contentLog.body as Record<string, unknown>).response, responseBody);
    assert.equal(
        signalEndpoint({ QYL_OTLP_ENDPOINT: "http://collector:4318/" }, "traces"),
        "http://collector:4318/v1/traces",
    );
    assert.equal(
        signalEndpoint({ QYL_OTLP_ENDPOINT: "http://collector:4318/" }, "metrics"),
        "http://collector:4318/v1/metrics",
    );
    assert.equal(
        signalEndpoint({ QYL_OTLP_ENDPOINT: "http://collector:4318/" }, "logs"),
        "http://collector:4318/v1/logs",
    );
});

test("client spans carry network and bounded workbench correlation attributes", () => {
    const descriptor = describeMcpOperationSpan({
        ...baseInput,
        serverId: "server-1",
        peerAddress: "mcp.example.test",
        peerPort: 443,
        executionId: "execution-1",
        evaluationRunId: "evaluation-1",
        testCaseId: "test-1",
    });

    assert.equal(descriptor.attributes[ATTR_NETWORK_PROTOCOL_NAME], "http");
    assert.equal(descriptor.attributes[ATTR_NETWORK_TRANSPORT], NETWORK_TRANSPORT_VALUE_TCP);
    assert.equal(descriptor.attributes[ATTR_SERVER_ADDRESS], "mcp.example.test");
    assert.equal(descriptor.attributes[ATTR_SERVER_PORT], 443);
    assert.equal(descriptor.attributes[ATTR_CLIENT_ADDRESS], undefined);
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.serverId], "server-1");
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.executionId], "execution-1");
    assert.equal(
        descriptor.attributes[WorkbenchTelemetryAttributes.evaluationRunId],
        "evaluation-1",
    );
    assert.equal(descriptor.attributes[WorkbenchTelemetryAttributes.testCaseId], "test-1");
});

test("server prompt spans use client peer attributes and preserve non-default JSON-RPC", () => {
    const descriptor = describeMcpOperationSpan({
        role: "server",
        method: "prompts/get",
        promptName: "release-notes",
        transport: "streamable_http",
        jsonRpcProtocolVersion: "2.1",
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
    assert.equal(descriptor.attributes[ATTR_JSONRPC_PROTOCOL_VERSION], "2.1");
    assert.equal(descriptor.attributes[ATTR_ERROR_TYPE], "-32602");
    assert.equal(descriptor.attributes[ATTR_RPC_RESPONSE_STATUS_CODE], "-32602");
    assert.equal(descriptor.attributes[ATTR_CLIENT_ADDRESS], "192.0.2.7");
    assert.equal(descriptor.attributes[ATTR_CLIENT_PORT], 51999);
    assert.equal(descriptor.attributes[ATTR_SERVER_ADDRESS], undefined);
});

test("operation metrics exclude request and workbench identifiers", () => {
    const client = describeMcpOperationMetric({
        role: "client",
        method: "resources/read",
        resourceUri: "https://example.test/item/1?token=secret",
        transport: "stdio",
        protocolVersion: "2026-07-28",
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
    assert.equal(client.value, 0.125);
    assert.equal(client.attributes[ATTR_NETWORK_TRANSPORT], NETWORK_TRANSPORT_VALUE_PIPE);
    assert.equal(client.attributes[ATTR_MCP_RESOURCE_URI], undefined);
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

test("resource telemetry sanitizes URIs and only records URI-bearing methods", () => {
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

    const mismatchedTarget = describeMcpOperationSpan({
        role: "client",
        method: "ping",
        toolName: "must-not-be-a-target",
        promptName: "must-not-be-a-target",
        transport: "inproc",
        startTimeMs: 12_000,
        endTimeMs: 12_001,
    });
    assert.equal(mismatchedTarget.name, "ping");
    assert.equal(mismatchedTarget.attributes[ATTR_GEN_AI_TOOL_NAME], undefined);
    assert.equal(mismatchedTarget.attributes[ATTR_GEN_AI_PROMPT_NAME], undefined);
});

test("disabled self-telemetry remains a no-op", async () => {
    const telemetry = new McpTelemetry({ QYL_MCP_TELEMETRY: "0" });
    assert.equal(telemetry.operationTracingEnabled, false);
    assert.equal(telemetry.recordOperation({
        role: "client",
        method: "ping",
        transport: "inproc",
        startTimeMs: 1,
        endTimeMs: 2,
    }), undefined);
    await telemetry.close();
});

test("server operations parent from MCP metadata and link ambient transport context", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const telemetry = new McpTelemetry(
        { QYL_MCP_TELEMETRY: "0" },
        new SecretRedactor(),
        { tracer: provider.getTracer("qyl.mcp/test") },
    );
    const ambientCarrier = {
        traceparent: "00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01",
        tracestate: "qyl=ambient",
        baggage: "tenant=ambient",
    };
    const remoteCarrier = {
        traceparent: "00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01",
        tracestate: "qyl=remote",
        baggage: "tenant=remote,release=2026-07-15",
    };

    try {
        const operation = runWithMcpPropagation(ambientCarrier, () => telemetry.startOperation({
            role: "server",
            method: "tools/call",
            toolName: "probe",
            transport: "streamable-http",
            remotePropagation: remoteCarrier,
            startTimeMs: 1_000,
        }));
        assert(operation.correlation);
        assert.equal(operation.correlation.traceId, "22222222222222222222222222222222");
        assert.match(
            operation.propagation?.traceparent ?? "",
            /^00-22222222222222222222222222222222-[0-9a-f]{16}-01$/u,
        );
        assert.equal(operation.propagation?.tracestate, remoteCarrier.tracestate);
        assert.equal(operation.propagation?.baggage, remoteCarrier.baggage);
        assert.equal(currentMcpPropagation(), undefined);
        assert.deepEqual(operation.run(currentMcpPropagation), operation.propagation);
        assert.equal(currentMcpPropagation(), undefined);

        operation.end({ endTimeMs: 1_025, protocolVersion: "2026-07-28" });
        const rootOperation = runWithMcpPropagation(ambientCarrier, () => telemetry.startOperation({
            role: "server",
            method: "ping",
            transport: "streamable-http",
            startTimeMs: 1_030,
        }));
        rootOperation.end({ endTimeMs: 1_035 });
        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        assert.equal(spans.length, 2);
        const span = spans.find(({ name }) => name === "tools/call probe")!;
        assert.equal(span.parentSpanContext?.traceId, "22222222222222222222222222222222");
        assert.equal(span.parentSpanContext?.spanId, "bbbbbbbbbbbbbbbb");
        assert.equal(span.parentSpanContext?.isRemote, true);
        assert.equal(span.links.length, 1);
        assert.equal(span.links[0]?.context.traceId, "11111111111111111111111111111111");
        assert.equal(span.links[0]?.context.spanId, "aaaaaaaaaaaaaaaa");
        assert.equal(span.status.code, SpanStatusCode.UNSET);
        assert.equal(span.attributes[ATTR_MCP_PROTOCOL_VERSION], "2026-07-28");
        const rootSpan = spans.find(({ name }) => name === "ping")!;
        assert.equal(rootSpan.parentSpanContext, undefined);
        assert.equal(rootSpan.links.length, 1);
        assert.equal(rootSpan.links[0]?.context.spanId, "aaaaaaaaaaaaaaaa");
    } finally {
        await telemetry.close();
        await provider.shutdown();
    }
});

test("a live operation exposes W3C context and exports every OTel signal", async () => {
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
        const traceparent = operation.propagation?.traceparent;
        assert(traceparent);
        assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u);
        const [, traceId, spanId] = traceparent.split("-");
        assert.equal(traceId, operation.correlation.traceId);
        assert.equal(spanId, operation.correlation.spanId);
        assert.equal(currentMcpPropagation(), undefined);
        assert.equal(
            runWithMcpPropagation(
                operation.propagation,
                () => currentMcpPropagation()?.traceparent,
            ),
            traceparent,
        );
        const serverOperation = telemetry.startOperation({
            role: "server",
            method: "tools/call",
            toolName: "probe",
            transport: "inproc",
            remotePropagation: operation.propagation,
            startTimeMs: 1_005,
        });
        assert.equal(serverOperation.correlation?.traceId, operation.correlation.traceId);
        assert.notEqual(serverOperation.correlation?.spanId, operation.correlation.spanId);
        serverOperation.end({ endTimeMs: 1_020 });
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
    assert(receivedPaths.includes("/v1/logs"));
});

function assertSingle<T>(values: readonly T[]): T {
    assert.equal(values.length, 1);
    return values[0]!;
}
