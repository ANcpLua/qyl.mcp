import { SpanKind, type Attributes } from "@opentelemetry/api";
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
    ATTR_MCP_SESSION_ID,
    ATTR_RPC_RESPONSE_STATUS_CODE,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    METRIC_MCP_CLIENT_OPERATION_DURATION,
    METRIC_MCP_CLIENT_SESSION_DURATION,
    METRIC_MCP_SERVER_OPERATION_DURATION,
    METRIC_MCP_SERVER_SESSION_DURATION,
} from "@opentelemetry/semantic-conventions/incubating";
import { SecretRedactor } from "./secret-redactor.js";

const ATTRIBUTE_VALUE_LIMIT = 2_000;
const JSONRPC_DEFAULT_VERSION = "2.0";

export const MCP_WELL_KNOWN_METHODS = [
    "initialize",
    "notifications/initialized",
    "ping",
    "notifications/cancelled",
    "notifications/progress",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "notifications/resources/list_changed",
    "notifications/resources/updated",
    "prompts/list",
    "prompts/get",
    "notifications/prompts/list_changed",
    "tools/list",
    "tools/call",
    "notifications/tools/list_changed",
    "roots/list",
    "notifications/roots/list_changed",
    "logging/setLevel",
    "notifications/message",
    "sampling/createMessage",
    "completion/complete",
    "elicitation/create",
] as const;

export type McpTelemetryRole = "client" | "server";
export type McpTelemetryTransport =
    | "stdio"
    | "http"
    | "streamable_http"
    | "streamable-http"
    | "sse"
    | "inproc"
    | "builtin";

/** Propagation-only MCP metadata. Values are never emitted as attributes. */
export type McpPropagationCarrier = Readonly<Record<string, string>>;

interface McpNetworkInput {
    role: McpTelemetryRole;
    transport: McpTelemetryTransport;
    networkProtocolName?: string;
    networkProtocolVersion?: string;
    /** Remote server for client signals; remote client for server spans. */
    peerAddress?: string;
    peerPort?: number;
}

interface McpProtocolInput extends McpNetworkInput {
    protocolVersion?: string;
    jsonRpcProtocolVersion?: string;
    errorType?: string;
    rpcResponseStatusCode?: string;
}

export interface McpOperationInput extends McpProtocolInput {
    method: string;
    toolName?: string;
    promptName?: string;
    resourceUri?: string;
    /** `mcp.resource.uri` is opt-in on operation metrics. */
    recordResourceUriOnMetric?: boolean;
    mcpSessionId?: string;
    jsonRpcRequestId?: string | number;
    serverId?: string;
    executionId?: string;
    evaluationRunId?: string;
    testCaseId?: string;
    startTimeMs: number;
    endTimeMs: number;
    /** Remote propagation extracted from MCP params._meta; never emitted as attributes. */
    remotePropagation?: McpPropagationCarrier;
}

export interface McpSessionInput extends McpProtocolInput {
    startTimeMs: number;
    endTimeMs: number;
}

export interface McpSpanDescriptor {
    name: string;
    kind: SpanKind.CLIENT | SpanKind.SERVER;
    attributes: Attributes;
}

export interface McpMetricDescriptor {
    name: string;
    unit: "s";
    value: number;
    attributes: Attributes;
}

export const WorkbenchTelemetryAttributes = {
    executionId: "qyl.mcp.execution.id",
    evaluationRunId: "qyl.mcp.evaluation_run.id",
    testCaseId: "qyl.mcp.test_case.id",
    serverId: "qyl.mcp.server.id",
} as const;

/** Build only attributes defined for the pinned `mcp.client`/`mcp.server` span. */
export function describeMcpOperationSpan(
    input: McpOperationInput,
    redactor: SecretRedactor = new SecretRedactor(),
): McpSpanDescriptor {
    validateTiming(input.startTimeMs, input.endTimeMs);
    const safe = safeText(redactor);
    const method = requireText(input.method, "method", safe);
    const attributes: Attributes = { [ATTR_MCP_METHOD_NAME]: method };

    addOperationCommon(attributes, input, safe, true);
    if (input.mcpSessionId) attributes[ATTR_MCP_SESSION_ID] = safe(input.mcpSessionId);
    if (input.jsonRpcRequestId !== undefined) {
        attributes[ATTR_JSONRPC_REQUEST_ID] = safe(String(input.jsonRpcRequestId));
    }
    if (input.resourceUri && resourceMethodHasUri(input.method)) {
        attributes[ATTR_MCP_RESOURCE_URI] = bounded(redactor.redactUri(input.resourceUri));
    }
    addPeerAttributes(attributes, input, safe, true);
    addWorkbenchSpanAttributes(attributes, input, safe);

    const target = input.method === "tools/call"
        ? input.toolName
        : input.method === "prompts/get" ? input.promptName : undefined;
    return {
        name: target ? `${method} ${safe(target)}` : method,
        kind: input.role === "client" ? SpanKind.CLIENT : SpanKind.SERVER,
        attributes,
    };
}

