import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
    getDefaultEnvironment,
    StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
    Implementation,
    Prompt,
    Resource,
    ResourceTemplate,
    ServerCapabilities,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
    JournaledTransport,
    ProtocolJournal,
    type CompletedProtocolOperation,
    type ProtocolExecutionCorrelation,
    type ProtocolJournalOptions,
} from "./protocol-journal.js";
import {
    SecretRedactor,
    validateEnvironmentVariableName,
} from "./secret-redactor.js";
import { Constants } from "./constants.js";
import { currentMcpTraceparent } from "./telemetry.js";
import type { Readable } from "node:stream";

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_DISCOVERY_PAGES = 100;
const DEFAULT_MAX_OBSERVER_ERRORS = 100;

export type ConnectionTransportKind =
    | "stdio"
    | "streamable-http"
    | "sse"
    | "inproc"
    | "builtin";

export type ConnectionLifecycle =
    | "disconnected"
    | "connecting"
    | "connected"
    | "disconnecting"
    | "failed";

export type EnvironmentHeaderScheme = "bearer" | "basic";

export interface EnvironmentHeaderReference {
    header: string;
    environmentVariable: string;
    scheme?: EnvironmentHeaderScheme;
}

export interface EnvironmentVariableReference {
    variable: string;
    environmentVariable: string;
}

interface ConnectionDefinitionBase {
    id: string;
}

export interface StdioConnectionDefinition extends ConnectionDefinitionBase {
    kind: "stdio";
    command: string;
    args?: readonly string[];
    cwd?: string;
    environment?: readonly EnvironmentVariableReference[];
}

interface RemoteConnectionDefinitionBase extends ConnectionDefinitionBase {
    endpoint: string;
    headers?: readonly EnvironmentHeaderReference[];
    /** Runtime-only SDK OAuth provider; never serialized into a connection DTO. */
    authProvider?: OAuthClientProvider;
}

export interface StreamableHttpConnectionDefinition extends RemoteConnectionDefinitionBase {
    kind: "streamable-http";
}

export interface SseConnectionDefinition extends RemoteConnectionDefinitionBase {
    kind: "sse";
}

export interface InProcessMcpServer {
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
}

export type InProcessMcpServerFactory = () => InProcessMcpServer | Promise<InProcessMcpServer>;

export interface InProcessConnectionDefinition extends ConnectionDefinitionBase {
    kind: "inproc";
    serverFactory: InProcessMcpServerFactory;
}

export interface BuiltinConnectionDefinition extends ConnectionDefinitionBase {
    kind: "builtin";
    builtin: string;
}

export type ConnectionDefinition =
    | StdioConnectionDefinition
    | StreamableHttpConnectionDefinition
    | SseConnectionDefinition
    | InProcessConnectionDefinition
    | BuiltinConnectionDefinition;

export interface DiscoverySnapshot {
    tools: readonly Tool[];
    resources: readonly Resource[];
    resourceTemplates: readonly ResourceTemplate[];
    prompts: readonly Prompt[];
}

export interface ConnectionInitializationSnapshot {
    connectedAt: string;
    serverInfo?: Implementation;
    capabilities: ServerCapabilities;
    instructions?: string;
    protocolVersion?: string;
    sessionId?: string;
    discovery: DiscoverySnapshot;
}

export interface ConnectionSnapshot {
    id: string;
    kind: ConnectionTransportKind;
    lifecycle: ConnectionLifecycle;
    initialization?: ConnectionInitializationSnapshot;
    lastError?: string;
    journalEntries: number;
}

export interface ConnectionObserverError {
    timestamp: string;
    message: string;
}

export interface ConnectOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface DisconnectOptions {
    timeoutMs?: number;
}

export interface ConnectionManagerOptions {
    clientInfo?: Implementation;
    environment?: Readonly<Record<string, string | undefined>>;
    connectTimeoutMs?: number;
    disconnectTimeoutMs?: number;
    maxDiscoveryPages?: number;
    journal?: Omit<ProtocolJournalOptions, "redactor" | "onOperation" | "initialSequence">;
    correlation?: (connectionId: string) => ProtocolExecutionCorrelation | undefined;
    onOperation?: (operation: ConnectionProtocolOperation) => void;
    onSession?: (session: CompletedConnectionSession) => void;
    redactor?: SecretRedactor;
    onSecretsResolved?: (connectionId: string, values: readonly string[]) => void;
    now?: () => number;
}

export interface ConnectionProtocolOperation extends CompletedProtocolOperation {
    connectionId: string;
    transport: ConnectionTransportKind;
    protocolVersion?: string;
    mcpSessionId?: string;
    peerAddress?: string;
    peerPort?: number;
}

