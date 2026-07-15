import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import type * as QylContracts from "@ancplua/qyl-api-schema/types";
import { z } from "zod";
import {
    RunnerMcpEvaluationExportIdSchema,
    RunnerMcpEvaluationJsonExportPayloadSchema,
    RunnerMcpEvaluationReportExportPayloadSchema,
    RunnerMcpEvaluationExportSchema,
    RunnerMcpEvaluationRunComparisonSchema,
    RunnerMcpEvaluationRunIdSchema,
    RunnerMcpEvaluationRunSchema,
    RunnerMcpEvaluationRunStatusSchema as EvaluationRunStatusSchema,
    RunnerMcpEvaluationSummarySchema,
    RunnerMcpEvaluationTestCaseSnapshotSchema,
    RunnerMcpExecutionIdSchema,
    RunnerMcpExecutionRecordSchema,
    RunnerMcpExecutionStatusSchema as ExecutionStatusSchema,
    RunnerMcpDiscoverySnapshotSchema,
    RunnerMcpConnectionSnapshotSchema,
    RunnerMcpInitializationSnapshotSchema,
    RunnerMcpProtocolEventSchema,
    RunnerMcpServerIdSchema,
    RunnerMcpServerConfigurationSchema,
    RunnerMcpServerSchema,
    RunnerMcpTestCaseIdSchema,
    RunnerMcpTestCaseSchema,
    RunnerMcpSuiteIdSchema,
    RunnerMcpTestSuiteSchema,
    RunnerMcpWorkspaceIdSchema,
    RunnerMcpWorkspacePreferencesSchema,
    RunnerMcpWorkbenchSessionSchema,
    publishedContractSchema,
} from "qyl-mcp-server/contract-validation";
import type { McpResource } from "./resources.js";
import {
    ConnectionManager,
    ConnectionManagerError,
    type ActiveConnectionProtocolOperation,
    type CompletedConnectionSession,
    type ConnectionDefinition,
    type ConnectionInitializationSnapshot,
    type ConnectionProtocolOperation,
    type ConnectionSnapshot,
    type StartedConnectionProtocolOperation,
} from "./connection-manager.js";
import {
    ExecutionConflictError,
    ExecutionNotFoundError,
    ExecutionService,
    ExecutionValidationError,
    type ExecutionRecord,
} from "./execution-service.js";
import {
    EvaluationEngine,
    compareEvaluationRuns,
    exportEvaluationReport,
    type EvaluationInvocationEvidence,
    type EvaluationRun,
    type WorkbenchSuite,
    type WorkbenchTestCase,
} from "./evaluation-engine.js";
import type { ExecutionOutcome } from "./assertions.js";
import type { ProtocolJournalEntry } from "./protocol-journal.js";
import { RunnerSessionManager, type RunnerSessionIdentity } from "./session-manager.js";
import { WorkbenchCorrelationRegistry } from "./observability-correlation.js";
import { QylObservabilityProvider } from "./qyl-observability.js";
import { McpTelemetry } from "./telemetry.js";
import { SecretRedactor } from "./secret-redactor.js";
import { LegacyResourceAdapter, type LegacyResourceBinding } from "./legacy-resource-adapter.js";
import { LogStore } from "./log-store.js";
import {
    RepositoryConflictError,
    RepositoryNotFoundError,
    WorkbenchRepository,
    type PersistedConnectionDefinition,
    type PersistedSuite,
    type PersistedTestCase,
    type ServerRecord,
    type WorkspacePreferences,
} from "./workbench-repository.js";
import {
    sendBadGateway,
    sendConflict,
    sendInternalServerError,
    sendNotFound,
    sendUnauthorized,
    sendValidationProblem,
} from "./problems.js";

type ExternalServerConfiguration = QylContracts.RunnerMcpServerConfiguration;

const ContractIdSchemas: Readonly<Record<string, z.ZodType<string>>> = {
    workspaceId: RunnerMcpWorkspaceIdSchema,
    serverId: RunnerMcpServerIdSchema,
    executionId: RunnerMcpExecutionIdSchema,
    testCaseId: RunnerMcpTestCaseIdSchema,
    suiteId: RunnerMcpSuiteIdSchema,
    evaluationRunId: RunnerMcpEvaluationRunIdSchema,
    exportId: RunnerMcpEvaluationExportIdSchema,
};
const AUTO_CONNECT_CONCURRENCY = 4;

const ProtocolSseEvent = requirePublishedSseEvent(
    qylOpenApi.paths["/runner/workspaces/{workspaceId}/servers/{serverId}/protocol/stream"]
        .get.responses["200"].content["text/event-stream"].itemSchema.oneOf[0].properties.event.const,
);
const ExecutionSseEvent = requirePublishedSseEvent(
    qylOpenApi.paths["/runner/workspaces/{workspaceId}/servers/{serverId}/executions/stream"]
        .get.responses["200"].content["text/event-stream"].itemSchema.oneOf[0].properties.event.const,
);

export interface WorkbenchApiOptions {
    repository?: WorkbenchRepository;
    sessions?: RunnerSessionManager;
    now?: () => Date;
    telemetry?: McpTelemetry;
    observability?: QylObservabilityProvider;
    environment?: Readonly<Record<string, string | undefined>>;
    redactor?: SecretRedactor;
    logStore?: LogStore;
}

interface DetachedServer {
    server: ServerRecord;
    reconnect: boolean;
}

/** Runtime owner for the generated Qyl MCP workbench HTTP surface. */
export class WorkbenchApi {
    readonly repository: WorkbenchRepository;
    readonly sessions: RunnerSessionManager;
    readonly connections: ConnectionManager;
    readonly executions: ExecutionService;
    readonly evaluations: EvaluationEngine;
    readonly correlations: WorkbenchCorrelationRegistry;
    readonly telemetry: McpTelemetry;
    readonly observability: QylObservabilityProvider;
    readonly legacyResources: LegacyResourceAdapter;

    private readonly now: () => Date;
    private readonly redactor: SecretRedactor;
    private readonly changedAt = new Map<string, string>();
    private readonly evaluationIdempotency = new Map<string, string>();
    private readonly workspaceMutations = new WorkspaceReadWriteLock();
    private autoConnectController: AbortController | undefined;
    private autoConnectPromise: Promise<void> | undefined;

    constructor(
        private readonly resources: readonly McpResource[],
        options: WorkbenchApiOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        const environment = managedResourceEnvironment(
            resources,
            options.environment ?? process.env,
        );
        const redactor = options.redactor ?? new SecretRedactor({
            environment,
            maxStringLength: 1_000_000,
        });
        this.redactor = redactor;
        this.repository = options.repository ?? new WorkbenchRepository({
            now: this.now,
            environment,
            redactor,
        });
        this.sessions = options.sessions ?? new RunnerSessionManager();
        this.correlations = new WorkbenchCorrelationRegistry({ redactor });
        this.telemetry = options.telemetry ?? new McpTelemetry(environment, redactor);
        this.observability = options.observability ?? new QylObservabilityProvider({
            environment,
            redactor,
        });
        let executions: ExecutionService | undefined;
        this.connections = new ConnectionManager({
            environment,
            redactor,
            onSecretsResolved: (_serverId, values) => this.repository.registerSecretValues(values),
            correlation: (serverId) => executions?.correlationFor(serverId),
            onOperationStart: (operation) => this.startProtocolOperation(operation),
            onOperation: (operation) => this.recordProtocolOperation(operation),
            onSession: (session) => this.recordProtocolSession(session),
            now: () => this.now().getTime(),
        });
        this.legacyResources = new LegacyResourceAdapter(
            resources,
            this.connections,
            options.logStore ?? new LogStore(),
            this.now,
        );
        this.executions = executions = new ExecutionService(this.connections, {
            persistence: this.repository,
            redactor,
            now: () => this.now().getTime(),
            telemetry: this.telemetry,
            correlations: this.correlations,
        });
        this.evaluations = new EvaluationEngine({
            invoke: (request) => this.invokeForEvaluation(request),
        }, this.now);
        this.connections.subscribe((snapshot) => {
            this.changedAt.set(snapshot.id, this.now().toISOString());
        });
    }

    private recordProtocolOperation(operation: ConnectionProtocolOperation): void {
        const executionId = operation.correlation?.executionId;
        if (executionId === undefined || operation.requestId === undefined) return;
        this.correlations.linkMcpRequest({
            executionId,
            serverId: operation.connectionId,
            requestId: operation.requestId,
            method: operation.method,
        });
    }

    private startProtocolOperation(
        operation: StartedConnectionProtocolOperation,
    ): ActiveConnectionProtocolOperation | undefined {
        // ExecutionService owns the correlated client tools/call span because it
        // also classifies CallToolResult.isError. The journal still injects its
        // execution-local carrier and records the request/response evidence.
        if (operation.role === "client"
            && operation.method === "tools/call"
            && operation.correlation?.executionId !== undefined) {
            return undefined;
        }
        const active = this.telemetry.startOperation({
            role: operation.role,
            method: operation.method,
            transport: operation.transport,
            protocolVersion: operation.protocolVersion,
            mcpSessionId: operation.mcpSessionId,
            jsonRpcProtocolVersion: "2.0",
            peerAddress: operation.peerAddress,
            peerPort: operation.peerPort,
            toolName: operation.toolName,
            promptName: operation.promptName,
            resourceUri: operation.resourceUri,
            serverId: operation.connectionId,
            executionId: operation.correlation?.executionId,
            evaluationRunId: operation.correlation?.evaluationRunId,
            testCaseId: operation.correlation?.testCaseId,
            startTimeMs: operation.startTimeMs,
            ...(operation.remotePropagation === undefined
                ? {}
                : { remotePropagation: operation.remotePropagation }),
        });
        return {
            ...(active.propagation === undefined ? {} : { propagation: active.propagation }),
            run: (dispatch) => active.run(dispatch),
            complete: (completed) => {
                const span = active.end({
                    endTimeMs: completed.endTimeMs,
                    protocolVersion: completed.protocolVersion,
                    mcpSessionId: completed.mcpSessionId,
                    errorType: completed.errorType,
                    rpcResponseStatusCode: completed.rpcResponseStatusCode,
                    jsonRpcRequestId: completed.requestId,
                });
                const executionId = completed.correlation?.executionId;
                if (executionId !== undefined && span !== undefined) {
                    this.correlations.linkTelemetry(executionId, span.traceId, span.spanId);
                }
            },
        };
    }

