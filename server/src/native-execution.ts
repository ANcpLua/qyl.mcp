import type {
  WorkbenchExecutionCost,
  WorkbenchExecutionTokenUsage,
} from "@ancplua/qyl-api-schema/types";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/core";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { McpServer, CallToolRequest, CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AtomicJsonStore, PersistenceError } from "./atomic-json-store.js";
import {
  WorkbenchExecutionCostSchema,
  WorkbenchExecutionTokenUsageSchema,
} from "./contract-validation.js";
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

// 2: usage and cost evidence follows the published contract's snake_case names,
// so a version-1 file must never half-parse. It is set aside rather than read —
// see archiveUnreadableState.
const NATIVE_STATE_VERSION = 2 as const;
const DEFAULT_MAX_EXECUTIONS = 1_000;
const NATIVE_SERVER_ID = "qyl.mcp/native";
const MAX_PROTOCOL_PAYLOAD_CHARACTERS = 64_000;

const IdentifierSchema = z.string().min(1).max(256);
const IsoDateSchema = z.string().datetime({ offset: true });
const JsonRpcRequestIdSchema = z.union([z.string().max(2_048), z.number().finite()]);
// Usage and cost evidence is the published contract's own shape, so the
// persisted record validates against the generated schema rather than a local
// copy that can drift from it.
const TokenUsageSchema = WorkbenchExecutionTokenUsageSchema;
const CostSchema = WorkbenchExecutionCostSchema;
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
  private store: AtomicJsonStore<NativeExecutionState>;
  private readonly openStore: () => AtomicJsonStore<NativeExecutionState>;
  private readonly filePath: string;
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
    this.filePath = options.filePath ?? nativeStatePath(environment);
    this.openStore = () =>
      new AtomicJsonStore(this.filePath, {
        initial: () => ({ version: NATIVE_STATE_VERSION, executions: [] }),
        parse: (value) => NativeExecutionStateSchema.parse(value),
        prepareForWrite: (value) =>
          NativeExecutionStateSchema.parse(redactor.redact(value)),
      });
    this.store = this.openStore();
  }

  /**
   * Move a state file this build cannot read out of the way, and say so.
   *
   * The schema deliberately refuses to half-parse an older layout, but refusing
   * forever is not the same as refusing to guess: a state file written before a
   * version bump would otherwise fail every single tool call for the life of the
   * installation, because the store caches its failed load and evidence is
   * written before the tool runs. Renaming preserves the old records for anyone
   * who wants them and lets this process start a fresh log. Nothing is deleted
   * and nothing is migrated.
   */
  private async archiveUnreadableState(reason: PersistenceError): Promise<void> {
    const archived = `${this.filePath}.unreadable-${new Date(this.now()).toISOString().replaceAll(":", "-")}`;
    await rename(this.filePath, archived);
    console.error(
      `qyl.mcp could not read its execution evidence (${reason.kind}); ` +
        `moved it to ${archived} and started a new log`,
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
    try {
      await this.store.initialize();
    } catch (error) {
      // A write fault is about this filesystem, not about the file's contents;
      // archiving would not help and would discard readable evidence.
      if (!(error instanceof PersistenceError) || error.kind === "write_failed") throw error;
      await this.archiveUnreadableState(error);
      this.store = this.openStore();
      await this.store.initialize();
    }
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
  ctx: ServerContext;
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
    const requestId = input.ctx.mcpReq.id;
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
      throw new EvidenceRecordingError(error);
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
        throw new EvidenceRecordingError(persistenceError);
      }
      operation?.end({
        endTimeMs: completedMs,
        jsonRpcRequestId: requestId,
        errorType: errorType(error),
        ...(error instanceof ProtocolError
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
      throw new EvidenceRecordingError(error);
    }
    operation?.end({
      endTimeMs: completedMs,
      jsonRpcRequestId: requestId,
      ...(toolFailed ? { errorType: "tool_error" } : {}),
      responseBody: this.redactor.redact(result),
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
        jsonRpcProtocolVersion: "2.0",
        executionId,
        requestBody: this.redactor.redact(input.request),
        remotePropagation: propagationCarrier(input.request.params._meta),
        startTimeMs: startedMs,
      });
    } catch {
      return undefined;
    }
  }
}

