import { useCallback, useEffect, useMemo, useState } from "react";
import { McpUiToolMetaSchema, getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { useResources } from "./useResources";
import { useLogs } from "./useLogs";
import { useTools } from "./useTools";
import { AppFrame } from "./app-frame";
import { callResourceTool, runnerAction } from "./bridge";
import type { ResourceLifecycle } from "./types";

const DOT: Record<ResourceLifecycle, string> = {
  pending: "#6b7280",
  starting: "#d97706",
  ready: "#16a34a",
  stopping: "#d97706",
  stopped: "#6b7280",
  failed: "#dc2626",
};

/**
 * Check if a tool is visible to the model (not app-only).
 * Tools with `_meta.ui.visibility: ["app"]` are not shown in the tools panel.
 */
function isToolVisibleToModel(tool: Tool): boolean {
  const result = McpUiToolMetaSchema.safeParse(tool._meta?.ui);
  if (!result.success) return true; // default: visible to model
  const visibility = result.data.visibility;
  if (!visibility) return true; // default: visible to model
  return visibility.includes("model");
}

/** Compare tools: UI-enabled first, then alphabetically by name. */
function compareTools(a: Tool, b: Tool): number {
  const aHasUi = !!getToolUiResourceUri(a);
  const bHasUi = !!getToolUiResourceUri(b);
  if (aHasUi && !bHasUi) return -1;
  if (!aHasUi && bHasUi) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Extract default values from a tool's JSON Schema inputSchema.
 * Returns a formatted JSON string with defaults, or "{}" if none found.
 */
function getToolDefaults(tool: Tool | undefined): string {
  if (!tool?.inputSchema?.properties) return "{}";

  const defaults: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
    if (prop && typeof prop === "object" && "default" in prop) {
      defaults[key] = prop.default;
    }
  }

  return Object.keys(defaults).length > 0
    ? JSON.stringify(defaults, null, 2)
    : "{}";
}

interface ToolCallEntry {
  id: number;
  resource: string;
  tool: Tool;
  input: Record<string, unknown>;
  resultPromise: Promise<CallToolResult>;
  appResourceUri?: string;
}

let nextToolCallId = 0;

export default function App() {
  const { resources, connection } = useResources();
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [destroyingIds, setDestroyingIds] = useState<Set<number>>(new Set());

  const logs = useLogs(selected);
  const selectedState = resources.find((r) => r.name === selected);
  const selectedReady = selectedState?.lifecycle === "ready";
  const { tools, loading: toolsLoading, error: toolsError } = useTools(selected, selectedReady);

  const pushError = useCallback((message: string) => {
    setErrors((prev) => (prev.includes(message) ? prev : [...prev, message]));
  }, []);

  const doAction = (name: string, action: "restart" | "stop") => {
    runnerAction(name, action).catch((err: unknown) => {
      pushError(err instanceof Error ? err.message : String(err));
    });
  };

  const callTool = (resource: string, tool: Tool, input: Record<string, unknown>) => {
    let appResourceUri: string | undefined;
    try {
      appResourceUri = getToolUiResourceUri(tool);
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    }
    const resultPromise = callResourceTool(resource, tool.name, input);
    // Both ResultView and AppFrame attach rejection handlers after mount; this
    // no-op handler keeps an early rejection from firing unhandledrejection.
    resultPromise.catch(() => {});
    setToolCalls((prev) => [
      ...prev,
      { id: nextToolCallId++, resource, tool, input, resultPromise, appResourceUri },
    ]);
  };

  const requestClose = (id: number, isApp: boolean) => {
    if (!isApp) {
      setToolCalls((prev) => prev.filter((c) => c.id !== id));
      return;
    }
    setDestroyingIds((prev) => new Set(prev).add(id));
  };

  const completeClose = useCallback((id: number) => {
    setDestroyingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setToolCalls((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return (
    <main className="app">
      <header className="header">
        <h1>
          qyl<span className="accent">.mcp</span>
        </h1>
        <span className={`conn conn-${connection}`}>● {connection}</span>
      </header>

      {errors.length > 0 && (
        <div className="banner" role="alert">
          <div className="banner-body">
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
          <button className="banner-close" onClick={() => setErrors([])}>
            ✕
          </button>
        </div>
      )}

      {resources.length === 0 ? (
        <p className="empty">
          {connection === "open"
            ? "Waiting for resources…"
            : "Runner unreachable — waiting to reconnect…"}
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Server</th>
              <th>Tools</th>
              <th>Restarts</th>
              <th>Endpoint</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr
                key={r.name}
                className={r.name === selected ? "row selected" : "row"}
                onClick={() => setSelected(r.name === selected ? null : r.name)}
              >
                <td className="name">{r.name}</td>
                <td>{r.kind ?? "—"}</td>
                <td>
                  <span
                    className="badge"
                    style={{ borderColor: DOT[r.lifecycle], color: DOT[r.lifecycle] }}
                  >
                    <span className="dot" style={{ background: DOT[r.lifecycle] }} />
                    {r.lifecycle}
                  </span>
                  {r.lastError ? (
                    <span className="err" title={r.lastError}>
                      {" — "}
                      {r.lastError}
                    </span>
                  ) : null}
                </td>
                <td>{r.serverInfo ? `${r.serverInfo.name}@${r.serverInfo.version}` : "—"}</td>
                <td>{r.toolCount ?? "—"}</td>
                <td>{r.restarts ?? 0}</td>
                <td>{r.endpoint ? <code>{r.endpoint}</code> : "—"}</td>
                <td className="actions">
                  <button
                    className="action"
                    disabled={!["ready", "failed", "stopped"].includes(r.lifecycle)}
                    onClick={(e) => {
                      e.stopPropagation();
                      doAction(r.name, "restart");
                    }}
                  >
                    restart
                  </button>
                  <button
                    className="action"
                    disabled={["stopping", "stopped"].includes(r.lifecycle)}
                    onClick={(e) => {
                      e.stopPropagation();
                      doAction(r.name, "stop");
                    }}
                  >
                    stop
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        selectedReady ? (
          <ToolsPanel
            key={selected}
            resource={selected}
            tools={tools}
            loading={toolsLoading}
            error={toolsError}
            onCall={(tool, input) => callTool(selected, tool, input)}
          />
        ) : (
          <p className="hint">
            Tools are available once <strong>{selected}</strong> is ready.
          </p>
        )
      ) : (
        resources.length > 0 && <p className="hint">Click a resource to see its tools and logs.</p>
      )}

      {toolCalls.map((entry) => (
        <ToolCallPanel
          key={entry.id}
          entry={entry}
          isDestroying={destroyingIds.has(entry.id)}
          onRequestClose={() => requestClose(entry.id, !!entry.appResourceUri)}
          onCloseComplete={() => completeClose(entry.id)}
          onError={pushError}
        />
      ))}

      {selected ? (
        <section className="logs">
          <div className="logs-head">
            <span>
              logs · <strong>{selected}</strong>
            </span>
            <button className="logs-close" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="logs-body">
            {logs.length === 0
              ? "— no output yet —"
              : logs.map((l, i) => (
                  <div key={i} className={l.stream === "err" ? "logline err-line" : "logline"}>
                    {l.line}
                  </div>
                ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

interface ToolsPanelProps {
  resource: string;
  tools: Tool[];
  loading: boolean;
  error: string | null;
  onCall: (tool: Tool, input: Record<string, unknown>) => void;
}

function ToolsPanel({ resource, tools, loading, error, onCall }: ToolsPanelProps) {
  const visibleTools = useMemo(
    () => tools.filter(isToolVisibleToModel).sort(compareTools),
    [tools],
  );
  const [selectedTool, setSelectedTool] = useState("");
  const [argsJson, setArgsJson] = useState("{}");

  useEffect(() => {
    if (visibleTools.some((t) => t.name === selectedTool)) return;
    const first = visibleTools[0];
    setSelectedTool(first?.name ?? "");
    setArgsJson(getToolDefaults(first));
  }, [visibleTools, selectedTool]);

  const isValidJson = useMemo(() => {
    try {
      JSON.parse(argsJson);
      return true;
    } catch {
      return false;
    }
  }, [argsJson]);

  const tool = visibleTools.find((t) => t.name === selectedTool);

  return (
    <section className="tools">
      <div className="tools-head">
        tools · <strong>{resource}</strong>
      </div>
      {error ? (
        <p className="err tools-status">Failed to load tools: {error}</p>
      ) : loading ? (
        <p className="hint tools-status">Loading tools…</p>
      ) : visibleTools.length === 0 ? (
        <p className="hint tools-status">No model-visible tools.</p>
      ) : (
        <form
          className="tools-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (tool && isValidJson) onCall(tool, JSON.parse(argsJson) as Record<string, unknown>);
          }}
        >
          <label>
            Tool
            <select
              value={selectedTool}
              onChange={(e) => {
                setSelectedTool(e.target.value);
                setArgsJson(getToolDefaults(visibleTools.find((t) => t.name === e.target.value)));
              }}
            >
              {visibleTools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {getToolUiResourceUri(t) ? " ⧉" : ""}
                </option>
              ))}
            </select>
          </label>
          {tool?.description ? <p className="hint tool-desc">{tool.description}</p> : null}
          <label>
            Arguments (JSON)
            <textarea
              aria-invalid={!isValidJson}
              value={argsJson}
              onChange={(e) => setArgsJson(e.target.value)}
              rows={6}
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={!tool || !isValidJson}>
            Call
          </button>
        </form>
      )}
    </section>
  );
}

interface ToolCallPanelProps {
  entry: ToolCallEntry;
  isDestroying: boolean;
  onRequestClose: () => void;
  onCloseComplete: () => void;
  onError: (message: string) => void;
}

function ToolCallPanel({ entry, isDestroying, onRequestClose, onCloseComplete, onError }: ToolCallPanelProps) {
  return (
    <section
      className="tool-call"
      style={isDestroying ? { opacity: 0.5, pointerEvents: "none" } : undefined}
    >
      <div className="tool-call-head">
        <span>
          {entry.resource}:<strong>{entry.tool.name}</strong>
        </span>
        {!isDestroying && (
          <button className="logs-close" onClick={onRequestClose} title="Close">
            ✕
          </button>
        )}
      </div>
      {entry.appResourceUri ? (
        <AppFrame
          resource={entry.resource}
          resourceUri={entry.appResourceUri}
          input={entry.input}
          resultPromise={entry.resultPromise}
          isDestroying={isDestroying}
          onTeardownComplete={onCloseComplete}
          onError={onError}
        />
      ) : (
        <ResultView resultPromise={entry.resultPromise} />
      )}
    </section>
  );
}

function ResultView({ resultPromise }: { resultPromise: Promise<CallToolResult> }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resultPromise.then(
      (result) => {
        if (!cancelled) setText(JSON.stringify(result, null, 2));
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [resultPromise]);

  if (error) return <pre className="result err">{error}</pre>;
  if (text === null) return <p className="hint tools-status">calling…</p>;
  return <pre className="result">{text}</pre>;
}
