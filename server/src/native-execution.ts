import type {
  RunnerMcpExecutionCost,
  RunnerMcpExecutionTokenUsage,
} from "@ancplua/qyl-api-schema/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { extractExecutionEvidence } from "./execution-evidence.js";
import {
  MAX_PERSISTED_RESULT_CHARACTERS,
  sanitizePersistedToolResult,
} from "./execution-result.js";
import type {
  McpPropagationCarrier,
  McpTelemetryTransport,
} from "./mcp-semconv.js";
import { SecretRedactor } from "./secret-redactor.js";
import {
  McpTelemetry,
  type ActiveMcpOperation,
  type McpSpanCorrelation,
} from "./telemetry.js";

const NATIVE_STATE_VERSION = 1 as const;
const DEFAULT_MAX_EXECUTIONS = 1_000;
const NATIVE_SERVER_ID = "qyl.mcp/native";
const MAX_PROTOCOL_PAYLOAD_CHARACTERS = 64_000;

const IdentifierSchema = z.string().min(1).max(256);
const IsoDateSchema = z.string().datetime({ offset: true });
const JsonRpcRequestIdSchema = z.union([z.string().max(2_048), z.number().finite()]);
const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  estimated: z.boolean(),
}).strict();
const CostSchema = z.object({
  amountUsd: z.number().finite().nonnegative(),
  estimated: z.boolean(),
  source: z.string().min(1).max(256).optional(),
}).strict();
const ProtocolEventSchema = z.object({
  sequence: z.number().int().positive(),
  timestamp: IsoDateSchema,
  direction: z.enum(["inbound", "outbound"]),
  messageKind: z.enum(["request", "result", "error"]),
  jsonrpc: z.literal("2.0"),
  requestId: JsonRpcRequestIdSchema,
  method: z.literal("tools/call"),
  payload: z.unknown(),
}).strict();
const NativeExecutionRecordSchema = z.object({
  id: IdentifierSchema,
  serverId: z.literal(NATIVE_SERVER_ID),
  status: z.enum(["running", "succeeded", "failed"]),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  attemptCount: z.literal(1),
  request: z.object({
    requestId: JsonRpcRequestIdSchema,
    toolName: z.string().min(1).max(1_024),
    arguments: z.record(z.string(), z.unknown()),
    transport: z.enum([
      "stdio",
      "http",
      "streamable_http",
      "streamable-http",
      "sse",
      "inproc",
      "builtin",
    ]),
    sessionId: z.string().min(1).max(2_048).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4_096),
  }).strict().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  cost: CostSchema.optional(),
  protocolEvents: z.array(ProtocolEventSchema).min(1).max(2),
  telemetryCorrelation: z.object({
    executionId: IdentifierSchema,
    traceIds: z.array(z.string().regex(/^[0-9a-f]{32}$/u)).max(2),
    spanIds: z.array(z.string().regex(/^[0-9a-f]{16}$/u)).max(2),
  }).strict(),
}).strict();
const NativeExecutionStateSchema = z.object({
  version: z.literal(NATIVE_STATE_VERSION),
  executions: z.array(NativeExecutionRecordSchema),
}).strict();

export type NativeExecutionRecord = z.infer<typeof NativeExecutionRecordSchema>;
interface NativeExecutionState {
  version: typeof NATIVE_STATE_VERSION;
  executions: NativeExecutionRecord[];
}

export interface NativeExecutionRepository {
  save(record: NativeExecutionRecord): Promise<void>;
}

export interface FileNativeExecutionRepositoryOptions {
  filePath?: string;
  maxExecutions?: number;
  now?: () => number;
  redactor?: SecretRedactor;
  environment?: Readonly<Record<string, string | undefined>>;
}

/** Durable, redacted native-server evidence kept separately from workbench state. */
export class FileNativeExecutionRepository implements NativeExecutionRepository {
  private readonly store: AtomicJsonStore<NativeExecutionState>;
  private readonly maxExecutions: number;
  private readonly now: () => number;
  private initialization: Promise<void> | undefined;

  constructor(options: FileNativeExecutionRepositoryOptions = {}) {
    const environment = options.environment ?? process.env;
    const redactor = options.redactor ?? new SecretRedactor({
      environment,
      maxStringLength: MAX_PERSISTED_RESULT_CHARACTERS + 1,
    });
    this.maxExecutions = positiveInteger(
      options.maxExecutions ?? DEFAULT_MAX_EXECUTIONS,
      "maxExecutions",
    );
    this.now = options.now ?? Date.now;
    this.store = new AtomicJsonStore(
      options.filePath ?? nativeStatePath(environment),
      {
        initial: () => ({ version: NATIVE_STATE_VERSION, executions: [] }),
        parse: (value) => NativeExecutionStateSchema.parse(value),
        prepareForWrite: (value) =>
          NativeExecutionStateSchema.parse(redactor.redact(value)),
      },
    );
  }

