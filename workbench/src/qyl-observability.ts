import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import type {
    LogRecord,
    WorkbenchExecutionTelemetryResponse,
    WorkbenchTelemetryAvailability,
    WorkbenchTelemetrySignalAvailability,
    WorkbenchTelemetrySignalSummary,
    Trace,
} from "@ancplua/qyl-api-schema/types";
import {
    LogsListResponseSchema,
    LogRecordSchema,
    WorkbenchTelemetryCorrelationSchema,
    TraceSchema,
} from "qyl-mcp-server/contract-validation";
import type { WorkbenchTelemetryCorrelation } from "./observability-correlation.js";
import { runWithObservabilitySelfExportSuppressed } from "./observability-suppression.js";
import { isCredentialKey, SecretRedactor } from "./secret-redactor.js";

const TRACE_DEFINITION = "OTel.Traces.Trace";
const LOG_DEFINITION = "OTel.Logs.LogRecord";
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const LOG_PAGE_SIZE = 10_000;
const MAX_REASON_LENGTH = 1_000;

type SignalName = "traces" | "logs";
export type TelemetryAvailability = WorkbenchTelemetryAvailability;
export type TelemetrySignalAvailability = WorkbenchTelemetrySignalAvailability;
export type TelemetrySignalSummary = WorkbenchTelemetrySignalSummary;
export type QylExecutionObservability = WorkbenchExecutionTelemetryResponse;

export interface QylObservabilityQuery {
    correlation: WorkbenchTelemetryCorrelation;
    instrumentationUnavailableReason?: string;
}

export interface ContractParser<T> {
    parse(value: unknown): T;
}

export interface QylObservabilityValidators {
    trace?: ContractParser<Trace>;
    log?: ContractParser<LogRecord>;
}

export interface QylObservabilityProviderOptions {
    environment?: Readonly<Record<string, string | undefined>>;
    baseUrl?: string;
    apiKey?: string;
    projectId?: string;
    fetcher?: typeof fetch;
    validators?: QylObservabilityValidators;
    requestTimeoutMs?: number;
    now?: () => Date;
    redactor?: SecretRedactor;
}

interface QylPage<T> {
    items: T[];
    hasMore: boolean;
    nextCursor?: string;
}

interface CollectedSignal<T> {
    items: T[];
    availability: TelemetrySignalAvailability;
}

interface OpenApiMetadata {
    components?: {
        securitySchemes?: Record<string, { type?: string; in?: string; name?: string }>;
        parameters?: Record<string, { in?: string; name?: string }>;
    };
}

const openApiMetadata = qylOpenApi as OpenApiMetadata;
const apiKeyHeader = requiredHeaderName(
    openApiMetadata.components?.securitySchemes?.ApiKeyAuth,
    "published Qyl API-key security scheme",
);
const projectHeader = requiredHeaderName(
    openApiMetadata.components?.parameters?.ProjectScopeHeader,
    "published Qyl project-scope parameter",
);

/**
 * Reads only real, contract-validated Qyl telemetry. It never creates demo
 * evidence and every read runs under self-export suppression.
 */
export class QylObservabilityProvider {
    private readonly baseUrl: URL;
    private readonly headers: Readonly<Record<string, string>>;
    private readonly fetcher: typeof fetch;
    private readonly validators: QylObservabilityValidators;
    private readonly requestTimeoutMs: number;
    private readonly now: () => Date;
    private readonly redactor: SecretRedactor;

    constructor(options: QylObservabilityProviderOptions = {}) {
        const environment = options.environment ?? process.env;
        const baseUrl = options.baseUrl ?? environment.QYL_COLLECTOR_URL ?? "http://127.0.0.1:5100";
        const apiKey = options.apiKey ?? environment.QYL_API_KEY;
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.headers = buildHeaders(apiKey, options.projectId);
        this.fetcher = options.fetcher ?? fetch;
        this.validators = options.validators ?? publishedValidators();
        this.requestTimeoutMs = positiveInteger(
            options.requestTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
            "requestTimeoutMs",
        );
        this.now = options.now ?? (() => new Date());
        this.redactor = options.redactor ?? new SecretRedactor({
            environment,
            ...(apiKey === undefined ? {} : { secretValues: [apiKey] }),
        });
    }

    queryExecution(
        query: QylObservabilityQuery,
    ): Promise<QylExecutionObservability> {
        return runWithObservabilitySelfExportSuppressed(() => this.queryExecutionSuppressed(query));
    }

