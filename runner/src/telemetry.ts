/** MCP self-telemetry exported through the official OpenTelemetry SDK. */

import {
    context,
    defaultTextMapGetter,
    defaultTextMapSetter,
    isSpanContextValid,
    propagation,
    ROOT_CONTEXT,
    SpanStatusCode,
    trace,
    type Context,
    type Histogram,
    type Link,
    type Span,
    type Tracer,
} from "@opentelemetry/api";
import {
    CompositePropagator,
    W3CBaggagePropagator,
    W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    MeterProvider,
    PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
    ATTR_SERVICE_INSTANCE_ID,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
    METRIC_MCP_CLIENT_OPERATION_DURATION,
    METRIC_MCP_CLIENT_SESSION_DURATION,
    METRIC_MCP_SERVER_OPERATION_DURATION,
    METRIC_MCP_SERVER_SESSION_DURATION,
} from "@opentelemetry/semantic-conventions/incubating";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Constants } from "./constants.js";
import {
    describeMcpOperationMetric,
    describeMcpOperationSpan,
    describeMcpSessionMetric,
    type McpPropagationCarrier,
    type McpOperationInput,
    type McpSessionInput,
} from "./mcp-semconv.js";
import { isObservabilitySelfExportSuppressed } from "./observability-suppression.js";
import { SecretRedactor } from "./secret-redactor.js";

export {
    WorkbenchTelemetryAttributes,
    describeMcpOperationMetric,
    describeMcpOperationSpan,
    describeMcpSessionMetric,
    type McpOperationInput,
    type McpPropagationCarrier,
    type McpSessionInput,
} from "./mcp-semconv.js";

const { Product } = Constants;

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE = 512;
const EXPORT_TIMEOUT_MS = 3_000;
const ATTRIBUTE_VALUE_LIMIT = 2_000;
const MAX_PROPAGATION_FIELDS = 32;
const MAX_PROPAGATION_KEY_CHARACTERS = 256;
const MAX_PROPAGATION_VALUE_CHARACTERS = 8_192;
const INSTRUMENTATION_SCOPE = "qyl.mcp/workbench";
const STANDARD_MCP_PROPAGATOR = new CompositePropagator({
    propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
    ],
});
export const MCP_DURATION_EXPLICIT_BUCKET_BOUNDARIES = [
    0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
] as const;
const API_KEY_HEADER = qylOpenApi.components.securitySchemes.ApiKeyAuth.name;
if (typeof API_KEY_HEADER !== "string" || API_KEY_HEADER.length === 0) {
    throw new Error("published Qyl OpenAPI has no API-key header name");
}

export interface McpSpanCorrelation {
    traceId: string;
    spanId: string;
}

export type McpOperationStartInput = Omit<
    McpOperationInput,
    "endTimeMs" | "errorType" | "rpcResponseStatusCode" | "jsonRpcRequestId"
>;

export interface McpOperationCompletion {
    endTimeMs: number;
    errorType?: string;
    rpcResponseStatusCode?: string;
    jsonRpcRequestId?: string | number;
    protocolVersion?: string;
    mcpSessionId?: string;
}

export interface ActiveMcpOperation {
    readonly correlation?: McpSpanCorrelation;
    readonly propagation?: McpPropagationCarrier;
    /** Compatibility view of the standard W3C field in `propagation`. */
    readonly traceparent?: string;
    run<T>(operation: () => T): T;
    end(completion: McpOperationCompletion): McpSpanCorrelation | undefined;
}

export interface McpTelemetryOptions {
    /** Test/embedding seam; production creates its isolated OTLP tracer. */
    tracer?: Tracer;
}

const activeMcpContext = new AsyncLocalStorage<Context | null>();

/**
 * Carries one explicitly-created MCP operation through SDK dispatch without
 * installing a global OpenTelemetry provider or context manager. A null store
 * deliberately clears any outer operation so unrelated requests cannot inherit
 * stale propagation state.
 */
