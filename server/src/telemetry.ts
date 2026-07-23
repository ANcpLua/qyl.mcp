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
import type { Logger } from "@opentelemetry/api-logs";
import {
    CompositePropagator,
    W3CBaggagePropagator,
    W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    BatchLogRecordProcessor,
    LoggerProvider,
} from "@opentelemetry/sdk-logs";
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
    METRIC_MCP_SERVER_OPERATION_DURATION,
} from "@opentelemetry/semantic-conventions/incubating";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import packageMetadata from "../package.json" with { type: "json" };
import {
    describeMcpOperationLog,
    describeMcpOperationMetric,
    describeMcpOperationSpan,
    type McpPropagationCarrier,
    type McpOperationInput,
} from "./mcp-semconv.js";
import { isObservabilitySelfExportSuppressed } from "./observability-suppression.js";
import { SecretRedactor } from "./secret-redactor.js";

export {
    WorkbenchTelemetryAttributes,
    describeMcpOperationLog,
    describeMcpOperationMetric,
    describeMcpOperationSpan,
    type McpOperationInput,
    type McpPropagationCarrier,
} from "./mcp-semconv.js";

const Product = {
    name: "qyl.mcp",
    version: packageMetadata.version,
} as const;

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE = 512;
const EXPORT_TIMEOUT_MS = 3_000;
const ATTRIBUTE_VALUE_LIMIT = 2_000;
const MAX_PROPAGATION_FIELDS = 32;
const MAX_PROPAGATION_KEY_CHARACTERS = 256;
const MAX_PROPAGATION_VALUE_CHARACTERS = 8_192;
const INSTRUMENTATION_SCOPE = "qyl.mcp";
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
    | "endTimeMs"
    | "errorType"
    | "errorMessage"
    | "rpcResponseStatusCode"
    | "jsonRpcRequestId"
    | "responseBody"
>;

export interface McpOperationCompletion {
    endTimeMs: number;
    errorType?: string;
    errorMessage?: string;
    rpcResponseStatusCode?: string;
    jsonRpcRequestId?: string | number;
    protocolVersion?: string;
    responseBody?: unknown;
}

export interface ActiveMcpOperation {
    readonly correlation?: McpSpanCorrelation;
    readonly propagation?: McpPropagationCarrier;
    run<T>(operation: () => T): T;
    end(completion: McpOperationCompletion): McpSpanCorrelation | undefined;
}

export interface McpTelemetryOptions {
    tracer?: Tracer;
    logger?: Logger;
}

const activeMcpContext = new AsyncLocalStorage<Context | null>();

export function runWithMcpPropagation<T>(
    carrier: McpPropagationCarrier | undefined,
    operation: () => T,
): T {
    if (carrier === undefined) return activeMcpContext.run(null, operation);
    const extracted = extractPropagation(context.active(), carrier);
    return activeMcpContext.run(extracted, () => context.with(extracted, operation));
}

export function currentMcpPropagation(): McpPropagationCarrier | undefined {
    const active = activeMcpContext.getStore();
    return active === null || active === undefined ? undefined : injectPropagation(active);
}

export function signalEndpoint(
    env: Readonly<Record<string, string | undefined>>,
    signal: "traces" | "metrics" | "logs",
): string {
    const explicit = signal === "traces"
        ? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        : signal === "metrics"
            ? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
            : env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    if (explicit) return explicit;

    const base = (
        env.QYL_OTLP_ENDPOINT
        ?? env.QYL_COLLECTOR_URL
        ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
        ?? "http://127.0.0.1:4318"
    ).replace(/\/+$/, "");
    return `${base}/v1/${signal}`;
}

export class McpTelemetry {
    private readonly traceProvider?: NodeTracerProvider;
    private readonly metricProvider?: MeterProvider;
    private readonly logProvider?: LoggerProvider;
    private tracer?: Tracer;
    private logger?: Logger;
    private readonly histograms = new Map<string, Histogram>();
    private readonly redactor: SecretRedactor;
    private readonly captureContent: boolean;

    get operationTracingEnabled(): boolean {
        return this.tracer !== undefined;
    }

    constructor(
        env: Readonly<Record<string, string | undefined>> = process.env,
        redactor: SecretRedactor = new SecretRedactor({ environment: env }),
        options: McpTelemetryOptions = {},
    ) {
        this.redactor = redactor;
        this.captureContent = env.QYL_MCP_CAPTURE_CONTENT === "1";
        this.tracer = options.tracer;
        this.logger = options.logger;
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
        const spanProcessor = new BatchSpanProcessor(traceExporter, {
            maxQueueSize: MAX_QUEUE,
            maxExportBatchSize: MAX_QUEUE,
            scheduledDelayMillis: FLUSH_INTERVAL_MS,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        });
        this.traceProvider = new NodeTracerProvider({
            resource,
            spanProcessors: [spanProcessor],
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
            METRIC_MCP_SERVER_OPERATION_DURATION,
        ]) {
            this.histograms.set(name, meter.createHistogram(name, {
                unit: "s",
                advice: {
                    explicitBucketBoundaries: [...MCP_DURATION_EXPLICIT_BUCKET_BOUNDARIES],
                },
            }));
        }

        const logExporter = new OTLPLogExporter({
            url: signalEndpoint(env, "logs"),
            timeoutMillis: EXPORT_TIMEOUT_MS,
            headers,
        });
        this.logProvider = new LoggerProvider({
            resource,
            processors: [new BatchLogRecordProcessor({
                exporter: logExporter,
                maxQueueSize: MAX_QUEUE,
                maxExportBatchSize: MAX_QUEUE,
                scheduledDelayMillis: FLUSH_INTERVAL_MS,
                exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            })],
            logRecordLimits: {
                attributeValueLengthLimit: ATTRIBUTE_VALUE_LIMIT,
                attributeCountLimit: 32,
            },
        });
        this.logger ??= this.logProvider.getLogger(INSTRUMENTATION_SCOPE, Product.version);
    }