  async save(record: NativeExecutionRecord): Promise<void> {
    await this.initialize();
    const validated = NativeExecutionRecordSchema.parse(record);
    await this.store.transact((state) => {
      const index = state.executions.findIndex((entry) => entry.id === validated.id);
      if (index < 0) state.executions.push(validated);
      else state.executions[index] = validated;
      state.executions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      if (state.executions.length > this.maxExecutions) {
        state.executions.splice(0, state.executions.length - this.maxExecutions);
      }
    });
  }

  async list(): Promise<NativeExecutionRecord[]> {
    await this.initialize();
    return (await this.store.read()).executions;
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.initializeCore();
    return this.initialization;
  }

  private async initializeCore(): Promise<void> {
    await this.store.initialize();
    const completedMs = this.now();
    const completedAt = timestamp(completedMs);
    const current = await this.store.read();
    if (!current.executions.some((record) => record.status === "running")) return;
    await this.store.transact((state) => {
      for (const record of state.executions) {
        if (record.status !== "running") continue;
        record.status = "failed";
        record.completedAt = completedAt;
        record.durationMs = Math.max(0, completedMs - Date.parse(record.startedAt));
        record.error = {
          code: "process_interrupted",
          message: "The qyl.mcp process stopped before this native tool call completed.",
        };
      }
    });
  }
}

export interface NativeExecutionTelemetry {
  startOperation: McpTelemetry["startOperation"];
  close?(): Promise<void>;
}

export interface NativeExecutionRuntimeOptions {
  telemetry?: NativeExecutionTelemetry;
  redactor?: SecretRedactor;
  now?: () => number;
  id?: () => string;
}

export interface NativeToolCallInput {
  request: CallToolRequest;
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
  transport: McpTelemetryTransport;
}

/** Owns the automatic inbound tools/call lifecycle and evidence transaction. */
export class NativeExecutionRuntime {
  private readonly telemetry?: NativeExecutionTelemetry;
  private readonly redactor: SecretRedactor;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly repository: NativeExecutionRepository,
    options: NativeExecutionRuntimeOptions = {},
  ) {
    this.telemetry = options.telemetry;
    this.redactor = options.redactor ?? new SecretRedactor({
      environment: process.env,
      maxStringLength: MAX_PERSISTED_RESULT_CHARACTERS + 1,
    });
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  async execute(
    input: NativeToolCallInput,
    invoke: () => unknown | Promise<unknown>,
  ): Promise<CallToolResult> {
    const startedMs = this.now();
    const executionId = this.id();
    const startedAt = timestamp(startedMs);
    const requestId = input.extra.requestId;
    const durableRequestId = sanitizeRequestId(requestId, this.redactor);
    const toolName = input.request.params.name;
    const operation = this.startTelemetry(input, executionId, startedMs);
    const running = NativeExecutionRecordSchema.parse({
      id: executionId,
      serverId: NATIVE_SERVER_ID,
      status: "running",
      createdAt: startedAt,
      startedAt,
      attemptCount: 1,
      request: {
        requestId: durableRequestId,
        toolName: this.redactor.redactText(toolName).slice(0, 1_024),
        arguments: sanitizeArguments(input.request.params.arguments, this.redactor),
        transport: input.transport,
        ...(input.extra.sessionId === undefined
          ? {}
          : { sessionId: this.redactor.redactText(input.extra.sessionId).slice(0, 2_048) }),
        ...(input.request.params._meta === undefined
          ? {}
          : { meta: sanitizeRecord(input.request.params._meta, this.redactor) }),
      },
      protocolEvents: [requestEvent(input, durableRequestId, startedAt, this.redactor)],
      telemetryCorrelation: correlation(executionId, operation?.correlation),
    });

    try {
      await this.repository.save(running);
    } catch (error) {
      operation?.end({
        endTimeMs: this.now(),
        jsonRpcRequestId: requestId,
        errorType: "evidence_persistence_failed",
      });
      throw error;
    }

    let result: CallToolResult;
    try {
      const rawResult = await (operation?.run(invoke) ?? invoke());
      result = CallToolResultSchema.parse(rawResult);
    } catch (error) {
      const completedMs = this.now();
      const completedAt = timestamp(completedMs);
      const failedRecord = NativeExecutionRecordSchema.parse({
        ...running,
        status: "failed",
        completedAt,
        durationMs: duration(startedMs, completedMs),
        error: errorEvidence(error, this.redactor),
        protocolEvents: [
          ...running.protocolEvents,
          errorEvent(durableRequestId, toolName, completedAt, error, this.redactor),
        ],
        telemetryCorrelation: correlation(executionId, operation?.correlation),
      });
      try {
        await this.repository.save(failedRecord);
      } catch (persistenceError) {
        operation?.end({
          endTimeMs: this.now(),
          jsonRpcRequestId: requestId,
          errorType: "evidence_persistence_failed",
        });
        throw persistenceError;
      }
      operation?.end({
        endTimeMs: completedMs,
        jsonRpcRequestId: requestId,
        errorType: errorType(error),
        ...(error instanceof McpError
          ? { rpcResponseStatusCode: String(error.code) }
          : {}),
      });
      throw error;
    }

    const completedMs = this.now();
    const completedAt = timestamp(completedMs);
    const durableResult = sanitizePersistedToolResult(result, this.redactor);
    const evidence = extractExecutionEvidence(result);
    const toolFailed = result.isError === true;
    const completedRecord = NativeExecutionRecordSchema.parse({
      ...running,
      status: toolFailed ? "failed" : "succeeded",
      completedAt,
      durationMs: duration(startedMs, completedMs),
      result: durableResult,
      ...(toolFailed
        ? {
            error: {
              code: "tool_result_error",
              message: "The MCP tool returned an error result.",
            },
          }
        : {}),
      ...evidenceFields(evidence, this.redactor),
      protocolEvents: [
        ...running.protocolEvents,
        resultEvent(durableRequestId, completedAt, durableResult),
      ],
      telemetryCorrelation: correlation(executionId, operation?.correlation),
    });
    try {
      await this.repository.save(completedRecord);
    } catch (error) {
      operation?.end({
        endTimeMs: this.now(),
        jsonRpcRequestId: requestId,
        errorType: "evidence_persistence_failed",
      });
      throw error;
    }
    operation?.end({
      endTimeMs: completedMs,
      jsonRpcRequestId: requestId,
      ...(toolFailed ? { errorType: "tool_error" } : {}),
    });
    return result;
  }

  close(): Promise<void> {
    return this.telemetry?.close?.() ?? Promise.resolve();
  }

  get telemetryEnabled(): boolean {
    return this.telemetry !== undefined;
  }

  private startTelemetry(
    input: NativeToolCallInput,
    executionId: string,
    startedMs: number,
  ): ActiveMcpOperation | undefined {
    try {
      return this.telemetry?.startOperation({
        role: "server",
        method: "tools/call",
        serverId: NATIVE_SERVER_ID,
        toolName: input.request.params.name,
        transport: input.transport,
        ...(input.extra.sessionId === undefined ? {} : { mcpSessionId: input.extra.sessionId }),
        jsonRpcProtocolVersion: "2.0",
        executionId,
        remotePropagation: propagationCarrier(input.request.params._meta),
        startTimeMs: startedMs,
      });
    } catch {
      return undefined;
    }
  }
}

type NativeRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type UntypedRequestHandler = (
  request: unknown,
  extra: NativeRequestExtra,
) => unknown | Promise<unknown>;
type UntypedSetRequestHandler = (schema: unknown, handler: UntypedRequestHandler) => void;
const instrumentedServers = new WeakSet<McpServer>();
const nativeTelemetryServers = new WeakSet<McpServer>();

/** Wrap the SDK's single tools/call dispatcher, covering all current and future tools. */
export function installNativeExecutionRecording(
  server: McpServer,
  runtime: NativeExecutionRuntime,
  transport: McpTelemetryTransport,
): void {
  if (instrumentedServers.has(server)) return;
  instrumentedServers.add(server);
  if (runtime.telemetryEnabled) nativeTelemetryServers.add(server);
  const lowLevel = server.server as unknown as { setRequestHandler: UntypedSetRequestHandler };
  const original = lowLevel.setRequestHandler.bind(server.server);
  lowLevel.setRequestHandler = (schema, handler) => {
    if (schema !== CallToolRequestSchema) {
      original(schema, handler);
      return;
    }
    original(schema, async (request, extra) => {
      const validated = CallToolRequestSchema.parse(request);
      return runtime.execute(
        { request: validated, extra, transport },
        () => handler(validated, extra),
      );
    });
  };
}

export function hasNativeExecutionTelemetry(server: unknown): boolean {
  return typeof server === "object" &&
    server !== null &&
    nativeTelemetryServers.has(server as McpServer);
}

let defaultRuntime: NativeExecutionRuntime | undefined;

export function defaultNativeExecutionRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NativeExecutionRuntime {
  defaultRuntime ??= createDefaultRuntime(environment);
  return defaultRuntime;
}

export async function closeDefaultNativeExecutionRuntime(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = undefined;
  await runtime?.close();
}

function createDefaultRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): NativeExecutionRuntime {
  const redactor = new SecretRedactor({
    environment,
    maxStringLength: MAX_PERSISTED_RESULT_CHARACTERS + 1,
  });
  const repository = new FileNativeExecutionRepository({ environment, redactor });
  let telemetry: McpTelemetry | undefined;
  try {
    telemetry = new McpTelemetry(environment, redactor);
  } catch {
    telemetry = undefined;
  }
  return new NativeExecutionRuntime(repository, { redactor, telemetry });
}