    private recordProtocolSession(session: CompletedConnectionSession): void {
        this.telemetry.recordSession({
            role: session.role,
            transport: session.transport,
            protocolVersion: session.protocolVersion,
            jsonRpcProtocolVersion: "2.0",
            peerAddress: session.peerAddress,
            peerPort: session.peerPort,
            errorType: session.errorType,
            startTimeMs: session.startTimeMs,
            endTimeMs: session.endTimeMs,
        });
    }

    async initialize(): Promise<void> {
        await this.repository.initialize();
        await this.repository.reconcileInterruptedWork();
        for (const resource of this.resources) {
            if (resource.kind === "inproc") this.connections.registerBuiltin(resource.name, resource.serverFactory);
        }
        const workspaces = await this.repository.listWorkspaces();
        const defaultWorkspace = workspaces.find((workspace) => workspace.id === "default") ?? workspaces[0];
        if (!defaultWorkspace) throw new Error("The workbench has no local workspace.");

        const existing = await this.repository.listServers(defaultWorkspace.id);
        const managedBindings: LegacyResourceBinding[] = [];
        for (const resource of this.resources) {
            const configuration = resourceToPersistedConfiguration(resource);
            const matches = existing.filter((server) => server.name === resource.name);
            if (matches.length > 1) {
                throw new RepositoryConflictError(
                    `Managed MCP resource '${resource.name}' matches multiple persisted servers in the default workspace.`,
                );
            }
            const persisted = matches[0];
            if (persisted !== undefined) {
                if (!samePersistedConfiguration(persisted.configuration, configuration)) {
                    throw new RepositoryConflictError(
                        `Managed MCP resource '${resource.name}' conflicts with a persisted server that has different configuration.`,
                    );
                }
                if (!persisted.autoConnect) {
                    throw new RepositoryConflictError(
                        `Managed MCP resource '${resource.name}' conflicts with a persisted server that has automatic connection disabled.`,
                    );
                }
                managedBindings.push({ resource, server: persisted });
                continue;
            }
            const server = await this.repository.createServer(defaultWorkspace.id, {
                name: resource.name,
                configuration,
                autoConnect: true,
            });
            existing.push(server);
            managedBindings.push({ resource, server });
        }
        this.legacyResources.bind(managedBindings);

        for (const workspace of await this.repository.listWorkspaces()) {
            for (const server of await this.repository.listServers(workspace.id)) {
                if (!this.connections.has(server.id)) this.connections.register(toConnectionDefinition(server));
                this.executions.restorePersisted(
                    await this.repository.listExecutions(workspace.id, server.id),
                );
            }
        }
    }

    startAutoConnect(): Promise<void> {
        if (this.autoConnectPromise !== undefined) return this.autoConnectPromise;
        const controller = new AbortController();
        this.autoConnectController = controller;
        this.autoConnectPromise = this.runAutoConnect(controller.signal);
        return this.autoConnectPromise;
    }

    private async runAutoConnect(signal: AbortSignal): Promise<void> {
        const servers = (await Promise.all((await this.repository.listWorkspaces()).map(
            (workspace) => this.repository.listServers(workspace.id),
        ))).flat().filter((server) =>
            server.autoConnect && !this.legacyResources.isManagedServer(server.workspaceId, server.id));
        const managed = this.legacyResources.startAutoConnect(signal);
        let next = 0;
        const worker = async (): Promise<void> => {
            while (!signal.aborted) {
                const server = servers[next++];
                if (server === undefined) return;
                if (!this.connections.has(server.id)) continue;
                const lifecycle = this.connections.get(server.id).lifecycle;
                if (lifecycle !== "disconnected" && lifecycle !== "failed") continue;
                try {
                    await this.connections.connect(server.id, { signal });
                } catch {
                    if (!signal.aborted) {
                        console.error(
                            `Workbench auto-connect failed for '${server.id}'; the sanitized connection error is available in its status.`,
                        );
                    }
                }
            }
        };
        await Promise.all([
            managed,
            ...Array.from(
                { length: Math.min(AUTO_CONNECT_CONCURRENCY, servers.length) },
                worker,
            ),
        ]);
    }

    async close(): Promise<void> {
        this.autoConnectController?.abort();
        if (this.autoConnectPromise !== undefined) {
            try {
                await this.autoConnectPromise;
            } catch {
                console.error("Workbench auto-connect shutdown failed after cancellation.");
            }
        }
        await Promise.all(this.connections.list().map(async (snapshot) => {
            if (snapshot.lifecycle === "disconnected") return;
            try {
                await this.connections.disconnect(snapshot.id);
            } catch {
                console.error(
                    `Workbench shutdown could not disconnect '${snapshot.id}'; the sanitized connection error is available in its status.`,
                );
            }
        }));
        this.legacyResources.dispose();
        await this.telemetry.close();
    }

    register(app: Express): void {
        app.post("/runner/session", this.route(async (_request, response) => {
            const created = this.sessions.create();
            response.setHeader("Set-Cookie", created.setCookie);
            response.setHeader("Cache-Control", "no-store");
            response.json(await this.sessionResponse(created.identity));
        }));

        app.use("/runner", (request, response, next) => {
            const session = this.sessions.authenticate(request.headers.cookie);
            if (!session) {
                sendUnauthorized(response);
                return;
            }
            response.locals.runnerSession = session;
            response.setHeader("Cache-Control", "no-store");
            next();
        });

        app.get("/runner/session", this.route(async (_request, response) => {
            response.json(await this.sessionResponse(response.locals.runnerSession as RunnerSessionIdentity));
        }));

        this.registerWorkspaceRoutes(app);
        this.registerServerRoutes(app);
        this.registerExecutionRoutes(app);
        this.registerTestRoutes(app);
        this.registerEvaluationRoutes(app);
    }