export interface CompletedConnectionSession {
    connectionId: string;
    role: "client" | "server";
    transport: ConnectionTransportKind;
    protocolVersion?: string;
    peerAddress?: string;
    peerPort?: number;
    startTimeMs: number;
    endTimeMs: number;
    errorType?: string;
}

export type ConnectionManagerErrorCode =
    | "already_registered"
    | "not_registered"
    | "invalid_state"
    | "invalid_configuration"
    | "connect_failed"
    | "disconnect_failed"
    | "timeout";

export class ConnectionManagerError extends Error {
    constructor(
        readonly code: ConnectionManagerErrorCode,
        readonly connectionId: string,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "ConnectionManagerError";
    }
}

interface ActiveConnection {
    client: Client;
    transport: JournaledTransport;
    server?: InProcessMcpServer;
}

interface ConnectionEntry {
    definition: ConnectionDefinition;
    lifecycle: ConnectionLifecycle;
    active?: ActiveConnection;
    journal?: ProtocolJournal;
    serverJournal?: ProtocolJournal;
    initialization?: ConnectionInitializationSnapshot;
    lastError?: string;
    redactor?: SecretRedactor;
    sessionStartedAtMs?: number;
    sessionProtocolVersion?: string;
    sessionId?: string;
}

interface CreatedTransport {
    transport: Transport;
    server?: InProcessMcpServer;
}

export interface CursorPage<T> {
    items: readonly T[];
    nextCursor?: string;
}

export interface CollectCursorPagesOptions {
    maxPages?: number;
    signal?: AbortSignal;
}

/** Collect every cursor page while bounding loops and hostile server cursors. */
export async function collectCursorPages<T>(
    fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
    options: CollectCursorPagesOptions = {},
): Promise<T[]> {
    const maxPages = positiveInteger(options.maxPages ?? DEFAULT_MAX_DISCOVERY_PAGES, "maxPages");
    const seenCursors = new Set<string>();
    const items: T[] = [];
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        throwIfAborted(options.signal);
        const page = await fetchPage(cursor);
        items.push(...page.items);
        if (page.nextCursor === undefined) return items;
        if (page.nextCursor.length === 0 || seenCursors.has(page.nextCursor)) {
            throw new Error("MCP discovery returned an empty or repeated cursor.");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }

    throw new Error(`MCP discovery exceeded the ${maxPages}-page safety limit.`);
}

/** Resolve HTTP header values exclusively from server-side environment keys. */
export function resolveEnvironmentHeaders(
    references: readonly EnvironmentHeaderReference[] | undefined,
    environment: Readonly<Record<string, string | undefined>>,
): { headers: Headers; secretValues: readonly string[] } {
    const headers = new Headers();
    const secretValues: string[] = [];
    for (const reference of references ?? []) {
        validateEnvironmentVariableName(reference.environmentVariable);
        const raw = requiredEnvironmentValue(reference.environmentVariable, environment);
        if (/[\r\n]/u.test(raw)) {
            throw new Error(
                `Environment variable '${reference.environmentVariable}' cannot contain header line breaks.`,
            );
        }
        const value = reference.scheme === undefined
            ? raw
            : `${reference.scheme === "bearer" ? "Bearer" : "Basic"} ${raw}`;
        try {
            headers.set(reference.header, value);
        } catch {
            throw new Error(`Invalid HTTP header name '${reference.header}'.`);
        }
        secretValues.push(raw, value);
    }
    return { headers, secretValues };
}

export class ConnectionManager {
    private readonly entries = new Map<string, ConnectionEntry>();
    private readonly builtins = new Map<string, InProcessMcpServerFactory>();
    private readonly subscribers = new Set<(snapshot: ConnectionSnapshot) => void>();
    private readonly observerErrors: ConnectionObserverError[] = [];
    private readonly clientInfo: Implementation;
    private readonly environment: Readonly<Record<string, string | undefined>>;
    private readonly connectTimeoutMs: number;
    private readonly disconnectTimeoutMs: number;
    private readonly maxDiscoveryPages: number;
    private readonly journalOptions: Omit<ProtocolJournalOptions, "redactor" | "onOperation" | "initialSequence">;
    private readonly correlation?: (connectionId: string) => ProtocolExecutionCorrelation | undefined;
    private readonly onOperation?: (operation: ConnectionProtocolOperation) => void;
    private readonly onSession?: (session: CompletedConnectionSession) => void;
    private readonly redactor: SecretRedactor;
    private readonly onSecretsResolved?: (connectionId: string, values: readonly string[]) => void;
    private readonly now: () => number;

