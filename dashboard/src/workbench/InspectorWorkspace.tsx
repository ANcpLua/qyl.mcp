import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/server";
import { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/core";
import type {
  WorkbenchDiscoveryCollection as DiscoveryCollection,
  WorkbenchDiscoverySnapshot as DiscoverySnapshot,
  WorkbenchError as RunnerError,
  WorkbenchErrorCategory as ErrorCategory,
  WorkbenchExecutionRecord as ExecutionRecord,
  WorkbenchExecutionRequest as ExecutionRequest,
  WorkbenchExecutionTelemetryResponse as ExecutionTelemetry,
  WorkbenchProtocolEvent as ProtocolEvent,
  WorkbenchServer as McpServer,
  WorkbenchWorkspacePreferences as WorkspacePreferences,
  WorkbenchWorkspacePreferencesUpdateRequest as WorkspacePreferencesUpdateRequest,
} from "@ancplua/qyl-api-schema/types";
import { connectionSafetyReview } from "./connection-safety.js";
import {
  ContentRenderer,
  JsonCodeView,
  SchemaViewer,
  SynchronizedSchemaForm,
  ToolRiskBadge,
  assessToolRisk,
  confirmationCopyForTool,
  formatDuration,
  type JsonSchema,
  type SynchronizedSchemaInputSnapshot,
} from "./index.js";

type DiscoveryTab = "tools" | "resources" | "templates" | "prompts" | "capabilities" | "connection";
type ExecutionTab = "result" | "request" | "protocol" | "observability";

interface InspectorWorkspaceProps {
  server: McpServer;
  preferences: WorkspacePreferences | null;
  discovery: DiscoverySnapshot | null;
  discoveryError: string | null;
  executions: ExecutionRecord[];
  protocolEvents: ProtocolEvent[];
  telemetry: ExecutionTelemetry | null;
  telemetryError: string | null;
  busy: ReadonlySet<string>;
  onUpdatePreference: (patch: WorkspacePreferencesUpdateRequest) => Promise<void>;
  onServerAction: (action: "connect" | "disconnect" | "reconnect") => Promise<void>;
  onDeleteServer: (serverId: string) => Promise<void>;
  onRefreshDiscovery: () => Promise<void>;
  onStartExecution: (request: ExecutionRequest) => Promise<ExecutionRecord>;
  onCancelExecution: (executionId: string) => Promise<void>;
  onLoadTelemetry: (executionId: string) => Promise<void>;
}

// The optional members of the generated `Tool` are re-declared as accepting
// explicit undefined: this is a local view built by spreading a zod parse
// result, which produces `T | undefined` for every optional. The generated type
// itself stays untouched.
type ToolItem = {
  [K in keyof Omit<Tool, "inputSchema">]: Omit<Tool, "inputSchema">[K] | undefined;
} & {
  name: string;
  source: Record<string, unknown>;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations | undefined;
};

interface ToolInputState {
  toolName: string;
  snapshot: SynchronizedSchemaInputSnapshot;
}

const ERROR_COPY: Readonly<Record<ErrorCategory, { title: string; guidance: string }>> = {
  authentication: { title: "Authentication failed", guidance: "Verify the server-side environment reference and expected authentication scheme." },
  transport: { title: "Transport failed", guidance: "Inspect the endpoint, process state, TLS, and chronological transport events." },
  protocol: { title: "MCP protocol error", guidance: "Inspect the JSON-RPC request id, method, response, and discovery negotiation." },
  serialization: { title: "Serialization failed", guidance: "Inspect the raw payload and the MCP SDK envelope expected at this protocol version." },
  schema_validation: { title: "Schema validation failed", guidance: "Correct the tool arguments or inspect the returned payload against the published schema." },
  tool_error: { title: "Tool-generated error", guidance: "The server completed the MCP call with an error result; inspect its returned content." },
  timeout: { title: "Execution timed out", guidance: "Confirm the server stopped work before retrying to avoid a duplicate consequence." },
  cancelled: { title: "Execution cancelled", guidance: "Check protocol events to see whether the server acknowledged cancellation." },
  internal: { title: "Runner internal error", guidance: "Inspect diagnostic details and runner logs; the failure was outside the tool contract." },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function itemName(value: unknown, index: number): string {
  if (!isRecord(value)) return `Item ${index + 1}`;
  return optionalString(value.name)
    ?? optionalString(value.title)
    ?? optionalString(value.uri)
    ?? optionalString(value.uriTemplate)
    ?? `Item ${index + 1}`;
}

function itemDescription(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.description) : undefined;
}

function toolFrom(value: unknown, _index: number): ToolItem | null {
  if (!isRecord(value)) return null;
  const parsed = ToolSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    source: value,
    inputSchema: parsed.data.inputSchema as JsonSchema,
  };
}

