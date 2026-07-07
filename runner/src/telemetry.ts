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
// OTLP on :5100), MCP_RUN_TELEMETRY=0 to disable.

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
}

export class McpTelemetry {
    private readonly endpoint: string;
    private readonly enabled: boolean;
    /** One session per runner process — qyl derives sessions from this attribute. */
    private readonly sessionId = randomUUID();
    private readonly queue: OtlpSpan[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private unreachableNoticeShown = false;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.endpoint = (env.QYL_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(/\/$/, "");
        this.enabled = env.MCP_RUN_TELEMETRY !== "0";
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

        // Base64, not hex: the OTLP spec special-cases trace/span ids to hex in JSON, but
        // collectors that parse OTLP JSON with stock protojson (qyl included) apply the
        // plain proto3 bytes mapping = base64. qyl is the target backend, so base64 wins;
        // switch to hex if pointing QYL_OTLP_ENDPOINT at a strict-OTLP collector.
        this.queue.push({
            traceId: randomBytes(16).toString("base64"),
            spanId: randomBytes(8).toString("base64"),
            name: input.toolName ? `${input.method} ${input.toolName}` : input.method,
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
                            scope: { name: "mcp-run/passthrough", version: Product.version },
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
                    `mcp-run telemetry: collector unreachable at ${this.endpoint} — MCP spans will be dropped ` +
                        `(start the qyl collector, set QYL_OTLP_ENDPOINT, or MCP_RUN_TELEMETRY=0 to silence): ` +
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