    constructor(options: ConnectionManagerOptions = {}) {
        this.clientInfo = options.clientInfo ?? Constants.Product;
        this.environment = options.environment ?? process.env;
        this.connectTimeoutMs = positiveInteger(
            options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
            "connectTimeoutMs",
        );
        this.disconnectTimeoutMs = positiveInteger(
            options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS,
            "disconnectTimeoutMs",
        );
        this.maxDiscoveryPages = positiveInteger(
            options.maxDiscoveryPages ?? DEFAULT_MAX_DISCOVERY_PAGES,
            "maxDiscoveryPages",
        );
        this.journalOptions = options.journal ?? {};
        this.correlation = options.correlation;
        this.onOperation = options.onOperation;
        this.onSession = options.onSession;
        this.redactor = options.redactor ?? new SecretRedactor({ environment: this.environment });
        this.onSecretsResolved = options.onSecretsResolved;
        this.now = options.now ?? Date.now;
    }

    registerBuiltin(name: string, factory: InProcessMcpServerFactory): void {
        requireNonEmpty(name, "Builtin name");
        if (this.builtins.has(name)) {
            throw new Error(`Builtin MCP server '${name}' is already registered.`);
        }
        this.builtins.set(name, factory);
    }

    register(definition: ConnectionDefinition): ConnectionSnapshot {
        requireNonEmpty(definition.id, "Connection id");
        if (this.entries.has(definition.id)) {
            throw new ConnectionManagerError(
                "already_registered",
                definition.id,
                `Connection '${definition.id}' is already registered.`,
            );
        }
        validateDefinition(definition);
        const entry: ConnectionEntry = { definition, lifecycle: "disconnected" };
        this.entries.set(definition.id, entry);
        const snapshot = this.snapshotOf(entry);
        this.publish(snapshot);
        return snapshot;
    }

    has(connectionId: string): boolean {
        return this.entries.has(connectionId);
    }

    /**
     * Remove a persisted connection from the runtime. Active SDK transports are
     * closed before ownership is released so deleting or replacing a server
     * cannot strand a child process, HTTP session, or in-process server.
     */
    async unregister(connectionId: string): Promise<void> {
        const entry = this.requireEntry(connectionId);
        if (entry.lifecycle !== "disconnected" || entry.active !== undefined) {
            await this.disconnect(connectionId);
        }
        this.entries.delete(connectionId);
    }