/** Build only attributes defined for the pinned operation-duration histogram. */
export function describeMcpOperationMetric(
    input: McpOperationInput,
    redactor: SecretRedactor = new SecretRedactor(),
): McpMetricDescriptor {
    validateTiming(input.startTimeMs, input.endTimeMs);
    const safe = safeText(redactor);
    const attributes: Attributes = {
        [ATTR_MCP_METHOD_NAME]: requireText(input.method, "method", safe),
    };
    addOperationCommon(attributes, input, safe, false);
    if (input.recordResourceUriOnMetric && input.resourceUri && resourceMethodHasUri(input.method)) {
        attributes[ATTR_MCP_RESOURCE_URI] = bounded(redactor.redactUri(input.resourceUri));
    }
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

/** Build only attributes defined for the pinned session-duration histogram. */
export function describeMcpSessionMetric(
    input: McpSessionInput,
    redactor: SecretRedactor = new SecretRedactor(),
): McpMetricDescriptor {
    validateTiming(input.startTimeMs, input.endTimeMs);
    const safe = safeText(redactor);
    const attributes: Attributes = {};
    // rpc.response.status_code is defined for MCP operations, not sessions.
    addProtocolAndNetwork(attributes, input, safe, false);
    addPeerAttributes(attributes, input, safe, false);
    return {
        name: input.role === "client"
            ? METRIC_MCP_CLIENT_SESSION_DURATION
            : METRIC_MCP_SERVER_SESSION_DURATION,
        unit: "s",
        value: durationSeconds(input.startTimeMs, input.endTimeMs),
        attributes,
    };
}

function addOperationCommon(
    attributes: Attributes,
    input: McpOperationInput,
    safe: (value: string) => string,
    span: boolean,
): void {
    addProtocolAndNetwork(attributes, input, safe);
    if (input.method === "tools/call") {
        attributes[ATTR_GEN_AI_OPERATION_NAME] = GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL;
    }
    if (input.method === "tools/call" && input.toolName) {
        attributes[ATTR_GEN_AI_TOOL_NAME] = safe(input.toolName);
    }
    if (input.method === "prompts/get" && input.promptName) {
        attributes[ATTR_GEN_AI_PROMPT_NAME] = safe(input.promptName);
    }
    // Arguments/results/prompt variables are deliberately not captured: those
    // registry attributes are opt-in and may contain credentials or user data.
    if (!span) return;
}

function addProtocolAndNetwork(
    attributes: Attributes,
    input: McpProtocolInput,
    safe: (value: string) => string,
    includeRpcResponseStatusCode = true,
): void {
    if (input.errorType) attributes[ATTR_ERROR_TYPE] = safe(input.errorType);
    if (input.protocolVersion) attributes[ATTR_MCP_PROTOCOL_VERSION] = safe(input.protocolVersion);
    if (input.jsonRpcProtocolVersion && input.jsonRpcProtocolVersion !== JSONRPC_DEFAULT_VERSION) {
        attributes[ATTR_JSONRPC_PROTOCOL_VERSION] = safe(input.jsonRpcProtocolVersion);
    }
    if (includeRpcResponseStatusCode && input.rpcResponseStatusCode) {
        attributes[ATTR_RPC_RESPONSE_STATUS_CODE] = safe(input.rpcResponseStatusCode);
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
    span: boolean,
): void {
    if (input.role === "client") {
        if (input.peerAddress) attributes[ATTR_SERVER_ADDRESS] = safe(input.peerAddress);
        if (input.peerAddress && input.peerPort !== undefined) attributes[ATTR_SERVER_PORT] = input.peerPort;
        return;
    }
    // Server metrics do not define client.address/client.port; server spans do.
    if (span && input.peerAddress) attributes[ATTR_CLIENT_ADDRESS] = safe(input.peerAddress);
    if (span && input.peerAddress && input.peerPort !== undefined) attributes[ATTR_CLIENT_PORT] = input.peerPort;
}

function addWorkbenchSpanAttributes(
    attributes: Attributes,
    input: McpOperationInput,
    safe: (value: string) => string,
): void {
    if (input.serverId) attributes[WorkbenchTelemetryAttributes.serverId] = safe(input.serverId);
    if (input.executionId) attributes[WorkbenchTelemetryAttributes.executionId] = safe(input.executionId);
    if (input.evaluationRunId) {
        attributes[WorkbenchTelemetryAttributes.evaluationRunId] = safe(input.evaluationRunId);
    }
    if (input.testCaseId) attributes[WorkbenchTelemetryAttributes.testCaseId] = safe(input.testCaseId);
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

function validateTiming(startTimeMs: number, endTimeMs: number): void {
    if (!Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs) || endTimeMs < startTimeMs) {
        throw new Error("MCP telemetry timestamps must be finite and ordered.");
    }
}

function durationSeconds(startTimeMs: number, endTimeMs: number): number {
    return (endTimeMs - startTimeMs) / 1_000;
}