    private registerWorkspaceRoutes(app: Express): void {
        app.get("/runner/workspaces", this.route(async (_request, response) => {
            response.json({ workspaces: await this.repository.listWorkspaces() });
        }));
        app.post("/runner/workspaces", this.route(async (request, response) => {
            const body = parseBody<QylContracts.RunnerMcpWorkspaceCreateRequest>(request);
            response.json(await this.repository.createWorkspace(body));
        }));
        app.get("/runner/workspaces/:workspaceId", this.route(async (request, response) => {
            response.json(await this.repository.getWorkspace(param(request, "workspaceId")));
        }));
        app.patch("/runner/workspaces/:workspaceId", this.route(async (request, response) => {
            const body = parseBody<QylContracts.RunnerMcpWorkspaceUpdateRequest>(request);
            requireNonEmptyPatch(body);
            response.json(await this.repository.updateWorkspace(param(request, "workspaceId"), body));
        }));
        app.delete("/runner/workspaces/:workspaceId", this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            if (this.legacyResources.workspaceHasManagedServers(workspaceId)) {
                throw new RepositoryConflictError(
                    "A workspace containing managed bootstrap MCP servers cannot be deleted.",
                );
            }
            const servers = await this.repository.listServers(workspaceId);
            await this.repository.ensureWorkspaceDeletable(workspaceId);
            for (const server of servers) {
                this.executions.ensureServerForgettable(workspaceId, server.id);
            }
            const detached = await this.detachServers(servers);
            try {
                await this.repository.deleteWorkspace(workspaceId);
            } catch (error) {
                await this.restoreDetachedServers(detached);
                throw error;
            }
            for (const server of servers) this.executions.forgetServer(workspaceId, server.id);
            response.status(204).end();
        }, "exclusive"));
        app.get("/runner/workspaces/:workspaceId/preferences", this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            response.json(preferencesResponse(workspaceId, await this.repository.getPreferences(workspaceId), this.now()));
        }));
        app.put("/runner/workspaces/:workspaceId/preferences", this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const body = parseBody<QylContracts.RunnerMcpWorkspacePreferencesUpdateRequest>(request);
            if (body.selectedServerId !== undefined) await this.repository.getServer(workspaceId, body.selectedServerId);
            const saved = await this.repository.savePreferences(workspaceId, {
                ...body,
                updatedAt: this.now().toISOString(),
            });
            response.json(preferencesResponse(workspaceId, saved, this.now()));
        }));
    }

    private registerServerRoutes(app: Express): void {
        const base = "/runner/workspaces/:workspaceId/servers";
        app.get(base, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            response.json({ servers: (await this.repository.listServers(workspaceId)).map((server) => this.serverResponse(server)) });
        }));
        app.post(base, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const body = parseBody<QylContracts.RunnerMcpServerCreateRequest>(request);
            const server = await this.repository.createServer(workspaceId, {
                name: body.name,
                ...(body.description === undefined ? {} : { description: body.description }),
                configuration: toPersistedConfiguration(body.configuration),
                autoConnect: body.autoConnect ?? false,
            });
            this.connections.register(toConnectionDefinition(server));
            if (server.autoConnect) {
                try {
                    await this.connections.connect(server.id);
                } catch {
                    console.error(
                        `Workbench auto-connect failed for newly created server '${server.id}'; its failed status was retained.`,
                    );
                }
            }
            response.json(this.serverResponse(server));
        }));
        app.get(`${base}/:serverId`, this.route(async (request, response) => {
            response.json(this.serverResponse(await this.scopedServer(request)));
        }));
        app.patch(`${base}/:serverId`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const serverId = param(request, "serverId");
            this.requireMutableServer(workspaceId, serverId);
            const previous = await this.repository.getServer(workspaceId, serverId);
            const body = parseBody<QylContracts.RunnerMcpServerUpdateRequest>(request);
            requireNonEmptyPatch(body);
            const updated = await this.repository.updateServer(workspaceId, serverId, {
                ...(body.name === undefined ? {} : { name: body.name }),
                ...(body.description === undefined ? {} : { description: body.description }),
                ...(body.configuration === undefined ? {} : { configuration: toPersistedConfiguration(body.configuration) }),
            });
            if (body.configuration !== undefined) {
                const wasConnected = this.connections.has(serverId)
                    && this.connections.get(serverId).lifecycle === "connected";
                try {
                    if (this.connections.has(serverId)) await this.connections.unregister(serverId);
                    this.connections.register(toConnectionDefinition(updated));
                    if (wasConnected) await this.connections.connect(serverId);
                } catch (error) {
                    await this.repository.restoreServer(previous);
                    try {
                        if (this.connections.has(serverId)) await this.connections.unregister(serverId);
                        this.connections.register(toConnectionDefinition(previous));
                        if (wasConnected) await this.connections.connect(serverId);
                    } catch {
                        console.error(
                            `Workbench could not restore runtime server '${serverId}' after a failed configuration update.`,
                        );
                    }
                    throw error;
                }
            }
            response.json(this.serverResponse(updated));
        }));
        app.delete(`${base}/:serverId`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const serverId = param(request, "serverId");
            this.requireMutableServer(workspaceId, serverId);
            const server = await this.repository.getServer(workspaceId, serverId);
            await this.repository.ensureServerDeletable(workspaceId, serverId);
            this.executions.ensureServerForgettable(workspaceId, serverId);
            const detached = await this.detachServers([server]);
            try {
                await this.repository.deleteServer(workspaceId, serverId);
            } catch (error) {
                await this.restoreDetachedServers(detached);
                throw error;
            }
            this.executions.forgetServer(workspaceId, serverId);
            response.status(204).end();
        }, "exclusive"));

        for (const action of ["connect", "disconnect", "reconnect"] as const) {
            app.post(`${base}/:serverId/${action}`, this.route(async (request, response) => {
                const server = await this.scopedServer(request);
                if (action === "connect") await this.connections.connect(server.id);
                else if (action === "disconnect") await this.connections.disconnect(server.id);
                else await this.connections.reconnect(server.id);
                response.status(202).json({ server: this.serverResponse(server) });
            }));
        }
        app.get(`${base}/:serverId/discovery`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            response.json(this.discoveryResponse(server.id, this.connections.get(server.id)));
        }));
        app.post(`${base}/:serverId/discovery/refresh`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            response.json(this.discoveryResponse(server.id, await this.connections.refreshDiscovery(server.id)));
        }));
        app.get(`${base}/:serverId/protocol`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const entries = this.connections.getJournal(server.id)?.snapshot() ?? [];
            const page = paginate(entries.map((entry) => protocolEvent(server.id, entry)), request, 200);
            response.json({ events: page.items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.get(`${base}/:serverId/protocol/stream`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const lastEventId = parseLastEventId(request.headers["last-event-id"]);
            openSse(response);
            const journal = this.connections.getJournal(server.id);
            if (!journal) return;
            const unsubscribe = subscribeSequencedSse(
                lastEventId,
                () => journal.snapshot(),
                (push) => journal.subscribe(push),
                (entry) => writeSse(
                    response,
                    protocolEvent(server.id, entry),
                    RunnerMcpProtocolEventSchema,
                    ProtocolSseEvent,
                    String(entry.sequence),
                ),
            );
            request.on("close", unsubscribe);
        }));
    }

    private registerExecutionRoutes(app: Express): void {
        const base = "/runner/workspaces/:workspaceId/servers/:serverId/executions";
        app.get(base, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const requestedStatus = optionalString(request.query.status);
            if (requestedStatus !== undefined && !ExecutionStatusSchema.safeParse(requestedStatus).success) {
                throw new RequestValidationError("status", "Unknown execution status.");
            }
            const memory = this.executions.list(server.workspaceId, server.id);
            const persisted = (await this.repository.listExecutions(server.workspaceId, server.id))
                .map((item) => item.evidence)
                .filter((item): item is ExecutionRecord => isExecutionRecord(item));
            const byId = new Map([...persisted, ...memory].map((record) => [record.id, record]));
            const filtered = [...byId.values()].filter((record) => requestedStatus === undefined || record.status === requestedStatus);
            const page = paginate(filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), request, 100);
            response.json({ executions: page.items.map(executionResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.post(base, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const body = parseBody<QylContracts.RunnerMcpExecutionRequest>(request);
            const execution = await this.executions.start({
                workspaceId: server.workspaceId,
                serverId: server.id,
                toolName: body.toolName,
                arguments: body.arguments,
                timeoutMs: body.timeoutMs,
                idempotencyKey: body.idempotencyKey,
                ...(body.confirmation === undefined ? {} : { confirmation: body.confirmation }),
            });
            response.status(202).json({ execution: executionResponse(execution) });
        }));
        app.get(`${base}/stream`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const executionId = optionalString(request.query.executionId);
            if (executionId !== undefined) await this.findExecution(server.workspaceId, server.id, executionId);
            const lastEventId = parseLastEventId(request.headers["last-event-id"]);
            openSse(response);
            const unsubscribe = subscribeSequencedSse(
                lastEventId,
                () => this.executions.streamSnapshot(server.workspaceId, server.id),
                (push) => this.executions.subscribeStream(push),
                (event) => writeSse(
                    response,
                    executionResponse(event.execution),
                    RunnerMcpExecutionRecordSchema,
                    ExecutionSseEvent,
                    String(event.sequence),
                ),
                (event) => executionId === undefined || event.execution.id === executionId,
            );
            request.on("close", unsubscribe);
        }));
        app.get(`${base}/:executionId`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            response.json(executionResponse(await this.findExecution(server.workspaceId, server.id, param(request, "executionId"))));
        }));
        app.post(`${base}/:executionId/cancel`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            parseBody<QylContracts.RunnerMcpExecutionCancelRequest>(request);
            const execution = await this.executions.cancel(server.workspaceId, server.id, param(request, "executionId"));
            response.status(202).json({ execution: executionResponse(execution) });
        }));
        app.get(`${base}/:executionId/telemetry`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const execution = await this.findExecution(server.workspaceId, server.id, param(request, "executionId"));
            const persisted = (await this.repository.listExecutions(server.workspaceId, server.id))
                .find((item) => item.id === execution.id);
            const correlation = this.correlations.correlation(execution.id) ?? persisted?.telemetryCorrelation ?? {
                executionId: execution.id,
                ...(execution.correlation.evaluationRunId === undefined ? {} : { evaluationRunId: execution.correlation.evaluationRunId }),
                ...(execution.correlation.testCaseId === undefined ? {} : { testCaseId: execution.correlation.testCaseId }),
                traceIds: [],
                spanIds: [],
            };
            response.json(await this.observability.queryExecution({
                correlation,
                startedAt: execution.startedAt,
                completedAt: execution.completedAt,
                method: "tools/call",
                toolName: execution.request.toolName,
            }));
        }));
    }

    private registerTestRoutes(app: Express): void {
        const tests = "/runner/workspaces/:workspaceId/test-cases";
        app.get(tests, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const serverId = optionalString(request.query.serverId);
            const toolName = optionalString(request.query.toolName);
            const filtered = (await this.repository.listTestCases(workspaceId)).filter((testCase) =>
                (serverId === undefined || testCase.serverId === serverId)
                && (toolName === undefined || testCase.toolName === toolName));
            const page = paginate(filtered, request, 100);
            response.json({ testCases: page.items.map(testCaseResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.post(tests, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const body = parseBody<QylContracts.RunnerMcpTestCaseCreateRequest>(request);
            const timestamp = this.now().toISOString();
            const testCase = await this.repository.saveTestCase(testCaseRecord(randomUUID(), workspaceId, body, timestamp, timestamp));
            response.json(testCaseResponse(testCase));
        }));
        app.get(`${tests}/:testCaseId`, this.route(async (request, response) => {
            response.json(testCaseResponse(await this.repository.getTestCase(param(request, "workspaceId"), param(request, "testCaseId"))));
        }));
        app.patch(`${tests}/:testCaseId`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const testCaseId = param(request, "testCaseId");
            const current = await this.repository.getTestCase(workspaceId, testCaseId);
            const body = parseBody<QylContracts.RunnerMcpTestCaseUpdateRequest>(request);
            requireNonEmptyPatch(body);
            const updated = await this.repository.saveTestCase(testCaseRecord(
                current.id,
                workspaceId,
                {
                    serverId: body.serverId ?? current.serverId,
                    name: body.name ?? current.name,
                    ...(body.description === undefined ? (current.description === undefined ? {} : { description: current.description }) : { description: body.description }),
                    toolName: body.toolName ?? current.toolName,
                    arguments: body.arguments ?? current.arguments,
                    timeoutMs: body.timeoutMs ?? current.timeoutMs,
                    assertions: body.assertions ?? [...current.assertions],
                    tags: body.tags ?? [...(current.tags ?? [])],
                },
                current.createdAt,
                this.now().toISOString(),
            ));
            response.json(testCaseResponse(updated));
        }));
        app.delete(`${tests}/:testCaseId`, this.route(async (request, response) => {
            await this.repository.deleteTestCase(param(request, "workspaceId"), param(request, "testCaseId"));
            response.status(204).end();
        }));
        app.post(`${tests}/:testCaseId/run`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const testCase = await this.repository.getTestCase(workspaceId, param(request, "testCaseId"));
            const body = parseBody<QylContracts.RunnerMcpTestCaseRunRequest>(request);
            const suite: PersistedSuite = {
                id: `single:${testCase.id}`,
                workspaceId,
                name: testCase.name,
                testCaseIds: [testCase.id],
                createdAt: testCase.createdAt,
                updatedAt: testCase.updatedAt,
            };
            response.status(202).json({ run: await this.startEvaluation(workspaceId, suite, [testCase], body) });
        }));

        const suites = "/runner/workspaces/:workspaceId/suites";
        app.get(suites, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const page = paginate(await this.repository.listSuites(workspaceId), request, 100);
            response.json({ suites: page.items.map(suiteResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.post(suites, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const body = parseBody<QylContracts.RunnerMcpTestSuiteCreateRequest>(request);
            const timestamp = this.now().toISOString();
            const suite = await this.repository.saveSuite({ id: randomUUID(), workspaceId, ...body, createdAt: timestamp, updatedAt: timestamp });
            response.json(suiteResponse(suite));
        }));
        app.get(`${suites}/:suiteId`, this.route(async (request, response) => {
            response.json(suiteResponse(await this.repository.getSuite(param(request, "workspaceId"), param(request, "suiteId"))));
        }));
        app.patch(`${suites}/:suiteId`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const current = await this.repository.getSuite(workspaceId, param(request, "suiteId"));
            const body = parseBody<QylContracts.RunnerMcpTestSuiteUpdateRequest>(request);
            requireNonEmptyPatch(body);
            const updated = await this.repository.saveSuite({
                ...current,
                ...body,
                updatedAt: this.now().toISOString(),
            });
            response.json(suiteResponse(updated));
        }));
        app.delete(`${suites}/:suiteId`, this.route(async (request, response) => {
            await this.repository.deleteSuite(param(request, "workspaceId"), param(request, "suiteId"));
            response.status(204).end();
        }));
        app.post(`${suites}/:suiteId/run`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const suite = await this.repository.getSuite(workspaceId, param(request, "suiteId"));
            const body = parseBody<QylContracts.RunnerMcpSuiteRunRequest>(request);
            const selected = body.selectedTestCaseIds ?? suite.testCaseIds;
            if (selected.some((id) => !suite.testCaseIds.includes(id))) {
                throw new RequestValidationError("selectedTestCaseIds", "Selected test cases must belong to the suite.");
            }
            const cases = await Promise.all(selected.map((id) => this.repository.getTestCase(workspaceId, id)));
            response.status(202).json({ run: await this.startEvaluation(workspaceId, { ...suite, testCaseIds: selected }, cases, body) });
        }));
    }

    private registerEvaluationRoutes(app: Express): void {
        const base = "/runner/workspaces/:workspaceId/evaluation-runs";
        app.get(base, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const requestedStatus = optionalString(request.query.status);
            const parsedStatus = requestedStatus === undefined
                ? undefined
                : EvaluationRunStatusSchema.safeParse(requestedStatus);
            if (parsedStatus !== undefined && !parsedStatus.success) {
                throw new RequestValidationError("status", "Unknown evaluation-run status.");
            }
            const status = parsedStatus?.data;
            const runs = (await this.repository.listEvaluationRuns(workspaceId))
                .filter((run) => status === undefined || run.status === status)
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            const page = paginate(runs, request, 100);
            response.json({ runs: page.items.map(evaluationRunResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.get(`${base}/:evaluationRunId`, this.route(async (request, response) => {
            response.json(evaluationRunResponse(await this.repository.getEvaluationRun(param(request, "workspaceId"), param(request, "evaluationRunId"))));
        }));
        app.post(`${base}/compare`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const body = parseBody<QylContracts.RunnerMcpEvaluationComparisonRequest>(request);
            const baseline = await this.repository.getEvaluationRun(workspaceId, body.baselineRunId);
            const candidate = await this.repository.getEvaluationRun(workspaceId, body.candidateRunId);
            if (baseline.status !== "completed" || candidate.status !== "completed") {
                throw new RepositoryConflictError("Only completed evaluation runs can be compared.");
            }
            response.json(comparisonResponse(compareEvaluationRuns(baseline, candidate), baseline, candidate, this.now()));
        }));
        app.post(`${base}/:evaluationRunId/export`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const run = await this.repository.getEvaluationRun(workspaceId, param(request, "evaluationRunId"));
            if (run.status === "queued" || run.status === "running") {
                throw new RepositoryConflictError("An evaluation run must finish before it can be exported.");
            }
            const body = parseBody<QylContracts.RunnerMcpEvaluationExportRequest>(request);
            let item = await this.repository.findEvaluationExportByIdempotency(workspaceId, run.id, body.idempotencyKey);
            if (!item) {
                const exportId = RunnerMcpEvaluationExportIdSchema.parse(randomUUID());
                const runId = RunnerMcpEvaluationRunIdSchema.parse(run.id);
                const exportedAt = this.now().toISOString();
                const mappedRun = evaluationRunResponse(run);
                const payload: QylContracts.RunnerMcpEvaluationExportPayload = body.format === "json"
                    ? RunnerMcpEvaluationJsonExportPayloadSchema.parse({
                          format: "json",
                          run: mappedRun,
                          protocolEvents: body.includeProtocolEvents ? await this.protocolEventsForRun(run) : [],
                          telemetry: body.includeTelemetry ? await this.telemetryForRun(run) : [],
                          exportedAt,
                      })
                    : RunnerMcpEvaluationReportExportPayloadSchema.parse({
                          format: "report",
                          markdown: exportEvaluationReport(run),
                          exportedAt,
                      });
                const serialized = payload.format === "json"
                    ? `${JSON.stringify(payload, null, 2)}\n`
                    : payload.markdown;
                const metadata = RunnerMcpEvaluationExportSchema.parse({
                    id: exportId,
                    runId,
                    format: body.format,
                    status: "ready",
                    requestedAt: exportedAt,
                    completedAt: exportedAt,
                    mediaType: body.format === "json" ? "application/json" : "text/markdown",
                    fileName: `${safeFileName(run.suiteName)}-${run.id}.${body.format === "json" ? "json" : "md"}`,
                    byteSize: Buffer.byteLength(serialized),
                    sha256: createHash("sha256").update(serialized).digest("hex"),
                });
                item = await this.repository.saveEvaluationExport({
                    id: exportId,
                    workspaceId,
                    runId: run.id,
                    idempotencyKey: body.idempotencyKey,
                    metadata,
                    payload,
                });
            }
            response.status(202).json({ export: item.metadata });
        }));
        app.get(`${base}/:evaluationRunId/exports/:exportId`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const run = await this.repository.getEvaluationRun(workspaceId, param(request, "evaluationRunId"));
            const item = await this.repository.getEvaluationExport(workspaceId, run.id, param(request, "exportId"));
            response.json(item.metadata);
        }));
        app.get(`${base}/:evaluationRunId/exports/:exportId/content`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspaceId");
            const run = await this.repository.getEvaluationRun(workspaceId, param(request, "evaluationRunId"));
            const item = await this.repository.getEvaluationExport(workspaceId, run.id, param(request, "exportId"));
            response.json({ export: item.metadata, payload: item.payload });
        }));
    }

    private readonly evaluationReservations = new Map<string, {
        fingerprint: string;
        promise: Promise<QylContracts.RunnerMcpEvaluationRun>;
    }>();

    private async startEvaluation(
        workspaceId: string,
        suite: PersistedSuite,
        testCases: PersistedTestCase[],
        request: QylContracts.RunnerMcpEvaluationRunRequest,
    ): Promise<QylContracts.RunnerMcpEvaluationRun> {
        const key = `${workspaceId}\u0000${suite.id}\u0000${request.idempotencyKey}`;
        const fingerprint = evaluationRequestFingerprint(workspaceId, suite, request);
        const reservation = this.evaluationReservations.get(key);
        if (reservation !== undefined) {
            assertMatchingEvaluationFingerprint(reservation.fingerprint, fingerprint);
            return await reservation.promise;
        }
        const previousId = this.evaluationIdempotency.get(key);
        if (previousId) {
            const previous = await this.repository.getEvaluationRun(workspaceId, previousId);
            assertMatchingEvaluationFingerprint(previous.idempotencyFingerprint, fingerprint);
            return evaluationRunResponse(previous);
        }

        const promise = this.startEvaluationReserved(
            workspaceId,
            suite,
            testCases,
            request,
            key,
            fingerprint,
        );
        this.evaluationReservations.set(key, { fingerprint, promise });
        try {
            return await promise;
        } finally {
            if (this.evaluationReservations.get(key)?.promise === promise) {
                this.evaluationReservations.delete(key);
            }
        }
    }

    private async startEvaluationReserved(
        workspaceId: string,
        suite: PersistedSuite,
        testCases: PersistedTestCase[],
        request: QylContracts.RunnerMcpEvaluationRunRequest,
        key: string,
        fingerprint: string,
    ): Promise<QylContracts.RunnerMcpEvaluationRun> {
        const persisted = await this.repository.findEvaluationRunByIdempotency(
            workspaceId,
            suite.id,
            request.idempotencyKey,
        );
        if (persisted !== undefined) {
            assertMatchingEvaluationFingerprint(persisted.idempotencyFingerprint, fingerprint);
            this.evaluationIdempotency.set(key, persisted.id);
            return evaluationRunResponse(persisted);
        }

        const runId = randomUUID();
        this.evaluationIdempotency.set(key, runId);
        const startedAt = this.now().toISOString();
        const confirmation = request.confirmation === undefined
            ? undefined
            : {
                acknowledged: true as const,
                acknowledgement: request.confirmation.acknowledgement,
                confirmedAt: startedAt,
            };
        const queued: EvaluationRun = {
            id: runId,
            workspaceId,
            suiteId: suite.id,
            suiteName: suite.name,
            suite: suiteSnapshot(suite),
            testCases: structuredClone(testCases),
            status: "running",
            startedAt,
            results: [],
            summary: { total: testCases.length, passed: 0, failed: 0, errors: 0, skipped: 0, successRate: 0, reliability: 0 },
            idempotencyKey: request.idempotencyKey,
            idempotencyFingerprint: fingerprint,
            ...(confirmation === undefined ? {} : { confirmation }),
        };
        try {
            await this.repository.saveEvaluationRun(queued);
        } catch (error) {
            if (this.evaluationIdempotency.get(key) === runId) {
                this.evaluationIdempotency.delete(key);
            }
            throw error;
        }
        void this.evaluations.runSuite({
            workspaceId,
            suite,
            testCases,
            approvedConsequential: request.confirmation?.acknowledged === true,
            concurrency: Math.min(request.concurrency ?? 1, 8),
            failFast: request.failFast ?? false,
            ...(confirmation === undefined ? {} : { confirmation }),
            runId,
        }).then((completed) => this.repository.saveEvaluationRun({
            ...completed,
            idempotencyKey: request.idempotencyKey,
            idempotencyFingerprint: fingerprint,
        })).catch(async () => {
            const completedAt = this.now().toISOString();
            try {
                await this.repository.saveEvaluationRun({
                    ...queued,
                    status: "failed",
                    completedAt,
                    summary: {
                        ...queued.summary,
                        errors: testCases.length,
                    },
                    error: {
                        category: "internal",
                        code: "evaluation_failed",
                        message: "The evaluation runner failed before producing complete evidence.",
                        occurredAt: completedAt,
                        retryable: false,
                    },
                });
                console.error(`Evaluation run '${runId}' failed; durable failure evidence was recorded.`);
            } catch {
                console.error(
                    `Evaluation run '${runId}' failed and its durable failure evidence could not be recorded.`,
                );
            }
        });
        return evaluationRunResponse(queued);
    }

    private async sessionResponse(identity: RunnerSessionIdentity): Promise<QylContracts.RunnerMcpWorkbenchSession> {
        const workspaces = await this.repository.listWorkspaces();
        const workspaceIds = workspaces.map((workspace) => workspace.id);
        return RunnerMcpWorkbenchSessionSchema.parse({
            id: identity.id,
            principal: { id: identity.userId, displayName: "Local user", local: true },
            workspaceIds,
            ...(workspaceIds.some((workspaceId) => workspaceId === identity.defaultWorkspaceId)
                ? { activeWorkspaceId: identity.defaultWorkspaceId }
                : workspaceIds[0] === undefined ? {} : { activeWorkspaceId: workspaceIds[0] }),
            createdAt: identity.createdAt,
            expiresAt: identity.expiresAt,
        });
    }

    private serverResponse(server: ServerRecord): QylContracts.RunnerMcpServer {
        return RunnerMcpServerSchema.parse({
            id: server.id,
            workspaceId: server.workspaceId,
            name: server.name,
            ...(server.description === undefined ? {} : { description: server.description }),
            configuration: externalConfiguration(server.configuration),
            connection: connectionResponse(this.connections.get(server.id), this.changedAt.get(server.id) ?? server.updatedAt),
            createdAt: server.createdAt,
            updatedAt: server.updatedAt,
        });
    }

    private discoveryResponse(serverId: string, snapshot: ConnectionSnapshot): QylContracts.RunnerMcpDiscoverySnapshot {
        if (snapshot.lifecycle !== "connected" || snapshot.initialization === undefined) {
            throw new ConnectionManagerError("invalid_state", serverId, `Connection '${serverId}' is not connected.`);
        }
        return discoveryResponse(serverId, snapshot.initialization, this.now());
    }

    private async scopedServer(request: Request): Promise<ServerRecord> {
        return this.repository.getServer(param(request, "workspaceId"), param(request, "serverId"));
    }

    private requireMutableServer(workspaceId: string, serverId: string): void {
        if (!this.legacyResources.isManagedServer(workspaceId, serverId)) return;
        throw new RepositoryConflictError(
            "Managed bootstrap MCP servers are defined by the runner builder and cannot be edited or deleted through the workbench.",
        );
    }

    private async detachServers(servers: readonly ServerRecord[]): Promise<DetachedServer[]> {
        const detached: DetachedServer[] = [];
        try {
            for (const server of servers) {
                if (!this.connections.has(server.id)) continue;
                const reconnect = this.connections.get(server.id).lifecycle === "connected";
                await this.connections.unregister(server.id);
                detached.push({ server, reconnect });
            }
            return detached;
        } catch (error) {
            await this.restoreDetachedServers(detached);
            throw error;
        }
    }

    private async restoreDetachedServers(detached: readonly DetachedServer[]): Promise<void> {
        for (const { server, reconnect } of detached) {
            try {
                if (!this.connections.has(server.id)) {
                    this.connections.register(toConnectionDefinition(server));
                }
                if (reconnect && this.connections.get(server.id).lifecycle !== "connected") {
                    await this.connections.connect(server.id);
                }
            } catch {
                console.error(
                    `Workbench runtime rollback could not reconnect '${server.id}'; its persisted configuration remains intact.`,
                );
            }
        }
    }

    private async findExecution(workspaceId: string, serverId: string, executionId: string): Promise<ExecutionRecord> {
        try {
            return this.executions.get(workspaceId, serverId, executionId);
        } catch (error) {
            if (!(error instanceof ExecutionNotFoundError)) throw error;
            const persisted = await this.repository.listExecutions(workspaceId, serverId);
            const found = persisted.find((item) => item.id === executionId)?.evidence;
            if (isExecutionRecord(found)) return found;
            throw error;
        }
    }

    private async invokeForEvaluation(request: {
        workspaceId: string;
        serverId: string;
        toolName: string;
        arguments: Record<string, unknown>;
        timeoutMs: number;
        confirmed: boolean;
        idempotencyKey: string;
        correlation: { evaluationRunId: string; testCaseId: string };
    }): Promise<EvaluationInvocationEvidence> {
        const record = await this.executions.start({
            workspaceId: request.workspaceId,
            serverId: request.serverId,
            toolName: request.toolName,
            arguments: request.arguments,
            timeoutMs: request.timeoutMs,
            idempotencyKey: request.idempotencyKey,
            ...(request.confirmed
                ? { confirmation: { acknowledged: true, acknowledgement: "Approved for this evaluation run." } as const }
                : {}),
            correlation: request.correlation,
        });
        const completed = await waitForTerminal(this.executions, record);
        const telemetryCorrelation = this.correlations.correlation(completed.id);
        return {
            executionId: completed.id,
            status: completed.status,
            outcome: executionOutcome(completed),
            startedAt: completed.startedAt ?? completed.createdAt,
            completedAt: completed.completedAt ?? completed.createdAt,
            durationMs: completed.durationMs ?? 0,
            ...(completed.result === undefined ? {} : { result: completed.result }),
            ...(completed.error === undefined ? {} : { errorKind: completed.error.category, errorMessage: completed.error.message }),
            ...(telemetryCorrelation?.traceIds[0] === undefined
                ? {}
                : { traceId: telemetryCorrelation.traceIds[0] }),
            ...(telemetryCorrelation?.spanIds[0] === undefined
                ? {}
                : { spanId: telemetryCorrelation.spanIds[0] }),
        };
    }

    private async protocolEventsForRun(run: EvaluationRun): Promise<QylContracts.RunnerMcpProtocolEvent[]> {
        const ids = new Set(run.results.flatMap((result) => result.executionId === undefined ? [] : [result.executionId]));
        const serverIds = new Set((run.testCases ?? []).map((testCase) => testCase.serverId));
        const events: QylContracts.RunnerMcpProtocolEvent[] = [];
        for (const serverId of serverIds) {
            for (const persisted of await this.repository.listExecutions(run.workspaceId, serverId)) {
                if (!ids.has(persisted.id)) continue;
                for (const entry of persisted.protocolEvents ?? []) {
                    if (isProtocolJournalEntry(entry)) events.push(protocolEvent(serverId, entry));
                }
            }
            if (this.connections.has(serverId)) {
                const journal = this.connections.getJournal(serverId);
                for (const entry of journal?.snapshot() ?? []) {
                    if (entry.correlation?.executionId && ids.has(entry.correlation.executionId)) {
                        events.push(protocolEvent(serverId, entry));
                    }
                }
            }
        }
        const unique = new Map(events.map((event) => [JSON.stringify(event), event]));
        return [...unique.values()].sort((left, right) =>
            String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")));
    }

    private async telemetryForRun(
        run: EvaluationRun,
    ): Promise<QylContracts.RunnerMcpExecutionTelemetryResponse[]> {
        const responses: QylContracts.RunnerMcpExecutionTelemetryResponse[] = [];
        for (const result of run.results) {
            if (!result.executionId) continue;
            const testCase = (run.testCases ?? []).find((item) => item.id === result.testCaseId);
            if (!testCase) continue;
            const execution = await this.findExecution(run.workspaceId, testCase.serverId, result.executionId);
            const persisted = (await this.repository.listExecutions(run.workspaceId, testCase.serverId))
                .find((item) => item.id === execution.id);
            const correlation = this.correlations.correlation(execution.id)
                ?? persisted?.telemetryCorrelation
                ?? {
                executionId: execution.id,
                evaluationRunId: run.id,
                testCaseId: result.testCaseId,
                traceIds: [],
                spanIds: [],
            };
            responses.push(await this.observability.queryExecution({
                correlation,
                startedAt: execution.startedAt,
                completedAt: execution.completedAt,
                method: "tools/call",
                toolName: execution.request.toolName,
            }));
        }
        return responses;
    }

    private route(
        handler: (request: Request, response: Response) => Promise<void>,
        lockMode: WorkspaceLockMode = "shared",
    ): (request: Request, response: Response) => void {
        return (request, response) => {
            const sendJson = response.json.bind(response);
            response.json = ((body: unknown) => sendJson(
                validatePublishedWorkbenchResponse(request, response.statusCode, body),
            )) as Response["json"];
            const workspaceId = request.params.workspaceId;
            const operation = () => handler(request, response);
            const promise = request.method === "GET" || request.method === "HEAD"
                || typeof workspaceId !== "string"
                ? operation()
                : this.workspaceMutations.run(workspaceId, lockMode, operation);
            void promise.catch((error: unknown) => this.handleError(error, response));
        };
    }

    private handleError(error: unknown, response: Response): void {
        if (response.headersSent) {
            response.end();
            return;
        }
        if (error instanceof RequestValidationError || error instanceof ExecutionValidationError) {
            sendValidationProblem(response, error.field, error.message);
            return;
        }
        if (error instanceof z.ZodError) {
            const issue = error.issues[0];
            sendValidationProblem(response, issue?.path.join(".") || "body", issue?.message ?? "The request is invalid.");
            return;
        }
        if (error instanceof RepositoryNotFoundError) {
            sendNotFound(response, error.kind, error.id);
            return;
        }
        if (error instanceof ExecutionNotFoundError) {
            sendNotFound(response, "execution", error.executionId);
            return;
        }
        if (error instanceof RepositoryConflictError || error instanceof ExecutionConflictError) {
            sendConflict(response, "workbench", error.message);
            return;
        }
        if (error instanceof ConnectionManagerError) {
            switch (error.code) {
                case "not_registered":
                    sendNotFound(response, "MCP server", error.connectionId);
                    break;
                case "invalid_configuration":
                    sendValidationProblem(response, "configuration", error.message);
                    break;
                case "invalid_state":
                case "already_registered":
                    sendConflict(response, error.connectionId, error.message);
                    break;
                case "connect_failed":
                case "disconnect_failed":
                case "timeout":
                    sendBadGateway(response);
                    break;
            }
            return;
        }
        console.error(`Runner workbench request failed: ${this.redactor.redactText(
            error instanceof Error ? error.message : String(error),
        )}`);
        sendInternalServerError(response);
    }
}