    list(): readonly ConnectionSnapshot[] {
        return [...this.entries.values()]
            .map((entry) => this.snapshotOf(entry))
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    get(connectionId: string): ConnectionSnapshot {
        return this.snapshotOf(this.requireEntry(connectionId));
    }

    getJournal(connectionId: string): ProtocolJournal | undefined {
        return this.requireEntry(connectionId).journal;
    }

    /** Paired server-side journal for in-process connections. */
    getServerJournal(connectionId: string): ProtocolJournal | undefined {
        return this.requireEntry(connectionId).serverJournal;
    }

    getClient(connectionId: string): Client {
        const entry = this.requireEntry(connectionId);
        if (entry.lifecycle !== "connected" || entry.active === undefined) {
            throw new ConnectionManagerError(
                "invalid_state",
                connectionId,
                `Connection '${connectionId}' is not connected.`,
            );
        }
        return entry.active.client;
    }

    getObserverErrors(): readonly ConnectionObserverError[] {
        return structuredClone(this.observerErrors);
    }

    subscribe(push: (snapshot: ConnectionSnapshot) => void): () => void {
        this.subscribers.add(push);
        return () => this.subscribers.delete(push);
    }

    async connect(
        connectionId: string,
        options: ConnectOptions = {},
    ): Promise<ConnectionSnapshot> {
        const entry = this.requireEntry(connectionId);
        if (entry.lifecycle !== "disconnected" && entry.lifecycle !== "failed") {
            throw new ConnectionManagerError(
                "invalid_state",
                connectionId,
                `Connection '${connectionId}' cannot connect while '${entry.lifecycle}'.`,
            );
        }
        if (entry.active !== undefined) {
            throw new ConnectionManagerError(
                "invalid_state",
                connectionId,
                `Connection '${connectionId}' still owns an active client.`,
            );
        }

        const timeoutMs = positiveInteger(options.timeoutMs ?? this.connectTimeoutMs, "timeoutMs");
        const deadline = this.now() + timeoutMs;
        let secretValues: readonly string[];
        try {
            secretValues = this.referencedSecretValues(entry.definition);
        } catch (error) {
            const redactor = this.redactor;
            const message = redactor.redactText(errorMessage(error));
            entry.redactor = redactor;
            entry.initialization = undefined;
            entry.lastError = message;
            this.transition(entry, "failed");
            throw new ConnectionManagerError(
                "invalid_configuration",
                connectionId,
                `Connection '${connectionId}' has invalid configuration: ${message}`,
                { cause: sanitizedCause(error, redactor) },
            );
        }
        this.redactor.registerSecretValues(secretValues);
        this.onSecretsResolved?.(connectionId, secretValues);
        const redactor = this.redactor;
        const journal = new ProtocolJournal({
            ...this.journalOptions,
            initialSequence: (entry.journal?.highWaterMark() ?? 0) + 1,
            redactor,
            now: this.now,
            onOperation: (operation) => this.publishOperation(entry, operation),
        });
        const serverJournal = new ProtocolJournal({
            ...this.journalOptions,
            initialSequence: (entry.serverJournal?.highWaterMark() ?? 0) + 1,
            redactor,
            now: this.now,
            onOperation: (operation) => this.publishOperation(entry, operation),
        });
        entry.redactor = redactor;
        entry.journal = journal;
        entry.serverJournal = entry.definition.kind === "inproc" || entry.definition.kind === "builtin"
            ? serverJournal
            : undefined;
        entry.initialization = undefined;
        entry.lastError = undefined;
        this.transition(entry, "connecting");

        let client: Client | undefined;
        let server: InProcessMcpServer | undefined;
        try {
            const created = await this.createTransport(
                entry.definition,
                deadline,
                journal,
                serverJournal,
                options.signal,
            );
            server = created.server;
            const transport = new JournaledTransport(created.transport, journal, {
                correlation: () => this.correlation?.(connectionId),
            });
            client = new Client(this.clientInfo);
            client.onclose = () => this.handleUnexpectedClose(entry, client!, journal);
            await withTimeout(
                client.connect(transport, requestOptions(deadline, this.now, options.signal)),
                remaining(deadline, this.now),
                `MCP initialization for '${connectionId}' timed out.`,
                options.signal,
            );

            const connectedAtMs = this.now();
            entry.sessionStartedAtMs = connectedAtMs;
            entry.sessionProtocolVersion = transport.protocolVersion;
            entry.sessionId = transport.sessionId;

            const capabilities = client.getServerCapabilities() ?? {};
            const discovery = await this.discoverClient(
                client,
                capabilities,
                deadline,
                options.signal,
            );
            const initialization: ConnectionInitializationSnapshot = {
                connectedAt: new Date(connectedAtMs).toISOString(),
                capabilities,
                discovery,
            };
            const serverInfo = client.getServerVersion();
            const instructions = client.getInstructions();
            if (serverInfo !== undefined) initialization.serverInfo = serverInfo;
            if (instructions !== undefined) initialization.instructions = instructions;
            if (transport.protocolVersion !== undefined) {
                initialization.protocolVersion = transport.protocolVersion;
            }
            if (transport.sessionId !== undefined) initialization.sessionId = transport.sessionId;

            entry.active = { client, transport, server };
            entry.initialization = initialization;
            this.transition(entry, "connected");
            return this.snapshotOf(entry);
        } catch (error) {
            await this.cleanupFailedConnection(client, server, journal);
            const message = redactor.redactText(errorMessage(error));
            entry.active = undefined;
            entry.lastError = message;
            this.completeSession(entry, this.now(), isTimeoutError(error) ? "timeout" : "connect_failed");
            this.transition(entry, "failed");
            const code = isTimeoutError(error) ? "timeout" : "connect_failed";
            throw new ConnectionManagerError(
                code,
                connectionId,
                `Connection '${connectionId}' failed: ${message}`,
                { cause: sanitizedCause(error, redactor) },
            );
        }
    }

    async disconnect(
        connectionId: string,
        options: DisconnectOptions = {},
    ): Promise<ConnectionSnapshot> {
        const entry = this.requireEntry(connectionId);
        if (entry.lifecycle === "disconnected") return this.snapshotOf(entry);
        if (entry.lifecycle === "connecting" || entry.lifecycle === "disconnecting") {
            throw new ConnectionManagerError(
                "invalid_state",
                connectionId,
                `Connection '${connectionId}' cannot disconnect while '${entry.lifecycle}'.`,
            );
        }
        if (entry.active === undefined) {
            entry.initialization = undefined;
            entry.lastError = undefined;
            this.transition(entry, "disconnected");
            return this.snapshotOf(entry);
        }

        const active = entry.active;
        const timeoutMs = positiveInteger(
            options.timeoutMs ?? this.disconnectTimeoutMs,
            "timeoutMs",
        );
        this.transition(entry, "disconnecting");
        try {
            await withTimeout(
                Promise.all([
                    active.client.close(),
                    active.server?.close() ?? Promise.resolve(),
                ]).then(() => undefined),
                timeoutMs,
                `Disconnect for '${connectionId}' timed out.`,
            );
            this.completeSession(entry, this.now());
            entry.active = undefined;
            entry.initialization = undefined;
            entry.lastError = undefined;
            this.transition(entry, "disconnected");
            return this.snapshotOf(entry);
        } catch (error) {
            const redactor = entry.redactor ?? new SecretRedactor({ environment: this.environment });
            const message = redactor.redactText(errorMessage(error));
            entry.lastError = message;
            this.transition(entry, "failed");
            throw new ConnectionManagerError(
                isTimeoutError(error) ? "timeout" : "disconnect_failed",
                connectionId,
                `Connection '${connectionId}' failed to disconnect: ${message}`,
                { cause: sanitizedCause(error, redactor) },
            );
        }
    }

    async reconnect(
        connectionId: string,
        options: ConnectOptions & DisconnectOptions = {},
    ): Promise<ConnectionSnapshot> {
        const entry = this.requireEntry(connectionId);
        if (entry.active !== undefined || entry.lifecycle !== "disconnected") {
            await this.disconnect(connectionId, { timeoutMs: options.timeoutMs });
        }
        return this.connect(connectionId, options);
    }

    async refreshDiscovery(
        connectionId: string,
        options: ConnectOptions = {},
    ): Promise<ConnectionSnapshot> {
        const entry = this.requireEntry(connectionId);
        if (entry.lifecycle !== "connected" || entry.active === undefined || entry.initialization === undefined) {
            throw new ConnectionManagerError(
                "invalid_state",
                connectionId,
                `Connection '${connectionId}' is not connected.`,
            );
        }
        const timeoutMs = positiveInteger(options.timeoutMs ?? this.connectTimeoutMs, "timeoutMs");
        const deadline = this.now() + timeoutMs;
        entry.initialization = {
            ...entry.initialization,
            discovery: await this.discoverClient(
                entry.active.client,
                entry.initialization.capabilities,
                deadline,
                options.signal,
            ),
        };
        const snapshot = this.snapshotOf(entry);
        this.publish(snapshot);
        return snapshot;
    }

    private async discoverClient(
        client: Client,
        capabilities: ServerCapabilities,
        deadline: number,
        signal?: AbortSignal,
    ): Promise<DiscoverySnapshot> {
        const tools = capabilities.tools
            ? await collectCursorPages(
                async (cursor) => {
                    const page = await client.listTools(
                        cursor === undefined ? undefined : { cursor },
                        requestOptions(deadline, this.now, signal),
                    );
                    return { items: page.tools, nextCursor: page.nextCursor };
                },
                { maxPages: this.maxDiscoveryPages, signal },
            )
            : [];

        const resources = capabilities.resources
            ? await collectCursorPages(
                async (cursor) => {
                    const page = await client.listResources(
                        cursor === undefined ? undefined : { cursor },
                        requestOptions(deadline, this.now, signal),
                    );
                    return { items: page.resources, nextCursor: page.nextCursor };
                },
                { maxPages: this.maxDiscoveryPages, signal },
            )
            : [];

        const resourceTemplates = capabilities.resources
            ? await collectCursorPages(
                async (cursor) => {
                    const page = await client.listResourceTemplates(
                        cursor === undefined ? undefined : { cursor },
                        requestOptions(deadline, this.now, signal),
                    );
                    return { items: page.resourceTemplates, nextCursor: page.nextCursor };
                },
                { maxPages: this.maxDiscoveryPages, signal },
            )
            : [];

        const prompts = capabilities.prompts
            ? await collectCursorPages(
                async (cursor) => {
                    const page = await client.listPrompts(
                        cursor === undefined ? undefined : { cursor },
                        requestOptions(deadline, this.now, signal),
                    );
                    return { items: page.prompts, nextCursor: page.nextCursor };
                },
                { maxPages: this.maxDiscoveryPages, signal },
            )
            : [];

        return { tools, resources, resourceTemplates, prompts };
    }

    private async createTransport(
        definition: ConnectionDefinition,
        deadline: number,
        journal: ProtocolJournal,
        serverJournal: ProtocolJournal,
        signal?: AbortSignal,
    ): Promise<CreatedTransport> {
        switch (definition.kind) {
            case "stdio": {
                const env = {
                    ...getDefaultEnvironment(),
                    ...resolveEnvironmentVariables(definition.environment, this.environment),
                };
                const transport = new StdioClientTransport({
                    command: definition.command,
                    args: [...(definition.args ?? [])],
                    cwd: definition.cwd,
                    env,
                    stderr: "pipe",
                });
                // Stdio has no W3C carrier. Keep it explicitly unpropagated, but
                // drain the child pipe from the moment it is constructed so a
                // verbose server cannot block before MCP initialization. Raw
                // stderr is deliberately discarded rather than journaled or
                // persisted because it may contain credentials.
                drainStdioStderr(transport, journal);
                return {
                    transport,
                };
            }
            case "streamable-http": {
                const { headers } = resolveEnvironmentHeaders(definition.headers, this.environment);
                assertOAuthHeaderCompatibility(definition, headers);
                return {
                    transport: new StreamableHTTPClientTransport(httpEndpoint(definition.endpoint), {
                        requestInit: { headers },
                        authProvider: definition.authProvider,
                        fetch: fetchWithActiveMcpTraceparent,
                    }),
                };
            }
            case "sse": {
                const { headers } = resolveEnvironmentHeaders(definition.headers, this.environment);
                assertOAuthHeaderCompatibility(definition, headers);
                return {
                    transport: new SSEClientTransport(httpEndpoint(definition.endpoint), {
                        requestInit: { headers },
                        authProvider: definition.authProvider,
                        fetch: fetchWithActiveMcpTraceparent,
                    }),
                };
            }
            case "inproc":
                return this.createInProcessTransport(
                    definition.id,
                    definition.serverFactory,
                    deadline,
                    journal,
                    serverJournal,
                    signal,
                );
            case "builtin": {
                const factory = this.builtins.get(definition.builtin);
                if (!factory) {
                    throw new Error(`Builtin MCP server '${definition.builtin}' is not registered.`);
                }
                return this.createInProcessTransport(
                    definition.id,
                    factory,
                    deadline,
                    journal,
                    serverJournal,
                    signal,
                );
            }
        }
    }

    private async createInProcessTransport(
        connectionId: string,
        factory: InProcessMcpServerFactory,
        deadline: number,
        journal: ProtocolJournal,
        serverJournal: ProtocolJournal,
        signal?: AbortSignal,
    ): Promise<CreatedTransport> {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const factoryPromise = Promise.resolve().then(factory);
        let server: InProcessMcpServer;
        try {
            server = await withTimeout(
                factoryPromise,
                remaining(deadline, this.now),
                "In-process MCP server factory timed out.",
                signal,
            );
        } catch (error) {
            if (isTimeoutError(error) || isAbortError(error)) {
                void factoryPromise
                    .then((lateServer) => lateServer.close())
                    .catch((cleanupError: unknown) => journal.recordTransportError(cleanupError));
            }
            throw error;
        }
        try {
            await withTimeout(
                server.connect(new JournaledTransport(serverTransport, serverJournal, {
                    correlation: () => this.correlation?.(connectionId),
                })),
                remaining(deadline, this.now),
                "In-process MCP server connection timed out.",
                signal,
            );
            return { transport: clientTransport, server };
        } catch (error) {
            try {
                await withTimeout(
                    server.close(),
                    this.disconnectTimeoutMs,
                    "In-process MCP server cleanup timed out.",
                );
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    `In-process MCP server connection failed: ${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`,
                );
            }
            throw error;
        }
    }