    private async queryExecutionSuppressed(
        query: QylObservabilityQuery,
    ): Promise<QylExecutionObservability> {
        const correlation = normalizeCorrelation(query.correlation);
        if (correlation.traceIds.length === 0 && query.instrumentationUnavailableReason !== undefined) {
            const reason = boundedReason(this.redactor.redactText(query.instrumentationUnavailableReason));
            const signal = () => unavailableAvailability(reason);
            return {
                signals: {
                    traces: signal(),
                    logs: signal(),
                    exceptions: signal(),
                    tool_call_events: signal(),
                },
                correlation: WorkbenchTelemetryCorrelationSchema.parse(
                    toContractCorrelation(correlation),
                ),
                traces: [],
                logs: [],
                queried_at: this.now().toISOString(),
                self_export_suppressed: true,
            };
        }
        const [traces, logs] = await Promise.all([
            this.collectTraces(correlation.traceIds),
            this.collectLogs(correlation.traceIds),
        ]);
        const expandedCorrelation = WorkbenchTelemetryCorrelationSchema.parse(
            toContractCorrelation(expandCorrelation(correlation, traces.items)),
        );
        const derived = deriveTraceSignals(traces.items, traces.availability);

        return {
            signals: {
                traces: traces.availability,
                logs: logs.availability,
                exceptions: derived.exceptions,
                tool_call_events: derived.tool_call_events,
            },
            correlation: expandedCorrelation,
            traces: traces.items,
            logs: logs.items,
            queried_at: this.now().toISOString(),
            self_export_suppressed: true,
        };
    }

    private async collectTraces(traceIds: readonly string[]): Promise<CollectedSignal<Trace>> {
        if (traceIds.length === 0) {
            return unavailable("Execution has no Qyl trace identifiers.");
        }
        const parser = this.validators.trace;
        if (!parser) return unavailable(missingContractReason(TRACE_DEFINITION));

        const items: Trace[] = [];
        const failures: string[] = [];
        for (const traceId of traceIds) {
            try {
                const body = await this.getJson(
                    `/api/v1/traces/${encodeURIComponent(traceId)}`,
                    {},
                    "traces",
                );
                items.push(this.parseAndSanitize(body, parser, "trace"));
            } catch (error) {
                failures.push(this.failureReason(error, "Qyl trace evidence is unavailable."));
            }
        }
        return collected(items, failures, traceIds.length - failures.length);
    }

    private async collectLogs(traceIds: readonly string[]): Promise<CollectedSignal<LogRecord>> {
        if (traceIds.length === 0) {
            return unavailable("Execution has no trace identifiers for correlated Qyl logs.");
        }
        const parser = this.validators.log;
        if (!parser) return unavailable(missingContractReason(LOG_DEFINITION));

        const items: LogRecord[] = [];
        const failures: string[] = [];
        let successfulReads = 0;
        for (const traceId of traceIds) {
            try {
                const body = await this.getJson(
                    "/api/v1/logs",
                    { traceId, limit: LOG_PAGE_SIZE },
                    "logs",
                );
                const page = this.parsePage(body, parser, LogsListResponseSchema, "logs");
                successfulReads += 1;
                items.push(...page.items);
                if (page.hasMore) {
                    failures.push("Qyl logs exceeded the contract's bounded non-paginated read.");
                }
            } catch (error) {
                failures.push(this.failureReason(error, "Qyl log evidence is unavailable."));
            }
        }
        return collected(items, failures, successfulReads);
    }

    private async getJson(
        pathname: string,
        params: Readonly<Record<string, string | number | undefined>>,
        signal: SignalName,
    ): Promise<unknown> {
        const url = new URL(pathname.replace(/^\/+/, ""), this.baseUrl);
        for (const [name, value] of Object.entries(params)) {
            if (value !== undefined) url.searchParams.set(name, String(value));
        }

        let response: Response;
        try {
            response = await this.fetcher(url, {
                method: "GET",
                headers: this.headers,
                signal: AbortSignal.timeout(this.requestTimeoutMs),
            });
        } catch {
            throw new QylObservabilityReadError(`Qyl ${signal} read API is unreachable.`);
        }
        if (!response.ok) {
            throw new QylObservabilityReadError(
                `Qyl ${signal} read API returned HTTP ${response.status}.`,
            );
        }
        try {
            return await response.json();
        } catch {
            throw new QylObservabilityReadError(`Qyl ${signal} read API returned invalid JSON.`);
        }
    }

