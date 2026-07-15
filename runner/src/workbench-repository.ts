import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
    RunnerMcpEvaluationExport,
    RunnerMcpEvaluationExportPayload,
    RunnerMcpWorkspace,
} from "@ancplua/qyl-api-schema/types";
import {
    RunnerMcpErrorSchema,
    RunnerMcpEvaluationExportPayloadSchema,
    RunnerMcpEvaluationExportSchema,
    RunnerMcpEvaluationRunStatusSchema,
    RunnerMcpExecutionConfirmationEvidenceSchema,
    RunnerMcpTestAssertionSchema,
    RunnerMcpWorkspaceSchema,
} from "qyl-mcp-server/contract-validation";
import { z } from "zod";
import type { EvaluationRun, WorkbenchSuite, WorkbenchTestCase } from "./evaluation-engine.js";
import type { ExecutionRecord } from "./execution-service.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { SecretRedactor } from "./secret-redactor.js";

const STATE_VERSION = 2 as const;
const DEFAULT_WORKSPACE_NAME = "Local workbench";

const IdentifierSchema = z.string().min(1).max(128);
const IsoDateSchema = z.string().datetime({ offset: true });
const JsonObjectSchema = z.record(z.string(), z.unknown());

const SecretReferenceSchema = z.object({
    source: z.literal("environment"),
    environmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
}).strict();

const EnvironmentReferenceSchema = z.object({
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    secret: SecretReferenceSchema,
}).strict();

const HeaderReferenceSchema = z.object({
    header: z.string().min(1).max(256),
    secret: SecretReferenceSchema,
    scheme: z.enum(["bearer", "basic"]).optional(),
}).strict();

export const PersistedConnectionDefinitionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("stdio"),
        command: z.string().min(1).max(4_096),
        args: z.array(z.string().max(16_384)).max(256).default([]),
        cwd: z.string().min(1).max(4_096).optional(),
        environment: z.array(EnvironmentReferenceSchema).max(128).default([]),
    }).strict(),
    z.object({
        kind: z.literal("streamable_http"),
        endpoint: z.string().url().max(8_192),
        headers: z.array(HeaderReferenceSchema).max(128).default([]),
    }).strict(),
    z.object({
        kind: z.literal("sse"),
        endpoint: z.string().url().max(8_192),
        headers: z.array(HeaderReferenceSchema).max(128).default([]),
    }).strict(),
    z.object({
        kind: z.literal("builtin"),
        builtin: z.string().min(1).max(256),
    }).strict(),
    z.object({
        kind: z.literal("inproc"),
        implementation: z.string().min(1).max(256),
    }).strict(),
]);

export type PersistedConnectionDefinition = z.infer<typeof PersistedConnectionDefinitionSchema>;

export type WorkspaceRecord = RunnerMcpWorkspace;

export interface ServerRecord {
    id: string;
    workspaceId: string;
    name: string;
    description?: string;
    configuration: PersistedConnectionDefinition;
    autoConnect: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface PersistedTestCase extends WorkbenchTestCase {
    description?: string;
    createdAt: string;
    updatedAt: string;
}

export interface PersistedSuite extends WorkbenchSuite {
    description?: string;
    tags?: readonly string[];
    createdAt: string;
    updatedAt: string;
}

export interface PersistedExecution {
    id: string;
    workspaceId: string;
    serverId: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    /** Durable SSE lifecycle cursor; allocated atomically by the repository. */
    streamEventId?: number;
    evidence: unknown;
    idempotency?: {
        key: string;
        fingerprint: string;
    };
    protocolEvents?: unknown[];
    telemetryCorrelation?: {
        executionId: string;
        evaluationRunId?: string;
        testCaseId?: string;
        traceIds: string[];
        spanIds: string[];
    };
}

interface PersistedEvaluationExport {
    id: string;
    workspaceId: string;
    runId: string;
    idempotencyKey: string;
    metadata: RunnerMcpEvaluationExport;
    payload: RunnerMcpEvaluationExportPayload;
}

export interface WorkspacePreferences {
    selectedServerId?: string;
    selectedToolName?: string;
    inputMode?: "form" | "json";
    activePanel?: string;
    compactMode?: boolean;
    updatedAt?: string;
}

export interface WorkbenchState {
    version: typeof STATE_VERSION;
    workspaces: WorkspaceRecord[];
    servers: ServerRecord[];
    testCases: PersistedTestCase[];
    suites: PersistedSuite[];
    evaluationRuns: EvaluationRun[];
    evaluationExports: PersistedEvaluationExport[];
    executions: PersistedExecution[];
    preferences: Record<string, WorkspacePreferences>;
}

export interface InterruptedWorkReconciliation {
    executionIds: string[];
    evaluationRunIds: string[];
}

const WorkspacePersistenceSchema = z.object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(4_000).optional(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
}).strict();