    private referencedSecretValues(definition: ConnectionDefinition): readonly string[] {
        if (definition.kind === "streamable-http" || definition.kind === "sse") {
            return resolveEnvironmentHeaders(definition.headers, this.environment).secretValues;
        }
        if (definition.kind === "stdio") {
            const values: string[] = [];
            for (const reference of definition.environment ?? []) {
                validateEnvironmentVariableName(reference.variable);
                validateEnvironmentVariableName(reference.environmentVariable);
                const value = requiredEnvironmentValue(reference.environmentVariable, this.environment);
                values.push(value);
            }
            return values;
        }
        return [];
    }

    private async cleanupFailedConnection(
        client: Client | undefined,
        server: InProcessMcpServer | undefined,
        journal: ProtocolJournal,
    ): Promise<void> {
        const cleanup = Promise.allSettled([
            client?.close() ?? Promise.resolve(),
            server?.close() ?? Promise.resolve(),
        ]);
        let closeResults: Awaited<typeof cleanup>;
        try {
            closeResults = await withTimeout(
                cleanup,
                this.disconnectTimeoutMs,
                "Failed connection cleanup timed out.",
            );
        } catch (error) {
            journal.recordTransportError(error);
            return;
        }
        for (const result of closeResults) {
            if (result.status === "rejected") journal.recordTransportError(result.reason);
        }
    }

