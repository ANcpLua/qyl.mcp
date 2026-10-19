import {
    context,
    defaultTextMapGetter,
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
} from "@ancplua/qyl-semantic-conventions";
import {
    METRIC_MCP_SERVER_OPERATION_DURATION,
    METRIC_MCP_SERVER_OPERATION_DURATION_UNIT,
} from "@ancplua/qyl-semantic-conventions/incubating";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import packageMetadata from "../package.json" with { type: "json" };
import { API_KEY_HEADER, PROJECT_HEADER } from "./contract-headers.js";
import {
    describeMcpOperationLog,
    describeMcpOperationMetric,
    describeMcpOperationSpan,
    type McpPropagationCarrier,
    type McpOperationInput,
} from "./mcp-semconv.js";
import { SecretRedactor } from "./secret-redactor.js";

const Product = {
    name: "qyl.mcp",
    version: packageMetadata.version,
} as const;

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE = 512;
const EXPORT_TIMEOUT_MS = 3_000;
const ATTRIBUTE_VALUE_LIMIT = 2_000;
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

export interface McpSpanCorrelation {
    traceId: string;
    spanId: string;
}

export type McpOperationStartInput = Omit<
    McpOperationInput,
    | "endTimeMs"
    | "errorType"
    | "rpcResponseStatusCode"
    | "jsonRpcRequestId"
>;

export interface McpOperationCompletion {
    endTimeMs: number;
    errorType?: string;
    rpcResponseStatusCode?: string;
    jsonRpcRequestId?: string | number;
    protocolVersion?: string;
}

export interface ActiveMcpOperation {
    readonly correlation?: McpSpanCorrelation;
    run<T>(operation: () => T): T;
    end(completion: McpOperationCompletion): McpSpanCorrelation | undefined;
}

export interface McpTelemetryOptions {
    tracer?: Tracer;
    logger?: Logger;
}

const activeMcpContext = new AsyncLocalStorage<Context | null>();

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
        this.logger = options.logger;
        if (env.QYL_MCP_TELEMETRY === "0") return;

        // Validate every destination before allocating SDK providers/timers, so
        // a bad signal endpoint cannot leave a partially constructed pipeline.
        const endpoints = {
            traces: signalEndpoint(env, "traces"),
            metrics: signalEndpoint(env, "metrics"),
            logs: signalEndpoint(env, "logs"),
        };
        for (const [signal, endpoint] of Object.entries(endpoints)) {
            let url: URL;
            try {
                url = new URL(endpoint);
            } catch {
                throw new Error(`OTLP ${signal} endpoint must be an absolute HTTP(S) URL`);
            }
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error(`OTLP ${signal} endpoint must use HTTP or HTTPS`);
            }
        }

        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: Product.name,
            [ATTR_SERVICE_VERSION]: Product.version,
            [ATTR_SERVICE_INSTANCE_ID]: randomUUID(),
        });
        const headers = {
            ...(env.QYL_API_KEY?.trim() ? { [API_KEY_HEADER]: env.QYL_API_KEY.trim() } : {}),
            ...(env.QYL_PROJECT?.trim() ? { [PROJECT_HEADER]: env.QYL_PROJECT.trim() } : {}),
        };

        const traceExporter = new OTLPTraceExporter({
            url: endpoints.traces,
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
            url: endpoints.metrics,
            timeoutMillis: EXPORT_TIMEOUT_MS,
            headers,
        });
        this.metricProvider = new MeterProvider({
            resource,
            readers: [new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: FLUSH_INTERVAL_MS,
                exportTimeoutMillis: EXPORT_TIMEOUT_MS,
                // Data points per export, the same cap the span and log processors
                // use per batch. The two histograms carry one point per attribute
                // set, up to 2000 sets each in the SDK, and cumulative temporality
                // resends every set on every collection; without the cap one
                // collection is one 4000-point request against a 16 MiB Collector
                // bound and one export timeout.
                maxExportBatchSize: MAX_QUEUE,
            })],
        });
        const meter = this.metricProvider.getMeter(INSTRUMENTATION_SCOPE, Product.version);
        this.histograms.set(METRIC_MCP_SERVER_OPERATION_DURATION, meter.createHistogram(METRIC_MCP_SERVER_OPERATION_DURATION, {
            unit: METRIC_MCP_SERVER_OPERATION_DURATION_UNIT,
            advice: {
                explicitBucketBoundaries: [...MCP_DURATION_EXPLICIT_BUCKET_BOUNDARIES],
            },
        }));

        const logExporter = new OTLPLogExporter({
            url: endpoints.logs,
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
        // A server operation starts its own trace unless the caller propagated one;
        // whatever was active when it started is linked, never parented.
        const ambientContext = activeMcpContext.getStore() ?? context.active();
        const parentContext = input.remotePropagation === undefined
            ? ROOT_CONTEXT
            : extractPropagation(ROOT_CONTEXT, input.remotePropagation);
        const links = operationLinks(ambientContext, parentContext);
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
        let ended = false;

        return {
            ...(correlation === undefined ? {} : { correlation }),
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
                    if (completed.errorType) span.setStatus({ code: SpanStatusCode.ERROR });
                } catch {
                    span.setStatus({ code: SpanStatusCode.ERROR });
                } finally {
                    span.end(completed.endTimeMs);
                }
                return correlation;
            },
        };
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
            const descriptor = describeMcpOperationLog(input, this.redactor);
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

function operationLinks(
    ambientContext: Context,
    parentContext: Context,
): Link[] | undefined {
    const ambient = trace.getSpanContext(ambientContext);
    const parent = trace.getSpanContext(parentContext);
    if (ambient === undefined || !isSpanContextValid(ambient)) return undefined;
    if (parent !== undefined
        && isSpanContextValid(parent)
        && ambient.traceId === parent.traceId
        && ambient.spanId === parent.spanId) return undefined;
    return [{ context: ambient }];
}