const WorkspaceSchema: z.ZodType<WorkspaceRecord> = WorkspacePersistenceSchema.transform(
    (workspace) => RunnerMcpWorkspaceSchema.parse(workspace),
);

const ServerSchema: z.ZodType<ServerRecord> = z.object({
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    configuration: PersistedConnectionDefinitionSchema,
    autoConnect: z.boolean(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
}).strict();

const TestCaseSchema: z.ZodType<PersistedTestCase> = z.object({
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    serverId: IdentifierSchema,
    toolName: z.string().min(1).max(1_024),
    arguments: JsonObjectSchema,
    assertions: z.array(RunnerMcpTestAssertionSchema).max(256),
    timeoutMs: z.number().int().min(1).max(3_600_000),
    tags: z.array(z.string().min(1).max(120)).max(64).optional(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
}).strict();

const SuiteSchema: z.ZodType<PersistedSuite> = z.object({
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(4_000).optional(),
    testCaseIds: z.array(IdentifierSchema).max(10_000),
    tags: z.array(z.string().min(1).max(120)).max(64).optional(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
}).strict();

const EvaluationRunSchema: z.ZodType<EvaluationRun> = z.object({
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    suiteId: IdentifierSchema,
    suiteName: z.string().min(1).max(120),
    suite: z.unknown().optional(),
    testCases: z.array(z.unknown()).optional(),
    status: RunnerMcpEvaluationRunStatusSchema,
    startedAt: IsoDateSchema,
    completedAt: IsoDateSchema.optional(),
    results: z.array(z.unknown()),
    summary: z.object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        successRate: z.number().finite().min(0).max(1),
        reliability: z.number().finite().min(0).max(1),
        averageLatencyMs: z.number().finite().nonnegative().optional(),
        p50LatencyMs: z.number().finite().nonnegative().optional(),
        p95LatencyMs: z.number().finite().nonnegative().optional(),
        p99LatencyMs: z.number().finite().nonnegative().optional(),
        inputTokens: z.number().finite().nonnegative().optional(),
        outputTokens: z.number().finite().nonnegative().optional(),
        estimatedCostUsd: z.number().finite().nonnegative().optional(),
    }).strict(),
    idempotencyKey: z.string().min(8).max(256).optional(),
    idempotencyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    confirmation: RunnerMcpExecutionConfirmationEvidenceSchema.optional(),
    error: RunnerMcpErrorSchema.optional(),
}).strict() as unknown as z.ZodType<EvaluationRun>;

const ExecutionSchema: z.ZodType<PersistedExecution> = z.object({
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    serverId: IdentifierSchema,
    status: z.string().min(1).max(64),
    createdAt: IsoDateSchema,
    completedAt: IsoDateSchema.optional(),
    streamEventId: z.number().int().positive().optional(),
    evidence: z.unknown(),
    idempotency: z.object({
        key: z.string().min(8).max(256),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    }).strict().optional(),
    protocolEvents: z.array(z.unknown()).max(1_000).optional(),
    telemetryCorrelation: z.object({
        executionId: IdentifierSchema,
        evaluationRunId: IdentifierSchema.optional(),
        testCaseId: IdentifierSchema.optional(),
        traceIds: z.array(z.string().regex(/^[0-9a-f]{32}$/iu)).max(64),
        spanIds: z.array(z.string().regex(/^[0-9a-f]{16}$/iu)).max(256),
    }).strict().optional(),
}).strict();

const PersistedEvaluationExportSchema: z.ZodType<PersistedEvaluationExport> = z.object({
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema,
    idempotencyKey: z.string().min(8).max(256),
    metadata: RunnerMcpEvaluationExportSchema,
    payload: RunnerMcpEvaluationExportPayloadSchema,
}).strict();

const PreferencesSchema: z.ZodType<WorkspacePreferences> = z.object({
    selectedServerId: IdentifierSchema.optional(),
    selectedToolName: z.string().min(1).max(1_024).optional(),
    inputMode: z.enum(["form", "json"]).optional(),
    activePanel: z.string().min(1).max(128).optional(),
    compactMode: z.boolean().optional(),
    updatedAt: IsoDateSchema.optional(),
}).strict();

const StateSchema: z.ZodType<WorkbenchState> = z.object({
    version: z.literal(STATE_VERSION),
    workspaces: z.array(WorkspaceSchema),
    servers: z.array(ServerSchema),
    testCases: z.array(TestCaseSchema),
    suites: z.array(SuiteSchema),
    evaluationRuns: z.array(EvaluationRunSchema),
    evaluationExports: z.array(PersistedEvaluationExportSchema).default([]),
    executions: z.array(ExecutionSchema),
    preferences: z.record(z.string(), PreferencesSchema),
}).strict();

export interface WorkbenchRepositoryOptions {
    filePath?: string;
    ownerId?: string;
    now?: () => Date;
    redactor?: SecretRedactor;
    environment?: Readonly<Record<string, string | undefined>>;
}

export class RepositoryConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RepositoryConflictError";
    }
}