    private parsePage<T>(
        body: unknown,
        itemParser: ContractParser<T>,
        pageParser: ContractParser<PublishedPage>,
        signal: SignalName,
    ): QylPage<T> {
        try {
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
                throw new Error("Qyl page must be an object.");
            }
            const source = body as Record<string, unknown>;
            if (!Array.isArray(source.items)) {
                throw new Error("Qyl page items must be an array.");
            }
            const page = pageParser.parse({
                ...source,
                items: source.items.map((item) => this.parseAndSanitize(item, itemParser, signal)),
            });
            return {
                items: page.items as T[],
                hasMore: page.has_more,
                ...(page.next_cursor === undefined ? {} : { nextCursor: page.next_cursor }),
            };
        } catch (error) {
            if (error instanceof QylObservabilityReadError) throw error;
            throw new QylObservabilityReadError(`Qyl ${signal} page violates the published contract.`);
        }
    }

    private parseAndSanitize<T>(value: unknown, parser: ContractParser<T>, context: string): T {
        try {
            const parsed = parser.parse(value);
            const sanitized = sanitizeTelemetryValue(parsed, this.redactor);
            return parser.parse(sanitized);
        } catch {
            throw new QylObservabilityReadError(
                `Qyl ${context} evidence violates the published contract.`,
            );
        }
    }

    private failureReason(error: unknown, fallback: string): string {
        const message = error instanceof QylObservabilityReadError ? error.message : fallback;
        return boundedReason(this.redactor.redactText(message));
    }
}

interface PublishedPage {
    items: unknown[];
    has_more: boolean;
    next_cursor?: string;
}

class QylObservabilityReadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QylObservabilityReadError";
    }
}

function publishedValidators(): QylObservabilityValidators {
    return {
        trace: TraceSchema,
        log: LogRecordSchema,
    };
}

function normalizeBaseUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Qyl collector URL must be an absolute HTTP(S) URL.");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new Error("Qyl collector URL must be a credential-free HTTP(S) URL.");
    }
    if (url.search || url.hash) {
        throw new Error("Qyl collector URL must not contain a query or fragment.");
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
    return url;
}

function buildHeaders(apiKey?: string, projectId?: string): Readonly<Record<string, string>> {
    const headers: Record<string, string> = { accept: "application/json" };
    const normalizedApiKey = apiKey?.trim();
    if (normalizedApiKey) headers[apiKeyHeader] = normalizedApiKey;
    const normalizedProject = projectId?.trim();
    if (normalizedProject) headers[projectHeader] = normalizedProject;
    return headers;
}

function requiredHeaderName(
    component: { in?: string; name?: string } | undefined,
    description: string,
): string {
    if (component?.in !== "header" || typeof component.name !== "string" || component.name.length === 0) {
        throw new Error(`${description} has no header name.`);
    }
    return component.name;
}

function normalizeCorrelation(
    correlation: WorkbenchTelemetryCorrelation,
): WorkbenchTelemetryCorrelation {
    return {
        executionId: requiredIdentifier(correlation.executionId, "executionId"),
        ...(correlation.evaluationRunId === undefined
            ? {}
            : { evaluationRunId: requiredIdentifier(correlation.evaluationRunId, "evaluationRunId") }),
        ...(correlation.testCaseId === undefined
            ? {}
            : { testCaseId: requiredIdentifier(correlation.testCaseId, "testCaseId") }),
        traceIds: uniqueW3cIds(correlation.traceIds, TRACE_ID_PATTERN),
        spanIds: uniqueW3cIds(correlation.spanIds, SPAN_ID_PATTERN),
    };
}

function requiredIdentifier(value: string, name: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 256) {
        throw new Error(`${name} must contain between 1 and 256 characters.`);
    }
    return normalized;
}

function uniqueW3cIds(values: readonly string[], pattern: RegExp): string[] {
    return [...new Set(values.filter((value) => pattern.test(value)).map((value) => value.toLowerCase()))];
}

function unavailable<T>(reason: string): CollectedSignal<T> {
    return {
        items: [],
        availability: {
            status: "unavailable",
            unavailable_reason: boundedReason(reason),
            item_count: 0,
        },
    };
}

function collected<T>(
    items: T[],
    failures: readonly string[],
    successfulReads: number,
): CollectedSignal<T> {
    const uniqueFailures = [...new Set(failures)];
    if (successfulReads === 0) {
        return unavailable(uniqueFailures.join(" ") || "Qyl signal is unavailable.");
    }
    return {
        items,
        availability: {
            status: uniqueFailures.length === 0 ? "available" : "partial",
            ...(uniqueFailures.length === 0
                ? {}
                : { unavailableReason: boundedReason(uniqueFailures.join(" ")) }),
            item_count: items.length,
        },
    };
}

function missingContractReason(definition: string): string {
    return `Published Qyl contract does not define ${definition}.`;
}

function boundedReason(reason: string): string {
    return reason.length <= MAX_REASON_LENGTH
        ? reason
        : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

function sanitizeTelemetryValue(value: unknown, redactor: SecretRedactor): unknown {
    const sanitized = sanitizeCredentialAttributes(value, redactor, new WeakSet<object>());
    return redactor.redact(sanitized);
}

function sanitizeCredentialAttributes(
    value: unknown,
    redactor: SecretRedactor,
    seen: WeakSet<object>,
): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => sanitizeCredentialAttributes(item, redactor, seen));
        }
        const source = value as Record<string, unknown>;
        if (typeof source.key === "string" && "value" in source && isCredentialKey(source.key)) {
            return { ...source, value: redactor.replacement };
        }
        return Object.fromEntries(
            Object.entries(source).map(([key, child]) => [
                key,
                sanitizeCredentialAttributes(child, redactor, seen),
            ]),
        );
    } finally {
        seen.delete(value);
    }
}

