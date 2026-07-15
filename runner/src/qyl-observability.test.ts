import assert from "node:assert/strict";
import test from "node:test";
import type { LogRecord, MetricPoint, Trace } from "@ancplua/qyl-api-schema/types";
import { isObservabilitySelfExportSuppressed } from "./observability-suppression.js";
import {
    QylObservabilityProvider,
    type ContractParser,
} from "./qyl-observability.js";
import { WorkbenchTelemetryAttributes } from "./telemetry.js";

const traceId = "a".repeat(32);
const secondTraceId = "b".repeat(32);
const spanId = "c".repeat(16);
const downstreamSpanId = "d".repeat(16);

function identityParser<T>(): ContractParser<T> {
    return {
        parse(value) {
            assert.equal(typeof value, "object");
            assert.notEqual(value, null);
            return value as T;
        },
    };
}

const validators = {
    trace: identityParser<Trace>(),
    log: identityParser<LogRecord>(),
    metric: identityParser<MetricPoint>(),
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function logRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        time_unix_nano: 1,
        observed_time_unix_nano: 1,
        severity_number: 9,
        body: { string_value: "fixture log" },
        resource: { "service.name": "fixture" },
        ...overrides,
    };
}

function gaugeMetric(
    name: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        type: "gauge",
        name,
        value: { as_double: 1 },
        start_time_unix_nano: "1",
        time_unix_nano: "2",
        flags: 0,
        resource: { "service.name": "fixture" },
        ...overrides,
    };
}

test("provider returns correlated real signals, derived events, redaction, and downstream ids", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        assert.equal(isObservabilitySelfExportSuppressed(), true);
        const url = new URL(String(input));
        requests.push(url);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-otlp-api-key"), "collector-secret");
        assert.equal(headers.get("X-Qyl-Project"), "project-a");

        if (url.pathname === `/api/v1/traces/${traceId}`) {
            return json({
                trace_id: traceId,
                spans: [
                    {
                        trace_id: traceId,
                        span_id: spanId,
                        name: "tools/call probe",
                        attributes: [
                            { key: "mcp.method.name", value: "tools/call" },
                            { key: "authorization", value: "Bearer trace-secret" },
                        ],
                        events: [{ name: "exception", attributes: [] }],
                    },
                    { trace_id: traceId, span_id: downstreamSpanId, name: "database.query" },
                ],
            });
        }
        if (url.pathname === "/api/v1/logs") {
            assert.equal(url.searchParams.get("traceId"), traceId);
            return json({
                items: [logRecord({
                    trace_id: traceId,
                    body: { string_value: "Authorization: Bearer log-secret" },
                })],
                has_more: false,
            });
        }
        if (url.pathname === "/api/v1/metrics") {
            assert.equal(url.searchParams.get("startTime"), "2026-07-15T00:00:00.000Z");
            assert.equal(url.searchParams.get("endTime"), "2026-07-15T00:00:11.000Z");
            return json({
                items: [
                    gaugeMetric("mcp.client.operation.duration", {
                        exemplars: [{
                            time_unix_nano: "2",
                            value: { as_double: 1 },
                            trace_id: traceId,
                            span_id: spanId,
                        }],
                    }),
                    gaugeMetric("unrelated", {
                        attributes: [{ key: WorkbenchTelemetryAttributes.executionId, value: "other" }],
                    }),
                    gaugeMetric("shared-evaluation", {
                        attributes: [{ key: WorkbenchTelemetryAttributes.evaluationRunId, value: "evaluation-1" }],
                    }),
                ],
                has_more: false,
            });
        }
        return json({}, 404);
    };

    const provider = new QylObservabilityProvider({
        baseUrl: "http://collector.test:5100",
        apiKey: "collector-secret",
        projectId: "project-a",
        fetcher,
        validators,
        now: () => new Date("2026-07-15T00:00:02.000Z"),
    });
    const result = await provider.queryExecution({
        correlation: {
            executionId: "execution-1",
            evaluationRunId: "evaluation-1",
            testCaseId: "test-1",
            traceIds: [traceId],
            spanIds: [spanId],
        },
        startedAt: "2026-07-15T00:00:00Z",
        completedAt: "2026-07-15T00:00:01Z",
    });

    assert.equal(requests.length, 3);
    assert.deepEqual(result.signals, {
        traces: { status: "available", itemCount: 1 },
        logs: { status: "available", itemCount: 1 },
        metrics: { status: "available", itemCount: 1 },
        exceptions: { status: "available", itemCount: 1 },
        toolCallEvents: { status: "available", itemCount: 1 },
    });
    assert.deepEqual(result.correlation.spanIds, [spanId, downstreamSpanId]);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.selfExportSuppressed, true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("trace-secret"), false);
    assert.equal(serialized.includes("log-secret"), false);
    assert.equal(serialized.includes("collector-secret"), false);
});