export class RepositoryNotFoundError extends Error {
    constructor(readonly kind: string, readonly id: string) {
        super(`${kind} '${id}' was not found.`);
        this.name = "RepositoryNotFoundError";
    }
}

/** Workspace-scoped durable state. Runtime transports and credentials are never persisted. */
export class WorkbenchRepository {
    private readonly ownerId: string;
    private readonly now: () => Date;
    private readonly redactor: SecretRedactor;
    private readonly environment: Readonly<Record<string, string | undefined>>;
    private readonly store: AtomicJsonStore<WorkbenchState>;

    constructor(options: WorkbenchRepositoryOptions = {}) {
        this.ownerId = options.ownerId ?? "local-user";
        this.now = options.now ?? (() => new Date());
        this.environment = options.environment ?? process.env;
        this.redactor = options.redactor ?? new SecretRedactor({ environment: this.environment });
        this.store = new AtomicJsonStore(
            options.filePath ?? defaultStatePath(),
            {
                initial: () => initialState(this.ownerId, this.now()),
                parse: (value) => validateState(StateSchema.parse(value), this.ownerId),
                prepareForWrite: (value) => {
                    validateConnections(value.servers);
                    return StateSchema.parse(redactPersistedState(value, this.redactor));
                },
            },
        );
    }

    async initialize(): Promise<void> {
        await this.store.initialize();
        const state = await this.store.read();
        const ownedWorkspaceIds = new Set<string>(
            state.workspaces
                .filter((workspace) => workspace.ownerId === this.ownerId)
                .map((workspace) => workspace.id),
        );
        for (const server of state.servers) {
            if (ownedWorkspaceIds.has(server.workspaceId)) {
                this.registerConnectionSecrets(server.configuration);
            }
        }
        // Re-prepare loaded state after resolving current connection references,
        // so legacy evidence containing a now-known secret is scrubbed on open. Assign
        // old execution rows durable stream cursors in the same atomic rewrite.
        await this.store.transact((draft) => {
            let nextStreamEventId = executionStreamHighWater(draft.executions) + 1;
            for (const execution of draft.executions) {
                if (execution.streamEventId === undefined) execution.streamEventId = nextStreamEventId++;
            }
        });
    }

    registerSecretValues(values: readonly string[]): void {
        this.redactor.registerSecretValues(values);
    }

    async snapshot(): Promise<WorkbenchState> {
        return this.store.read();
    }

    /** Atomically fail durable work that cannot still have an owning task after restart. */
    async reconcileInterruptedWork(): Promise<InterruptedWorkReconciliation> {
        const completedAt = this.now().toISOString();
        const { result } = await this.store.transact((state) => {
            const ownedWorkspaceIds = new Set<string>(
                state.workspaces
                    .filter((workspace) => workspace.ownerId === this.ownerId)
                    .map((workspace) => workspace.id),
            );
            const executionIds: string[] = [];
            const evaluationRunIds: string[] = [];
            let nextStreamEventId = executionStreamHighWater(state.executions) + 1;
            state.executions = state.executions.map((execution) => {
                if (!ownedWorkspaceIds.has(execution.workspaceId)
                    || !isActiveExecutionStatus(execution.status)) return execution;
                executionIds.push(execution.id);
                return {
                    ...reconcileExecution(execution, completedAt),
                    streamEventId: nextStreamEventId++,
                };
            });
            state.evaluationRuns = state.evaluationRuns.map((run) => {
                if (!ownedWorkspaceIds.has(run.workspaceId)
                    || (run.status !== "queued" && run.status !== "running")) return run;
                evaluationRunIds.push(run.id);
                return reconcileEvaluationRun(run, completedAt);
            });
            return { executionIds, evaluationRunIds };
        });
        return result;
    }

    async listWorkspaces(): Promise<WorkspaceRecord[]> {
        return (await this.store.read()).workspaces
            .filter((workspace) => workspace.ownerId === this.ownerId);
    }