type WorkspaceLockMode = "shared" | "exclusive";

interface WorkspaceLockRequest {
    mode: WorkspaceLockMode;
    resolve: (release: () => void) => void;
}

interface WorkspaceLockState {
    readers: number;
    writer: boolean;
    queue: WorkspaceLockRequest[];
}

/**
 * Fair per-workspace read/write coordination. Ordinary mutations remain
 * concurrent (required for idempotent coalescing); server/workspace deletion
 * is exclusive so no invocation can slip between durable preflight and runtime
 * shutdown.
 */
class WorkspaceReadWriteLock {
    private readonly states = new Map<string, WorkspaceLockState>();

    async run<T>(key: string, mode: WorkspaceLockMode, operation: () => Promise<T>): Promise<T> {
        const release = await this.acquire(key, mode);
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private acquire(key: string, mode: WorkspaceLockMode): Promise<() => void> {
        const state = this.states.get(key) ?? { readers: 0, writer: false, queue: [] };
        this.states.set(key, state);
        if (state.queue.length === 0
            && !state.writer
            && (mode === "shared" || state.readers === 0)) {
            return Promise.resolve(this.grant(key, state, mode));
        }
        return new Promise((resolve) => {
            state.queue.push({ mode, resolve });
            this.pump(key, state);
        });
    }

    private grant(
        key: string,
        state: WorkspaceLockState,
        mode: WorkspaceLockMode,
    ): () => void {
        if (mode === "exclusive") state.writer = true;
        else state.readers += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (mode === "exclusive") state.writer = false;
            else state.readers -= 1;
            this.pump(key, state);
        };
    }

