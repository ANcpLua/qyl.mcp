import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import type * as QylContracts from "@ancplua/qyl-api-schema/types";
import { z } from "zod";
import {
    WorkbenchEvaluationExportIdSchema,
    WorkbenchEvaluationJsonExportPayloadSchema,
    WorkbenchEvaluationReportExportPayloadSchema,
    WorkbenchEvaluationExportSchema,
    WorkbenchEvaluationRunComparisonSchema,
    WorkbenchEvaluationRunIdSchema,
    WorkbenchEvaluationRunSchema,
    WorkbenchEvaluationRunStatusSchema as EvaluationRunStatusSchema,
    WorkbenchEvaluationSummarySchema,
    WorkbenchEvaluationTestCaseSnapshotSchema,
    WorkbenchExecutionIdSchema,
    WorkbenchExecutionRecordSchema,
    WorkbenchExecutionStatusSchema as ExecutionStatusSchema,
    WorkbenchDiscoverySnapshotSchema,
    WorkbenchConnectionSnapshotSchema,
    WorkbenchInitializationSnapshotSchema,
    WorkbenchProtocolEventSchema,
    WorkbenchServerIdSchema,
    WorkbenchServerConfigurationSchema,
    WorkbenchServerSchema,
    WorkbenchTestCaseIdSchema,
    WorkbenchTestCaseSchema,
    WorkbenchSuiteIdSchema,
    WorkbenchTestSuiteSchema,
    WorkbenchWorkspaceIdSchema,
    WorkbenchWorkspacePreferencesSchema,
    WorkbenchSessionSchema,
    publishedContractSchema,
} from "qyl-mcp-server/contract-validation";
import type { ContractInput } from "qyl-mcp-server/contract-validation";
import {
    ConnectionManager,
    ConnectionManagerError,
    type ActiveConnectionProtocolOperation,
    type ConnectionDefinition,
    type ConnectionInitializationSnapshot,
    type ConnectionProtocolOperation,
    type ConnectionSnapshot,
    type InProcessMcpServerFactory,
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
import { WorkbenchSessionManager, type WorkbenchSessionIdentity } from "./session-manager.js";
import { WorkbenchCorrelationRegistry } from "./observability-correlation.js";
import { QylObservabilityProvider } from "./qyl-observability.js";
import { McpTelemetry } from "./telemetry.js";
import { MAX_PERSISTED_RESULT_CHARACTERS } from "qyl-mcp-server/execution-result";
import { SecretRedactor } from "./secret-redactor.js";
import {
    PersistedConnectionDefinitionSchema,
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

/** Keyed by the contract's path-parameter names, which is what Express binds. */
const ContractIdSchemas: Readonly<Record<string, z.ZodType<string>>> = {
    workspace_id: WorkbenchWorkspaceIdSchema,
    server_id: WorkbenchServerIdSchema,
    execution_id: WorkbenchExecutionIdSchema,
    test_case_id: WorkbenchTestCaseIdSchema,
    suite_id: WorkbenchSuiteIdSchema,
    evaluation_run_id: WorkbenchEvaluationRunIdSchema,
    export_id: WorkbenchEvaluationExportIdSchema,
};
const AUTO_CONNECT_CONCURRENCY = 4;
const TELEMETRY_DISABLED_REASON =
    "Workbench MCP telemetry is currently disabled (QYL_MCP_TELEMETRY=0), and this execution has no persisted span identifiers.";

const ProtocolSseEvent = requirePublishedSseEvent(
    qylOpenApi.paths["/workbench/workspaces/{workspace_id}/servers/{server_id}/protocol/stream"]
        .get.responses["200"].content["text/event-stream"].itemSchema.oneOf[0].properties.event.const,
);
const ExecutionSseEvent = requirePublishedSseEvent(
    qylOpenApi.paths["/workbench/workspaces/{workspace_id}/servers/{server_id}/executions/stream"]
        .get.responses["200"].content["text/event-stream"].itemSchema.oneOf[0].properties.event.const,
);

export interface WorkbenchApiOptions {
    repository?: WorkbenchRepository;
    sessions?: WorkbenchSessionManager;
    now?: () => Date;
    telemetry?: McpTelemetry;
    observability?: QylObservabilityProvider;
    environment?: Readonly<Record<string, string | undefined>>;
    redactor?: SecretRedactor;
}

export interface BuiltinMcpServer {
    name: string;
    serverFactory: InProcessMcpServerFactory;
}

interface DetachedServer {
    server: ServerRecord;
    reconnect: boolean;
}

/** Runtime owner for the generated Qyl MCP workbench HTTP surface. */
export class WorkbenchApi {
    readonly repository: WorkbenchRepository;
    readonly sessions: WorkbenchSessionManager;
    readonly connections: ConnectionManager;
    readonly executions: ExecutionService;
    readonly evaluations: EvaluationEngine;
    readonly correlations: WorkbenchCorrelationRegistry;
    readonly telemetry: McpTelemetry;
    readonly observability: QylObservabilityProvider;
    private readonly now: () => Date;
    private readonly redactor: SecretRedactor;
    private readonly builtinServerIds = new Set<string>();
    private readonly changedAt = new Map<string, string>();
    private readonly evaluationIdempotency = new Map<string, string>();
    private readonly workspaceMutations = new WorkspaceReadWriteLock();
    private autoConnectController: AbortController | undefined;
    private autoConnectPromise: Promise<void> | undefined;

    constructor(
        private readonly builtins: readonly BuiltinMcpServer[],
        options: WorkbenchApiOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        const environment = options.environment ?? process.env;
        const redactor = options.redactor ?? new SecretRedactor({
            environment,
            maxStringLength: MAX_PERSISTED_RESULT_CHARACTERS + 1,
        });
        this.redactor = redactor;
        this.repository = options.repository ?? new WorkbenchRepository({
            now: this.now,
            environment,
            redactor,
        });
        this.sessions = options.sessions ?? new WorkbenchSessionManager();
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
            journal: {
                captureContent: environment.QYL_MCP_CAPTURE_CONTENT === "1",
            },
            onSecretsResolved: (_serverId, values) => this.repository.registerSecretValues(values),
            correlation: (serverId) => executions?.correlationFor(serverId),
            onOperationStart: (operation) => this.startProtocolOperation(operation),
            onOperation: (operation) => this.recordProtocolOperation(operation),
            now: () => this.now().getTime(),
        });
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
        if (operation.role === "server"
            && operation.method === "tools/call"
            && operation.nativeExecutionTelemetry === true) {
            return undefined;
        }
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
            requestBody: operation.requestBody,
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
                    errorType: completed.errorType,
                    errorMessage: completed.errorMessage,
                    rpcResponseStatusCode: completed.rpcResponseStatusCode,
                    jsonRpcRequestId: completed.requestId,
                    responseBody: completed.responseBody,
                });
                const executionId = completed.correlation?.executionId;
                if (executionId !== undefined && span !== undefined) {
                    this.correlations.linkTelemetry(executionId, span.traceId, span.spanId);
                }
            },
        };
    }

    async initialize(): Promise<void> {
        await this.repository.initialize();
        await this.repository.reconcileInterruptedWork();
        for (const builtin of this.builtins) {
            this.connections.registerBuiltin(builtin.name, builtin.serverFactory);
        }
        const workspaces = await this.repository.listWorkspaces();
        const defaultWorkspace = workspaces.find((workspace) => workspace.id === "default") ?? workspaces[0];
        if (!defaultWorkspace) throw new Error("The workbench has no local workspace.");

        const existing = await this.repository.listServers(defaultWorkspace.id);
        for (const builtin of this.builtins) {
            const configuration: PersistedConnectionDefinition = {
                transport: "builtin",
                name: builtin.name,
            };
            const matches = existing.filter((server) => server.name === builtin.name);
            if (matches.length > 1) {
                throw new RepositoryConflictError(
                    `Built-in MCP server '${builtin.name}' matches multiple persisted servers in the default workspace.`,
                );
            }
            const persisted = matches[0];
            if (persisted !== undefined) {
                if (persisted.configuration.transport !== "builtin"
                    || persisted.configuration.name !== builtin.name) {
                    throw new RepositoryConflictError(
                        `Built-in MCP server '${builtin.name}' conflicts with a persisted server that has different configuration.`,
                    );
                }
                if (!persisted.autoConnect) {
                    throw new RepositoryConflictError(
                        `Built-in MCP server '${builtin.name}' conflicts with a persisted server that has automatic connection disabled.`,
                    );
                }
                this.builtinServerIds.add(persisted.id);
                continue;
            }
            const server = await this.repository.createServer(defaultWorkspace.id, {
                name: builtin.name,
                configuration,
                autoConnect: true,
            });
            existing.push(server);
            this.builtinServerIds.add(server.id);
        }

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
        ))).flat().filter((server) => server.autoConnect);
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
        await Promise.all(Array.from(
            { length: Math.min(AUTO_CONNECT_CONCURRENCY, servers.length) },
            worker,
        ));
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
        await this.telemetry.close();
    }

    register(app: Express): void {
        app.post("/workbench/session", this.route(async (_request, response) => {
            const created = this.sessions.create();
            response.setHeader("Set-Cookie", created.setCookie);
            response.setHeader("Cache-Control", "no-store");
            response.json(await this.sessionResponse(created.identity));
        }));

        app.use("/workbench", (request, response, next) => {
            const session = this.sessions.authenticate(request.headers.cookie);
            if (!session) {
                sendUnauthorized(response);
                return;
            }
            response.locals.workbenchSession = session;
            response.setHeader("Cache-Control", "no-store");
            next();
        });

        app.get("/workbench/session", this.route(async (_request, response) => {
            response.json(await this.sessionResponse(response.locals.workbenchSession as WorkbenchSessionIdentity));
        }));

        this.registerWorkspaceRoutes(app);
        this.registerServerRoutes(app);
        this.registerExecutionRoutes(app);
        this.registerTestRoutes(app);
        this.registerEvaluationRoutes(app);
    }

    private registerWorkspaceRoutes(app: Express): void {
        app.get("/workbench/workspaces", this.route(async (_request, response) => {
            response.json({ workspaces: await this.repository.listWorkspaces() });
        }));
        app.post("/workbench/workspaces", this.route(async (request, response) => {
            const body = parseBody<QylContracts.WorkbenchWorkspaceCreateRequest>(request);
            response.json(await this.repository.createWorkspace(body));
        }));
        app.get("/workbench/workspaces/:workspace_id", this.route(async (request, response) => {
            response.json(await this.repository.getWorkspace(param(request, "workspace_id")));
        }));
        app.patch("/workbench/workspaces/:workspace_id", this.route(async (request, response) => {
            const body = parseBody<QylContracts.WorkbenchWorkspaceUpdateRequest>(request);
            requireNonEmptyPatch(body);
            response.json(await this.repository.updateWorkspace(param(request, "workspace_id"), body));
        }));
        app.delete("/workbench/workspaces/:workspace_id", this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const servers = await this.repository.listServers(workspaceId);
            if (servers.some((server) => this.builtinServerIds.has(server.id))) {
                throw new RepositoryConflictError(
                    "A workspace containing built-in MCP servers cannot be deleted.",
                );
            }
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
        app.get("/workbench/workspaces/:workspace_id/preferences", this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            response.json(preferencesResponse(workspaceId, await this.repository.getPreferences(workspaceId), this.now()));
        }));
        app.put("/workbench/workspaces/:workspace_id/preferences", this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const body = parseBody<QylContracts.WorkbenchWorkspacePreferencesUpdateRequest>(request);
            if (body.selected_server_id !== undefined) await this.repository.getServer(workspaceId, body.selected_server_id);
            const saved = await this.repository.savePreferences(workspaceId, {
                ...fromPreferencesUpdateRequest(body),
                updatedAt: this.now().toISOString(),
            });
            response.json(preferencesResponse(workspaceId, saved, this.now()));
        }));
    }

    private registerServerRoutes(app: Express): void {
        const base = "/workbench/workspaces/:workspace_id/servers";
        app.get(base, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            response.json({ servers: (await this.repository.listServers(workspaceId)).map((server) => this.serverResponse(server)) });
        }));
        app.post(base, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const body = parseBody<QylContracts.WorkbenchServerCreateRequest>(request);
            const server = await this.repository.createServer(workspaceId, {
                name: body.name,
                ...(body.description === undefined ? {} : { description: body.description }),
                configuration: PersistedConnectionDefinitionSchema.parse(body.configuration),
                autoConnect: body.auto_connect ?? false,
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
        app.get(`${base}/:server_id`, this.route(async (request, response) => {
            response.json(this.serverResponse(await this.scopedServer(request)));
        }));
        app.patch(`${base}/:server_id`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const serverId = param(request, "server_id");
            this.requireMutableServer(serverId);
            const previous = await this.repository.getServer(workspaceId, serverId);
            const body = parseBody<QylContracts.WorkbenchServerUpdateRequest>(request);
            requireNonEmptyPatch(body);
            const updated = await this.repository.updateServer(workspaceId, serverId, {
                ...(body.name === undefined ? {} : { name: body.name }),
                ...(body.description === undefined ? {} : { description: body.description }),
                ...(body.configuration === undefined ? {} : { configuration: PersistedConnectionDefinitionSchema.parse(body.configuration) }),
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
        app.delete(`${base}/:server_id`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const serverId = param(request, "server_id");
            this.requireMutableServer(serverId);
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
            app.post(`${base}/:server_id/${action}`, this.route(async (request, response) => {
                const server = await this.scopedServer(request);
                if (action === "connect") await this.connections.connect(server.id);
                else if (action === "disconnect") await this.connections.disconnect(server.id);
                else await this.connections.reconnect(server.id);
                response.status(202).json({ server: this.serverResponse(server) });
            }));
        }
        app.get(`${base}/:server_id/discovery`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            response.json(this.discoveryResponse(server.id, this.connections.get(server.id)));
        }));
        app.post(`${base}/:server_id/discovery/refresh`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            response.json(this.discoveryResponse(server.id, await this.connections.refreshDiscovery(server.id)));
        }));
        app.get(`${base}/:server_id/protocol`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const entries = this.connections.getJournal(server.id)?.snapshot() ?? [];
            const page = paginate(entries.map((entry) => protocolEvent(server.id, entry)), request, 200);
            response.json({ events: page.items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.get(`${base}/:server_id/protocol/stream`, this.route(async (request, response) => {
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
                    WorkbenchProtocolEventSchema,
                    ProtocolSseEvent,
                    String(entry.sequence),
                ),
            );
            request.on("close", unsubscribe);
        }));
    }

    private registerExecutionRoutes(app: Express): void {
        const base = "/workbench/workspaces/:workspace_id/servers/:server_id/executions";
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
            const body = parseBody<QylContracts.WorkbenchExecutionRequest>(request);
            const execution = await this.executions.start({
                workspaceId: server.workspaceId,
                serverId: server.id,
                toolName: body.tool_name,
                arguments: body.arguments,
                timeoutMs: body.timeout_ms,
                idempotencyKey: body.idempotency_key,
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
                    WorkbenchExecutionRecordSchema,
                    ExecutionSseEvent,
                    String(event.sequence),
                ),
                (event) => executionId === undefined || event.execution.id === executionId,
            );
            request.on("close", unsubscribe);
        }));
        app.get(`${base}/:execution_id`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            response.json(executionResponse(await this.findExecution(server.workspaceId, server.id, param(request, "execution_id"))));
        }));
        app.post(`${base}/:execution_id/cancel`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            parseBody<QylContracts.WorkbenchExecutionCancelRequest>(request);
            const execution = await this.executions.cancel(server.workspaceId, server.id, param(request, "execution_id"));
            response.status(202).json({ execution: executionResponse(execution) });
        }));
        app.get(`${base}/:execution_id/telemetry`, this.route(async (request, response) => {
            const server = await this.scopedServer(request);
            const execution = await this.findExecution(server.workspaceId, server.id, param(request, "execution_id"));
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
                ...(!this.telemetry.operationTracingEnabled && correlation.traceIds.length === 0
                    ? { instrumentationUnavailableReason: TELEMETRY_DISABLED_REASON }
                    : {}),
            }));
        }));
    }

    private registerTestRoutes(app: Express): void {
        const tests = "/workbench/workspaces/:workspace_id/test-cases";
        app.get(tests, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const serverId = optionalString(request.query.serverId);
            const toolName = optionalString(request.query.toolName);
            const filtered = (await this.repository.listTestCases(workspaceId)).filter((testCase) =>
                (serverId === undefined || testCase.serverId === serverId)
                && (toolName === undefined || testCase.toolName === toolName));
            const page = paginate(filtered, request, 100);
            response.json({ testCases: page.items.map(testCaseResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.post(tests, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const body = parseBody<QylContracts.WorkbenchTestCaseCreateRequest>(request);
            const timestamp = this.now().toISOString();
            const testCase = await this.repository.saveTestCase(
                testCaseRecord(randomUUID(), workspaceId, fromTestCaseCreateRequest(body), timestamp, timestamp),
            );
            response.json(testCaseResponse(testCase));
        }));
        app.get(`${tests}/:test_case_id`, this.route(async (request, response) => {
            response.json(testCaseResponse(await this.repository.getTestCase(param(request, "workspace_id"), param(request, "test_case_id"))));
        }));
        app.patch(`${tests}/:test_case_id`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const testCaseId = param(request, "test_case_id");
            const current = await this.repository.getTestCase(workspaceId, testCaseId);
            const body = parseBody<QylContracts.WorkbenchTestCaseUpdateRequest>(request);
            requireNonEmptyPatch(body);
            const updated = await this.repository.saveTestCase(testCaseRecord(
                current.id,
                workspaceId,
                {
                    serverId: body.server_id ?? current.serverId,
                    name: body.name ?? current.name,
                    ...(body.description === undefined ? (current.description === undefined ? {} : { description: current.description }) : { description: body.description }),
                    toolName: body.tool_name ?? current.toolName,
                    arguments: body.arguments ?? current.arguments,
                    timeoutMs: body.timeout_ms ?? current.timeoutMs,
                    assertions: body.assertions ?? [...current.assertions],
                    tags: body.tags ?? [...(current.tags ?? [])],
                },
                current.createdAt,
                this.now().toISOString(),
            ));
            response.json(testCaseResponse(updated));
        }));
        app.delete(`${tests}/:test_case_id`, this.route(async (request, response) => {
            await this.repository.deleteTestCase(param(request, "workspace_id"), param(request, "test_case_id"));
            response.status(204).end();
        }));
        app.post(`${tests}/:test_case_id/run`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const testCase = await this.repository.getTestCase(workspaceId, param(request, "test_case_id"));
            const body = parseBody<QylContracts.WorkbenchTestCaseRunRequest>(request);
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

        const suites = "/workbench/workspaces/:workspace_id/suites";
        app.get(suites, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const page = paginate(await this.repository.listSuites(workspaceId), request, 100);
            response.json({ suites: page.items.map(suiteResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }));
        app.post(suites, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const body = parseBody<QylContracts.WorkbenchTestSuiteCreateRequest>(request);
            const timestamp = this.now().toISOString();
            const suite = await this.repository.saveSuite({
                id: randomUUID(),
                workspaceId,
                name: body.name,
                ...(body.description === undefined ? {} : { description: body.description }),
                testCaseIds: body.test_case_ids,
                ...(body.tags === undefined ? {} : { tags: body.tags }),
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            response.json(suiteResponse(suite));
        }));
        app.get(`${suites}/:suite_id`, this.route(async (request, response) => {
            response.json(suiteResponse(await this.repository.getSuite(param(request, "workspace_id"), param(request, "suite_id"))));
        }));
        app.patch(`${suites}/:suite_id`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const current = await this.repository.getSuite(workspaceId, param(request, "suite_id"));
            const body = parseBody<QylContracts.WorkbenchTestSuiteUpdateRequest>(request);
            requireNonEmptyPatch(body);
            const updated = await this.repository.saveSuite({
                ...current,
                ...body,
                updatedAt: this.now().toISOString(),
            });
            response.json(suiteResponse(updated));
        }));
        app.delete(`${suites}/:suite_id`, this.route(async (request, response) => {
            await this.repository.deleteSuite(param(request, "workspace_id"), param(request, "suite_id"));
            response.status(204).end();
        }));
        app.post(`${suites}/:suite_id/run`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const suite = await this.repository.getSuite(workspaceId, param(request, "suite_id"));
            const body = parseBody<QylContracts.WorkbenchSuiteRunRequest>(request);
            const selected = body.selected_test_case_ids ?? suite.testCaseIds;
            if (selected.some((id) => !suite.testCaseIds.includes(id))) {
                throw new RequestValidationError("selectedTestCaseIds", "Selected test cases must belong to the suite.");
            }
            const cases = await Promise.all(selected.map((id) => this.repository.getTestCase(workspaceId, id)));
            response.status(202).json({ run: await this.startEvaluation(workspaceId, { ...suite, testCaseIds: selected }, cases, body) });
        }));
    }

    private registerEvaluationRoutes(app: Express): void {
        const base = "/workbench/workspaces/:workspace_id/evaluation-runs";
        app.get(base, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
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
        app.get(`${base}/:evaluation_run_id`, this.route(async (request, response) => {
            response.json(evaluationRunResponse(await this.repository.getEvaluationRun(param(request, "workspace_id"), param(request, "evaluation_run_id"))));
        }));
        app.post(`${base}/compare`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const body = parseBody<QylContracts.WorkbenchEvaluationComparisonRequest>(request);
            const baseline = await this.repository.getEvaluationRun(workspaceId, body.baseline_run_id);
            const candidate = await this.repository.getEvaluationRun(workspaceId, body.candidate_run_id);
            if (baseline.status !== "completed" || candidate.status !== "completed") {
                throw new RepositoryConflictError("Only completed evaluation runs can be compared.");
            }
            response.json(comparisonResponse(compareEvaluationRuns(baseline, candidate), baseline, candidate, this.now()));
        }));
        app.post(`${base}/:evaluation_run_id/export`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const run = await this.repository.getEvaluationRun(workspaceId, param(request, "evaluation_run_id"));
            if (run.status === "queued" || run.status === "running") {
                throw new RepositoryConflictError("An evaluation run must finish before it can be exported.");
            }
            const body = parseBody<QylContracts.WorkbenchEvaluationExportRequest>(request);
            let item = await this.repository.findEvaluationExportByIdempotency(workspaceId, run.id, body.idempotency_key);
            if (!item) {
                const exportId = WorkbenchEvaluationExportIdSchema.parse(randomUUID());
                const runId = WorkbenchEvaluationRunIdSchema.parse(run.id);
                const exportedAt = this.now().toISOString();
                const mappedRun = evaluationRunResponse(run);
                const payload: QylContracts.WorkbenchEvaluationExportPayload = body.format === "json"
                    ? WorkbenchEvaluationJsonExportPayloadSchema.parse({
                          format: "json",
                          run: mappedRun,
                          protocol_events: body.include_protocol_events ? await this.protocolEventsForRun(run) : [],
                          telemetry: body.include_telemetry ? await this.telemetryForRun(run) : [],
                          exported_at: exportedAt,
                      } satisfies ContractInput<QylContracts.WorkbenchEvaluationJsonExportPayload>)
                    : WorkbenchEvaluationReportExportPayloadSchema.parse({
                          format: "report",
                          markdown: exportEvaluationReport(run),
                          exported_at: exportedAt,
                      } satisfies ContractInput<QylContracts.WorkbenchEvaluationReportExportPayload>);
                const serialized = payload.format === "json"
                    ? `${JSON.stringify(payload, null, 2)}\n`
                    : payload.markdown;
                const metadata = WorkbenchEvaluationExportSchema.parse({
                    id: exportId,
                    run_id: runId,
                    format: body.format,
                    status: "ready",
                    requested_at: exportedAt,
                    completed_at: exportedAt,
                    media_type: body.format === "json" ? "application/json" : "text/markdown",
                    file_name: `${safeFileName(run.suiteName)}-${run.id}.${body.format === "json" ? "json" : "md"}`,
                    byte_size: Buffer.byteLength(serialized),
                    sha256: createHash("sha256").update(serialized).digest("hex"),
                } satisfies ContractInput<QylContracts.WorkbenchEvaluationExport>);
                item = await this.repository.saveEvaluationExport({
                    id: exportId,
                    workspaceId,
                    runId: run.id,
                    idempotencyKey: body.idempotency_key,
                    metadata,
                    payload,
                });
            }
            response.status(202).json({ export: item.metadata });
        }));
        app.get(`${base}/:evaluation_run_id/exports/:export_id`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const run = await this.repository.getEvaluationRun(workspaceId, param(request, "evaluation_run_id"));
            const item = await this.repository.getEvaluationExport(workspaceId, run.id, param(request, "export_id"));
            response.json(item.metadata);
        }));
        app.get(`${base}/:evaluation_run_id/exports/:export_id/content`, this.route(async (request, response) => {
            const workspaceId = param(request, "workspace_id");
            const run = await this.repository.getEvaluationRun(workspaceId, param(request, "evaluation_run_id"));
            const item = await this.repository.getEvaluationExport(workspaceId, run.id, param(request, "export_id"));
            response.json({ export: item.metadata, payload: item.payload });
        }));
    }

    private readonly evaluationReservations = new Map<string, {
        fingerprint: string;
        promise: Promise<QylContracts.WorkbenchEvaluationRun>;
    }>();

    private async startEvaluation(
        workspaceId: string,
        suite: PersistedSuite,
        testCases: PersistedTestCase[],
        request: QylContracts.WorkbenchEvaluationRunRequest,
    ): Promise<QylContracts.WorkbenchEvaluationRun> {
        const key = `${workspaceId}\u0000${suite.id}\u0000${request.idempotency_key}`;
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
        request: QylContracts.WorkbenchEvaluationRunRequest,
        key: string,
        fingerprint: string,
    ): Promise<QylContracts.WorkbenchEvaluationRun> {
        const persisted = await this.repository.findEvaluationRunByIdempotency(
            workspaceId,
            suite.id,
            request.idempotency_key,
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
                confirmed_at: startedAt,
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
            idempotencyKey: request.idempotency_key,
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
            failFast: request.fail_fast ?? false,
            ...(confirmation === undefined ? {} : { confirmation }),
            runId,
        }).then((completed) => this.repository.saveEvaluationRun({
            ...completed,
            idempotencyKey: request.idempotency_key,
            idempotencyFingerprint: fingerprint,
        })).catch(async (error: unknown) => {
            // The durable evidence below records *that* the run failed. Without
            // this line the cause is discarded, and an operator sees only
            // "failed before producing complete evidence".
            console.error(`Evaluation run '${runId}' failed: ${this.redactor.redactText(
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            )}`);
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
                        message: "The evaluation engine failed before producing complete evidence.",
                        occurred_at: completedAt,
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

    private async sessionResponse(identity: WorkbenchSessionIdentity): Promise<QylContracts.WorkbenchSession> {
        const workspaces = await this.repository.listWorkspaces();
        const workspaceIds = workspaces.map((workspace) => workspace.id);
        return WorkbenchSessionSchema.parse({
            id: identity.id,
            principal: { id: identity.userId, display_name: "Local user", local: true },
            workspace_ids: workspaceIds,
            ...(workspaceIds.some((workspaceId) => workspaceId === identity.defaultWorkspaceId)
                ? { active_workspace_id: identity.defaultWorkspaceId }
                : workspaceIds[0] === undefined ? {} : { active_workspace_id: workspaceIds[0] }),
            created_at: identity.createdAt,
            expires_at: identity.expiresAt,
        } satisfies ContractInput<QylContracts.WorkbenchSession>);
    }

    private serverResponse(server: ServerRecord): QylContracts.WorkbenchServer {
        return WorkbenchServerSchema.parse({
            id: server.id,
            workspace_id: server.workspaceId,
            name: server.name,
            ...(server.description === undefined ? {} : { description: server.description }),
            configuration: WorkbenchServerConfigurationSchema.parse(server.configuration),
            connection: connectionResponse(this.connections.get(server.id), this.changedAt.get(server.id) ?? server.updatedAt),
            created_at: server.createdAt,
            updated_at: server.updatedAt,
        } satisfies ContractInput<QylContracts.WorkbenchServer>);
    }

    private discoveryResponse(serverId: string, snapshot: ConnectionSnapshot): QylContracts.WorkbenchDiscoverySnapshot {
        if (snapshot.lifecycle !== "connected" || snapshot.initialization === undefined) {
            throw new ConnectionManagerError("invalid_state", serverId, `Connection '${serverId}' is not connected.`);
        }
        return discoveryResponse(serverId, snapshot.initialization, this.now());
    }

    private async scopedServer(request: Request): Promise<ServerRecord> {
        return this.repository.getServer(param(request, "workspace_id"), param(request, "server_id"));
    }

    private requireMutableServer(serverId: string): void {
        if (!this.builtinServerIds.has(serverId)) return;
        throw new RepositoryConflictError(
            "Built-in MCP servers cannot be edited or deleted through the workbench.",
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
            ...(completed.tokenUsage === undefined && completed.cost === undefined ? {} : {
                usage: {
                    ...(completed.tokenUsage === undefined ? {} : { tokenUsage: completed.tokenUsage }),
                    ...(completed.cost === undefined ? {} : { cost: completed.cost }),
                },
            }),
            ...(telemetryCorrelation?.traceIds[0] === undefined
                ? {}
                : { traceId: telemetryCorrelation.traceIds[0] }),
            ...(telemetryCorrelation?.spanIds[0] === undefined
                ? {}
                : { spanId: telemetryCorrelation.spanIds[0] }),
        };
    }

    private async protocolEventsForRun(run: EvaluationRun): Promise<QylContracts.WorkbenchProtocolEvent[]> {
        const ids = new Set(run.results.flatMap((result) => result.executionId === undefined ? [] : [result.executionId]));
        const serverIds = new Set((run.testCases ?? []).map((testCase) => testCase.serverId));
        const events: QylContracts.WorkbenchProtocolEvent[] = [];
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
    ): Promise<QylContracts.WorkbenchExecutionTelemetryResponse[]> {
        const responses: QylContracts.WorkbenchExecutionTelemetryResponse[] = [];
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
                ...(!this.telemetry.operationTracingEnabled && correlation.traceIds.length === 0
                    ? { instrumentationUnavailableReason: TELEMETRY_DISABLED_REASON }
                    : {}),
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
        console.error(`Workbench host request failed: ${this.redactor.redactText(
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

function toConnectionDefinition(server: ServerRecord): ConnectionDefinition {
    const configuration = server.configuration;
    switch (configuration.transport) {
        case "stdio":
            return {
                id: server.id,
                kind: "stdio",
                command: configuration.command,
                args: configuration.arguments,
                ...(configuration.working_directory === undefined
                    ? {}
                    : { cwd: configuration.working_directory }),
                environment: configuration.environment.map((reference) => ({
                    variable: reference.name,
                    environmentVariable: reference.secret.environment_variable,
                })),
            };
        case "streamable_http":
            return {
                id: server.id,
                kind: "streamable-http",
                endpoint: configuration.endpoint,
                headers: configuration.headers.map((reference) => ({
                    header: reference.name,
                    environmentVariable: reference.secret.environment_variable,
                    ...(reference.scheme === undefined ? {} : { scheme: reference.scheme }),
                })),
            };
        case "builtin":
            return { id: server.id, kind: "builtin", builtin: configuration.name };
    }
}

function connectionResponse(snapshot: ConnectionSnapshot, changedAt: string): QylContracts.WorkbenchConnectionSnapshot {
    const status = snapshot.lifecycle;
    return WorkbenchConnectionSnapshotSchema.parse({
        status,
        changed_at: changedAt,
        ...(snapshot.initialization === undefined ? {} : {
            connected_at: snapshot.initialization.connectedAt,
            initialization: initializationResponse(snapshot.initialization),
        }),
        ...(status === "disconnected" ? { disconnected_at: changedAt } : {}),
        ...(snapshot.lastError === undefined ? {} : {
            recent_error: {
                category: "transport",
                code: "connection_failure",
                message: snapshot.lastError,
                occurred_at: changedAt,
                retryable: true,
            },
        }),
    } satisfies ContractInput<QylContracts.WorkbenchConnectionSnapshot>);
}

function initializationResponse(initialization: ConnectionInitializationSnapshot): QylContracts.WorkbenchInitializationSnapshot {
    const protocolVersion = initialization.protocolVersion ?? "unknown";
    const serverIdentity = initialization.serverInfo ?? { name: "unknown", version: "unknown" };
    return WorkbenchInitializationSnapshotSchema.parse({
        initialized_at: initialization.connectedAt,
        protocol_version: protocolVersion,
        server_identity: serverIdentity,
        capabilities: initialization.capabilities,
        ...(initialization.instructions === undefined ? {} : { instructions: initialization.instructions }),
        ...(initialization.sessionId === undefined ? {} : { session_info: { id: initialization.sessionId } }),
        result: {
            protocolVersion,
            serverInfo: serverIdentity,
            capabilities: initialization.capabilities,
            ...(initialization.instructions === undefined ? {} : { instructions: initialization.instructions }),
        },
    } satisfies ContractInput<QylContracts.WorkbenchInitializationSnapshot>);
}

function discoveryResponse(serverId: string, initialization: ConnectionInitializationSnapshot, now: Date): QylContracts.WorkbenchDiscoverySnapshot {
    const discoveredAt = now.toISOString();
    const collection = (items: readonly unknown[]) => ({
        items,
        count: items.length,
        complete: true,
        discovered_at: discoveredAt,
    });
    return WorkbenchDiscoverySnapshotSchema.parse({
        server_id: serverId,
        started_at: initialization.connectedAt,
        completed_at: discoveredAt,
        tools: collection(initialization.discovery.tools),
        resources: collection(initialization.discovery.resources),
        resource_templates: collection(initialization.discovery.resourceTemplates),
        prompts: collection(initialization.discovery.prompts),
    } satisfies ContractInput<QylContracts.WorkbenchDiscoverySnapshot>);
}

function protocolEvent(serverId: string, entry: ProtocolJournalEntry): QylContracts.WorkbenchProtocolEvent {
    if (entry.kind === "message") {
        return WorkbenchProtocolEventSchema.parse({
            id: String(entry.sequence),
            server_id: serverId,
            direction: entry.direction === "outbound" ? "client_to_server" : "server_to_client",
            kind: entry.messageKind === "error_response" ? "error" : entry.messageKind,
            ...(entry.method === undefined ? {} : { method: entry.method }),
            ...(entry.requestId === undefined ? {} : { request_id: entry.requestId }),
            timestamp: entry.timestamp,
            ...(entry.durationMs === undefined ? {} : { duration_ms: entry.durationMs }),
            payload: entry.payload,
            redaction_applied: true,
            ...(entry.correlation?.executionId === undefined ? {} : { execution_id: entry.correlation.executionId }),
        } satisfies ContractInput<QylContracts.WorkbenchProtocolEvent>);
    }
    const message = entry.kind === "transport_close" ? "MCP transport closed." : entry.message;
    return WorkbenchProtocolEventSchema.parse({
        id: String(entry.sequence),
        server_id: serverId,
        direction: "local",
        kind: entry.kind === "transport_error" ? "error" : "transport",
        timestamp: entry.timestamp,
        payload: { message },
        redaction_applied: true,
        ...(entry.correlation?.executionId === undefined ? {} : { execution_id: entry.correlation.executionId }),
    } satisfies ContractInput<QylContracts.WorkbenchProtocolEvent>);
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

function executionResponse(record: ExecutionRecord): QylContracts.WorkbenchExecutionRecord {
    return WorkbenchExecutionRecordSchema.parse({
        id: record.id,
        workspace_id: record.workspaceId,
        server_id: record.serverId,
        request: {
            tool_name: record.request.toolName,
            arguments: record.request.arguments,
            timeout_ms: record.request.timeoutMs,
            ...(record.confirmation === undefined ? {} : {
                confirmation: {
                    acknowledged: true,
                    acknowledgement: record.confirmation.acknowledgement,
                },
            }),
            idempotency_key: record.request.idempotencyKey,
        },
        effect: record.effect,
        ...(record.confirmation === undefined ? {} : { confirmation: record.confirmation }),
        status: record.status,
        created_at: record.createdAt,
        ...(record.startedAt === undefined ? {} : { started_at: record.startedAt }),
        ...(record.completedAt === undefined ? {} : { completed_at: record.completedAt }),
        ...(record.durationMs === undefined ? {} : { duration_ms: record.durationMs }),
        attempt_count: record.attemptCount,
        retry_count: record.retryCount ?? 0,
        ...(record.cancelRequestedAt === undefined ? {} : { cancel_requested_at: record.cancelRequestedAt }),
        ...(record.cancelledAt === undefined ? {} : { cancelled_at: record.cancelledAt }),
        ...(record.result === undefined ? {} : { result: record.result }),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.tokenUsage === undefined ? {} : { token_usage: record.tokenUsage }),
        ...(record.cost === undefined ? {} : { cost: record.cost }),
    } satisfies ContractInput<QylContracts.WorkbenchExecutionRecord>);
}

function isExecutionRecord(value: unknown): value is ExecutionRecord {
    return typeof value === "object" && value !== null
        && typeof (value as { id?: unknown }).id === "string"
        && typeof (value as { workspaceId?: unknown }).workspaceId === "string"
        && typeof (value as { serverId?: unknown }).serverId === "string"
        && typeof (value as { status?: unknown }).status === "string";
}

function preferencesResponse(workspaceId: string, preferences: WorkspacePreferences, now: Date): QylContracts.WorkbenchWorkspacePreferences {
    return WorkbenchWorkspacePreferencesSchema.parse({
        workspace_id: workspaceId,
        ...(preferences.selectedServerId === undefined ? {} : { selected_server_id: preferences.selectedServerId }),
        ...(preferences.selectedToolName === undefined ? {} : { selected_tool_name: preferences.selectedToolName }),
        input_mode: preferences.inputMode ?? "form",
        ...(preferences.activePanel === undefined ? {} : { active_panel: preferences.activePanel }),
        compact_mode: preferences.compactMode ?? false,
        updated_at: preferences.updatedAt ?? now.toISOString(),
    } satisfies ContractInput<QylContracts.WorkbenchWorkspacePreferences>);
}

/** The contract's snake_case preferences update as the internal persisted shape. */
function fromPreferencesUpdateRequest(
    body: QylContracts.WorkbenchWorkspacePreferencesUpdateRequest,
): WorkspacePreferences {
    return {
        ...(body.selected_server_id === undefined ? {} : { selectedServerId: body.selected_server_id }),
        ...(body.selected_tool_name === undefined ? {} : { selectedToolName: body.selected_tool_name }),
        ...(body.input_mode === undefined ? {} : { inputMode: body.input_mode }),
        ...(body.active_panel === undefined ? {} : { activePanel: body.active_panel }),
        ...(body.compact_mode === undefined ? {} : { compactMode: body.compact_mode }),
    };
}

/** The contract's snake_case create request as the internal test-case shape. */
function fromTestCaseCreateRequest(body: QylContracts.WorkbenchTestCaseCreateRequest): {
    serverId: string;
    name: string;
    description?: string;
    toolName: string;
    arguments?: unknown;
    timeoutMs: number;
    assertions: QylContracts.WorkbenchTestAssertion[];
    tags?: string[];
} {
    return {
        serverId: body.server_id,
        name: body.name,
        ...(body.description === undefined ? {} : { description: body.description }),
        toolName: body.tool_name,
        ...(body.arguments === undefined ? {} : { arguments: body.arguments }),
        timeoutMs: body.timeout_ms,
        assertions: body.assertions,
        ...(body.tags === undefined ? {} : { tags: [...body.tags] }),
    };
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
        assertions: QylContracts.WorkbenchTestAssertion[];
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

function testCaseResponse(testCase: PersistedTestCase | WorkbenchTestCase): QylContracts.WorkbenchTestCase {
    const record = testCase as PersistedTestCase;
    return WorkbenchTestCaseSchema.parse({
        id: testCase.id,
        workspace_id: testCase.workspaceId,
        server_id: testCase.serverId,
        name: testCase.name,
        ...(record.description === undefined ? {} : { description: record.description }),
        tool_name: testCase.toolName,
        arguments: testCase.arguments,
        timeout_ms: testCase.timeoutMs,
        assertions: [...testCase.assertions],
        tags: testCase.tags ?? [],
        created_at: record.createdAt ?? new Date(0).toISOString(),
        updated_at: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
    } satisfies ContractInput<QylContracts.WorkbenchTestCase>);
}

function suiteResponse(suite: PersistedSuite): QylContracts.WorkbenchTestSuite {
    return WorkbenchTestSuiteSchema.parse({
        id: suite.id,
        workspace_id: suite.workspaceId,
        name: suite.name,
        ...(suite.description === undefined ? {} : { description: suite.description }),
        test_case_ids: suite.testCaseIds,
        tags: suite.tags ?? [],
        created_at: suite.createdAt,
        updated_at: suite.updatedAt,
    } satisfies ContractInput<QylContracts.WorkbenchTestSuite>);
}

function suiteSnapshot(suite: WorkbenchSuite & { description?: string; tags?: readonly string[] }): WorkbenchSuite {
    return structuredClone(suite);
}

function evaluationRunResponse(run: EvaluationRun): QylContracts.WorkbenchEvaluationRun {
    const testCases = run.testCases ?? [];
    return WorkbenchEvaluationRunSchema.parse({
        id: run.id,
        workspace_id: run.workspaceId,
        ...(run.suite === undefined ? {} : {
            suite: {
                id: run.suite.id,
                name: run.suite.name,
                ...((run.suite as PersistedSuite).description === undefined ? {} : { description: (run.suite as PersistedSuite).description }),
                test_case_ids: run.suite.testCaseIds,
                tags: (run.suite as PersistedSuite).tags ?? [],
            },
        }),
        test_cases: testCases.map(evaluationTestSnapshot),
        status: run.status,
        created_at: run.startedAt,
        started_at: run.startedAt,
        ...(run.completedAt === undefined ? {} : { completed_at: run.completedAt }),
        ...(run.confirmation === undefined ? {} : { confirmation: run.confirmation }),
        ...(run.error === undefined ? {} : { error: run.error }),
        results: run.results.map((result) => ({
            test_case: evaluationTestSnapshot(testCases.find((testCase) => testCase.id === result.testCaseId) ?? {
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
            ...(result.executionId === undefined ? {} : { execution_id: result.executionId }),
            status: result.status,
            ...(result.startedAt === undefined ? {} : { started_at: result.startedAt }),
            ...(result.completedAt === undefined ? {} : { completed_at: result.completedAt }),
            ...(result.durationMs === undefined ? {} : { duration_ms: result.durationMs }),
            assertions: [...result.assertionResults],
        })),
        summary: evaluationSummary(run),
    } satisfies ContractInput<QylContracts.WorkbenchEvaluationRun>);
}

function evaluationTestSnapshot(testCase: WorkbenchTestCase): QylContracts.WorkbenchEvaluationTestCaseSnapshot {
    return WorkbenchEvaluationTestCaseSnapshotSchema.parse({
        id: testCase.id,
        server_id: testCase.serverId,
        name: testCase.name,
        ...((testCase as PersistedTestCase).description === undefined ? {} : { description: (testCase as PersistedTestCase).description }),
        tool_name: testCase.toolName,
        arguments: testCase.arguments,
        timeout_ms: testCase.timeoutMs,
        assertions: [...testCase.assertions],
        tags: testCase.tags ?? [],
    } satisfies ContractInput<QylContracts.WorkbenchEvaluationTestCaseSnapshot>);
}

function evaluationSummary(run: EvaluationRun): QylContracts.WorkbenchEvaluationSummary {
    const summary = run.summary;
    return WorkbenchEvaluationSummarySchema.parse({
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        errors: summary.errors,
        skipped: summary.skipped,
        success_rate: summary.successRate,
        reliability: summary.reliability,
        ...(summary.averageLatencyMs === undefined ? {} : { mean_duration_ms: summary.averageLatencyMs }),
        ...(summary.p50LatencyMs === undefined ? {} : { p50_duration_ms: summary.p50LatencyMs }),
        ...(summary.p95LatencyMs === undefined ? {} : { p95_duration_ms: summary.p95LatencyMs }),
        ...(summary.p99LatencyMs === undefined ? {} : { p99_duration_ms: summary.p99LatencyMs }),
        ...(summary.tokenUsage === undefined ? {} : { token_usage: summary.tokenUsage }),
        ...(summary.cost === undefined ? {} : { cost: summary.cost }),
    } satisfies ContractInput<QylContracts.WorkbenchEvaluationSummary>);
}

function comparisonResponse(
    comparison: ReturnType<typeof compareEvaluationRuns>,
    baseline: EvaluationRun,
    candidate: EvaluationRun,
    now: Date,
): QylContracts.WorkbenchEvaluationRunComparison {
    return WorkbenchEvaluationRunComparisonSchema.parse({
        baseline_run_id: comparison.baselineRunId,
        candidate_run_id: comparison.candidateRunId,
        baseline: evaluationSummary(baseline),
        candidate: evaluationSummary(candidate),
        success_rate_delta: comparison.successRateChange,
        reliability_delta: comparison.reliabilityChange,
        ...(comparison.p95LatencyChangeMs === undefined ? {} : { p95_duration_delta_ms: comparison.p95LatencyChangeMs }),
        tests: comparison.cases.map((item) => ({
            test_case_id: item.testCaseId,
            status: item.statusChange,
            ...(item.baselineStatus === undefined ? {} : { baseline_status: item.baselineStatus }),
            ...(item.candidateStatus === undefined ? {} : { candidate_status: item.candidateStatus }),
            ...(item.latencyChangeMs === undefined ? {} : { duration_delta_ms: item.latencyChangeMs }),
        })),
        compared_at: now.toISOString(),
    } satisfies ContractInput<QylContracts.WorkbenchEvaluationRunComparison>);
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
    request: QylContracts.WorkbenchEvaluationRunRequest,
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
