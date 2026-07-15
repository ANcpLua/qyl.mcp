import { useMemo, useState, type FormEvent } from "react";
import type {
  RunnerMcpServer as McpServer,
  RunnerMcpServerConfiguration as ServerConfiguration,
  RunnerMcpWorkspace as Workspace,
} from "@ancplua/qyl-api-schema/types";
import {
  connectionSafetyReview,
  normalizeRemoteEndpoint,
} from "./connection-safety.js";

interface WorkbenchSidebarProps {
  workspaces: Workspace[];
  workspaceId: string;
  servers: McpServer[];
  serverId: string;
  busy: ReadonlySet<string>;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string, description?: string) => Promise<unknown>;
  onUpdateWorkspace: (workspaceId: string, name: string, description?: string) => Promise<unknown>;
  onSelectServer: (serverId: string) => void;
  onCreateServer: (draft: {
    name: string;
    description?: string;
    configuration: ServerConfiguration;
    autoConnect: boolean;
  }) => Promise<unknown>;
  onUpdateServer: (serverId: string, draft: {
    name: string;
    description?: string;
    configuration: ServerConfiguration;
  }) => Promise<unknown>;
}

type Transport = ServerConfiguration["transport"];
type UserConfigurableTransport = Extract<Transport, "streamable_http" | "sse" | "stdio">;
type UserConfigurableConfiguration = Extract<ServerConfiguration, { transport: UserConfigurableTransport }>;
type UserConfigurableServer = McpServer & { configuration: UserConfigurableConfiguration };

export const SERVER_TRANSPORT_OPTIONS: ReadonlyArray<{ value: UserConfigurableTransport; label: string }> = [
  { value: "streamable_http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "Local stdio" },
];

export function isUserConfigurableServer(server: McpServer): server is UserConfigurableServer {
  return server.configuration.transport === "streamable_http"
    || server.configuration.transport === "sse"
    || server.configuration.transport === "stdio";
}

function connectionTone(status: McpServer["connection"]["status"]): string {
  if (status === "connected") return "positive";
  if (status === "failed") return "negative";
  if (status === "disconnected") return "neutral";
  return "pending";
}

function parseArguments(value: string): string[] | undefined {
  const entries = value.split("\n").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function parseEnvironment(value: string): Array<{ name: string; secret: { source: "environment"; environmentVariable: string } }> | undefined {
  const result = value.split("\n").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`Environment reference “${entry}” must use NAME=ENV_VAR.`);
    const name = entry.slice(0, separator).trim();
    const environmentVariable = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentVariable)) {
      throw new Error(`Environment reference “${entry}” contains an invalid variable name.`);
    }
    return { name, secret: { source: "environment" as const, environmentVariable } };
  });
  return result.length > 0 ? result : undefined;
}

function parseHeaders(value: string): Array<{
  name: string;
  secret: { source: "environment"; environmentVariable: string };
  scheme?: "bearer" | "basic";
}> | undefined {
  const seen = new Set<string>();
  const result = value.split("\n").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`Header reference “${entry}” must use Header=ENV_VAR or Header=ENV_VAR|scheme.`);
    const name = entry.slice(0, separator).trim();
    const [environmentVariable = "", rawScheme] = entry.slice(separator + 1).split("|").map((part) => part.trim());
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentVariable)) {
      throw new Error(`Header reference “${entry}” contains an invalid name or environment variable.`);
    }
    const normalizedName = name.toLocaleLowerCase();
    if (seen.has(normalizedName)) throw new Error(`Header “${name}” is configured more than once.`);
    seen.add(normalizedName);
    if (rawScheme !== undefined && rawScheme !== "bearer" && rawScheme !== "basic") {
      throw new Error(`Header scheme “${rawScheme}” must be bearer or basic.`);
    }
    return {
      name,
      secret: { source: "environment" as const, environmentVariable },
      scheme: rawScheme as "bearer" | "basic" | undefined,
    };
  });
  return result.length > 0 ? result : undefined;
}