test("provider reports each failed signal unavailable without leaking response content", async () => {
    const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith("/api/v1/traces/")) {
            return json({ detail: "Bearer trace-response-secret" }, 503);
        }
        if (url.pathname === "/api/v1/logs") {
            return json({ detail: "Bearer log-response-secret" }, 401);
        }
        return json({ detail: "Bearer metric-response-secret" }, 404);
    };
    const provider = new QylObservabilityProvider({
        baseUrl: "http://collector.test",
        fetcher,
        validators,
    });
    const result = await provider.queryExecution({
        correlation: {
            executionId: "execution-1",
            traceIds: [traceId],
            spanIds: [spanId],
        },
        startedAt: "2026-07-15T00:00:00Z",
        completedAt: "2026-07-15T00:00:01Z",
    });

    for (const signal of ["traces", "logs", "metrics", "exceptions", "toolCallEvents"] as const) {
        assert.equal(result.signals[signal].status, "unavailable");
        assert.equal(result.signals[signal].itemCount, 0);
    }
    assert.deepEqual(result.traces, []);
    assert.deepEqual(result.logs, []);
    assert.deepEqual(result.metrics, []);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("response-secret"), false);
    assert.match(result.signals.traces.unavailableReason ?? "", /HTTP 503/u);
    assert.match(result.signals.logs.unavailableReason ?? "", /HTTP 401/u);
    assert.match(result.signals.metrics.unavailableReason ?? "", /HTTP 404/u);
});

test("provider labels semantic time-window metric correlation as partial", async () => {
    const provider = new QylObservabilityProvider({
        baseUrl: "http://collector.test",
        fetcher: async (input) => {
            const url = new URL(String(input));
            if (url.pathname.startsWith("/api/v1/traces/")) {
                return json({ trace_id: traceId, spans: [] });
            }
            if (url.pathname === "/api/v1/logs") {
                return json({ items: [], has_more: false });
            }
            return json({
                items: [
                    gaugeMetric("mcp.client.operation.duration", {
                        attributes: [
                            { key: "mcp.method.name", value: "tools/call" },
                            { key: "gen_ai.tool.name", value: "probe" },
                        ],
                    }),
                    gaugeMetric("mcp.client.operation.duration", {
                        attributes: [
                            { key: "mcp.method.name", value: "tools/call" },
                            { key: "gen_ai.tool.name", value: "other" },
                        ],
                    }),
                ],
                has_more: false,
            });
        },
        validators,
    });
    const result = await provider.queryExecution({
        correlation: { executionId: "execution-1", traceIds: [traceId], spanIds: [spanId] },
        startedAt: "2026-07-15T00:00:00Z",
        completedAt: "2026-07-15T00:00:01Z",
        method: "tools/call",
        toolName: "probe",
    });

    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0]?.name, "mcp.client.operation.duration");
    assert.equal(result.signals.metrics.status, "partial");
    assert.match(result.signals.metrics.unavailableReason ?? "", /does not export exemplars/u);
});

test("provider distinguishes partial retained evidence from unavailable signals", async () => {
    const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === `/api/v1/traces/${traceId}`) {
            return json({ trace_id: traceId, spans: [] });
        }
        if (url.pathname === `/api/v1/traces/${secondTraceId}`) return json({}, 404);
        if (url.pathname === "/api/v1/logs" && url.searchParams.get("traceId") === traceId) {
            return json({ items: [logRecord({ trace_id: traceId })], has_more: true });
        }
        if (url.pathname === "/api/v1/logs") return json({}, 500);
        if (url.pathname === "/api/v1/metrics") {
            return json({
                items: [gaugeMetric("correlated", {
                    attributes: [{ key: WorkbenchTelemetryAttributes.executionId, value: "execution-1" }],
                })],
                has_more: true,
            });
        }
        return json({}, 404);
    };
    const provider = new QylObservabilityProvider({
        baseUrl: "http://collector.test",
        fetcher,
        validators,
    });
    const result = await provider.queryExecution({
        correlation: {
            executionId: "execution-1",
            traceIds: [traceId, secondTraceId],
            spanIds: [],
        },
        startedAt: "2026-07-15T00:00:00Z",
        completedAt: "2026-07-15T00:00:01Z",
    });

    assert.equal(result.signals.traces.status, "partial");
    assert.equal(result.signals.traces.itemCount, 1);
    assert.equal(result.signals.logs.status, "partial");
    assert.equal(result.signals.logs.itemCount, 1);
    assert.equal(result.signals.metrics.status, "partial");
    assert.equal(result.signals.metrics.itemCount, 1);
    assert.equal(result.signals.exceptions.status, "partial");
    assert.equal(result.signals.toolCallEvents.status, "partial");
});

test("provider does not fabricate trace or log evidence without correlation ids", async () => {
    let fetchCount = 0;
    const provider = new QylObservabilityProvider({
        baseUrl: "http://collector.test",
        fetcher: async () => {
            fetchCount += 1;
            return json({ items: [], has_more: false });
        },
        validators,
    });
    const result = await provider.queryExecution({
        correlation: { executionId: "execution-1", traceIds: [], spanIds: [] },
    });

    assert.equal(fetchCount, 0);
    assert.equal(result.signals.traces.status, "unavailable");
    assert.equal(result.signals.logs.status, "unavailable");
    assert.equal(result.signals.metrics.status, "unavailable");
    assert.deepEqual(result.traces, []);
    assert.deepEqual(result.logs, []);
    assert.deepEqual(result.metrics, []);

    const disabledReason =
        "Workbench MCP telemetry is disabled; QYL_MCP_TELEMETRY=0 prevents execution span identifiers from being created.";
    const disabled = await provider.queryExecution({
        correlation: { executionId: "execution-disabled", traceIds: [], spanIds: [] },
        instrumentationUnavailableReason: disabledReason,
        startedAt: "2026-07-15T00:00:00Z",
        completedAt: "2026-07-15T00:00:01Z",
    });
    assert.equal(fetchCount, 0);
    for (const availability of Object.values(disabled.signals)) {
        assert.equal(availability.status, "unavailable");
        assert.equal(availability.unavailableReason, disabledReason);
    }
});