    async getWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
        const state = await this.store.read();
        return findOwnedWorkspace(state, workspaceId, this.ownerId);
    }

    async createWorkspace(input: { name: string; description?: string }): Promise<WorkspaceRecord> {
        const timestamp = this.now().toISOString();
        const workspace = WorkspaceSchema.parse({
            id: randomUUID(),
            ownerId: this.ownerId,
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        await this.store.transact((state) => {
            if (state.workspaces.some((item) => item.ownerId === this.ownerId && item.name === workspace.name)) {
                throw new RepositoryConflictError(`Workspace '${workspace.name}' already exists.`);
            }
            state.workspaces.push(workspace);
        });
        return workspace;
    }

    async updateWorkspace(
        workspaceId: string,
        input: { name?: string; description?: string },
    ): Promise<WorkspaceRecord> {
        let updated!: WorkspaceRecord;
        await this.store.transact((state) => {
            const workspace = findOwnedWorkspace(state, workspaceId, this.ownerId);
            updated = WorkspaceSchema.parse({
                ...workspace,
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.description === undefined ? {} : { description: input.description }),
                updatedAt: this.now().toISOString(),
            });
            state.workspaces[state.workspaces.indexOf(workspace)] = updated;
        });
        return updated;
    }

    async deleteWorkspace(workspaceId: string): Promise<void> {
        await this.store.transact((state) => {
            const workspace = assertWorkspaceDeletable(state, workspaceId, this.ownerId);
            state.workspaces.splice(state.workspaces.indexOf(workspace), 1);
            state.servers = state.servers.filter((item) => item.workspaceId !== workspaceId);
            state.testCases = state.testCases.filter((item) => item.workspaceId !== workspaceId);
            state.suites = state.suites.filter((item) => item.workspaceId !== workspaceId);
            state.evaluationRuns = state.evaluationRuns.filter((item) => item.workspaceId !== workspaceId);
            state.evaluationExports = state.evaluationExports.filter((item) => item.workspaceId !== workspaceId);
            state.executions = state.executions.filter((item) => item.workspaceId !== workspaceId);
            delete state.preferences[workspaceId];
        });
    }

    /** Read-only preflight for coordinating runtime shutdown before durable deletion. */
    async ensureWorkspaceDeletable(workspaceId: string): Promise<void> {
        assertWorkspaceDeletable(await this.store.read(), workspaceId, this.ownerId);
    }

    async listServers(workspaceId: string): Promise<ServerRecord[]> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.servers.filter((item) => item.workspaceId === workspaceId);
    }

    async getServer(workspaceId: string, serverId: string): Promise<ServerRecord> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return findScoped(state.servers, workspaceId, serverId, "MCP server");
    }

    async createServer(
        workspaceId: string,
        input: Omit<ServerRecord, "id" | "workspaceId" | "createdAt" | "updatedAt">,
    ): Promise<ServerRecord> {
        this.registerConnectionSecrets(input.configuration);
        let server!: ServerRecord;
        await this.store.transact((state) => {
            findOwnedWorkspace(state, workspaceId, this.ownerId);
            if (state.servers.some((item) => item.workspaceId === workspaceId && item.name === input.name)) {
                throw new RepositoryConflictError(`MCP server '${input.name}' already exists.`);
            }
            const timestamp = this.now().toISOString();
            server = ServerSchema.parse({
                ...input,
                id: randomUUID(),
                workspaceId,
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            validateConnection(server.configuration);
            state.servers.push(server);
        });
        return server;
    }

    async updateServer(
        workspaceId: string,
        serverId: string,
        input: Partial<Pick<ServerRecord, "name" | "description" | "configuration" | "autoConnect">>,
    ): Promise<ServerRecord> {
        if (input.configuration !== undefined) this.registerConnectionSecrets(input.configuration);
        let updated!: ServerRecord;
        await this.store.transact((state) => {
            findOwnedWorkspace(state, workspaceId, this.ownerId);
            const server = findScoped(state.servers, workspaceId, serverId, "MCP server");
            updated = ServerSchema.parse({ ...server, ...input, updatedAt: this.now().toISOString() });
            validateConnection(updated.configuration);
            state.servers[state.servers.indexOf(server)] = updated;
        });
        return updated;
    }

    /** Restore an exact previously committed row after a coordinated runtime update fails. */
    async restoreServer(server: ServerRecord): Promise<ServerRecord> {
        this.registerConnectionSecrets(server.configuration);
        const restored = ServerSchema.parse(server);
        await this.store.transact((state) => {
            findOwnedWorkspace(state, restored.workspaceId, this.ownerId);
            const current = findScoped(
                state.servers,
                restored.workspaceId,
                restored.id,
                "MCP server",
            );
            validateConnection(restored.configuration);
            state.servers[state.servers.indexOf(current)] = restored;
        });
        return restored;
    }

    async deleteServer(workspaceId: string, serverId: string): Promise<void> {
        await this.store.transact((state) => {
            const server = assertServerDeletable(state, workspaceId, serverId, this.ownerId);
            state.servers.splice(state.servers.indexOf(server), 1);
            // Terminal executions are scoped to the deleted server. Evaluation
            // runs retain immutable case/result snapshots, so their evidence
            // remains reviewable without leaving inaccessible execution rows.
            state.executions = state.executions.filter((item) => item.serverId !== serverId);
            if (state.preferences[workspaceId]?.selectedServerId === serverId) {
                delete state.preferences[workspaceId]!.selectedServerId;
            }
        });
    }

    /** Read-only preflight for coordinating runtime shutdown before durable deletion. */
    async ensureServerDeletable(workspaceId: string, serverId: string): Promise<void> {
        assertServerDeletable(await this.store.read(), workspaceId, serverId, this.ownerId);
    }

    async listTestCases(workspaceId: string): Promise<PersistedTestCase[]> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.testCases.filter((item) => item.workspaceId === workspaceId);
    }

    async getTestCase(workspaceId: string, testCaseId: string): Promise<PersistedTestCase> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return findScoped(state.testCases, workspaceId, testCaseId, "test case");
    }

    async saveTestCase(testCase: PersistedTestCase): Promise<PersistedTestCase> {
        const parsed = TestCaseSchema.parse(testCase);
        await this.store.transact((state) => {
            findOwnedWorkspace(state, parsed.workspaceId, this.ownerId);
            findScoped(state.servers, parsed.workspaceId, parsed.serverId, "MCP server");
            upsert(state.testCases, parsed);
        });
        return parsed;
    }

    async deleteTestCase(workspaceId: string, testCaseId: string): Promise<void> {
        await this.store.transact((state) => {
            findOwnedWorkspace(state, workspaceId, this.ownerId);
            const testCase = findScoped(state.testCases, workspaceId, testCaseId, "test case");
            if (state.suites.some((suite) => suite.workspaceId === workspaceId && suite.testCaseIds.includes(testCaseId))) {
                throw new RepositoryConflictError("Remove this test case from evaluation suites first.");
            }
            state.testCases.splice(state.testCases.indexOf(testCase), 1);
        });
    }

    async listSuites(workspaceId: string): Promise<PersistedSuite[]> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.suites.filter((item) => item.workspaceId === workspaceId);
    }

    async getSuite(workspaceId: string, suiteId: string): Promise<PersistedSuite> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return findScoped(state.suites, workspaceId, suiteId, "evaluation suite");
    }

    async saveSuite(suite: PersistedSuite): Promise<PersistedSuite> {
        const parsed = SuiteSchema.parse(suite);
        await this.store.transact((state) => {
            findOwnedWorkspace(state, parsed.workspaceId, this.ownerId);
            for (const testCaseId of parsed.testCaseIds) {
                findScoped(state.testCases, parsed.workspaceId, testCaseId, "test case");
            }
            if (new Set(parsed.testCaseIds).size !== parsed.testCaseIds.length) {
                throw new RepositoryConflictError("An evaluation suite cannot contain duplicate test cases.");
            }
            upsert(state.suites, parsed);
        });
        return parsed;
    }

    async deleteSuite(workspaceId: string, suiteId: string): Promise<void> {
        await this.store.transact((state) => {
            findOwnedWorkspace(state, workspaceId, this.ownerId);
            const suite = findScoped(state.suites, workspaceId, suiteId, "evaluation suite");
            state.suites.splice(state.suites.indexOf(suite), 1);
        });
    }

    async saveEvaluationRun(run: EvaluationRun): Promise<EvaluationRun> {
        const parsed = EvaluationRunSchema.parse(run);
        await this.store.transact((state) => {
            findOwnedWorkspace(state, parsed.workspaceId, this.ownerId);
            upsert(state.evaluationRuns, parsed);
        });
        return parsed;
    }

    async listEvaluationRuns(workspaceId: string): Promise<EvaluationRun[]> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.evaluationRuns.filter((item) => item.workspaceId === workspaceId);
    }

    async getEvaluationRun(workspaceId: string, evaluationRunId: string): Promise<EvaluationRun> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return findScoped(state.evaluationRuns, workspaceId, evaluationRunId, "evaluation run");
    }

    async findEvaluationRunByIdempotency(
        workspaceId: string,
        suiteId: string,
        idempotencyKey: string,
    ): Promise<EvaluationRun | undefined> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.evaluationRuns.find((candidate) =>
            candidate.workspaceId === workspaceId
            && candidate.suiteId === suiteId
            && candidate.idempotencyKey === idempotencyKey);
    }

    async saveEvaluationExport(item: PersistedEvaluationExport): Promise<PersistedEvaluationExport> {
        const parsed = PersistedEvaluationExportSchema.parse(item);
        await this.store.transact((state) => {
            findOwnedWorkspace(state, parsed.workspaceId, this.ownerId);
            findScoped(state.evaluationRuns, parsed.workspaceId, parsed.runId, "evaluation run");
            upsert(state.evaluationExports, parsed);
        });
        return parsed;
    }

    async getEvaluationExport(
        workspaceId: string,
        runId: string,
        exportId: string,
    ): Promise<PersistedEvaluationExport> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        const item = state.evaluationExports.find((candidate) =>
            candidate.id === exportId && candidate.workspaceId === workspaceId && candidate.runId === runId);
        if (!item) throw new RepositoryNotFoundError("evaluation export", exportId);
        return item;
    }

    async findEvaluationExportByIdempotency(
        workspaceId: string,
        runId: string,
        idempotencyKey: string,
    ): Promise<PersistedEvaluationExport | undefined> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.evaluationExports.find((candidate) =>
            candidate.workspaceId === workspaceId
            && candidate.runId === runId
            && candidate.idempotencyKey === idempotencyKey);
    }

    async saveExecution(execution: PersistedExecution): Promise<PersistedExecution> {
        const parsed = ExecutionSchema.parse(execution);
        const { result } = await this.store.transact((state) => {
            findOwnedWorkspace(state, parsed.workspaceId, this.ownerId);
            findScoped(state.servers, parsed.workspaceId, parsed.serverId, "MCP server");
            const saved = {
                ...parsed,
                streamEventId: executionStreamHighWater(state.executions) + 1,
            };
            upsert(state.executions, saved);
            return saved;
        });
        return result;
    }

    async listExecutions(workspaceId: string, serverId: string): Promise<PersistedExecution[]> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        findScoped(state.servers, workspaceId, serverId, "MCP server");
        return state.executions.filter(
            (item) => item.workspaceId === workspaceId && item.serverId === serverId,
        );
    }

    async findExecutionByIdempotency(
        workspaceId: string,
        serverId: string,
        idempotencyKey: string,
    ): Promise<PersistedExecution | undefined> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        findScoped(state.servers, workspaceId, serverId, "MCP server");
        return state.executions.find((candidate) =>
            candidate.workspaceId === workspaceId
            && candidate.serverId === serverId
            && candidate.idempotency?.key === idempotencyKey);
    }

    async getPreferences(workspaceId: string): Promise<WorkspacePreferences> {
        const state = await this.store.read();
        findOwnedWorkspace(state, workspaceId, this.ownerId);
        return state.preferences[workspaceId] ?? {};
    }

    async savePreferences(workspaceId: string, preferences: WorkspacePreferences): Promise<WorkspacePreferences> {
        const parsed = PreferencesSchema.parse(preferences);
        await this.store.transact((state) => {
            findOwnedWorkspace(state, workspaceId, this.ownerId);
            state.preferences[workspaceId] = parsed;
        });
        return parsed;
    }

    private registerConnectionSecrets(configuration: PersistedConnectionDefinition): void {
        const names = configuration.kind === "stdio"
            ? configuration.environment.map((reference) => reference.secret.environmentVariable)
            : configuration.kind === "streamable_http" || configuration.kind === "sse"
              ? configuration.headers.map((reference) => reference.secret.environmentVariable)
              : [];
        this.redactor.registerSecretValues(names.flatMap((name) => {
            const value = this.environment[name];
            return value === undefined || value.length === 0 ? [] : [value];
        }));
    }
}