    private pump(key: string, state: WorkspaceLockState): void {
        if (state.writer || state.readers > 0) return;
        const first = state.queue[0];
        if (first === undefined) {
            this.states.delete(key);
            return;
        }
        if (first.mode === "exclusive") {
            state.queue.shift();
            first.resolve(this.grant(key, state, "exclusive"));
            return;
        }
        while (state.queue[0]?.mode === "shared") {
            const reader = state.queue.shift()!;
            reader.resolve(this.grant(key, state, "shared"));
        }
    }
}

class RequestValidationError extends Error {
    constructor(readonly field: string, message: string) {
        super(message);
        this.name = "RequestValidationError";
    }
}

function parseBody<T>(request: Request): T {
    const { operationId } = publishedOperation(request);
    const schema = publishedContractSchema<T>(`Operations.${operationId}.Request`);
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw parsed.error;
    return parsed.data;
}

interface PublishedOperation {
    operationId?: string;
    responses?: Record<string, {
        content?: Record<string, unknown>;
    }>;
}

function publishedOperation(request: Request): {
    operationId: string;
    operation: PublishedOperation;
    openApiPath: string;
} {
    const routePath = (request.route as { path?: unknown } | undefined)?.path;
    if (typeof routePath !== "string") {
        throw new Error("Cannot resolve the published Qyl route for a workbench operation.");
    }
    const openApiPath = routePath.replace(/:([^/]+)/gu, "{$1}");
    const paths = qylOpenApi.paths as unknown as Record<string, Record<string, PublishedOperation>>;
    const operation = paths[openApiPath]?.[request.method.toLowerCase()];
    if (!operation) {
        throw new Error(`Published Qyl contract has no ${request.method} ${openApiPath} operation.`);
    }
    if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
        throw new Error(`Published Qyl operation ${request.method} ${openApiPath} has no operationId.`);
    }
    return { operationId: operation.operationId, operation, openApiPath };
}