    private handleUnexpectedClose(
        entry: ConnectionEntry,
        client: Client,
        journal: ProtocolJournal,
    ): void {
        if (entry.active?.client !== client || entry.lifecycle !== "connected") return;
        const server = entry.active.server;
        entry.active = undefined;
        entry.lastError = "MCP transport closed unexpectedly.";
        this.completeSession(entry, this.now(), "connection_closed");
        this.transition(entry, "failed");
        if (server) {
            void server.close().catch((error: unknown) => journal.recordTransportError(error));
        }
    }

    private publishOperation(
        entry: ConnectionEntry,
        operation: CompletedProtocolOperation,
    ): void {
        if (!this.onOperation) return;
        const peer = operation.role === "client" ? connectionPeer(entry.definition) : undefined;
        const enriched: ConnectionProtocolOperation = {
            ...operation,
            connectionId: entry.definition.id,
            transport: entry.definition.kind,
        };
        const protocolVersion = entry.initialization?.protocolVersion ?? entry.sessionProtocolVersion;
        const mcpSessionId = entry.initialization?.sessionId ?? entry.sessionId;
        if (protocolVersion !== undefined) enriched.protocolVersion = protocolVersion;
        if (mcpSessionId !== undefined) enriched.mcpSessionId = mcpSessionId;
        if (peer?.address !== undefined) enriched.peerAddress = peer.address;
        if (peer?.port !== undefined) enriched.peerPort = peer.port;
        this.onOperation(enriched);
    }