function expandCorrelation(
    correlation: WorkbenchTelemetryCorrelation,
    traces: readonly unknown[],
): WorkbenchTelemetryCorrelation {
    const traceIds = new Set(correlation.traceIds);
    const spanIds = new Set(correlation.spanIds);
    for (const trace of traces) {
        const record = asOptionalRecord(trace);
        if (!record) continue;
        if (typeof record.trace_id === "string" && TRACE_ID_PATTERN.test(record.trace_id)) {
            traceIds.add(record.trace_id.toLowerCase());
        }
        if (!Array.isArray(record.spans)) continue;
        for (const span of record.spans) {
            const candidate = asOptionalRecord(span);
            if (typeof candidate?.span_id === "string" && SPAN_ID_PATTERN.test(candidate.span_id)) {
                spanIds.add(candidate.span_id.toLowerCase());
            }
        }
    }
    return { ...correlation, traceIds: [...traceIds], spanIds: [...spanIds] };
}

/**
 * The internal correlation record as the contract's wire shape. Internal code
 * keeps camelCase; the contract's snake_case names are produced here and only
 * here, so a missed field is a compile error rather than a silently absent key.
 */
function toContractCorrelation(correlation: WorkbenchTelemetryCorrelation): {
    execution_id: string;
    evaluation_run_id?: string;
    test_case_id?: string;
    trace_ids: string[];
    span_ids: string[];
} {
    return {
        execution_id: correlation.executionId,
        ...(correlation.evaluationRunId === undefined
            ? {}
            : { evaluation_run_id: correlation.evaluationRunId }),
        ...(correlation.testCaseId === undefined ? {} : { test_case_id: correlation.testCaseId }),
        trace_ids: [...correlation.traceIds],
        span_ids: [...correlation.spanIds],
    };
}

function deriveTraceSignals(
    traces: readonly unknown[],
    traceAvailability: TelemetrySignalAvailability,
): Pick<TelemetrySignalSummary, "exceptions" | "tool_call_events"> {
    if (traceAvailability.status === "unavailable") {
        const reason = `Requires Qyl trace evidence: ${traceAvailability.unavailable_reason ?? "traces unavailable"}`;
        return { exceptions: unavailableAvailability(reason), tool_call_events: unavailableAvailability(reason) };
    }

    let exceptions = 0;
    let toolCallEvents = 0;
    for (const trace of traces) {
        const spans = asOptionalRecord(trace)?.spans;
        if (!Array.isArray(spans)) continue;
        for (const span of spans) {
            const record = asOptionalRecord(span);
            if (!record) continue;
            if (isToolCallSpan(record)) toolCallEvents += 1;
            const events = Array.isArray(record.events) ? record.events : [];
            for (const event of events) {
                const candidate = asOptionalRecord(event);
                if (candidate && isExceptionEvent(candidate)) exceptions += 1;
            }
        }
    }

    const status = traceAvailability.status;
    const reason = traceAvailability.unavailable_reason;
    return {
        exceptions: derivedAvailability(status, exceptions, reason),
        tool_call_events: derivedAvailability(status, toolCallEvents, reason),
    };
}

function isToolCallSpan(span: Record<string, unknown>): boolean {
    if (typeof span.name === "string" && span.name.startsWith("tools/call")) return true;
    const attributes = attributeMap(span.attributes);
    return attributes.get("mcp.method.name") === "tools/call" ||
        attributes.get("gen_ai.operation.name") === "execute_tool" ||
        attributes.has("gen_ai.tool.name");
}

function isExceptionEvent(event: Record<string, unknown>): boolean {
    if (event.name === "exception") return true;
    const attributes = attributeMap(event.attributes);
    return attributes.has("exception.type") || attributes.has("exception.message");
}

function attributeMap(value: unknown): Map<string, unknown> {
    const result = new Map<string, unknown>();
    if (!Array.isArray(value)) return result;
    for (const item of value) {
        const attribute = asOptionalRecord(item);
        if (attribute && typeof attribute.key === "string") {
            result.set(attribute.key, attribute.value);
        }
    }
    return result;
}

function derivedAvailability(
    status: "available" | "partial",
    itemCount: number,
    reason?: string,
): TelemetrySignalAvailability {
    return {
        status,
        ...(reason === undefined ? {} : { unavailable_reason: reason }),
        item_count: itemCount,
    };
}

function unavailableAvailability(reason: string): TelemetrySignalAvailability {
    return { status: "unavailable", unavailable_reason: boundedReason(reason), item_count: 0 };
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}