function validatePublishedWorkbenchResponse(
    request: Request,
    statusCode: number,
    body: unknown,
): unknown {
    if (statusCode < 200 || statusCode >= 300) return body;
    const { operationId, operation, openApiPath } = publishedOperation(request);
    const publishedResponse = operation?.responses?.[String(statusCode)];
    if (!publishedResponse) {
        throw new Error(
            `Published Qyl contract has no ${statusCode} response for ${request.method} ${openApiPath}.`,
        );
    }
    if (!("application/json" in (publishedResponse.content ?? {}))) return body;
    return publishedContractSchema(
        `Operations.${operationId}.Response.${statusCode}`,
    ).parse(body);
}

function param(request: Request, name: string): string {
    const value = request.params[name];
    const schema = ContractIdSchemas[name];
    if (!schema) throw new Error(`No published Qyl identifier schema is registered for '${name}'.`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RequestValidationError(name, `${name} is not a valid identifier.`);
    return parsed.data;
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new RequestValidationError("query", "Query values must be strings.");
    return value;
}

function requireNonEmptyPatch(value: object): void {
    if (Object.keys(value).length === 0) throw new RequestValidationError("body", "At least one field must be supplied.");
}

function toPersistedConfiguration(configuration: ExternalServerConfiguration): PersistedConnectionDefinition {
    switch (configuration.transport) {
        case "stdio":
            return {
                kind: "stdio",
                command: configuration.command,
                args: configuration.arguments ?? [],
                ...(configuration.workingDirectory === undefined ? {} : { cwd: configuration.workingDirectory }),
                environment: (configuration.environment ?? []).map((reference) => ({
                    variable: reference.name,
                    secret: reference.secret,
                })),
            };
        case "streamable_http":
        case "sse":
            return {
                kind: configuration.transport,
                endpoint: configuration.endpoint,
                headers: (configuration.headers ?? []).map((reference) => ({
                    header: reference.name,
                    secret: reference.secret,
                    ...(reference.scheme === undefined ? {} : { scheme: reference.scheme }),
                })),
            };
        case "builtin":
            return { kind: "builtin", builtin: configuration.name };
        case "inproc":
            return { kind: "inproc", implementation: configuration.implementation };
    }
}

function externalConfiguration(configuration: PersistedConnectionDefinition): QylContracts.RunnerMcpServerConfiguration {
    switch (configuration.kind) {
        case "stdio":
            return RunnerMcpServerConfigurationSchema.parse({
                transport: "stdio",
                command: configuration.command,
                arguments: configuration.args,
                ...(configuration.cwd === undefined ? {} : { workingDirectory: configuration.cwd }),
                environment: configuration.environment.map((reference) => ({ name: reference.variable, secret: reference.secret })),
            });
        case "streamable_http":
        case "sse":
            return RunnerMcpServerConfigurationSchema.parse({
                transport: configuration.kind,
                endpoint: configuration.endpoint,
                headers: configuration.headers.map((reference) => ({
                    name: reference.header,
                    secret: reference.secret,
                    ...(reference.scheme === undefined ? {} : { scheme: reference.scheme }),
                })),
            });
        case "builtin":
            return RunnerMcpServerConfigurationSchema.parse({ transport: "builtin", name: configuration.builtin });
        case "inproc":
            return RunnerMcpServerConfigurationSchema.parse({ transport: "inproc", implementation: configuration.implementation });
    }
}

function toConnectionDefinition(server: ServerRecord): ConnectionDefinition {
    const configuration = server.configuration;
    switch (configuration.kind) {
        case "stdio":
            return {
                id: server.id,
                kind: "stdio",
                command: configuration.command,
                args: configuration.args,
                ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
                environment: configuration.environment.map((reference) => ({
                    variable: reference.variable,
                    environmentVariable: reference.secret.environmentVariable,
                })),
            };
        case "streamable_http":
        case "sse":
            return {
                id: server.id,
                kind: configuration.kind === "streamable_http" ? "streamable-http" : "sse",
                endpoint: configuration.endpoint,
                headers: configuration.headers.map((reference) => ({
                    header: reference.header,
                    environmentVariable: reference.secret.environmentVariable,
                    ...(reference.scheme === undefined ? {} : { scheme: reference.scheme }),
                })),
            };
        case "builtin":
            return { id: server.id, kind: "builtin", builtin: configuration.builtin };
        case "inproc":
            return { id: server.id, kind: "builtin", builtin: configuration.implementation };
    }
}

function resourceToPersistedConfiguration(resource: McpResource): PersistedConnectionDefinition {
    if (resource.kind === "inproc") return { kind: "inproc", implementation: resource.name };
    if (resource.kind === "http") return { kind: "streamable_http", endpoint: resource.endpoint, headers: [] };
    const environment = Object.keys(resource.launch.env).map((variable) => ({
        variable,
        secret: {
            source: "environment" as const,
            environmentVariable: managedResourceEnvironmentVariable(resource.name, variable),
        },
    }));
    return {
        kind: "stdio",
        command: resource.launch.command,
        args: [...resource.launch.args],
        ...(resource.launch.cwd === undefined ? {} : { cwd: resource.launch.cwd }),
        environment,
    };
}

function managedResourceEnvironment(
    resources: readonly McpResource[],
    base: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
    const environment: Record<string, string | undefined> = { ...base };
    for (const resource of resources) {
        if (resource.kind !== "stdio") continue;
        for (const [variable, value] of Object.entries(resource.launch.env)) {
            const reference = managedResourceEnvironmentVariable(resource.name, variable);
            const existing = environment[reference];
            if (existing !== undefined && existing !== value) {
                throw new Error(
                    `Managed MCP resource environment reference collision for '${resource.name}'.`,
                );
            }
            environment[reference] = value;
        }
    }
    return environment;
}

function managedResourceEnvironmentVariable(resourceName: string, variable: string): string {
    const digest = createHash("sha256")
        .update(resourceName)
        .update("\0")
        .update(variable)
        .digest("hex")
        .slice(0, 24)
        .toUpperCase();
    return `QYL_MCP_MANAGED_${digest}`;
}

function samePersistedConfiguration(
    left: PersistedConnectionDefinition,
    right: PersistedConnectionDefinition,
): boolean {
    return JSON.stringify(normalizePersistedConfiguration(left))
        === JSON.stringify(normalizePersistedConfiguration(right));
}

function normalizePersistedConfiguration(
    configuration: PersistedConnectionDefinition,
): PersistedConnectionDefinition {
    switch (configuration.kind) {
        case "stdio":
            return {
                ...configuration,
                environment: [...configuration.environment].sort((left, right) =>
                    left.variable.localeCompare(right.variable)
                    || left.secret.environmentVariable.localeCompare(right.secret.environmentVariable)),
            };
        case "streamable_http":
        case "sse":
            return {
                ...configuration,
                headers: [...configuration.headers].sort((left, right) =>
                    left.header.localeCompare(right.header)
                    || left.secret.environmentVariable.localeCompare(right.secret.environmentVariable)),
            };
        case "builtin":
        case "inproc":
            return configuration;
    }
}

function connectionResponse(snapshot: ConnectionSnapshot, changedAt: string): QylContracts.RunnerMcpConnectionSnapshot {
    const status = snapshot.lifecycle;
    return RunnerMcpConnectionSnapshotSchema.parse({
        status,
        changedAt,
        ...(snapshot.initialization === undefined ? {} : {
            connectedAt: snapshot.initialization.connectedAt,
            initialization: initializationResponse(snapshot.initialization),
        }),
        ...(status === "disconnected" ? { disconnectedAt: changedAt } : {}),
        ...(snapshot.lastError === undefined ? {} : {
            recentError: {
                category: "transport",
                code: "connection_failure",
                message: snapshot.lastError,
                occurredAt: changedAt,
                retryable: true,
            },
        }),
    });
}

function initializationResponse(initialization: ConnectionInitializationSnapshot): QylContracts.RunnerMcpInitializationSnapshot {
    const protocolVersion = initialization.protocolVersion ?? "unknown";
    const serverIdentity = initialization.serverInfo ?? { name: "unknown", version: "unknown" };
    return RunnerMcpInitializationSnapshotSchema.parse({
        initializedAt: initialization.connectedAt,
        protocolVersion,
        serverIdentity,
        capabilities: initialization.capabilities,
        ...(initialization.instructions === undefined ? {} : { instructions: initialization.instructions }),
        ...(initialization.sessionId === undefined ? {} : { sessionInfo: { id: initialization.sessionId } }),
        result: {
            protocolVersion,
            serverInfo: serverIdentity,
            capabilities: initialization.capabilities,
            ...(initialization.instructions === undefined ? {} : { instructions: initialization.instructions }),
        },
    });
}

function discoveryResponse(serverId: string, initialization: ConnectionInitializationSnapshot, now: Date): QylContracts.RunnerMcpDiscoverySnapshot {
    const discoveredAt = now.toISOString();
    const collection = (items: readonly unknown[]) => ({ items, count: items.length, complete: true, discoveredAt });
    return RunnerMcpDiscoverySnapshotSchema.parse({
        serverId,
        startedAt: initialization.connectedAt,
        completedAt: discoveredAt,
        tools: collection(initialization.discovery.tools),
        resources: collection(initialization.discovery.resources),
        resourceTemplates: collection(initialization.discovery.resourceTemplates),
        prompts: collection(initialization.discovery.prompts),
    });
}

function protocolEvent(serverId: string, entry: ProtocolJournalEntry): QylContracts.RunnerMcpProtocolEvent {
    if (entry.kind === "message") {
        return RunnerMcpProtocolEventSchema.parse({
            id: String(entry.sequence),
            serverId,
            direction: entry.direction === "outbound" ? "client_to_server" : "server_to_client",
            kind: entry.messageKind === "error_response" ? "error" : entry.messageKind,
            ...(entry.method === undefined ? {} : { method: entry.method }),
            ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
            timestamp: entry.timestamp,
            ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
            payload: entry.payload,
            redactionApplied: true,
            ...(entry.correlation?.executionId === undefined ? {} : { executionId: entry.correlation.executionId }),
        });
    }
    const message = entry.kind === "transport_close" ? "MCP transport closed." : entry.message;
    return RunnerMcpProtocolEventSchema.parse({
        id: String(entry.sequence),
        serverId,
        direction: "local",
        kind: entry.kind === "transport_error" ? "error" : "transport",
        timestamp: entry.timestamp,
        payload: { message },
        redactionApplied: true,
        ...(entry.correlation?.executionId === undefined ? {} : { executionId: entry.correlation.executionId }),
    });
}

function isProtocolJournalEntry(value: unknown): value is ProtocolJournalEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    if (!Number.isSafeInteger(entry.sequence)
        || typeof entry.timestamp !== "string"
        || typeof entry.timestampMs !== "number") {
        return false;
    }
    if (entry.correlation !== undefined
        && (typeof entry.correlation !== "object" || entry.correlation === null || Array.isArray(entry.correlation))) {
        return false;
    }
    switch (entry.kind) {
        case "message":
            return (entry.direction === "outbound" || entry.direction === "inbound")
                && (entry.messageKind === "request" || entry.messageKind === "notification"
                    || entry.messageKind === "response" || entry.messageKind === "error_response");
        case "transport_error":
        case "observer_error":
            return typeof entry.message === "string";
        case "transport_close":
            return true;
        default:
            return false;
    }
}