function configurationDetail(server: McpServer): string {
  const configuration = server.configuration;
  switch (configuration.transport) {
    case "streamable_http": return configuration.endpoint;
    case "stdio": return [configuration.command, ...(configuration.arguments ?? [])].join(" ");
    case "builtin": return configuration.name;
  }
}

function collectionFor(tab: DiscoveryTab, discovery: DiscoverySnapshot | null): DiscoveryCollection | null {
  if (!discovery) return null;
  switch (tab) {
    case "tools": return discovery.tools;
    case "resources": return discovery.resources;
    case "templates": return discovery.resource_templates;
    case "prompts": return discovery.prompts;
    case "capabilities":
    case "connection": return null;
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function copyText(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

function StatusBadge({ status }: { status: ExecutionRecord["status"] }) {
  const tone = status === "succeeded"
    ? "positive"
    : status === "failed" || status === "timed_out"
      ? "negative"
      : status === "cancelled"
        ? "neutral"
        : "pending";
  return <span className={`pill tone-${tone}`}>{status.replaceAll("_", " ")}</span>;
}

function ErrorPanel({ error }: { error: RunnerError }) {
  const copy = ERROR_COPY[error.category];
  return (
    <section className={`typed-error error-${error.category}`} role="alert">
      <div className="section-heading-row">
        <div><span className="section-kicker">{error.category.replaceAll("_", " ")}</span><h3>{copy.title}</h3></div>
        <span className={`pill ${error.retryable ? "tone-pending" : "tone-negative"}`}>{error.retryable ? "retryable" : "terminal"}</span>
      </div>
      <p>{error.message}</p>
      <p className="muted-copy">{copy.guidance}</p>
      <div className="meta-line"><code>{error.code}</code><span>{formatTimestamp(error.occurred_at)}</span></div>
      {error.details !== undefined ? <JsonCodeView value={error.details} label="Error details" onCopy={copyText} /> : null}
    </section>
  );
}

function ResultPanel({ execution }: { execution: ExecutionRecord }) {
  if (execution.error) return <ErrorPanel error={execution.error} />;
  if (execution.result === undefined) {
    return <div className="empty-state compact-empty"><strong>No result yet</strong><span>The accepted execution is still in progress.</span></div>;
  }
  // CallToolResultSchema is a loose object whose `content` carries `.default([])`,
  // so safeParse accepts ANY JSON object — `{}` parses to `{ content: [] }`. Without
  // a discriminator first, a payload that is not a tool result would render as an
  // empty ContentRenderer instead of falling through to the raw view.
  const parsed = hasToolResultField(execution.result)
    ? CallToolResultSchema.safeParse(execution.result)
    : undefined;
  return parsed?.success === true
    ? <ContentRenderer result={parsed.data} onCopyStructuredContent={copyText} />
    : <JsonCodeView value={execution.result} label="Raw result" onCopy={copyText} />;
}

function hasToolResultField(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.hasOwn(value, "content")
    || Object.hasOwn(value, "structuredContent")
    || Object.hasOwn(value, "isError");
}

function ProtocolTimeline({ events, executionId }: { events: ProtocolEvent[]; executionId?: string }) {
  const relevant = executionId ? events.filter((event) => event.execution_id === executionId) : events;
  const [selectedEventId, setSelectedEventId] = useState("");
  const selected = relevant.find((event) => event.id === selectedEventId) ?? relevant.at(-1);
  return (
    <div className="protocol-inspector">
      <div className="protocol-timeline" aria-label="Chronological MCP protocol events">
        {relevant.map((event) => (
          <button
            type="button"
            key={event.id}
            className={`protocol-event${selected?.id === event.id ? " is-selected" : ""}`}
            onClick={() => setSelectedEventId(event.id)}
          >
            <span className={`direction direction-${event.direction}`}>{event.direction === "client_to_server" ? "→" : event.direction === "server_to_client" ? "←" : "•"}</span>
            <span><strong>{event.method ?? event.kind}</strong><small>{event.kind} · {formatTimestamp(event.timestamp)}</small></span>
            <span>{event.duration_ms === undefined ? "" : formatDuration(event.duration_ms)}</span>
          </button>
        ))}
        {relevant.length === 0 ? <p className="empty-note">No protocol events recorded for this selection.</p> : null}
      </div>
      <div className="protocol-payload">
        {selected ? (
          <>
            <dl className="detail-grid">
              <div><dt>Direction</dt><dd>{selected.direction}</dd></div>
              <div><dt>Kind</dt><dd>{selected.kind}</dd></div>
              <div><dt>Request id</dt><dd>{selected.request_id === undefined ? "—" : String(selected.request_id)}</dd></div>
              <div><dt>Redacted</dt><dd>{selected.redaction_applied ? "yes" : "no"}</dd></div>
            </dl>
            <JsonCodeView value={selected.payload} label="Protocol payload" onCopy={copyText} />
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TelemetryPanel({ telemetry, error, loading, onRefresh }: { telemetry: ExecutionTelemetry | null; error: string | null; loading: boolean; onRefresh: () => void }) {
  const signals = telemetry ? Object.entries(telemetry.signals) as Array<[keyof ExecutionTelemetry["signals"], ExecutionTelemetry["signals"][keyof ExecutionTelemetry["signals"]]]> : [];
  return (
    <section className="telemetry-panel">
      <div className="section-heading-row">
        <div><span className="section-kicker">qyl correlation</span><h3>Observability evidence</h3></div>
        <button type="button" className="small-button" disabled={loading} onClick={onRefresh}>{loading ? "Querying…" : "Refresh signals"}</button>
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {telemetry ? (
        <>
          <div className="signal-grid">
            {signals.map(([name, signal]) => (
              <article key={name} className={`signal-card signal-${signal.status}`}>
                <span>{name.replace(/([A-Z])/gu, " $1")}</span>
                <strong>{signal.item_count}</strong>
                <small>{signal.status}{signal.unavailable_reason ? ` · ${signal.unavailable_reason}` : ""}</small>
              </article>
            ))}
          </div>
          <div className="correlation-strip">
            <span>Trace ids <code>{telemetry.correlation.trace_ids.join(", ") || "—"}</code></span>
            <span>Span ids <code>{telemetry.correlation.span_ids.join(", ") || "—"}</code></span>
            <span className="safe-marker">Self-export suppressed</span>
          </div>
          <details><summary>Traces ({telemetry.traces.length})</summary><JsonCodeView value={telemetry.traces} label="Correlated traces" onCopy={copyText} /></details>
          <details><summary>Logs ({telemetry.logs.length})</summary><JsonCodeView value={telemetry.logs} label="Correlated logs" onCopy={copyText} /></details>
        </>
      ) : !error ? <p className="empty-note">Telemetry availability is being queried; no signal is assumed available.</p> : null}
    </section>
  );
}

export function InspectorWorkspace({
  server,
  preferences,
  discovery,
  discoveryError,
  executions,
  protocolEvents,
  telemetry,
  telemetryError,
  busy,
  onUpdatePreference,
  onServerAction,
  onDeleteServer,
  onRefreshDiscovery,
  onStartExecution,
  onCancelExecution,
  onLoadTelemetry,
}: InspectorWorkspaceProps) {
  const [discoveryTab, setDiscoveryTab] = useState<DiscoveryTab>("tools");
  const [query, setQuery] = useState("");
  const [selectedItemIndex, setSelectedItemIndex] = useState(0);
  const [selectedToolName, setSelectedToolName] = useState("");
  const [toolInput, setToolInput] = useState<ToolInputState | null>(null);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [confirmationChecked, setConfirmationChecked] = useState(false);
  const [executionSubmitError, setExecutionSubmitError] = useState<string | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [executionTab, setExecutionTab] = useState<ExecutionTab>("result");
  const [pendingConnectionAction, setPendingConnectionAction] = useState<"connect" | "reconnect" | null>(null);
  const [connectionReviewed, setConnectionReviewed] = useState(false);
  const loadTelemetryRef = useRef(onLoadTelemetry);
  loadTelemetryRef.current = onLoadTelemetry;

  const tools = useMemo(
    () => (discovery?.tools.items ?? []).map(toolFrom).filter((tool): tool is ToolItem => tool !== null),
    [discovery],
  );
  const selectedTool = tools.find((tool) => tool.name === selectedToolName) ?? null;
  const selectedExecution = executions.find((execution) => execution.id === selectedExecutionId) ?? executions[0] ?? null;
  const collection = collectionFor(discoveryTab, discovery);
  const filteredItems = useMemo(() => {
    const lowerQuery = query.trim().toLocaleLowerCase();
    return (collection?.items ?? []).map((item, index) => ({ item, index })).filter(({ item, index }) => {
      if (!lowerQuery) return true;
      return `${itemName(item, index)} ${itemDescription(item) ?? ""}`.toLocaleLowerCase().includes(lowerQuery);
    });
  }, [collection, query]);
  const selectedCollectionItem = collection?.items[selectedItemIndex];

  useEffect(() => {
    const preferred = preferences?.selected_tool_name;
    const next = tools.some((tool) => tool.name === selectedToolName)
      ? selectedToolName
      : tools.some((tool) => tool.name === preferred)
        ? preferred ?? ""
        : tools[0]?.name ?? "";
    setSelectedToolName(next);
  }, [tools, preferences?.selected_tool_name, selectedToolName]);

  useEffect(() => {
    if (!selectedExecutionId && executions[0]) setSelectedExecutionId(executions[0].id);
  }, [executions, selectedExecutionId]);

  useEffect(() => {
    if (executionTab === "observability" && selectedExecution) {
      void loadTelemetryRef.current(selectedExecution.id);
    }
  }, [executionTab, selectedExecution?.id]);

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
    setConfirmationOpen(false);
    setConfirmationChecked(false);
    setExecutionSubmitError(null);
  }, [selectedToolName]);

  const handleInputChange = useCallback((snapshot: SynchronizedSchemaInputSnapshot) => {
    setToolInput({ toolName: selectedToolName, snapshot });
  }, [selectedToolName]);

  const input = toolInput?.toolName === selectedToolName ? toolInput.snapshot : null;

  const requestPreview: ExecutionRequest | null = selectedTool && input ? {
    tool_name: selectedTool.name,
    arguments: input.value,
    timeout_ms: timeoutMs,
    idempotency_key: idempotencyKey,
  } : null;

  async function submitExecution(confirmed = false) {
    if (!selectedTool || !input?.isValid || !requestPreview) return;
    setExecutionSubmitError(null);
    const risk = assessToolRisk(selectedTool.annotations);
    if (risk.requiresConfirmation && !confirmed) {
      setConfirmationOpen(true);
      return;
    }
    const request: ExecutionRequest = {
      ...requestPreview,
      ...(risk.requiresConfirmation
        ? {
            confirmation: {
              acknowledged: true as const,
              acknowledgement: `Reviewed exact arguments and confirmed ${selectedTool.name}`,
            },
          }
        : {}),
    };
    try {
      const execution = await onStartExecution(request);
      setSelectedExecutionId(execution.id);
      setExecutionTab("result");
      setIdempotencyKey(crypto.randomUUID());
      setConfirmationOpen(false);
      setConfirmationChecked(false);
    } catch (error) {
      setExecutionSubmitError(error instanceof Error ? error.message : String(error));
    }
  }

  async function requestConnectionAction(action: "connect" | "disconnect" | "reconnect", confirmed = false) {
    const review = connectionSafetyReview(server.configuration);
    if (action !== "disconnect" && review && !confirmed) {
      setPendingConnectionAction(action);
      setConnectionReviewed(false);
      return;
    }
    await onServerAction(action);
    setPendingConnectionAction(null);
    setConnectionReviewed(false);
  }

  function selectTool(tool: ToolItem) {
    setSelectedToolName(tool.name);
    void onUpdatePreference({ selected_tool_name: tool.name });
  }

  const connection = server.connection;
  const connectionReview = connectionSafetyReview(server.configuration);
  const connectionCanStart = connection.status === "disconnected" || connection.status === "failed";
  const connectionCanStop = connection.status === "connected" || connection.status === "connecting" || connection.status === "reconnecting";

  return (
    <div className="inspector-workspace">
      <section className="server-overview panel-surface">
        <div className="server-identity">
          <span className={`status-dot tone-${connection.status === "connected" ? "positive" : connection.status === "failed" ? "negative" : "pending"}`} />
          <div><span className="section-kicker">{server.configuration.transport.replaceAll("_", " ")}</span><h2>{server.name}</h2><p>{server.description ?? configurationDetail(server)}</p></div>
        </div>
        <dl className="server-facts">
          <div><dt>Status</dt><dd>{connection.status}</dd></div>
          <div><dt>Protocol</dt><dd>{connection.initialization?.protocol_version ?? "not connected"}</dd></div>
          <div><dt>Changed</dt><dd>{formatTimestamp(connection.changed_at)}</dd></div>
        </dl>
        <div className="server-actions">
          <button className="primary-button" disabled={!connectionCanStart || busy.has("server:connect")} onClick={() => void requestConnectionAction("connect")}>Connect</button>
          <button className="secondary-button" disabled={connection.status === "disconnected" || busy.has("server:reconnect")} onClick={() => void requestConnectionAction("reconnect")}>Reconnect</button>
          <button className="secondary-button" disabled={!connectionCanStop || busy.has("server:disconnect")} onClick={() => void requestConnectionAction("disconnect")}>Disconnect</button>
          <button className="danger-button" disabled={connection.status !== "disconnected"} onClick={() => {
            if (window.confirm(`Delete the saved server configuration “${server.name}”?`)) void onDeleteServer(server.id);
          }}>Delete</button>
        </div>
        {connection.recent_error ? <ErrorPanel error={connection.recent_error} /> : null}
      </section>

      <section className="workbench-grid panel-surface">
        <div className="discovery-column">
          <div className="panel-toolbar">
            <div className="tab-list" role="tablist" aria-label="MCP discovery categories">
              {(["tools", "resources", "templates", "prompts", "capabilities", "connection"] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={discoveryTab === tab} onClick={() => {
                  setDiscoveryTab(tab);
                  setSelectedItemIndex(0);
                }}>{tab}</button>
              ))}
            </div>
            <button className="small-button" disabled={connection.status !== "connected" || busy.has("discovery")} onClick={() => void onRefreshDiscovery()}>Refresh</button>
          </div>
          {discoveryError ? <p className="inline-error discovery-refresh-error" role="alert">Latest refresh failed · {discoveryError}</p> : null}

          {collection ? (
            <>
              <label className="search-control"><span>Search {discoveryTab}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${collection.count} discovered items`} /></label>
              <div className="discovery-body">
                <div className="discovery-list">
                  {filteredItems.map(({ item, index }) => {
                    const tool = discoveryTab === "tools" ? toolFrom(item, index) : null;
                    const selected = discoveryTab === "tools" ? tool?.name === selectedToolName : selectedItemIndex === index;
                    return (
                      <button type="button" key={`${itemName(item, index)}-${index}`} className={`discovery-row${selected ? " is-selected" : ""}`} onClick={() => {
                        setSelectedItemIndex(index);
                        if (tool) selectTool(tool);
                      }}>
                        <span><strong>{itemName(item, index)}</strong><small>{itemDescription(item) ?? "No description supplied"}</small></span>
                        {tool ? <ToolRiskBadge annotations={tool.annotations} /> : null}
                      </button>
                    );
                  })}
                  {filteredItems.length === 0 ? <p className="empty-note">No matching {discoveryTab}.</p> : null}
                </div>
                <div className="discovery-detail">
                  {discoveryTab === "tools" && selectedTool ? (
                    <>
                      <div className="section-heading-row"><div><span className="section-kicker">Tool contract</span><h3>{selectedTool.name}</h3></div><ToolRiskBadge annotations={selectedTool.annotations} /></div>
                      <p>{selectedTool.description ?? "No description supplied by the server."}</p>
                      <SchemaViewer schema={selectedTool.inputSchema} label="Complete input schema" onCopy={copyText} />
                      <details><summary>Annotations and metadata</summary><JsonCodeView value={selectedTool.source} label="Tool metadata" onCopy={copyText} /></details>
                    </>
                  ) : selectedCollectionItem !== undefined ? <JsonCodeView value={selectedCollectionItem} label={`${discoveryTab} detail`} onCopy={copyText} /> : null}
                </div>
              </div>
              <div className="collection-foot"><span>{collection.count} items</span><span>{collection.complete ? "complete" : `partial · next cursor ${collection.next_cursor ?? "unknown"}`}</span><span>{formatTimestamp(collection.discovered_at)}</span></div>
            </>
          ) : discoveryTab === "capabilities" ? (
            <JsonCodeView value={connection.initialization?.capabilities ?? null} label="Negotiated capabilities" onCopy={copyText} />
          ) : discoveryTab === "connection" ? (
            <JsonCodeView value={connection.initialization ?? null} label="Connection result" onCopy={copyText} />
          ) : discoveryError ? null : <div className="empty-state compact-empty"><strong>No discovery snapshot</strong><span>Connect the server, then refresh discovery.</span></div>}
        </div>

        <div className="composer-column">
          <div className="panel-title"><span className="section-kicker">Invocation</span><h3>{selectedTool?.name ?? "Select a tool"}</h3></div>
          {selectedTool ? (
            <>
              <div className="risk-summary"><ToolRiskBadge annotations={selectedTool.annotations} /><span>{assessToolRisk(selectedTool.annotations).explanation}</span></div>
              <SynchronizedSchemaForm
                key={selectedTool.name}
                schema={selectedTool.inputSchema}
                onChange={handleInputChange}
                mode={preferences?.input_mode === "json" ? "raw" : "form"}
                onModeChange={(mode) => void onUpdatePreference({ input_mode: mode === "raw" ? "json" : "form" })}
                idPrefix={`tool-${selectedTool.name}`}
                disabled={busy.has("execute")}
              />
              <label className="timeout-control">Timeout <span><input type="number" min={1} max={3_600_000} value={timeoutMs} onChange={(event) => setTimeoutMs(Math.min(3_600_000, Math.max(1, Number(event.target.value))))} /> ms</span></label>
              {requestPreview ? <details><summary>Request representation</summary><JsonCodeView value={requestPreview} label="Execution request" onCopy={copyText} /></details> : null}
              <button className="run-button" disabled={!input?.isValid || busy.has("execute") || connection.status !== "connected"} onClick={() => void submitExecution()}>
                {busy.has("execute") ? "Submitting…" : assessToolRisk(selectedTool.annotations).requiresConfirmation ? "Review & run" : "Run tool"}
              </button>
              {input && !input.isValid ? <p className="field-error">Resolve the highlighted input errors before invoking.</p> : null}
              {executionSubmitError ? <p className="field-error" role="alert">{executionSubmitError}</p> : null}
            </>
          ) : <p className="empty-note">Select a discovered tool to build a schema-validated request.</p>}
        </div>
      </section>

      <section className="execution-console panel-surface">
        <div className="execution-history">
          <div className="panel-title"><span className="section-kicker">History</span><h3>Executions</h3></div>
          {executions.map((execution) => (
            <button type="button" key={execution.id} className={`execution-row${selectedExecution?.id === execution.id ? " is-selected" : ""}`} onClick={() => setSelectedExecutionId(execution.id)}>
              <span><strong>{execution.request.tool_name}</strong><small>{formatTimestamp(execution.created_at)}</small></span>
              <StatusBadge status={execution.status} />
              <span className="duration-cell">{formatDuration(execution.duration_ms)}</span>
            </button>
          ))}
          {executions.length === 0 ? <p className="empty-note">No persisted executions for this server.</p> : null}
        </div>
        <div className="execution-detail">
          {selectedExecution ? (
            <>
              <div className="execution-detail-head">
                <div><span className="section-kicker">Execution {selectedExecution.id.slice(0, 8)}</span><h3>{selectedExecution.request.tool_name}</h3></div>
                <div className="button-row">
                  <StatusBadge status={selectedExecution.status} />
                  {(["queued", "running", "cancelling"] as const).includes(selectedExecution.status as "queued" | "running" | "cancelling") ? (
                    <button className="danger-button" disabled={busy.has(`cancel:${selectedExecution.id}`) || selectedExecution.status === "cancelling"} onClick={() => void onCancelExecution(selectedExecution.id)}>Cancel</button>
                  ) : null}
                </div>
              </div>
              <dl className="execution-facts">
                <div><dt>Started</dt><dd>{formatTimestamp(selectedExecution.started_at)}</dd></div>
                <div><dt>Duration</dt><dd>{formatDuration(selectedExecution.duration_ms)}</dd></div>
                <div><dt>Attempts</dt><dd>{selectedExecution.attempt_count} ({selectedExecution.retry_count} retries)</dd></div>
                <div><dt>Effect</dt><dd>{selectedExecution.effect.replaceAll("_", " ")}</dd></div>
                <div><dt>Cancellation</dt><dd>{selectedExecution.cancelled_at ? `cancelled ${formatTimestamp(selectedExecution.cancelled_at)}` : selectedExecution.cancel_requested_at ? `requested ${formatTimestamp(selectedExecution.cancel_requested_at)}` : "not requested"}</dd></div>
              </dl>
              <div className="tab-list execution-tabs" role="tablist" aria-label="Execution evidence">
                {(["result", "request", "protocol", "observability"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={executionTab === tab} onClick={() => setExecutionTab(tab)}>{tab}</button>)}
              </div>
              <div className="execution-tab-panel">
                {executionTab === "result" ? <ResultPanel execution={selectedExecution} /> : null}
                {executionTab === "request" ? <JsonCodeView value={selectedExecution.request} label="Persisted request" onCopy={copyText} /> : null}
                {executionTab === "protocol" ? <ProtocolTimeline events={protocolEvents} executionId={selectedExecution.id} /> : null}
                {executionTab === "observability" ? <TelemetryPanel telemetry={telemetry} error={telemetryError} loading={busy.has(`telemetry:${selectedExecution.id}`)} onRefresh={() => void onLoadTelemetry(selectedExecution.id)} /> : null}
              </div>
            </>
          ) : <div className="empty-state compact-empty"><strong>No execution selected</strong><span>Run a tool or choose persisted history.</span></div>}
        </div>
      </section>

      <section className="protocol-console panel-surface">
        <div className="section-heading-row"><div><span className="section-kicker">Server journal</span><h3>All protocol traffic</h3></div><span className="count-label">{protocolEvents.length}</span></div>
        <ProtocolTimeline events={protocolEvents} />
      </section>

      {confirmationOpen && selectedTool && input ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
            <span className="section-kicker">Explicit safety confirmation</span>
            <h2 id="confirmation-title">{confirmationCopyForTool(selectedTool.name, selectedTool.annotations).title}</h2>
            <p>{confirmationCopyForTool(selectedTool.name, selectedTool.annotations).body}</p>
            <JsonCodeView value={{ toolName: selectedTool.name, arguments: input.value, timeoutMs }} label="Exact operation" />
            {executionSubmitError ? <p className="field-error" role="alert">{executionSubmitError}</p> : null}
            <label className="check-label confirmation-check"><input type="checkbox" checked={confirmationChecked} onChange={(event) => setConfirmationChecked(event.target.checked)} />I reviewed the exact target and arguments and accept the external effects.</label>
            <div className="button-row dialog-actions">
              <button className="danger-primary-button" disabled={!confirmationChecked || busy.has("execute")} onClick={() => void submitExecution(true)}>{confirmationCopyForTool(selectedTool.name, selectedTool.annotations).confirmLabel}</button>
              <button className="ghost-button" onClick={() => {
                setConfirmationOpen(false);
                setConfirmationChecked(false);
              }}>Cancel</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingConnectionAction && connectionReview ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-confirmation-title">
            <span className="section-kicker">Local execution boundary</span>
            <h2 id="connection-confirmation-title">{connectionReview.title}</h2>
            <p>{connectionReview.body}</p>
            <JsonCodeView value={{ action: pendingConnectionAction, configuration: server.configuration }} label="Exact connection operation" />
            <label className="check-label confirmation-check"><input type="checkbox" checked={connectionReviewed} onChange={(event) => setConnectionReviewed(event.target.checked)} />{connectionReview.acknowledgement}</label>
            <div className="button-row dialog-actions">
              <button className="danger-primary-button" disabled={!connectionReviewed || busy.has(`server:${pendingConnectionAction}`)} onClick={() => void requestConnectionAction(pendingConnectionAction, true)}>{pendingConnectionAction === "connect" ? "Start and connect" : "Restart and reconnect"}</button>
              <button className="ghost-button" onClick={() => {
                setPendingConnectionAction(null);
                setConnectionReviewed(false);
              }}>Cancel</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
