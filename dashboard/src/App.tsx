import { useEffect, useState } from "react";
import { EvaluationsWorkspace } from "./workbench/EvaluationsWorkspace.js";
import { InspectorWorkspace } from "./workbench/InspectorWorkspace.js";
import { TestsWorkspace } from "./workbench/TestsWorkspace.js";
import { WorkbenchSidebar } from "./workbench/WorkbenchSidebar.js";
import { useWorkbench } from "./workbench/useWorkbench.js";

type ActivePanel = "inspect" | "tests" | "evaluations";

function isActivePanel(value: string | undefined): value is ActivePanel {
  return value === "inspect" || value === "tests" || value === "evaluations";
}

export default function App() {
  const workbench = useWorkbench();
  const [activePanel, setActivePanel] = useState<ActivePanel>("inspect");

  useEffect(() => {
    if (isActivePanel(workbench.preferences?.activePanel)) {
      setActivePanel(workbench.preferences.activePanel);
    }
  }, [workbench.preferences?.activePanel]);

  function selectPanel(panel: ActivePanel) {
    setActivePanel(panel);
    void workbench.updatePreference({ activePanel: panel });
  }

  if (workbench.phase === "loading") {
    return (
      <main className="boot-screen">
        <div className="brand-mark">qyl<span>.mcp</span></div>
        <div className="boot-progress"><span /></div>
        <p>Opening the local, workspace-isolated MCP workbench…</p>
      </main>
    );
  }

  return (
    <div className={`application${workbench.preferences?.compactMode ? " compact-mode" : ""}`}>
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark">qyl<span>.mcp</span></div>
          <span className="product-label">developer workbench</span>
        </div>
        <nav className="primary-nav" aria-label="Workbench areas">
          <button type="button" aria-current={activePanel === "inspect" ? "page" : undefined} onClick={() => selectPanel("inspect")}>Explorer</button>
          <button type="button" aria-current={activePanel === "tests" ? "page" : undefined} onClick={() => selectPanel("tests")}>Tests</button>
          <button type="button" aria-current={activePanel === "evaluations" ? "page" : undefined} onClick={() => selectPanel("evaluations")}>Evaluations</button>
        </nav>
        <div className="header-context">
          <div className="session-principal">
            <span className="status-dot tone-positive" />
            <span><strong>{workbench.session?.principal.displayName ?? workbench.session?.principal.id ?? "local user"}</strong><small>loopback session</small></span>
          </div>
          <button
            type="button"
            className="compact-toggle"
            disabled={workbench.phase !== "ready" || workbench.busy.has("refresh-all")}
            title={workbench.lastRefreshedAt ? `Last refreshed ${new Date(workbench.lastRefreshedAt).toLocaleString()}` : "Reload persisted workspace state"}
            onClick={() => void workbench.refreshAll()}
          >
            {workbench.busy.has("refresh-all") ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="compact-toggle"
            aria-pressed={workbench.preferences?.compactMode ?? false}
            disabled={!workbench.workspaceId}
            onClick={() => void workbench.updatePreference({ compactMode: !(workbench.preferences?.compactMode ?? false) })}
          >
            Density
          </button>
        </div>
      </header>

      <div className="notice-stack" aria-live="polite">
        {workbench.notices.map((notice) => (
          <div key={notice.id} className={`notice notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            <span>{notice.message}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => workbench.dismissNotice(notice.id)}>×</button>
          </div>
        ))}
      </div>

      <div className="application-shell">
        <WorkbenchSidebar
          workspaces={workbench.workspaces}
          workspaceId={workbench.workspaceId}
          servers={workbench.servers}
          serverId={workbench.serverId}
          busy={workbench.busy}
          onSelectWorkspace={workbench.selectWorkspace}
          onCreateWorkspace={workbench.createWorkspace}
          onUpdateWorkspace={workbench.updateWorkspace}
          onSelectServer={workbench.selectServer}
          onCreateServer={workbench.createServer}
          onUpdateServer={workbench.updateServer}
        />

        <main className="workspace-content">
          {workbench.phase === "failed" ? (
            <section className="empty-state panel-surface critical-state">
              <strong>The local runner is unavailable</strong>
              <span>Session bootstrap failed. Start qyl.mcp on the loopback interface, then reload this page.</span>
              <button type="button" className="primary-button" onClick={() => window.location.reload()}>Reload</button>
            </section>
          ) : !workbench.workspaceId ? (
            <section className="empty-state panel-surface">
              <strong>Create a workspace to begin</strong>
              <span>Server configurations, tests, evaluation evidence, and UI preferences stay isolated inside it.</span>
            </section>
          ) : activePanel === "inspect" ? (
            workbench.selectedServer ? (
              <InspectorWorkspace
                server={workbench.selectedServer}
                preferences={workbench.preferences}
                discovery={workbench.discovery}
                discoveryError={workbench.discoveryError}
                executions={workbench.executions}
                protocolEvents={workbench.protocolEvents}
                telemetry={workbench.telemetry}
                telemetryError={workbench.telemetryError}
                busy={workbench.busy}
                onUpdatePreference={workbench.updatePreference}
                onServerAction={workbench.serverAction}
                onDeleteServer={workbench.deleteServer}
                onRefreshDiscovery={workbench.refreshDiscovery}
                onStartExecution={workbench.startExecution}
                onCancelExecution={workbench.cancelExecution}
                onLoadTelemetry={workbench.loadTelemetry}
              />
            ) : (
              <section className="empty-state panel-surface">
                <strong>Add an MCP server</strong>
                <span>Add Streamable HTTP, SSE, or local stdio. Runner-registered internal servers appear automatically; credentials remain server-side environment references.</span>
              </section>
            )
          ) : activePanel === "tests" ? (
            <TestsWorkspace
              servers={workbench.servers}
              executions={workbench.executions}
              testCases={workbench.testCases}
              suites={workbench.suites}
              busy={workbench.busy}
              onCreateTestCase={workbench.createTestCase}
              onUpdateTestCase={workbench.updateTestCase}
              onDeleteTestCase={async (testCaseId) => { await workbench.deleteTestCase(testCaseId); }}
              onRunTestCase={async (testCaseId, confirmation) => { await workbench.runTestCase(testCaseId, confirmation); }}
              onCreateSuite={workbench.createSuite}
              onUpdateSuite={workbench.updateSuite}
              onDeleteSuite={async (suiteId) => { await workbench.deleteSuite(suiteId); }}
              onRunSuite={async (suiteId, confirmation) => { await workbench.runSuite(suiteId, confirmation); }}
            />
          ) : (
            <EvaluationsWorkspace
              runs={workbench.evaluationRuns}
              comparison={workbench.comparison}
              activeExport={workbench.activeExport}
              exportArtifact={workbench.exportArtifact}
              busy={workbench.busy}
              onCompare={async (baseline, candidate) => { await workbench.compareRuns(baseline, candidate); }}
              onExport={async (runId, format) => { await workbench.requestExport(runId, format); }}
              onRefreshExport={async () => { await workbench.refreshExport(); }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