type UntypedRequestHandler = (
  request: unknown,
  ctx: ServerContext,
) => unknown | Promise<unknown>;
type UntypedSetRequestHandler = (
  method: string,
  handlerOrSchemas: unknown,
  handler?: UntypedRequestHandler,
) => void;
/**
 * A fault in the evidence layer itself, as opposed to anything the tool did.
 * Only these become an isError result; a malformed tool result is a server bug
 * that fails the runtime's CallToolResultSchema parse and stays loud.
 */
export class EvidenceRecordingError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "EvidenceRecordingError";
  }
}

/**
 * Report a recording-layer fault to the caller of `tools/call`.
 *
 * The detail goes to stderr rather than into the result: the message reaches a
 * model, and a persistence fault names a local state path that has no meaning
 * to it and does not belong on the wire.
 */
function recordingFailureResult(error: unknown): CallToolResult {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`native execution evidence could not be recorded: ${detail}`);
  return {
    content: [{
      type: "text",
      text: "This tool call was not run: qyl.mcp could not record its execution evidence. " +
        "The server logged the reason; every tool stays unavailable until it is resolved.",
    }],
    isError: true,
  };
}

const instrumentedServers = new WeakSet<McpServer>();
const nativeTelemetryServers = new WeakSet<McpServer>();
const recordingServers = new WeakSet<McpServer>();

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
  lowLevel.setRequestHandler = (method, handlerOrSchemas, customHandler) => {
    const handler = customHandler ?? handlerOrSchemas;
    if (method !== "tools/call" || typeof handler !== "function") {
      original(method, handlerOrSchemas, customHandler);
      return;
    }
    recordingServers.add(server);
    original(method, async (request: unknown, ctx: ServerContext) => {
      const validated = CallToolRequestSchema.parse(request);
      try {
        return await runtime.execute(
          { request: validated, ctx, transport },
          () => handler(validated, ctx),
        );
      } catch (error) {
        // The SDK converts throws into isError only inside the dispatcher this
        // wrapper calls (errors.md); above it a throw leaves as a JSON-RPC error,
        // so an evidence fault is answered here and every other throw passes.
        if (!(error instanceof EvidenceRecordingError)) throw error;
        return recordingFailureResult(error.cause);
      }
    });
  };
}

/**
 * Fail construction when recording never took hold, which is otherwise silent.
 *
 * The wrapper above only sees a tools/call registration that happens after it is
 * installed. McpServer registers that dispatcher in its own constructor as soon as
 * `capabilities.tools` is declared there, and only defers it to the first
 * registerTool call when it is not — so declaring the capability up front would
 * leave every tool call unrecorded while answering normally. Evidence is an audit
 * surface; losing it has to be an error at startup, not a gap discovered later.
 */
export function assertNativeExecutionRecordingArmed(server: McpServer): void {
  if (recordingServers.has(server)) return;
  throw new Error(
    "native execution recording never wrapped a tools/call dispatcher: the MCP server " +
      "registered it before installNativeExecutionRecording ran (declaring capabilities.tools " +
      "on the McpServer constructor does this). Register tools after installing recording.",
  );
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
        code: error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError,
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
  if (error instanceof ProtocolError) return `mcp_${error.code}`;
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
  tokenUsage?: WorkbenchExecutionTokenUsage;
  cost?: WorkbenchExecutionCost;
}, redactor: SecretRedactor): Pick<NativeExecutionRecord, "tokenUsage" | "cost"> {
  const source = evidence.cost?.source === undefined
    ? undefined
    : redactor.redactText(evidence.cost.source).trim().slice(0, 256);
  const cost = evidence.cost === undefined
    ? undefined
    : {
        amount_usd: evidence.cost.amount_usd,
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