function initialState(ownerId: string, now: Date): WorkbenchState {
    const timestamp = now.toISOString();
    return {
        version: STATE_VERSION,
        workspaces: [WorkspaceSchema.parse({
            id: "default",
            ownerId,
            name: DEFAULT_WORKSPACE_NAME,
            createdAt: timestamp,
            updatedAt: timestamp,
        })],
        servers: [],
        testCases: [],
        suites: [],
        evaluationRuns: [],
        evaluationExports: [],
        executions: [],
        preferences: {},
    };
}

function reconcileExecution(execution: PersistedExecution, completedAt: string): PersistedExecution {
    const evidence = execution.evidence;
    if (!isRecoverableExecutionRecord(evidence)
        || evidence.id !== execution.id
        || evidence.workspaceId !== execution.workspaceId
        || evidence.serverId !== execution.serverId
        || evidence.status !== execution.status) {
        throw new Error(`Interrupted execution '${execution.id}' has invalid durable evidence.`);
    }
    const {
        completedAt: _completedAt,
        durationMs: _durationMs,
        result: _result,
        error: _error,
        cancelledAt: _cancelledAt,
        ...preserved
    } = evidence;
    const startedAtMs = evidence.startedAt === undefined ? undefined : Date.parse(evidence.startedAt);
    const completedAtMs = Date.parse(completedAt);
    const recovered: ExecutionRecord = {
        ...preserved,
        status: "failed",
        completedAt,
        ...(startedAtMs === undefined || !Number.isFinite(startedAtMs)
            ? {}
            : { durationMs: Math.max(0, completedAtMs - startedAtMs) }),
        error: {
            category: "internal",
            code: "execution_interrupted",
            message: "Execution was interrupted by a runner restart.",
            occurredAt: completedAt,
            retryable: true,
        },
    };
    return {
        ...execution,
        status: "failed",
        completedAt,
        evidence: recovered,
    };
}