export function runWithMcpPropagation<T>(
    carrier: McpPropagationCarrier | undefined,
    operation: () => T,
): T {
    if (carrier === undefined) return activeMcpContext.run(null, operation);
    const extracted = extractPropagation(context.active(), carrier);
    return activeMcpContext.run(extracted, () => context.with(extracted, operation));
}

/** Compatibility wrapper for callers that only have a W3C traceparent. */
export function runWithMcpTraceparent<T>(
    traceparent: string | undefined,
    operation: () => T,
): T {
    return runWithMcpPropagation(
        traceparent === undefined ? undefined : { traceparent },
        operation,
    );
}

/** Current execution-local propagation carrier, if an MCP operation exists. */
export function currentMcpPropagation(): McpPropagationCarrier | undefined {
    const active = activeMcpContext.getStore();
    return active === null || active === undefined ? undefined : injectPropagation(active);
}

/** Current execution-local W3C trace parent, if a client operation span exists. */
export function currentMcpTraceparent(): string | undefined {
    return currentMcpPropagation()?.traceparent;
}

export function signalEndpoint(
    env: Readonly<Record<string, string | undefined>>,
    signal: "traces" | "metrics",
): string {
    const explicit = signal === "traces"
        ? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        : env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    if (explicit) return explicit;

    const base = (
        env.QYL_OTLP_ENDPOINT
        ?? env.QYL_COLLECTOR_URL
        ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
        ?? "http://127.0.0.1:4318"
    ).replace(/\/+$/, "");
    return `${base}/v1/${signal}`;
}

/**
 * Records completed MCP operations and sessions without installing global SDK
 * providers. Signal-specific descriptors prevent span-only identifiers from
 * appearing on duration histograms.
 */
export class McpTelemetry {
    private readonly traceProvider?: NodeTracerProvider;
    private readonly metricProvider?: MeterProvider;
    private tracer?: Tracer;
    private readonly histograms = new Map<string, Histogram>();
    private readonly redactor: SecretRedactor;

    get operationTracingEnabled(): boolean {
        return this.tracer !== undefined;
    }