function executionResponse(record: ExecutionRecord): QylContracts.RunnerMcpExecutionRecord {
    return RunnerMcpExecutionRecordSchema.parse({
        id: record.id,
        workspaceId: record.workspaceId,
        serverId: record.serverId,
        request: {
            toolName: record.request.toolName,
            arguments: record.request.arguments,
            timeoutMs: record.request.timeoutMs,
            ...(record.confirmation === undefined ? {} : {
                confirmation: {
                    acknowledged: true,
                    acknowledgement: record.confirmation.acknowledgement,
                },
            }),
            idempotencyKey: record.request.idempotencyKey,
        },
        effect: record.effect,
        ...(record.confirmation === undefined ? {} : { confirmation: record.confirmation }),
        status: record.status,
        createdAt: record.createdAt,
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
        ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
        attemptCount: record.attemptCount,
        retryCount: record.retryCount ?? 0,
        ...(record.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: record.cancelRequestedAt }),
        ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt }),
        ...(record.result === undefined ? {} : { result: record.result }),
        ...(record.error === undefined ? {} : { error: record.error }),
    });
}

function isExecutionRecord(value: unknown): value is ExecutionRecord {
    return typeof value === "object" && value !== null
        && typeof (value as { id?: unknown }).id === "string"
        && typeof (value as { workspaceId?: unknown }).workspaceId === "string"
        && typeof (value as { serverId?: unknown }).serverId === "string"
        && typeof (value as { status?: unknown }).status === "string";
}

function preferencesResponse(workspaceId: string, preferences: WorkspacePreferences, now: Date): QylContracts.RunnerMcpWorkspacePreferences {
    return RunnerMcpWorkspacePreferencesSchema.parse({
        workspaceId,
        ...(preferences.selectedServerId === undefined ? {} : { selectedServerId: preferences.selectedServerId }),
        ...(preferences.selectedToolName === undefined ? {} : { selectedToolName: preferences.selectedToolName }),
        inputMode: preferences.inputMode ?? "form",
        ...(preferences.activePanel === undefined ? {} : { activePanel: preferences.activePanel }),
        compactMode: preferences.compactMode ?? false,
        updatedAt: preferences.updatedAt ?? now.toISOString(),
    });
}

function testCaseRecord(
    id: string,
    workspaceId: string,
    input: {
        serverId: string;
        name: string;
        description?: string;
        toolName: string;
        arguments?: unknown;
        timeoutMs: number;
        assertions: QylContracts.RunnerMcpTestAssertion[];
        tags?: string[];
    },
    createdAt: string,
    updatedAt: string,
): PersistedTestCase {
    const args = input.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new RequestValidationError("arguments", "Test-case arguments must be a JSON object.");
    }
    return {
        id,
        workspaceId,
        serverId: input.serverId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        toolName: input.toolName,
        arguments: args as Record<string, unknown>,
        timeoutMs: input.timeoutMs,
        assertions: structuredClone(input.assertions),
        tags: input.tags ?? [],
        createdAt,
        updatedAt,
    };
}

function testCaseResponse(testCase: PersistedTestCase | WorkbenchTestCase): QylContracts.RunnerMcpTestCase {
    const record = testCase as PersistedTestCase;
    return RunnerMcpTestCaseSchema.parse({
        id: testCase.id,
        workspaceId: testCase.workspaceId,
        serverId: testCase.serverId,
        name: testCase.name,
        ...(record.description === undefined ? {} : { description: record.description }),
        toolName: testCase.toolName,
        arguments: testCase.arguments,
        timeoutMs: testCase.timeoutMs,
        assertions: [...testCase.assertions],
        tags: testCase.tags ?? [],
        createdAt: record.createdAt ?? new Date(0).toISOString(),
        updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
    });
}