    private completeSession(
        entry: ConnectionEntry,
        endTimeMs: number,
        errorType?: string,
    ): void {
        const startTimeMs = entry.sessionStartedAtMs;
        if (startTimeMs === undefined) return;
        entry.sessionStartedAtMs = undefined;
        const protocolVersion = entry.sessionProtocolVersion;
        entry.sessionProtocolVersion = undefined;
        entry.sessionId = undefined;
        if (!this.onSession) return;

        const base = {
            connectionId: entry.definition.id,
            transport: entry.definition.kind,
            startTimeMs,
            endTimeMs: Math.max(startTimeMs, endTimeMs),
            ...(protocolVersion === undefined ? {} : { protocolVersion }),
            ...(errorType === undefined ? {} : { errorType }),
        };
        const peer = connectionPeer(entry.definition);
        const clientSession: CompletedConnectionSession = {
            ...base,
            role: "client",
            ...(peer?.address === undefined ? {} : { peerAddress: peer.address }),
            ...(peer?.port === undefined ? {} : { peerPort: peer.port }),
        };
        this.notifySession(entry, clientSession);
        if (entry.definition.kind === "inproc" || entry.definition.kind === "builtin") {
            this.notifySession(entry, { ...base, role: "server" });
        }
    }

    private notifySession(entry: ConnectionEntry, session: CompletedConnectionSession): void {
        try {
            this.onSession?.(structuredClone(session));
        } catch (error) {
            const redactor = entry.redactor ?? new SecretRedactor({ environment: this.environment });
            this.observerErrors.push({
                timestamp: new Date(this.now()).toISOString(),
                message: redactor.redactText(errorMessage(error)),
            });
            while (this.observerErrors.length > DEFAULT_MAX_OBSERVER_ERRORS) {
                this.observerErrors.shift();
            }
        }
    }

    private requireEntry(connectionId: string): ConnectionEntry {
        const entry = this.entries.get(connectionId);
        if (!entry) {
            throw new ConnectionManagerError(
                "not_registered",
                connectionId,
                `Connection '${connectionId}' is not registered.`,
            );
        }
        return entry;
    }

    private transition(entry: ConnectionEntry, lifecycle: ConnectionLifecycle): void {
        entry.lifecycle = lifecycle;
        this.publish(this.snapshotOf(entry));
    }

    private snapshotOf(entry: ConnectionEntry): ConnectionSnapshot {
        const snapshot: ConnectionSnapshot = {
            id: entry.definition.id,
            kind: entry.definition.kind,
            lifecycle: entry.lifecycle,
            journalEntries: entry.journal?.snapshot().length ?? 0,
        };
        if (entry.initialization !== undefined) {
            snapshot.initialization = structuredClone(entry.initialization);
        }
        if (entry.lastError !== undefined) snapshot.lastError = entry.lastError;
        return snapshot;
    }

    private publish(snapshot: ConnectionSnapshot): void {
        for (const push of this.subscribers) {
            try {
                push(structuredClone(snapshot));
            } catch (error) {
                const redactor = this.entries.get(snapshot.id)?.redactor ??
                    new SecretRedactor({ environment: this.environment });
                this.observerErrors.push({
                    timestamp: new Date(this.now()).toISOString(),
                    message: redactor.redactText(errorMessage(error)),
                });
                while (this.observerErrors.length > DEFAULT_MAX_OBSERVER_ERRORS) {
                    this.observerErrors.shift();
                }
            }
        }
    }
}

const fetchWithActiveMcpTraceparent: FetchLike = async (url, init) => {
    const traceparent = currentMcpTraceparent();
    if (traceparent === undefined
        || !isValidTraceparent(traceparent)
        || !isJsonRpcRequest(init?.body)) {
        return fetch(url, init);
    }
    const headers = new Headers(init?.headers);
    headers.set("traceparent", traceparent);
    return fetch(url, { ...init, headers });
};

function isJsonRpcRequest(body: RequestInit["body"]): boolean {
    if (typeof body !== "string") return false;
    try {
        const parsed = JSON.parse(body) as unknown;
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        return messages.some((message) => {
            if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
            const candidate = message as Record<string, unknown>;
            return candidate.jsonrpc === "2.0"
                && typeof candidate.method === "string"
                && (typeof candidate.id === "string" || typeof candidate.id === "number");
        });
    } catch {
        return false;
    }
}