function reconcileEvaluationRun(run: EvaluationRun, completedAt: string): EvaluationRun {
    const accounted = run.summary.passed
        + run.summary.failed
        + run.summary.errors
        + run.summary.skipped;
    const errors = run.summary.errors + Math.max(0, run.summary.total - accounted);
    const eligible = run.summary.passed + run.summary.failed;
    const attempted = eligible + errors;
    return {
        ...run,
        status: "failed",
        completedAt,
        summary: {
            ...run.summary,
            errors,
            successRate: eligible === 0 ? 0 : run.summary.passed / eligible,
            reliability: attempted === 0 ? 0 : eligible / attempted,
        },
        error: {
            category: "internal",
            code: "evaluation_interrupted",
            message: "Evaluation was interrupted by a runner restart.",
            occurredAt: completedAt,
            retryable: true,
        },
    };
}

function isActiveExecutionStatus(status: string): status is "queued" | "running" | "cancelling" {
    return status === "queued" || status === "running" || status === "cancelling";
}

function isRecoverableExecutionRecord(value: unknown): value is ExecutionRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const candidate = value as Partial<ExecutionRecord>;
    const request = candidate.request;
    const correlation = candidate.correlation;
    return typeof candidate.id === "string"
        && typeof candidate.workspaceId === "string"
        && typeof candidate.serverId === "string"
        && isActiveExecutionStatus(String(candidate.status))
        && typeof candidate.createdAt === "string"
        && Number.isSafeInteger(candidate.attemptCount)
        && Number.isSafeInteger(candidate.retryCount)
        && typeof request === "object"
        && request !== null
        && typeof request.toolName === "string"
        && typeof request.idempotencyKey === "string"
        && typeof request.timeoutMs === "number"
        && typeof request.arguments === "object"
        && request.arguments !== null
        && !Array.isArray(request.arguments)
        && typeof correlation === "object"
        && correlation !== null
        && typeof correlation.executionId === "string";
}

