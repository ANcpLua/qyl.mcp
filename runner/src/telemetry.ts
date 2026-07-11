// MCP self-monitoring — the qyl-based answer to Sentry's "MCP monitoring" product.
//
// The runner is the single choke point for all managed servers (every dashboard/agent call
// flows through the /runner/mcp passthrough), so instrumenting HERE monitors every MCP
// server without touching any of them. Spans follow the OTel MCP semantic conventions
// (mcp.method.name, mcp.tool.name — see semantic-conventions model/mcp, moved to the GenAI
// registry) plus the gen_ai.tool.* aliases Sentry's MCP dashboards pivot on, and carry a
// session.id resource attribute so the qyl collector groups one runner run into one session.
//
// Zero dependencies: OTLP/HTTP JSON straight to the collector (POST {endpoint}/v1/traces).
// Fire-and-forget with a bounded queue — telemetry must never slow down or break the
// passthrough, so export failures are silently dropped after one console notice.
//
// Config: QYL_OTLP_ENDPOINT (default http://127.0.0.1:4318; the qyl collector also accepts
// OTLP on :5100), QYL_MCP_TELEMETRY=0 to disable.

import { randomBytes, randomUUID } from "node:crypto";
import { Constants } from "./constants.js";

const { Product } = Constants;

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE = 512;
const EXPORT_TIMEOUT_MS = 3_000;

/** OTLP AnyValue for the JSON encoding. */
type OtlpValue =
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { doubleValue: number };

interface OtlpSpan {
    traceId: string;
    spanId: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Array<{ key: string; value: OtlpValue }>;
    status: { code: number; message?: string };
}

function toOtlpValue(value: string | number | boolean): OtlpValue {
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "boolean") return { boolValue: value };
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

export interface McpCallSpanInput {
    /** MCP request method, e.g. "tools/call", "tools/list", "resources/read". */
    method: string;
    /** Managed resource (server) name the call was routed to. */
    serverName: string;
    /** Tool name for tools/call. */
    toolName?: string;
    /** Resource URI for resources/read. */
    resourceUri?: string;
    /** Transport of the managed server ("stdio" | "http"). */
    transport: string;
    startTimeMs: number;
    endTimeMs: number;
    error?: string;
    /** tools/call arguments — recorded only when QYL_MCP_RECORD_INPUTS=1. */
    arguments?: Record<string, unknown>;
    /** Tool result — recorded only when QYL_MCP_RECORD_OUTPUTS=1. */
    result?: unknown;
}

/** Cap recorded input/output attribute values so spans stay bounded. */
const RECORDED_VALUE_MAX_CHARS = 2_000;

function truncated(value: unknown): string {
    let text: string;
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value);
    }
    return text.length > RECORDED_VALUE_MAX_CHARS ? `${text.slice(0, RECORDED_VALUE_MAX_CHARS)}…` : text;
}