function formatEnvironment(configuration: Extract<ServerConfiguration, { transport: "stdio" }>): string {
  return (configuration.environment ?? [])
    .map((reference) => `${reference.name}=${reference.secret.environmentVariable}`)
    .join("\n");
}

function formatHeaders(configuration: Extract<ServerConfiguration, { transport: "streamable_http" | "sse" }>): string {
  return (configuration.headers ?? [])
    .map((reference) => `${reference.name}=${reference.secret.environmentVariable}${reference.scheme ? `|${reference.scheme}` : ""}`)
    .join("\n");
}

function transportLabel(configuration: ServerConfiguration): string {
  switch (configuration.transport) {
    case "streamable_http": return "HTTP";
    case "sse": return "SSE";
    case "stdio": return "STDIO";
    case "inproc": return "INPROC";
    case "builtin": return "BUILTIN";
  }
}

export function WorkbenchSidebar({
  workspaces,
  workspaceId,
  servers,
  serverId,
  busy,
  onSelectWorkspace,
  onCreateWorkspace,
  onUpdateWorkspace,
  onSelectServer,
  onCreateServer,
  onUpdateServer,
}: WorkbenchSidebarProps) {
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceDescription, setWorkspaceDescription] = useState("");
  const [workspaceFormError, setWorkspaceFormError] = useState<string | null>(null);
  const [showServerForm, setShowServerForm] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [transport, setTransport] = useState<UserConfigurableTransport>("streamable_http");
  const [endpoint, setEndpoint] = useState("");
  const [command, setCommand] = useState("");
  const [argumentsText, setArgumentsText] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [environmentText, setEnvironmentText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [autoConnect, setAutoConnect] = useState(true);
  const [connectionReviewed, setConnectionReviewed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedServer = servers.find((server) => server.id === serverId);
  const editingServer = editingServerId === null
    ? undefined
    : servers.find((server) => server.id === editingServerId);
  const localProcessStartsOnSave = transport === "stdio"
    && (editingServer ? editingServer.connection.status === "connected" : autoConnect);

  const canSubmitServer = useMemo(() => {
    if (!name.trim()) return false;
    if (localProcessStartsOnSave && !connectionReviewed) return false;
    if (transport === "streamable_http" || transport === "sse") return endpoint.trim().length > 0;
    return command.trim().length > 0;
  }, [name, transport, endpoint, command, localProcessStartsOnSave, connectionReviewed]);

  function resetWorkspaceForm() {
    setShowWorkspaceForm(false);
    setEditingWorkspaceId(null);
    setWorkspaceName("");
    setWorkspaceDescription("");
    setWorkspaceFormError(null);
  }

  function beginCreateWorkspace() {
    resetWorkspaceForm();
    setShowWorkspaceForm(true);
  }

  function beginEditWorkspace() {
    if (!selectedWorkspace) return;
    setEditingWorkspaceId(selectedWorkspace.id);
    setWorkspaceName(selectedWorkspace.name);
    setWorkspaceDescription(selectedWorkspace.description ?? "");
    setWorkspaceFormError(null);
    setShowWorkspaceForm(true);
  }

  function resetServerForm() {
    setShowServerForm(false);
    setEditingServerId(null);
    setName("");
    setDescription("");
    setTransport("streamable_http");
    setEndpoint("");
    setCommand("");
    setArgumentsText("");
    setWorkingDirectory("");
    setEnvironmentText("");
    setHeadersText("");
    setAutoConnect(true);
    setConnectionReviewed(false);
    setFormError(null);
  }

  function beginCreateServer() {
    resetServerForm();
    setShowServerForm(true);
  }

  function beginEditServer() {
    if (!selectedServer || !isUserConfigurableServer(selectedServer)) return;
    const configuration = selectedServer.configuration;
    setEditingServerId(selectedServer.id);
    setName(selectedServer.name);
    setDescription(selectedServer.description ?? "");
    setTransport(configuration.transport);
    setEndpoint(configuration.transport === "streamable_http" || configuration.transport === "sse" ? configuration.endpoint : "");
    setHeadersText(configuration.transport === "streamable_http" || configuration.transport === "sse" ? formatHeaders(configuration) : "");
    setCommand(configuration.transport === "stdio" ? configuration.command : "");
    setArgumentsText(configuration.transport === "stdio" ? (configuration.arguments ?? []).join("\n") : "");
    setWorkingDirectory(configuration.transport === "stdio" ? configuration.workingDirectory ?? "" : "");
    setEnvironmentText(configuration.transport === "stdio" ? formatEnvironment(configuration) : "");
    setConnectionReviewed(false);
    setFormError(null);
    setShowServerForm(true);
  }

  function serverConfiguration(): ServerConfiguration {
    switch (transport) {
      case "stdio":
        return {
          transport,
          command: command.trim(),
          arguments: parseArguments(argumentsText),
          workingDirectory: workingDirectory.trim() || undefined,
          environment: parseEnvironment(environmentText),
        };
      case "streamable_http":
      case "sse":
        return { transport, endpoint: normalizeRemoteEndpoint(endpoint), headers: parseHeaders(headersText) };
    }
  }

  async function submitWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim()) return;
    setWorkspaceFormError(null);
    try {
      if (editingWorkspaceId) {
        await onUpdateWorkspace(editingWorkspaceId, workspaceName.trim(), workspaceDescription.trim() || undefined);
      } else {
        await onCreateWorkspace(workspaceName.trim(), workspaceDescription.trim() || undefined);
      }
      resetWorkspaceForm();
    } catch (error) {
      setWorkspaceFormError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitServer(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    try {
      const configuration = serverConfiguration();
      if (localProcessStartsOnSave && connectionSafetyReview(configuration) && !connectionReviewed) {
        throw new Error("Review and acknowledge the local executable connection before connecting.");
      }
      const draft = { name: name.trim(), description: description.trim() || undefined, configuration };
      if (editingServerId) await onUpdateServer(editingServerId, draft);
      else await onCreateServer({ ...draft, autoConnect });
      resetServerForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <aside className="workbench-sidebar" aria-label="Server workspace">
      <section className="sidebar-section workspace-switcher">
        <div className="section-kicker">Workspace</div>
        <div className="inline-control">
          <select
            aria-label="Active workspace"
            value={workspaceId}
            onChange={(event) => onSelectWorkspace(event.target.value)}
          >
            {workspaces.length === 0 ? <option value="">No workspaces</option> : null}
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button
            type="button"
            className="icon-button"
            aria-label="Create workspace"
            title="Create workspace"
            onClick={beginCreateWorkspace}
          >
            +
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Edit workspace"
            title="Edit selected workspace"
            disabled={!selectedWorkspace}
            onClick={beginEditWorkspace}
          >
            ✎
          </button>
        </div>
        {showWorkspaceForm ? (
          <form className="stack-form inset-form" onSubmit={(event) => void submitWorkspace(event)}>
            <strong>{editingWorkspaceId ? "Edit workspace" : "Create workspace"}</strong>
            <label>Name<input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required /></label>
            <label>Description<textarea rows={2} value={workspaceDescription} onChange={(event) => setWorkspaceDescription(event.target.value)} /></label>
            {workspaceFormError ? <p className="field-error" role="alert">{workspaceFormError}</p> : null}
            <div className="button-row">
              <button className="primary-button" disabled={!workspaceName.trim() || busy.has(editingWorkspaceId ? `update-workspace:${editingWorkspaceId}` : "create-workspace")}>{editingWorkspaceId ? "Save changes" : "Create"}</button>
              <button type="button" className="ghost-button" onClick={resetWorkspaceForm}>Cancel</button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="sidebar-section server-list-section">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">MCP servers</div>
            <span className="count-label">{servers.length}</span>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="small-button"
              disabled={!selectedServer || !isUserConfigurableServer(selectedServer)}
              title={selectedServer && !isUserConfigurableServer(selectedServer) ? "Runner-owned built-in and in-process servers cannot be edited." : "Edit selected server"}
              onClick={beginEditServer}
            >
              Edit
            </button>
            <button
              type="button"
              className="small-button"
              disabled={!workspaceId}
              onClick={beginCreateServer}
            >
              Add server
            </button>
          </div>
        </div>

        {showServerForm ? (
          <form className="stack-form server-form" onSubmit={(event) => void submitServer(event)}>
            <strong>{editingServerId ? "Edit server" : "Add server"}</strong>
            <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <label>Description<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <label>Transport
              <select value={transport} onChange={(event) => {
                setTransport(event.target.value as UserConfigurableTransport);
                setConnectionReviewed(false);
              }}>
                {SERVER_TRANSPORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <p className="form-help">Runner-registered in-process and built-in servers are displayed when available, but cannot be created or edited from the browser.</p>
            {transport === "streamable_http" || transport === "sse" ? (
              <>
                <label>Endpoint<input type="url" placeholder="https://mcp.example.test/mcp" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required /></label>
                <label>Header secret references<textarea rows={3} placeholder={"Authorization=MCP_TOKEN|bearer\nX-Api-Key=MCP_API_KEY"} value={headersText} onChange={(event) => setHeadersText(event.target.value)} /></label>
                <p className="form-help">Only environment-variable names are persisted. Secret values never enter the browser.</p>
              </>
            ) : null}
            {transport === "stdio" ? (
              <>
                <label>Command<input placeholder="npx" value={command} onChange={(event) => { setCommand(event.target.value); setConnectionReviewed(false); }} required /></label>
                <label>Arguments, one per line<textarea rows={3} value={argumentsText} onChange={(event) => { setArgumentsText(event.target.value); setConnectionReviewed(false); }} /></label>
                <label>Working directory<input value={workingDirectory} onChange={(event) => { setWorkingDirectory(event.target.value); setConnectionReviewed(false); }} /></label>
                <label>Environment references<textarea rows={3} placeholder="SERVER_TOKEN=MCP_SERVER_TOKEN" value={environmentText} onChange={(event) => { setEnvironmentText(event.target.value); setConnectionReviewed(false); }} /></label>
              </>
            ) : null}
            {!editingServerId ? <label className="check-label"><input type="checkbox" checked={autoConnect} onChange={(event) => { setAutoConnect(event.target.checked); if (event.target.checked) setConnectionReviewed(false); }} />Connect after save</label> : null}
            {localProcessStartsOnSave ? (
              <div className="local-execution-warning">
                <strong>Local code execution</strong>
                <p>{editingServerId ? "Saving reconnects this connected server and starts" : "Connecting starts"} the exact command above with your local user permissions.</p>
                <label className="check-label"><input type="checkbox" checked={connectionReviewed} onChange={(event) => setConnectionReviewed(event.target.checked)} />I reviewed the executable target and want to {editingServerId ? "reconnect" : "connect"} after saving.</label>
              </div>
            ) : null}
            {formError ? <p className="field-error" role="alert">{formError}</p> : null}
            <div className="button-row">
              <button className="primary-button" disabled={!canSubmitServer || busy.has(editingServerId ? `update-server:${editingServerId}` : "create-server")}>{editingServerId ? "Save changes" : "Save server"}</button>
              <button type="button" className="ghost-button" onClick={resetServerForm}>Cancel</button>
            </div>
          </form>
        ) : null}

        <nav className="server-list" aria-label="Configured MCP servers">
          {servers.map((server) => (
            <button
              type="button"
              key={server.id}
              className={`server-row${server.id === serverId ? " is-selected" : ""}`}
              onClick={() => onSelectServer(server.id)}
            >
              <span className={`status-dot tone-${connectionTone(server.connection.status)}`} aria-hidden="true" />
              <span className="server-row-main">
                <strong>{server.name}</strong>
                <span>{transportLabel(server.configuration)} · {server.connection.status}</span>
              </span>
            </button>
          ))}
          {workspaceId && servers.length === 0 && !showServerForm ? (
            <p className="empty-note">No MCP servers configured in this workspace.</p>
          ) : null}
        </nav>
      </section>

      <footer className="sidebar-footer">
        <span>Secrets: environment references only</span>
        <span>Session: loopback cookie</span>
      </footer>
    </aside>
  );
}