function suiteResponse(suite: PersistedSuite): QylContracts.RunnerMcpTestSuite {
    return RunnerMcpTestSuiteSchema.parse({
        id: suite.id,
        workspaceId: suite.workspaceId,
        name: suite.name,
        ...(suite.description === undefined ? {} : { description: suite.description }),
        testCaseIds: suite.testCaseIds,
        tags: suite.tags ?? [],
        createdAt: suite.createdAt,
        updatedAt: suite.updatedAt,
    });
}

function suiteSnapshot(suite: WorkbenchSuite & { description?: string; tags?: readonly string[] }): WorkbenchSuite {
    return structuredClone(suite);
}

function evaluationRunResponse(run: EvaluationRun): QylContracts.RunnerMcpEvaluationRun {
    const testCases = run.testCases ?? [];
    return RunnerMcpEvaluationRunSchema.parse({
        id: run.id,
        workspaceId: run.workspaceId,
        ...(run.suite === undefined ? {} : {
            suite: {
                id: run.suite.id,
                name: run.suite.name,
                ...((run.suite as PersistedSuite).description === undefined ? {} : { description: (run.suite as PersistedSuite).description }),
                testCaseIds: run.suite.testCaseIds,
                tags: (run.suite as PersistedSuite).tags ?? [],
            },
        }),
        testCases: testCases.map(evaluationTestSnapshot),
        status: run.status,
        createdAt: run.startedAt,
        startedAt: run.startedAt,
        ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
        ...(run.confirmation === undefined ? {} : { confirmation: run.confirmation }),
        ...(run.error === undefined ? {} : { error: run.error }),
        results: run.results.map((result) => ({
            testCase: evaluationTestSnapshot(testCases.find((testCase) => testCase.id === result.testCaseId) ?? {
                id: result.testCaseId,
                workspaceId: run.workspaceId,
                serverId: "unknown",
                name: result.testCaseName,
                toolName: "unknown",
                arguments: {},
                timeoutMs: 30_000,
                assertions: [],
                tags: [],
            }),
            ...(result.executionId === undefined ? {} : { executionId: result.executionId }),
            status: result.status,
            ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
            ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt }),
            ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
            assertions: [...result.assertionResults],
        })),
        summary: evaluationSummary(run),
    });
}

function evaluationTestSnapshot(testCase: WorkbenchTestCase): QylContracts.RunnerMcpEvaluationTestCaseSnapshot {
    return RunnerMcpEvaluationTestCaseSnapshotSchema.parse({
        id: testCase.id,
        serverId: testCase.serverId,
        name: testCase.name,
        ...((testCase as PersistedTestCase).description === undefined ? {} : { description: (testCase as PersistedTestCase).description }),
        toolName: testCase.toolName,
        arguments: testCase.arguments,
        timeoutMs: testCase.timeoutMs,
        assertions: [...testCase.assertions],
        tags: testCase.tags ?? [],
    });
}

function evaluationSummary(run: EvaluationRun): QylContracts.RunnerMcpEvaluationSummary {
    const summary = run.summary;
    return RunnerMcpEvaluationSummarySchema.parse({
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        errors: summary.errors,
        skipped: summary.skipped,
        successRate: summary.successRate,
        reliability: summary.reliability,
        ...(summary.averageLatencyMs === undefined ? {} : { meanDurationMs: summary.averageLatencyMs }),
        ...(summary.p50LatencyMs === undefined ? {} : { p50DurationMs: summary.p50LatencyMs }),
        ...(summary.p95LatencyMs === undefined ? {} : { p95DurationMs: summary.p95LatencyMs }),
        ...(summary.p99LatencyMs === undefined ? {} : { p99DurationMs: summary.p99LatencyMs }),
        ...(summary.inputTokens === undefined && summary.outputTokens === undefined ? {} : {
            tokenUsage: {
                ...(summary.inputTokens === undefined ? {} : { inputTokens: summary.inputTokens }),
                ...(summary.outputTokens === undefined ? {} : { outputTokens: summary.outputTokens }),
                totalTokens: (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0),
                estimated: true,
            },
        }),
        ...(summary.estimatedCostUsd === undefined ? {} : { cost: { amountUsd: summary.estimatedCostUsd, estimated: true } }),
    });
}

function comparisonResponse(
    comparison: ReturnType<typeof compareEvaluationRuns>,
    baseline: EvaluationRun,
    candidate: EvaluationRun,
    now: Date,
): QylContracts.RunnerMcpEvaluationRunComparison {
    return RunnerMcpEvaluationRunComparisonSchema.parse({
        baselineRunId: comparison.baselineRunId,
        candidateRunId: comparison.candidateRunId,
        baseline: evaluationSummary(baseline),
        candidate: evaluationSummary(candidate),
        successRateDelta: comparison.successRateChange,
        reliabilityDelta: comparison.reliabilityChange,
        ...(comparison.p95LatencyChangeMs === undefined ? {} : { p95DurationDeltaMs: comparison.p95LatencyChangeMs }),
        tests: comparison.cases.map((item) => ({
            testCaseId: item.testCaseId,
            status: item.statusChange,
            ...(item.baselineStatus === undefined ? {} : { baselineStatus: item.baselineStatus }),
            ...(item.candidateStatus === undefined ? {} : { candidateStatus: item.candidateStatus }),
            ...(item.latencyChangeMs === undefined ? {} : { durationDeltaMs: item.latencyChangeMs }),
        })),
        comparedAt: now.toISOString(),
    });
}

function executionOutcome(record: ExecutionRecord): ExecutionOutcome {
    switch (record.status) {
        case "succeeded": return "succeeded";
        case "cancelled": return "cancelled";
        case "timed_out": return "timed_out";
        case "failed":
            switch (record.error?.category) {
                case "tool_error": return "tool_error";
                case "schema_validation": return "schema_error";
                case "protocol": return "protocol_error";
                case "transport": return "transport_error";
                case "authentication": return "authentication_error";
                default: return "internal_error";
            }
        default: return "internal_error";
    }
}

async function waitForTerminal(service: ExecutionService, initial: ExecutionRecord): Promise<ExecutionRecord> {
    if (isTerminal(initial.status)) return initial;
    return new Promise<ExecutionRecord>((resolve) => {
        const unsubscribe = service.subscribe((record) => {
            if (record.id !== initial.id || !isTerminal(record.status)) return;
            unsubscribe();
            resolve(record);
        });
        const current = service.get(initial.workspaceId, initial.serverId, initial.id);
        if (isTerminal(current.status)) {
            unsubscribe();
            resolve(current);
        }
    });
}

function isTerminal(status: ExecutionRecord["status"]): boolean {
    return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function paginate<T>(values: readonly T[], request: Request, defaultLimit: number): { items: T[]; nextCursor?: string } {
    const cursorValue = optionalString(request.query.cursor);
    const limitValue = optionalString(request.query.limit);
    const cursor = cursorValue === undefined ? 0 : Number(cursorValue);
    const limit = limitValue === undefined ? defaultLimit : Number(limitValue);
    if (!Number.isInteger(cursor) || cursor < 0) throw new RequestValidationError("cursor", "Cursor must be a non-negative integer.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RequestValidationError("limit", "Limit must be an integer from 1 to 1000.");
    const items = values.slice(cursor, cursor + limit);
    const next = cursor + items.length;
    return { items, ...(next < values.length ? { nextCursor: String(next) } : {}) };
}

/** Subscribe first, then replay a sequence snapshot without gaps or duplicate race events. */
function subscribeSequencedSse<T extends { sequence: number }>(
    lastEventId: number,
    snapshot: () => readonly T[],
    subscribe: (push: (event: T) => void) => () => void,
    publish: (event: T) => void,
    accepts: (event: T) => boolean = () => true,
): () => void {
    let replaying = true;
    let highWater = lastEventId;
    const pending: T[] = [];
    const emit = (event: T): void => {
        if (!accepts(event) || event.sequence <= highWater) return;
        publish(event);
        highWater = event.sequence;
    };
    const unsubscribe = subscribe((event) => {
        if (replaying) pending.push(event);
        else emit(event);
    });
    try {
        for (const event of [...snapshot()].sort((left, right) => left.sequence - right.sequence)) emit(event);
        for (const event of pending.sort((left, right) => left.sequence - right.sequence)) emit(event);
        replaying = false;
        return unsubscribe;
    } catch (error) {
        unsubscribe();
        throw error;
    }
}

function openSse(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
}

function writeSse<T>(
    response: Response,
    payload: unknown,
    schema: z.ZodType<T>,
    event: string,
    id?: string,
): void {
    const validated = schema.parse(payload);
    response.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(validated)}\n\n`);
}

function requirePublishedSseEvent(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("Published Qyl OpenAPI is missing a workbench SSE event name.");
    }
    return value;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function parseLastEventId(value: string | string[] | undefined): number {
    const header = singleHeader(value);
    if (header === undefined || header === "") return 0;
    const parsed = Number(header);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RequestValidationError("Last-Event-ID", "Last-Event-ID must be a non-negative integer.");
    return parsed;
}

function safeFileName(value: string): string {
    const result = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
    return result || "evaluation";
}

function evaluationRequestFingerprint(
    workspaceId: string,
    suite: PersistedSuite,
    request: QylContracts.RunnerMcpEvaluationRunRequest,
): string {
    return createHash("sha256").update(canonicalEvaluationJson({
        workspaceId,
        suiteId: suite.id,
        selectedTestCaseIds: suite.testCaseIds,
        request,
    })).digest("hex");
}

function assertMatchingEvaluationFingerprint(previous: string | undefined, candidate: string): void {
    if (previous !== undefined && previous !== candidate) {
        throw new RepositoryConflictError(
            "The idempotency key was already used for a different evaluation request.",
        );
    }
}

function canonicalEvaluationJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalEvaluationJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvaluationJson(child)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
