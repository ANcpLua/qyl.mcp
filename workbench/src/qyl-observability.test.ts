import assert from "node:assert/strict";
import test from "node:test";
import type { LogRecord, Trace } from "@ancplua/qyl-api-schema/types";
import { isObservabilitySelfExportSuppressed } from "./observability-suppression.js";
import {
    QylObservabilityProvider,
    type ContractParser,
} from "./qyl-observability.js";

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
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function logRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        time_unix_nano: '1',
        observed_time_unix_nano: '1',
        severity_number: 9,
        body: { string_value: "fixture log" },
        resource: { service_name: "fixture" },
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
            assert.equal(url.searchParams.get("trace_id"), traceId);
            return json({
                items: [logRecord({
                    trace_id: traceId,
                    body: { string_value: "Authorization: Bearer log-secret" },
                })],
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
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(result.signals, {
        traces: { status: "available", item_count: 1 },
        logs: { status: "available", item_count: 1 },
        exceptions: { status: "available", item_count: 1 },
        tool_call_events: { status: "available", item_count: 1 },
    });
    assert.deepEqual(result.correlation.span_ids, [spanId, downstreamSpanId]);
    assert.equal(result.self_export_suppressed, true);
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
            traceIds: [traceId],
            spanIds: [spanId],
        },
    });

    for (const signal of ["traces", "logs", "exceptions", "tool_call_events"] as const) {
        assert.equal(result.signals[signal].status, "unavailable");
        assert.equal(result.signals[signal].item_count, 0);
    }
    assert.deepEqual(result.traces, []);
    assert.deepEqual(result.logs, []);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("response-secret"), false);
    assert.match(result.signals.traces.unavailable_reason ?? "", /HTTP 503/u);
    assert.match(result.signals.logs.unavailable_reason ?? "", /HTTP 401/u);
});

test("provider distinguishes partial retained evidence from unavailable signals", async () => {
    const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === `/api/v1/traces/${traceId}`) {
            return json({ trace_id: traceId, spans: [] });
        }
        if (url.pathname === `/api/v1/traces/${secondTraceId}`) return json({}, 404);
        if (url.pathname === "/api/v1/logs" && url.searchParams.get("trace_id") === traceId) {
            return json({ items: [logRecord({ trace_id: traceId })], has_more: true });
        }
        if (url.pathname === "/api/v1/logs") return json({}, 500);
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
    });

    assert.equal(result.signals.traces.status, "partial");
    assert.equal(result.signals.traces.item_count, 1);
    assert.equal(result.signals.logs.status, "partial");
    assert.equal(result.signals.logs.item_count, 1);
    assert.equal(result.signals.exceptions.status, "partial");
    assert.equal(result.signals.tool_call_events.status, "partial");
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
    assert.deepEqual(result.traces, []);
    assert.deepEqual(result.logs, []);

    const disabledReason =
        "Workbench MCP telemetry is disabled; QYL_MCP_TELEMETRY=0 prevents execution span identifiers from being created.";
    const disabled = await provider.queryExecution({
        correlation: { executionId: "execution-disabled", traceIds: [], spanIds: [] },
        instrumentationUnavailableReason: disabledReason,
    });
    assert.equal(fetchCount, 0);
    for (const availability of Object.values(disabled.signals)) {
        assert.equal(availability.status, "unavailable");
        assert.equal(availability.unavailable_reason, disabledReason);
    }
});