export class McpTelemetry {
    private readonly endpoint: string;
    private readonly enabled: boolean;
    /** One session per runner process — qyl derives sessions from this attribute. */
    private readonly sessionId = randomUUID();
    private readonly queue: OtlpSpan[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private unreachableNoticeShown = false;

    // Sentry-MCP-style recordInputs/recordOutputs: tool arguments and results as span
    // attributes (gen_ai.tool.call.arguments.<key> / gen_ai.tool.call.result). Off by
    // default — argument/result payloads may carry user data; opt in per environment.
    private readonly recordInputs: boolean;
    private readonly recordOutputs: boolean;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.endpoint = (env.QYL_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(/\/$/, "");
        this.enabled = env.QYL_MCP_TELEMETRY !== "0";
        this.recordInputs = env.QYL_MCP_RECORD_INPUTS === "1";
        this.recordOutputs = env.QYL_MCP_RECORD_OUTPUTS === "1";
        if (this.enabled) {
            this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
            this.timer.unref();
        }
    }

    /** Record one passthrough MCP call as a CLIENT span. Never throws. */
    recordCall(input: McpCallSpanInput): void {
        if (!this.enabled) return;
        if (this.queue.length >= MAX_QUEUE) this.queue.shift();

        const attributes: Array<{ key: string; value: OtlpValue }> = [
            { key: "mcp.method.name", value: toOtlpValue(input.method) },
            { key: "mcp.server.name", value: toOtlpValue(input.serverName) },
            { key: "app.transport", value: toOtlpValue(input.transport) },
        ];
        if (input.toolName) {
            // Both keys on purpose: mcp.tool.name is the semconv canonical, gen_ai.tool.name
            // is what GenAI-centric dashboards (Sentry MCP, qyl genai_usage) pivot on.
            attributes.push({ key: "mcp.tool.name", value: toOtlpValue(input.toolName) });
            attributes.push({ key: "gen_ai.tool.name", value: toOtlpValue(input.toolName) });
        }
        if (input.resourceUri) {
            attributes.push({ key: "mcp.resource.uri", value: toOtlpValue(input.resourceUri) });
        }
        if (input.error) {
            attributes.push({ key: "error.type", value: toOtlpValue("mcp_error") });
        }
        if (this.recordInputs && input.arguments) {
            for (const [key, value] of Object.entries(input.arguments)) {
                attributes.push({
                    key: `gen_ai.tool.call.arguments.${key}`,
                    value: toOtlpValue(truncated(value)),
                });
            }
        }
        if (this.recordOutputs && input.result !== undefined) {
            attributes.push({ key: "gen_ai.tool.call.result", value: toOtlpValue(truncated(input.result)) });
            const count = Array.isArray((input.result as any)?.content)
                ? (input.result as any).content.length
                : undefined;
            if (count !== undefined) {
                attributes.push({ key: "gen_ai.tool.call.result.count", value: toOtlpValue(count) });
            }
        }

        // Hex, per the OTLP/JSON spec (trace/span ids are special-cased to hex in JSON).
        // The qyl collector enforces spec-hex strictly since 2026-07-11 (Phase 1 of its repair
        // plan): it rewrites hex ids for protojson and rejects non-hex/wrong-length ids with 400.
        this.queue.push({
            traceId: randomBytes(16).toString("hex"),
            spanId: randomBytes(8).toString("hex"),
            // Sentry-style span description: target in the name ("tools/call get_trace",
            // "resources/read ui://..."). Doubles as the recovery channel for collectors
            // that redact unknown attributes (qyl's allowlist strips mcp.* today).
            name: input.toolName
                ? `${input.method} ${input.toolName}`
                : input.resourceUri
                  ? `${input.method} ${input.resourceUri}`
                  : input.method,
            kind: 3, // SPAN_KIND_CLIENT — the runner calls the managed server
            startTimeUnixNano: String(Math.round(input.startTimeMs * 1e6)),
            endTimeUnixNano: String(Math.round(input.endTimeMs * 1e6)),
            attributes,
            status: input.error ? { code: 2, message: input.error } : { code: 1 },
        });
    }

    /** Drain the queue to the collector. Failures drop the batch silently (one notice). */
    async flush(): Promise<void> {
        if (this.queue.length === 0) return;
        const spans = this.queue.splice(0, this.queue.length);
        const payload = {
            resourceSpans: [
                {
                    resource: {
                        attributes: [
                            { key: "service.name", value: toOtlpValue(Product.name) },
                            { key: "service.version", value: toOtlpValue(Product.version) },
                            { key: "session.id", value: toOtlpValue(this.sessionId) },
                        ],
                    },
                    scopeSpans: [
                        {
                            scope: { name: "qyl.mcp/passthrough", version: Product.version },
                            spans,
                        },
                    ],
                },
            ],
        };

        try {
            await fetch(`${this.endpoint}/v1/traces`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
            });
        } catch (error) {
            if (!this.unreachableNoticeShown) {
                this.unreachableNoticeShown = true;
                console.error(
                    `qyl.mcp telemetry: collector unreachable at ${this.endpoint} — MCP spans will be dropped ` +
                        `(start the qyl collector, set QYL_OTLP_ENDPOINT, or QYL_MCP_TELEMETRY=0 to silence): ` +
                        `${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    async close(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.flush();
    }
}
