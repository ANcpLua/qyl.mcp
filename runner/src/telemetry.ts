/** MCP passthrough self-telemetry exported through the official OTel SDK. */

import {
    SpanKind,
    SpanStatusCode,
    type Attributes,
    type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_TRANSPORT,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
    NETWORK_TRANSPORT_VALUE_PIPE,
    NETWORK_TRANSPORT_VALUE_TCP,
} from "@opentelemetry/semantic-conventions";
import {
    ATTR_GEN_AI_TOOL_NAME,
    ATTR_MCP_METHOD_NAME,
    ATTR_MCP_RESOURCE_URI,
    ATTR_SERVICE_PEER_NAME,
    ATTR_SESSION_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import { randomUUID } from "node:crypto";
import { Constants } from "./constants.js";

const { Product } = Constants;

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE = 512;
const EXPORT_TIMEOUT_MS = 3_000;
const ATTRIBUTE_VALUE_LIMIT = 2_000;
const INSTRUMENTATION_SCOPE = "qyl.mcp/passthrough";
const API_KEY_HEADER = qylOpenApi.components.securitySchemes.ApiKeyAuth.name;
if (typeof API_KEY_HEADER !== "string" || API_KEY_HEADER.length === 0) {
    throw new Error("published Qyl OpenAPI has no API-key header name");
}

export interface McpCallSpanInput {
    /** MCP request method, e.g. "tools/call", "tools/list", "resources/read". */
    method: string;
    /** Logical name of the managed MCP server. */
    serverName: string;
    /** Tool name for tools/call. */
    toolName?: string;
    /** Resource URI for resources/read. */
    resourceUri?: string;
    /** Transport of the managed server. */
    transport: "stdio" | "http" | "inproc";
    startTimeMs: number;
    endTimeMs: number;
    failed?: boolean;
}

function tracesEndpoint(env: NodeJS.ProcessEnv): string {
    const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (tracesUrl) return tracesUrl;

    const base = (
        env.QYL_OTLP_ENDPOINT ??
        env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        "http://127.0.0.1:4318"
    ).replace(/\/+$/, "");
    return `${base}/v1/traces`;
}

function bounded(value: string): string {
    return value.length <= ATTRIBUTE_VALUE_LIMIT
        ? value
        : `${value.slice(0, ATTRIBUTE_VALUE_LIMIT - 1)}…`;
}

/** Remove credentials, query values, and fragments before recording a URI. */
function safeResourceUri(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return bounded(url.toString());
    } catch {
        return bounded(value.split(/[?#]/, 1)[0]);
    }
}

function networkTransport(
    transport: McpCallSpanInput["transport"],
): string | undefined {
    if (transport === "stdio") return NETWORK_TRANSPORT_VALUE_PIPE;
    if (transport === "http") return NETWORK_TRANSPORT_VALUE_TCP;
    return undefined;
}

/**
 * Records completed MCP calls without installing a global tracer provider.
 * Arguments, results, error messages, and resource URI query values are never
 * recorded, even when a caller passes them accidentally.
 */
export class McpTelemetry {
    private readonly provider?: NodeTracerProvider;
    private readonly tracer?: Tracer;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        if (env.QYL_MCP_TELEMETRY === "0") return;

        const exporter = new OTLPTraceExporter({
            url: tracesEndpoint(env),
            timeoutMillis: EXPORT_TIMEOUT_MS,
            headers: env.QYL_API_KEY?.trim()
                ? { [API_KEY_HEADER]: env.QYL_API_KEY.trim() }
                : undefined,
        });
        const processor = new BatchSpanProcessor(exporter, {
            maxQueueSize: MAX_QUEUE,
            maxExportBatchSize: MAX_QUEUE,
            scheduledDelayMillis: FLUSH_INTERVAL_MS,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        });
        this.provider = new NodeTracerProvider({
            resource: resourceFromAttributes({
                [ATTR_SERVICE_NAME]: Product.name,
                [ATTR_SERVICE_VERSION]: Product.version,
                [ATTR_SESSION_ID]: randomUUID(),
            }),
            spanProcessors: [processor],
            spanLimits: {
                attributeValueLengthLimit: ATTRIBUTE_VALUE_LIMIT,
                attributeCountLimit: 32,
                eventCountLimit: 0,
                linkCountLimit: 0,
            },
        });
        this.tracer = this.provider.getTracer(INSTRUMENTATION_SCOPE, Product.version);
    }

    /** Record one completed passthrough call as a client span. Never throws. */
    recordCall(input: McpCallSpanInput): void {
        if (!this.tracer) return;
        try {
            const attributes: Attributes = {
                [ATTR_MCP_METHOD_NAME]: bounded(input.method),
                [ATTR_SERVICE_PEER_NAME]: bounded(input.serverName),
            };
            const transport = networkTransport(input.transport);
            if (transport) attributes[ATTR_NETWORK_TRANSPORT] = transport;
            if (input.toolName) {
                attributes[ATTR_GEN_AI_TOOL_NAME] = bounded(input.toolName);
            }
            if (input.resourceUri) {
                attributes[ATTR_MCP_RESOURCE_URI] = safeResourceUri(input.resourceUri);
            }
            if (input.failed) attributes[ATTR_ERROR_TYPE] = "mcp_error";

            const spanName = input.toolName
                ? `${input.method} ${bounded(input.toolName)}`
                : input.method;
            const span = this.tracer.startSpan(spanName, {
                kind: SpanKind.CLIENT,
                attributes,
                startTime: input.startTimeMs,
            });
            span.setStatus({
                code: input.failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            });
            span.end(input.endTimeMs);
        } catch {
            // Self-telemetry must never change the passthrough response.
        }
    }

    /** Flush and stop the SDK during runner shutdown. */
    async close(): Promise<void> {
        await this.provider?.shutdown();
    }
}