function isValidTraceparent(value: string): boolean {
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(value);
    return match !== null
        && match[1] !== "00000000000000000000000000000000"
        && match[2] !== "0000000000000000";
}

function drainStdioStderr(
    transport: StdioClientTransport,
    journal: ProtocolJournal,
): void {
    const stderr = transport.stderr as Readable | null;
    if (stderr === null) return;
    stderr.on("error", () => {
        journal.recordTransportError(new Error("The stdio child stderr pipe failed."));
    });
    stderr.resume();
}

function connectionPeer(
    definition: ConnectionDefinition,
): { address: string; port?: number } | undefined {
    if (definition.kind !== "streamable-http" && definition.kind !== "sse") return undefined;
    const endpoint = new URL(definition.endpoint);
    const port = endpoint.port.length > 0
        ? Number(endpoint.port)
        : endpoint.protocol === "https:"
          ? 443
          : 80;
    return {
        address: endpoint.hostname,
        ...(Number.isSafeInteger(port) && port > 0 ? { port } : {}),
    };
}

function resolveEnvironmentVariables(
    references: readonly EnvironmentVariableReference[] | undefined,
    environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const reference of references ?? []) {
        validateEnvironmentVariableName(reference.variable);
        validateEnvironmentVariableName(reference.environmentVariable);
        result[reference.variable] = requiredEnvironmentValue(
            reference.environmentVariable,
            environment,
        );
    }
    return result;
}

function requiredEnvironmentValue(
    name: string,
    environment: Readonly<Record<string, string | undefined>>,
): string {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`Required environment variable '${name}' is not set.`);
    }
    return value;
}

function validateDefinition(definition: ConnectionDefinition): void {
    switch (definition.kind) {
        case "stdio":
            requireNonEmpty(definition.command, "Stdio command");
            break;
        case "streamable-http":
        case "sse":
            httpEndpoint(definition.endpoint);
            break;
        case "inproc":
            if (typeof definition.serverFactory !== "function") {
                throw new Error("In-process MCP connection requires a server factory.");
            }
            break;
        case "builtin":
            requireNonEmpty(definition.builtin, "Builtin name");
            break;
    }
}

function httpEndpoint(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("MCP endpoint must be an absolute HTTP URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("MCP endpoint must use HTTP or HTTPS.");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error(
            "MCP endpoint cannot contain userinfo, query parameters, or fragments; use environment-backed headers.",
        );
    }
    return url;
}

function assertOAuthHeaderCompatibility(
    definition: StreamableHttpConnectionDefinition | SseConnectionDefinition,
    headers: Headers,
): void {
    if (definition.authProvider && headers.has("authorization")) {
        throw new Error("OAuth and an environment-backed Authorization header cannot be configured together.");
    }
}

function requestOptions(
    deadline: number,
    now: () => number,
    signal?: AbortSignal,
): { timeout: number; maxTotalTimeout: number; signal?: AbortSignal } {
    throwIfAborted(signal);
    const timeout = remaining(deadline, now);
    const options: { timeout: number; maxTotalTimeout: number; signal?: AbortSignal } = {
        timeout,
        maxTotalTimeout: timeout,
    };
    if (signal !== undefined) options.signal = signal;
    return options;
}

function remaining(deadline: number, now: () => number): number {
    const value = deadline - now();
    if (value <= 0) throw timeoutError("MCP connection operation timed out.");
    return Math.max(1, value);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error("MCP connection operation was cancelled.");
    error.name = "AbortError";
    throw error;
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    signal?: AbortSignal,
): Promise<T> {
    throwIfAborted(signal);
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(message)), timeoutMs);
        if (signal) {
            abortListener = () => {
                const error = new Error("MCP connection operation was cancelled.");
                error.name = "AbortError";
                reject(error);
            };
            signal.addEventListener("abort", abortListener, { once: true });
        }
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
}

function timeoutError(message: string): Error {
    const error = new Error(message);
    error.name = "TimeoutError";
    return error;
}

function isTimeoutError(error: unknown): boolean {
    return error instanceof Error && (
        error.name === "TimeoutError" ||
        error.message.toLowerCase().includes("timed out") ||
        error.message.toLowerCase().includes("timeout")
    );
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sanitizedCause(error: unknown, redactor: SecretRedactor): Error {
    const cause = new Error(redactor.redactText(errorMessage(error)));
    if (error instanceof Error) cause.name = redactor.redactText(error.name);
    return cause;
}

function requireNonEmpty(value: string, name: string): void {
    if (!value.trim()) throw new Error(`${name} must not be empty.`);
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}