function nativeStatePath(environment: Readonly<Record<string, string | undefined>>): string {
  return environment.QYL_MCP_NATIVE_STATE_PATH
    ?? join(homedir(), ".qyl", "mcp-native-executions.json");
}

function requestEvent(
  input: NativeToolCallInput,
  requestId: string | number,
  at: string,
  redactor: SecretRedactor,
): NativeExecutionRecord["protocolEvents"][number] {
  return {
    sequence: 1,
    timestamp: at,
    direction: "inbound",
    messageKind: "request",
    jsonrpc: "2.0",
    requestId,
    method: "tools/call",
    payload: boundPayload(redactor.redact({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: input.request.params,
    })),
  };
}

function resultEvent(
  requestId: string | number,
  at: string,
  result: CallToolResult,
): NativeExecutionRecord["protocolEvents"][number] {
  return {
    sequence: 2,
    timestamp: at,
    direction: "outbound",
    messageKind: "result",
    jsonrpc: "2.0",
    requestId,
    method: "tools/call",
    payload: boundPayload({ jsonrpc: "2.0", id: requestId, result }),
  };
}

function errorEvent(
  requestId: string | number,
  toolName: string,
  at: string,
  error: unknown,
  redactor: SecretRedactor,
): NativeExecutionRecord["protocolEvents"][number] {
  const evidence = errorEvidence(error, redactor);
  return {
    sequence: 2,
    timestamp: at,
    direction: "outbound",
    messageKind: "error",
    jsonrpc: "2.0",
    requestId,
    method: "tools/call",
    payload: boundPayload({
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: error instanceof McpError ? error.code : ErrorCode.InternalError,
        message: evidence.message,
        data: { toolName: redactor.redactText(toolName).slice(0, 1_024) },
      },
    }),
  };
}

function errorEvidence(
  error: unknown,
  redactor: SecretRedactor,
): NonNullable<NativeExecutionRecord["error"]> {
  const message = redactor.redactText(error instanceof Error ? error.message : String(error));
  return {
    code: errorType(error),
    message: message.trim().length === 0 ? "Native MCP tool execution failed." : message.slice(0, 4_096),
  };
}

function errorType(error: unknown): string {
  if (error instanceof McpError) return `mcp_${error.code}`;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)) {
    return error.name.slice(0, 128);
  }
  return "native_tool_failure";
}

function correlation(
  executionId: string,
  span: McpSpanCorrelation | undefined,
): NativeExecutionRecord["telemetryCorrelation"] {
  return {
    executionId,
    traceIds: span === undefined ? [] : [span.traceId],
    spanIds: span === undefined ? [] : [span.spanId],
  };
}

function propagationCarrier(value: unknown): McpPropagationCarrier | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function sanitizeArguments(
  value: Record<string, unknown> | undefined,
  redactor: SecretRedactor,
): Record<string, unknown> {
  return sanitizeRecord(value ?? {}, redactor);
}

function sanitizeRecord(
  value: Record<string, unknown>,
  redactor: SecretRedactor,
): Record<string, unknown> {
  const sanitized = redactor.redact(value);
  if (!isRecord(sanitized)) return {};
  const bounded = boundPayload(sanitized);
  return isRecord(bounded) ? bounded : {};
}

function boundPayload(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= MAX_PROTOCOL_PAYLOAD_CHARACTERS) {
    return value;
  }
  return {
    truncated: true,
    originalCharacters: serialized.length,
    preview: `${serialized.slice(0, MAX_PROTOCOL_PAYLOAD_CHARACTERS - 1)}…`,
  };
}

function evidenceFields(evidence: {
  tokenUsage?: RunnerMcpExecutionTokenUsage;
  cost?: RunnerMcpExecutionCost;
}, redactor: SecretRedactor): Pick<NativeExecutionRecord, "tokenUsage" | "cost"> {
  const source = evidence.cost?.source === undefined
    ? undefined
    : redactor.redactText(evidence.cost.source).trim().slice(0, 256);
  const cost = evidence.cost === undefined
    ? undefined
    : {
        amountUsd: evidence.cost.amountUsd,
        estimated: evidence.cost.estimated,
        ...(source === undefined || source.length === 0 ? {} : { source }),
      };
  return {
    ...(evidence.tokenUsage === undefined ? {} : { tokenUsage: evidence.tokenUsage }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function sanitizeRequestId(
  value: string | number,
  redactor: SecretRedactor,
): string | number {
  return typeof value === "string"
    ? redactor.redactText(value).slice(0, 2_048)
    : value;
}

function duration(startedMs: number, completedMs: number): number {
  return Math.max(0, completedMs - startedMs);
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