    constructor(
        env: Readonly<Record<string, string | undefined>> = process.env,
        redactor: SecretRedactor = new SecretRedactor({ environment: env }),
        options: McpTelemetryOptions = {},
    ) {
        this.redactor = redactor;
        this.tracer = options.tracer;
        if (env.QYL_MCP_TELEMETRY === "0") return;

        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: Product.name,
            [ATTR_SERVICE_VERSION]: Product.version,
            [ATTR_SERVICE_INSTANCE_ID]: randomUUID(),
        });
        const headers = env.QYL_API_KEY?.trim()
            ? { [API_KEY_HEADER]: env.QYL_API_KEY.trim() }
            : undefined;

        const traceExporter = new OTLPTraceExporter({
            url: signalEndpoint(env, "traces"),
            timeoutMillis: EXPORT_TIMEOUT_MS,
            headers,
        });
        const processor = new BatchSpanProcessor(traceExporter, {
            maxQueueSize: MAX_QUEUE,
            maxExportBatchSize: MAX_QUEUE,
            scheduledDelayMillis: FLUSH_INTERVAL_MS,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        });
        this.traceProvider = new NodeTracerProvider({
            resource,
            spanProcessors: [processor],
            spanLimits: {
                attributeValueLengthLimit: ATTRIBUTE_VALUE_LIMIT,
                attributeCountLimit: 32,
                eventCountLimit: 0,
                linkCountLimit: 1,
            },
        });
        this.tracer ??= this.traceProvider.getTracer(INSTRUMENTATION_SCOPE, Product.version);

        const metricExporter = new OTLPMetricExporter({
            url: signalEndpoint(env, "metrics"),
            timeoutMillis: EXPORT_TIMEOUT_MS,
            headers,
        });
        this.metricProvider = new MeterProvider({
            resource,
            readers: [new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: FLUSH_INTERVAL_MS,
                exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            })],
        });
        const meter = this.metricProvider.getMeter(INSTRUMENTATION_SCOPE, Product.version);
        for (const name of [
            METRIC_MCP_CLIENT_OPERATION_DURATION,
            METRIC_MCP_CLIENT_SESSION_DURATION,
            METRIC_MCP_SERVER_OPERATION_DURATION,
            METRIC_MCP_SERVER_SESSION_DURATION,
        ]) {
            this.histograms.set(name, meter.createHistogram(name, {
                unit: "s",
                advice: {
                    explicitBucketBoundaries: [...MCP_DURATION_EXPLICIT_BUCKET_BOUNDARIES],
                },
            }));
        }
    }

    /**
     * Start an MCP operation before the SDK call so its trace context can be
     * propagated. Completion-only attributes are applied immediately before
     * ending the span, and the metric is recorded exactly once at completion.
     */
    startOperation(input: McpOperationStartInput): ActiveMcpOperation {
        if (isObservabilitySelfExportSuppressed()) return inactiveOperation();

        const ambientContext = activeMcpContext.getStore() ?? context.active();
        const baseParentContext = input.role === "server" ? ROOT_CONTEXT : ambientContext;
        const parentContext = input.remotePropagation === undefined
            ? baseParentContext
            : extractPropagation(baseParentContext, input.remotePropagation);
        const links = operationLinks(
            input.role,
            ambientContext,
            parentContext,
        );
        let span: Span | undefined;
        let operationContext: Context | undefined;
        if (this.tracer) {
            try {
                const descriptor = describeMcpOperationSpan({
                    ...input,
                    endTimeMs: input.startTimeMs,
                }, this.redactor);
                span = this.tracer.startSpan(descriptor.name, {
                    kind: descriptor.kind,
                    attributes: descriptor.attributes,
                    startTime: input.startTimeMs,
                    ...(links === undefined ? {} : { links }),
                }, parentContext);
                operationContext = trace.setSpan(parentContext, span);
            } catch {
                // Self-telemetry must never change the MCP request.
            }
        }

        const identifiers = span?.spanContext();
        const correlation = identifiers !== undefined && isSpanContextValid(identifiers)
            ? { traceId: identifiers.traceId, spanId: identifiers.spanId }
            : undefined;
        const carrier = operationContext === undefined
            ? undefined
            : injectPropagation(operationContext);
        const traceparent = carrier?.traceparent;
        let ended = false;

        return {
            ...(correlation === undefined ? {} : { correlation }),
            ...(carrier === undefined ? {} : { propagation: carrier }),
            ...(traceparent === undefined ? {} : { traceparent }),
            run: (operation) => operationContext === undefined
                ? operation()
                : activeMcpContext.run(
                    operationContext,
                    () => context.with(operationContext, operation),
                ),
            end: (completion) => {
                if (ended) return correlation;
                ended = true;
                const completed: McpOperationInput = { ...input, ...completion };
                let metric: ReturnType<typeof describeMcpOperationMetric> | undefined;
                try {
                    metric = describeMcpOperationMetric(completed, this.redactor);
                } catch {
                    // Self-telemetry must never change the MCP response.
                }

                if (span === undefined) {
                    this.recordOperationMetric(metric);
                    return correlation;
                }

                try {
                    try {
                        const descriptor = describeMcpOperationSpan(completed, this.redactor);
                        span.setAttributes(descriptor.attributes);
                    } catch {
                        // Keep the already-started span valid even if optional completion data is invalid.
                    }
                    if (metric !== undefined) {
                        this.histograms.get(metric.name)?.record(
                            metric.value,
                            metric.attributes,
                            operationContext,
                        );
                        metric = undefined;
                    }
                    if (completed.errorType) {
                        span.setStatus({ code: SpanStatusCode.ERROR });
                    }
                } catch {
                    // Self-telemetry must never change the MCP response.
                } finally {
                    try {
                        span.end(completed.endTimeMs);
                    } catch {
                        // Self-telemetry must never change the MCP response.
                    }
                }
                this.recordOperationMetric(metric);
                return correlation;
            },
        };
    }

    /** Record one already-completed client or server operation. Never throws. */
    recordOperation(input: McpOperationInput): McpSpanCorrelation | undefined {
        const {
            endTimeMs,
            errorType,
            rpcResponseStatusCode,
            jsonRpcRequestId,
            ...start
        } = input;
        return this.startOperation(start).end({
            endTimeMs,
            ...(errorType === undefined ? {} : { errorType }),
            ...(rpcResponseStatusCode === undefined ? {} : { rpcResponseStatusCode }),
            ...(jsonRpcRequestId === undefined ? {} : { jsonRpcRequestId }),
        });
    }

    /** Record one completed client or server session histogram. Never throws. */
    recordSession(input: McpSessionInput): void {
        if (isObservabilitySelfExportSuppressed()) return;
        try {
            const metric = describeMcpSessionMetric(input, this.redactor);
            this.histograms.get(metric.name)?.record(metric.value, metric.attributes);
        } catch {
            // Self-telemetry must never change connection shutdown.
        }
    }

    /** Flush and stop both SDK providers during runner shutdown. */
    async close(): Promise<void> {
        await Promise.all([
            this.traceProvider?.shutdown(),
            this.metricProvider?.shutdown(),
        ]);
    }

    private recordOperationMetric(
        metric: ReturnType<typeof describeMcpOperationMetric> | undefined,
    ): void {
        if (metric === undefined) return;
        try {
            this.histograms.get(metric.name)?.record(metric.value, metric.attributes);
        } catch {
            // Self-telemetry must never change the MCP response.
        }
    }
}