function executionStreamHighWater(executions: readonly PersistedExecution[]): number {
    return executions.reduce(
        (highest, execution) => Math.max(highest, execution.streamEventId ?? 0),
        0,
    );
}

function validateState(state: WorkbenchState, ownerId: string): WorkbenchState {
    if (!state.workspaces.some((workspace) => workspace.ownerId === ownerId)) {
        throw new Error("Persisted qyl.mcp state has no workspace for the authenticated owner.");
    }
    const workspaceIds = new Set<string>(state.workspaces.map((workspace) => workspace.id));
    if (workspaceIds.size !== state.workspaces.length) throw new Error("Workspace identifiers must be unique.");
    const serverIds = new Set(state.servers.map((server) => server.id));
    if (serverIds.size !== state.servers.length) throw new Error("Server identifiers must be unique.");
    const executionStreamEventIds = state.executions
        .map((execution) => execution.streamEventId)
        .filter((eventId): eventId is number => eventId !== undefined);
    if (new Set(executionStreamEventIds).size !== executionStreamEventIds.length) {
        throw new Error("Execution stream event identifiers must be unique.");
    }
    for (const server of state.servers) {
        if (!workspaceIds.has(server.workspaceId)) throw new Error("A server references an unknown workspace.");
    }
    validateConnections(state.servers);
    return state;
}

function validateConnections(servers: readonly ServerRecord[]): void {
    for (const server of servers) validateConnection(server.configuration);
}

function redactPersistedState(state: WorkbenchState, redactor: SecretRedactor): WorkbenchState {
    const withoutConfigurations = {
        ...state,
        servers: state.servers.map(({ configuration: _configuration, ...server }) => server),
    };
    const sanitized = redactor.redact(withoutConfigurations) as Omit<WorkbenchState, "servers"> & {
        servers: Array<Omit<ServerRecord, "configuration">>;
    };
    return {
        ...sanitized,
        servers: sanitized.servers.map((server, index) => ({
            ...server,
            configuration: redactConnection(state.servers[index]!.configuration, redactor),
        })),
    };
}