    startOperation(input: McpOperationStartInput): ActiveMcpOperation {
        if (isObservabilitySelfExportSuppressed()) return inactiveOperation();

        const ambientContext = activeMcpContext.getStore() ?? context.active();
        const baseParentContext = input.role === "server" ? ROOT_CONTEXT : ambientContext;
        const parentContext = input.remotePropagation === undefined
            ? baseParentContext
            : extractPropagation(baseParentContext, input.remotePropagation);
        const links = operationLinks(input.role, ambientContext, parentContext);
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
                span = undefined;
                operationContext = undefined;
            }
        }

        const identifiers = span?.spanContext();
        const correlation = identifiers !== undefined && isSpanContextValid(identifiers)
            ? { traceId: identifiers.traceId, spanId: identifiers.spanId }
            : undefined;
        const carrier = operationContext === undefined
            ? undefined
            : injectPropagation(operationContext);
        let ended = false;

        return {
            ...(correlation === undefined ? {} : { correlation }),
            ...(carrier === undefined ? {} : { propagation: carrier }),
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
                const durationMetric = safeDescriptor(
                    () => describeMcpOperationMetric(completed, this.redactor),
                );
                const signalContext = operationContext ?? parentContext;
                this.recordOperationMetric(durationMetric, signalContext);
                this.emitOperationLog(completed, signalContext);

                if (span === undefined) return correlation;
                try {
                    const descriptor = safeDescriptor(
                        () => describeMcpOperationSpan(completed, this.redactor),
                    );
                    if (descriptor !== undefined) span.setAttributes(descriptor.attributes);
                    if (completed.errorType) {
                        span.setStatus({
                            code: SpanStatusCode.ERROR,
                            ...(!this.captureContent || completed.errorMessage === undefined
                                ? {}
                                : { message: this.redactor.redactText(completed.errorMessage) }),
                        });
                    }
                } catch {
                    span.setStatus({ code: SpanStatusCode.ERROR });
                } finally {
                    span.end(completed.endTimeMs);
                }
                return correlation;
            },
        };
    }

    recordOperation(input: McpOperationInput): McpSpanCorrelation | undefined {
        const {
            endTimeMs,
            errorType,
            errorMessage,
            rpcResponseStatusCode,
            jsonRpcRequestId,
            responseBody,
            ...start
        } = input;
        return this.startOperation(start).end({
            endTimeMs,
            ...(errorType === undefined ? {} : { errorType }),
            ...(errorMessage === undefined ? {} : { errorMessage }),
            ...(rpcResponseStatusCode === undefined ? {} : { rpcResponseStatusCode }),
            ...(jsonRpcRequestId === undefined ? {} : { jsonRpcRequestId }),
            ...(responseBody === undefined ? {} : { responseBody }),
        });
    }

    async close(): Promise<void> {
        await Promise.all([
            this.traceProvider?.shutdown(),
            this.metricProvider?.shutdown(),
            this.logProvider?.shutdown(),
        ]);
    }

    private recordOperationMetric(
        metric: ReturnType<typeof describeMcpOperationMetric> | undefined,
        operationContext: Context,
    ): void {
        if (metric === undefined) return;
        try {
            this.histograms.get(metric.name)?.record(
                metric.value,
                metric.attributes,
                operationContext,
            );
        } catch {
            return;
        }
    }

    private emitOperationLog(input: McpOperationInput, operationContext: Context): void {
        if (this.logger === undefined) return;
        try {
            const descriptor = describeMcpOperationLog(
                input,
                this.redactor,
                this.captureContent,
            );
            this.logger.emit({
                eventName: descriptor.eventName,
                severityNumber: descriptor.severityNumber,
                severityText: descriptor.severityText,
                body: descriptor.body,
                attributes: descriptor.attributes,
                timestamp: input.endTimeMs,
                context: operationContext,
            });
        } catch {
            return;
        }
    }
}

function safeDescriptor<T>(create: () => T): T | undefined {
    try {
        return create();
    } catch {
        return undefined;
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
        return extracted;
    }
    return extracted;
}

function injectPropagation(value: Context): McpPropagationCarrier | undefined {
    const staging = Object.create(null) as Record<string, string>;
    STANDARD_MCP_PROPAGATOR.inject(value, staging, defaultTextMapSetter);
    try {
        propagation.inject(value, staging, defaultTextMapSetter);
    } catch {
        // Standard W3C propagation remains available.
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
    if (ambient === undefined || !isSpanContextValid(ambient)) return undefined;
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