function inactiveOperation(): ActiveMcpOperation {
    return {
        run: (operation) => operation(),
        end: () => undefined,
    };
}

function extractPropagation(
    base: Context,
    carrier: McpPropagationCarrier,
): Context {
    let extracted = STANDARD_MCP_PROPAGATOR.extract(base, carrier, defaultTextMapGetter);
    try {
        extracted = propagation.extract(extracted, carrier, defaultTextMapGetter);
    } catch {
        // A host-configured propagator cannot change MCP behavior.
    }
    return extracted;
}

function injectPropagation(value: Context): McpPropagationCarrier | undefined {
    const staging = Object.create(null) as Record<string, string>;
    STANDARD_MCP_PROPAGATOR.inject(value, staging, defaultTextMapSetter);
    try {
        propagation.inject(value, staging, defaultTextMapSetter);
    } catch {
        // Retain the standard W3C fields when a host propagator fails.
    }
    const bounded = Object.create(null) as Record<string, string>;
    for (const [key, entry] of prioritizedPropagationEntries(staging)) {
        if (key.length === 0
            || key.length > MAX_PROPAGATION_KEY_CHARACTERS
            || typeof entry !== "string"
            || entry.length > MAX_PROPAGATION_VALUE_CHARACTERS) {
            continue;
        }
        bounded[key] = entry;
        if (Object.keys(bounded).length >= MAX_PROPAGATION_FIELDS) break;
    }
    return Object.keys(bounded).length === 0
        ? undefined
        : Object.freeze({ ...bounded });
}

function operationLinks(
    role: McpOperationStartInput["role"],
    ambientContext: Context,
    parentContext: Context,
): Link[] | undefined {
    if (role !== "server") return undefined;
    const ambient = trace.getSpanContext(ambientContext);
    const parent = trace.getSpanContext(parentContext);
    if (ambient === undefined || !isSpanContextValid(ambient)) {
        return undefined;
    }
    if (parent !== undefined
        && isSpanContextValid(parent)
        && ambient.traceId === parent.traceId
        && ambient.spanId === parent.spanId) return undefined;
    return [{ context: ambient }];
}

function prioritizedPropagationEntries(
    value: Readonly<Record<string, unknown>>,
): [string, unknown][] {
    const entries = Object.entries(value);
    const priority = new Set(["traceparent", "tracestate", "baggage"]);
    return [
        ...entries.filter(([key]) => priority.has(key)),
        ...entries.filter(([key]) => !priority.has(key)),
    ];
}