function redactConnection(
    configuration: PersistedConnectionDefinition,
    redactor: SecretRedactor,
): PersistedConnectionDefinition {
    if (configuration.kind === "builtin") {
        return { ...configuration, builtin: redactor.redactText(configuration.builtin) };
    }
    if (configuration.kind === "inproc") {
        return { ...configuration, implementation: redactor.redactText(configuration.implementation) };
    }
    if (configuration.kind === "stdio") {
        return {
            ...configuration,
            command: redactor.redactText(configuration.command),
            args: configuration.args.map((argument) => redactor.redactText(argument)),
            ...(configuration.cwd === undefined
                ? {}
                : { cwd: redactor.redactText(configuration.cwd) }),
            environment: configuration.environment.map((reference) => structuredClone(reference)),
        };
    }
    return {
        ...configuration,
        endpoint: redactor.redactUri(configuration.endpoint),
        headers: configuration.headers.map((reference) => structuredClone(reference)),
    };
}

function validateConnection(configuration: PersistedConnectionDefinition): void {
    if (configuration.kind === "streamable_http" || configuration.kind === "sse") {
        const endpoint = new URL(configuration.endpoint);
        if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
            throw new Error("Remote MCP endpoints must use HTTP or HTTPS.");
        }
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
            throw new Error("Remote MCP endpoints cannot embed credentials, query values, or fragments.");
        }
        for (const header of configuration.headers) {
            if (/^(cookie|set-cookie)$/iu.test(header.header)) {
                throw new Error("Persistent Cookie header configuration is not supported.");
            }
        }
        return;
    }
    if (configuration.kind === "stdio") {
        const serialized = [configuration.command, ...configuration.args].join(" ");
        if (/(?:^|\s)--?(?:api[-_]?key|authorization|password|secret|token)(?:=|\s|$)|\bbearer\s+\S+/iu.test(serialized)) {
            throw new Error("Stdio commands cannot contain plaintext credential arguments; use environment references.");
        }
    }
}

function assertWorkspaceDeletable(
    state: WorkbenchState,
    workspaceId: string,
    ownerId: string,
): WorkspaceRecord {
    const workspace = findOwnedWorkspace(state, workspaceId, ownerId);
    if (state.workspaces.filter((item) => item.ownerId === ownerId).length === 1) {
        throw new RepositoryConflictError("The final workspace cannot be deleted.");
    }
    if (state.executions.some((execution) => execution.workspaceId === workspaceId
        && isActiveExecutionStatus(execution.status))) {
        throw new RepositoryConflictError("A workspace with active executions cannot be deleted.");
    }
    if (state.evaluationRuns.some((run) => run.workspaceId === workspaceId
        && (run.status === "queued" || run.status === "running"))) {
        throw new RepositoryConflictError("A workspace with active evaluation runs cannot be deleted.");
    }
    return workspace;
}

function assertServerDeletable(
    state: WorkbenchState,
    workspaceId: string,
    serverId: string,
    ownerId: string,
): ServerRecord {
    findOwnedWorkspace(state, workspaceId, ownerId);
    const server = findScoped(state.servers, workspaceId, serverId, "MCP server");
    if (state.testCases.some((item) => item.workspaceId === workspaceId && item.serverId === serverId)) {
        throw new RepositoryConflictError("Delete test cases that reference this server first.");
    }
    if (state.executions.some((execution) => execution.workspaceId === workspaceId
        && execution.serverId === serverId
        && isActiveExecutionStatus(execution.status))) {
        throw new RepositoryConflictError("An MCP server with active executions cannot be deleted.");
    }
    const executionIds = new Set(state.executions
        .filter((execution) => execution.workspaceId === workspaceId && execution.serverId === serverId)
        .map((execution) => execution.id));
    if (state.evaluationRuns.some((run) => run.workspaceId === workspaceId
        && (run.testCases?.some((testCase) => testCase.serverId === serverId)
            || run.results.some((result) => result.executionId !== undefined
                && executionIds.has(result.executionId))))) {
        throw new RepositoryConflictError(
            "An MCP server referenced by evaluation evidence cannot be deleted.",
        );
    }
    return server;
}

function findOwnedWorkspace(state: WorkbenchState, id: string, ownerId: string): WorkspaceRecord {
    const workspace = state.workspaces.find((item) => item.id === id && item.ownerId === ownerId);
    if (!workspace) throw new RepositoryNotFoundError("workspace", id);
    return workspace;
}

function findScoped<T extends { id: string; workspaceId: string }>(
    values: readonly T[],
    workspaceId: string,
    id: string,
    kind: string,
): T {
    const value = values.find((item) => item.id === id && item.workspaceId === workspaceId);
    if (!value) throw new RepositoryNotFoundError(kind, id);
    return value;
}

function upsert<T extends { id: string }>(values: T[], value: T): void {
    const index = values.findIndex((item) => item.id === value.id);
    if (index < 0) values.push(value);
    else values[index] = value;
}

function defaultStatePath(): string {
    return process.env.QYL_MCP_STATE_PATH ?? join(homedir(), ".qyl", "mcp-workbench.json");
}
