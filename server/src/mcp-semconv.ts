import { SpanKind, type Attributes } from "@opentelemetry/api";
import {
    SeverityNumber,
    type LogAttributes,
    type LogBody,
} from "@opentelemetry/api-logs";
import {
    ATTR_CLIENT_ADDRESS,
    ATTR_CLIENT_PORT,
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_PROTOCOL_NAME,
    ATTR_NETWORK_PROTOCOL_VERSION,
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
import { SecretRedactor } from "./secret-redactor.js";

const ATTRIBUTE_VALUE_LIMIT = 2_000;
const LOG_BODY_CHARACTER_LIMIT = 64_000;
const JSONRPC_DEFAULT_VERSION = "2.0";

export const EVENT_QYL_MCP_OPERATION = "qyl.mcp.operation";

export type McpTelemetryRole = "client" | "server";
export type McpTelemetryTransport =
    | "stdio"
    | "http"
    | "streamable_http"
    | "streamable-http"
    | "sse"
    | "inproc"
    | "builtin";

export type McpPropagationCarrier = Readonly<Record<string, string>>;

interface McpNetworkInput {
    role: McpTelemetryRole;
    transport: McpTelemetryTransport;
    networkProtocolName?: string;
    networkProtocolVersion?: string;
    peerAddress?: string;
    peerPort?: number;
}

interface McpProtocolInput extends McpNetworkInput {
    protocolVersion?: string;
    jsonRpcProtocolVersion?: string;
    errorType?: string;
    errorMessage?: string;
    rpcResponseStatusCode?: string;
}

export interface McpOperationInput extends McpProtocolInput {
    method: string;
    toolName?: string;
    promptName?: string;
    resourceUri?: string;
    jsonRpcRequestId?: string | number;
    serverId?: string;
    executionId?: string;
    evaluationRunId?: string;
    testCaseId?: string;
    requestBody?: unknown;
    responseBody?: unknown;
    startTimeMs: number;
    endTimeMs: number;
    remotePropagation?: McpPropagationCarrier;
}

export interface McpSpanDescriptor {
    name: string;
    kind: SpanKind.CLIENT | SpanKind.SERVER;
    attributes: Attributes;
}

export interface McpMetricDescriptor {
    name:
        | typeof METRIC_MCP_CLIENT_OPERATION_DURATION
        | typeof METRIC_MCP_SERVER_OPERATION_DURATION;
    unit: "s";
    value: number;
    attributes: Attributes;
}

export interface McpLogDescriptor {
    eventName: typeof EVENT_QYL_MCP_OPERATION;
    severityNumber: SeverityNumber.INFO | SeverityNumber.ERROR;
    severityText: "INFO" | "ERROR";
    body: LogBody;
    attributes: LogAttributes;
}

export const WorkbenchTelemetryAttributes = {
    executionId: "qyl.mcp.execution.id",
    evaluationRunId: "qyl.mcp.evaluation_run.id",
    testCaseId: "qyl.mcp.test_case.id",
    serverId: "qyl.mcp.server.id",
} as const;

export function describeMcpOperationSpan(
    input: McpOperationInput,
    redactor: SecretRedactor = new SecretRedactor(),
): McpSpanDescriptor {
    validateTiming(input.startTimeMs, input.endTimeMs);
    const safe = safeText(redactor);
    const method = requireText(input.method, "method", safe);
    const attributes: Attributes = { [ATTR_MCP_METHOD_NAME]: method };

    addOperationAttributes(attributes, input, safe);
    if (input.jsonRpcRequestId !== undefined) {
        attributes[ATTR_JSONRPC_REQUEST_ID] = safe(String(input.jsonRpcRequestId));
    }
    if (input.resourceUri && resourceMethodHasUri(input.method)) {
        attributes[ATTR_MCP_RESOURCE_URI] = bounded(redactor.redactUri(input.resourceUri));
    }
    addPeerAttributes(attributes, input, safe, true);
    addWorkbenchAttributes(attributes, input, safe);

    const target = input.method === "tools/call"
        ? input.toolName
        : input.method === "prompts/get" ? input.promptName : undefined;
    return {
        name: target ? `${method} ${safe(target)}` : method,
        kind: input.role === "client" ? SpanKind.CLIENT : SpanKind.SERVER,
        attributes,
    };
}

export function describeMcpOperationMetric(
    input: McpOperationInput,
    redactor: SecretRedactor = new SecretRedactor(),
): McpMetricDescriptor {
    validateTiming(input.startTimeMs, input.endTimeMs);
    const safe = safeText(redactor);
    const attributes: Attributes = {
        [ATTR_MCP_METHOD_NAME]: requireText(input.method, "method", safe),
    };
    addOperationAttributes(attributes, input, safe);
    addPeerAttributes(attributes, input, safe, false);
    return {
        name: input.role === "client"
            ? METRIC_MCP_CLIENT_OPERATION_DURATION
            : METRIC_MCP_SERVER_OPERATION_DURATION,
        unit: "s",
        value: durationSeconds(input.startTimeMs, input.endTimeMs),
        attributes,
    };
}

export function describeMcpOperationLog(
    input: McpOperationInput,
    redactor: SecretRedactor = new SecretRedactor(),
    captureContent = false,
): McpLogDescriptor {
    validateTiming(input.startTimeMs, input.endTimeMs);
    const safe = safeText(redactor);
    const attributes: Attributes = {
        [ATTR_MCP_METHOD_NAME]: requireText(input.method, "method", safe),
    };
    addOperationAttributes(attributes, input, safe);
    if (input.jsonRpcRequestId !== undefined) {
        attributes[ATTR_JSONRPC_REQUEST_ID] = safe(String(input.jsonRpcRequestId));
    }
    if (input.resourceUri && resourceMethodHasUri(input.method)) {
        attributes[ATTR_MCP_RESOURCE_URI] = bounded(redactor.redactUri(input.resourceUri));
    }
    addPeerAttributes(attributes, input, safe, true);
    addWorkbenchAttributes(attributes, input, safe);

    const failed = input.errorType !== undefined;
    const body = {
        message: "MCP operation completed.",
        role: input.role,
        duration_ms: input.endTimeMs - input.startTimeMs,
        ...(captureContent && input.requestBody !== undefined
            ? { request: input.requestBody }
            : {}),
        ...(captureContent && input.responseBody !== undefined
            ? { response: input.responseBody }
            : {}),
        ...(failed
            ? {
                error: {
                    type: input.errorType,
                    ...(input.rpcResponseStatusCode === undefined
                        ? {}
                        : { code: input.rpcResponseStatusCode }),
                    ...(!captureContent || input.errorMessage === undefined
                        ? {}
                        : { message: input.errorMessage }),
                },
            }
            : {}),
    };
    return {
        eventName: EVENT_QYL_MCP_OPERATION,
        severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
        severityText: failed ? "ERROR" : "INFO",
        body: boundedLogBody(body, redactor),
        attributes: attributes as LogAttributes,
    };
}

function addOperationAttributes(
    attributes: Attributes,
    input: McpOperationInput,
    safe: (value: string) => string,
): void {
    if (input.errorType) attributes[ATTR_ERROR_TYPE] = safe(input.errorType);
    if (input.protocolVersion) {
        attributes[ATTR_MCP_PROTOCOL_VERSION] = safe(input.protocolVersion);
    }
    if (input.jsonRpcProtocolVersion
        && input.jsonRpcProtocolVersion !== JSONRPC_DEFAULT_VERSION) {
        attributes[ATTR_JSONRPC_PROTOCOL_VERSION] = safe(input.jsonRpcProtocolVersion);
    }
    if (input.rpcResponseStatusCode) {
        attributes[ATTR_RPC_RESPONSE_STATUS_CODE] = safe(input.rpcResponseStatusCode);
    }
    if (input.method === "tools/call") {
        attributes[ATTR_GEN_AI_OPERATION_NAME] = GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL;
    }
    if (input.method === "tools/call" && input.toolName) {
        attributes[ATTR_GEN_AI_TOOL_NAME] = safe(input.toolName);
    }
    if (input.method === "prompts/get" && input.promptName) {
        attributes[ATTR_GEN_AI_PROMPT_NAME] = safe(input.promptName);
    }
    const transport = networkTransport(input.transport);
    if (transport) attributes[ATTR_NETWORK_TRANSPORT] = transport;
    const protocolName = input.networkProtocolName ?? inferredNetworkProtocol(input.transport);
    if (protocolName) attributes[ATTR_NETWORK_PROTOCOL_NAME] = safe(protocolName);
    if (input.networkProtocolVersion) {
        attributes[ATTR_NETWORK_PROTOCOL_VERSION] = safe(input.networkProtocolVersion);
    }
}

function addPeerAttributes(
    attributes: Attributes,
    input: McpNetworkInput,
    safe: (value: string) => string,
    spanOrLog: boolean,
): void {
    if (input.role === "client") {
        if (input.peerAddress) attributes[ATTR_SERVER_ADDRESS] = safe(input.peerAddress);
        if (input.peerAddress && input.peerPort !== undefined) {
            attributes[ATTR_SERVER_PORT] = input.peerPort;
        }
        return;
    }
    if (spanOrLog && input.peerAddress) {
        attributes[ATTR_CLIENT_ADDRESS] = safe(input.peerAddress);
    }
    if (spanOrLog && input.peerAddress && input.peerPort !== undefined) {
        attributes[ATTR_CLIENT_PORT] = input.peerPort;
    }
}

function addWorkbenchAttributes(
    attributes: Attributes,
    input: McpOperationInput,
    safe: (value: string) => string,
): void {
    if (input.serverId) attributes[WorkbenchTelemetryAttributes.serverId] = safe(input.serverId);
    if (input.executionId) {
        attributes[WorkbenchTelemetryAttributes.executionId] = safe(input.executionId);
    }
    if (input.evaluationRunId) {
        attributes[WorkbenchTelemetryAttributes.evaluationRunId] = safe(input.evaluationRunId);
    }
    if (input.testCaseId) {
        attributes[WorkbenchTelemetryAttributes.testCaseId] = safe(input.testCaseId);
    }
}

function resourceMethodHasUri(method: string): boolean {
    return method === "resources/read"
        || method === "resources/subscribe"
        || method === "resources/unsubscribe"
        || method === "notifications/resources/updated";
}

function networkTransport(transport: McpTelemetryTransport): string | undefined {
    if (transport === "stdio") return NETWORK_TRANSPORT_VALUE_PIPE;
    if (transport === "http" || transport === "streamable_http"
        || transport === "streamable-http" || transport === "sse") {
        return NETWORK_TRANSPORT_VALUE_TCP;
    }
    return undefined;
}

function inferredNetworkProtocol(transport: McpTelemetryTransport): string | undefined {
    return transport === "http" || transport === "streamable_http"
        || transport === "streamable-http" || transport === "sse"
        ? "http"
        : undefined;
}

function safeText(redactor: SecretRedactor): (value: string) => string {
    return (value) => bounded(redactor.redactText(value));
}

function requireText(value: string, name: string, safe: (value: string) => string): string {
    if (value.trim().length === 0) throw new Error(`${name} must not be empty.`);
    return safe(value);
}

function bounded(value: string): string {
    return value.length <= ATTRIBUTE_VALUE_LIMIT
        ? value
        : `${value.slice(0, ATTRIBUTE_VALUE_LIMIT - 1)}…`;
}

function boundedLogBody(value: unknown, redactor: SecretRedactor): LogBody {
    const redacted = redactor.redact(value);
    const serialized = JSON.stringify(redacted);
    if (serialized === undefined) return String(redacted);
    if (serialized.length <= LOG_BODY_CHARACTER_LIMIT) {
        return JSON.parse(serialized) as LogBody;
    }
    return {
        truncated: true,
        original_characters: serialized.length,
        preview: `${serialized.slice(0, LOG_BODY_CHARACTER_LIMIT - 1)}…`,
    };
}

function validateTiming(startTimeMs: number, endTimeMs: number): void {
    if (!Number.isFinite(startTimeMs)
        || !Number.isFinite(endTimeMs)
        || endTimeMs < startTimeMs) {
        throw new Error("MCP telemetry timestamps must be finite and ordered.");
    }
}

function durationSeconds(startTimeMs: number, endTimeMs: number): number {
    return (endTimeMs - startTimeMs) / 1_000;
}
