import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WorkbenchApi,
  WorkbenchApiError,
  describeApiError,
} from "./api.js";
import type {
  RunnerMcpDiscoverySnapshot as DiscoverySnapshot,
  RunnerMcpEvaluationExport as EvaluationExport,
  RunnerMcpEvaluationExportArtifact as EvaluationExportArtifact,
  RunnerMcpEvaluationRun as EvaluationRun,
  RunnerMcpEvaluationRunComparison as EvaluationComparison,
  RunnerMcpExecutionConfirmationRequest as ExecutionConfirmationRequest,
  RunnerMcpExecutionRecord as ExecutionRecord,
  RunnerMcpExecutionRequest as ExecutionRequest,
  RunnerMcpExecutionTelemetryResponse as ExecutionTelemetry,
  RunnerMcpProtocolEvent as ProtocolEvent,
  RunnerMcpServer as McpServer,
  RunnerMcpServerConfiguration as ServerConfiguration,
  RunnerMcpServerId as ServerId,
  RunnerMcpServerUpdateRequest as ServerUpdateRequest,
  RunnerMcpTestAssertion as TestAssertion,
  RunnerMcpTestCase as TestCase,
  RunnerMcpTestCaseCreateRequest as TestCaseCreateRequest,
  RunnerMcpTestCaseId as TestCaseId,
  RunnerMcpTestCaseUpdateRequest as TestCaseUpdateRequest,
  RunnerMcpTestSuite as TestSuite,
  RunnerMcpTestSuiteCreateRequest as TestSuiteCreateRequest,
  RunnerMcpTestSuiteUpdateRequest as TestSuiteUpdateRequest,
  RunnerMcpWorkbenchSession as WorkbenchSession,
  RunnerMcpWorkspace as Workspace,
  RunnerMcpWorkspaceUpdateRequest as WorkspaceUpdateRequest,
  RunnerMcpWorkspacePreferences as WorkspacePreferences,
  RunnerMcpWorkspacePreferencesUpdateRequest as WorkspacePreferencesUpdateRequest,
} from "@ancplua/qyl-api-schema/types";

const api = new WorkbenchApi();

export interface Notice {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
}

export interface TestCaseDraft {
  name: string;
  description?: string;
  serverId: string;
  toolName: string;
  arguments?: unknown;
  timeoutMs: number;
  assertions: TestAssertion[];
  tags: string[];
}

export interface SuiteDraft {
  name: string;
  description?: string;
  testCaseIds: string[];
  tags: string[];
}

export interface ServerDraft {
  name: string;
  description?: string;
  configuration: ServerConfiguration;
}

let nextNoticeId = 1;

export function useWorkbench() {
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceIdState] = useState("");
  const [preferences, setPreferences] = useState<WorkspacePreferences | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [serverId, setServerIdState] = useState("");
  const [discovery, setDiscovery] = useState<DiscoverySnapshot | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [protocolEvents, setProtocolEvents] = useState<ProtocolEvent[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [evaluationRuns, setEvaluationRuns] = useState<EvaluationRun[]>([]);
  const [comparison, setComparison] = useState<EvaluationComparison | null>(null);
  const [activeExport, setActiveExport] = useState<EvaluationExport | null>(null);
  const [exportArtifact, setExportArtifact] = useState<EvaluationExportArtifact | null>(null);
  const [telemetry, setTelemetry] = useState<ExecutionTelemetry | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [notices, setNotices] = useState<Notice[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  const serverIdRef = useRef(serverId);
  const telemetryRequestRef = useRef(0);
  workspaceIdRef.current = workspaceId;
  serverIdRef.current = serverId;

  const notify = useCallback((tone: Notice["tone"], message: string) => {
    setNotices((current) => [...current.slice(-3), { id: nextNoticeId++, tone, message }]);
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const runBusy = useCallback(async <T,>(key: string, work: () => Promise<T>): Promise<T> => {
    setBusy((current) => new Set(current).add(key));
    try {
      return await work();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const refreshWorkspaceList = useCallback(async () => {
    const next = await api.listWorkspaces();
    setWorkspaces(next);
    return next;
  }, []);

  const refreshWorkspace = useCallback(async (targetWorkspaceId = workspaceIdRef.current) => {
    if (!targetWorkspaceId) return;
    const [nextPreferences, nextServers, nextTests, nextSuites, nextRuns] = await Promise.all([
      api.getPreferences(targetWorkspaceId),
      api.listServers(targetWorkspaceId),
      api.listTestCases(targetWorkspaceId),
      api.listSuites(targetWorkspaceId),
      api.listEvaluationRuns(targetWorkspaceId),
    ]);
    setPreferences(nextPreferences);
    setServers(nextServers);
    setTestCases(nextTests);
    setSuites(nextSuites);
    setEvaluationRuns(nextRuns);
    const preferredServer = nextPreferences.selectedServerId;
    const currentServer = serverIdRef.current;
    const nextServerId = nextServers.some((server) => server.id === currentServer)
      ? currentServer
      : nextServers.some((server) => server.id === preferredServer)
        ? preferredServer ?? ""
        : nextServers[0]?.id ?? "";
    setServerIdState(nextServerId);
  }, []);

  const refreshSelectedServer = useCallback(async (targetWorkspaceId = workspaceIdRef.current, targetServerId = serverIdRef.current) => {
    if (!targetWorkspaceId || !targetServerId) return;
    const [nextExecutions, nextEvents] = await Promise.all([
      api.listExecutions(targetWorkspaceId, targetServerId),
      api.protocolEvents(targetWorkspaceId, targetServerId),
    ]);
    setExecutions(nextExecutions);
    setProtocolEvents(nextEvents);
  }, []);

  const loadDiscovery = useCallback(async (refresh = false) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const targetServerId = serverIdRef.current;
    if (!targetWorkspaceId || !targetServerId) return;
    setDiscoveryError(null);
    try {
      const next = refresh
        ? await api.refreshDiscovery(targetWorkspaceId, targetServerId)
        : await api.discovery(targetWorkspaceId, targetServerId);
      setDiscovery(next);
    } catch (error) {
      setDiscovery(null);
      setDiscoveryError(describeApiError(error));
      if (refresh) throw error;
    }
  }, []);

  const refreshAll = useCallback(() => runBusy("refresh-all", async () => {
    const nextWorkspaces = await refreshWorkspaceList();
    const targetWorkspaceId = workspaceIdRef.current;
    const targetServerId = serverIdRef.current;
    if (targetWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === targetWorkspaceId)) {
      await refreshWorkspace(targetWorkspaceId);
      if (targetServerId) {
        await Promise.all([
          refreshSelectedServer(targetWorkspaceId, targetServerId),
          loadDiscovery(),
        ]);
      }
    }
    setLastRefreshedAt(new Date().toISOString());
    notify("success", "Persisted workbench state refreshed.");
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, refreshWorkspaceList, refreshWorkspace, refreshSelectedServer, loadDiscovery, notify]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let nextSession: WorkbenchSession;
        try {
          nextSession = await api.getSession();
        } catch (error) {
          if (!(error instanceof WorkbenchApiError) || error.status !== 401) throw error;
          nextSession = await api.bootstrapSession();
        }
        const nextWorkspaces = await api.listWorkspaces();
        if (!active) return;
        setSession(nextSession);
        setWorkspaces(nextWorkspaces);
        const initialWorkspace = nextWorkspaces.some((workspace) => workspace.id === nextSession.activeWorkspaceId)
          ? nextSession.activeWorkspaceId ?? ""
          : nextWorkspaces[0]?.id ?? "";
        setWorkspaceIdState(initialWorkspace);
        setPhase("ready");
      } catch (error) {
        if (!active) return;
        setPhase("failed");
        notify("error", describeApiError(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [notify]);

  useEffect(() => {
    if (!workspaceId) {
      setPreferences(null);
      setServers([]);
      setServerIdState("");
      setTestCases([]);
      setSuites([]);
      setEvaluationRuns([]);
      return;
    }
    let active = true;
    void refreshWorkspace(workspaceId).catch((error) => {
      if (active) notify("error", describeApiError(error));
    });
    const timer = window.setInterval(() => {
      void Promise.all([
        api.listServers(workspaceId),
        api.listEvaluationRuns(workspaceId),
      ]).then(([nextServers, nextRuns]) => {
        if (!active) return;
        setServers(nextServers);
        setEvaluationRuns(nextRuns);
      }, (error: unknown) => {
        if (active) notify("error", describeApiError(error));
      });
    }, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspaceId, refreshWorkspace, notify]);

  useEffect(() => {
    telemetryRequestRef.current += 1;
    setDiscovery(null);
    setDiscoveryError(null);
    setExecutions([]);
    setProtocolEvents([]);
    setTelemetry(null);
    setTelemetryError(null);
    if (!workspaceId || !serverId) return;
    let active = true;
    void Promise.all([refreshSelectedServer(workspaceId, serverId), loadDiscovery()]).catch((error) => {
      if (active) notify("error", describeApiError(error));
    });
    const timer = window.setInterval(() => {
      void refreshSelectedServer(workspaceId, serverId).catch((error) => {
        if (active) notify("error", describeApiError(error));
      });
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspaceId, serverId, refreshSelectedServer, loadDiscovery, notify]);

  const selectWorkspace = useCallback((nextWorkspaceId: string) => {
    setWorkspaceIdState(nextWorkspaceId);
    setServerIdState("");
  }, []);

  const updatePreference = useCallback(async (patch: WorkspacePreferencesUpdateRequest) => {
    if (!workspaceIdRef.current) return;
    try {
      const next = await api.updatePreferences(workspaceIdRef.current, patch);
      setPreferences(next);
    } catch (error) {
      notify("error", describeApiError(error));
    }
  }, [notify]);

  const selectServer = useCallback((nextServerId: string) => {
    setServerIdState(nextServerId);
    void updatePreference({
      selectedServerId: nextServerId ? nextServerId as ServerId : undefined,
    });
  }, [updatePreference]);

  const createWorkspace = useCallback((name: string, description?: string) => runBusy("create-workspace", async () => {
    const created = await api.createWorkspace({ name, description: description || undefined });
    await refreshWorkspaceList();
    setWorkspaceIdState(created.id);
    notify("success", `Workspace “${created.name}” created.`);
    return created;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, refreshWorkspaceList, notify]);

  const updateWorkspace = useCallback((targetWorkspaceId: string, name: string, description?: string) => runBusy(`update-workspace:${targetWorkspaceId}`, async () => {
    const request: WorkspaceUpdateRequest = { name, description: description ?? "" };
    const updated = await api.updateWorkspace(targetWorkspaceId, request);
    setWorkspaces((current) => current.map((workspace) => workspace.id === updated.id ? updated : workspace));
    notify("success", `Workspace “${updated.name}” updated.`);
    return updated;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const createServer = useCallback((draft: ServerDraft & { autoConnect: boolean }) => runBusy("create-server", async () => {
    if (!workspaceIdRef.current) throw new Error("Select a workspace first.");
    const created = await api.createServer(workspaceIdRef.current, draft);
    await refreshWorkspace(workspaceIdRef.current);
    setServerIdState(created.id);
    notify("success", `Server “${created.name}” saved${draft.autoConnect ? " and connection started" : ""}.`);
    return created;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, refreshWorkspace, notify]);

  const updateServer = useCallback((targetServerId: string, draft: ServerDraft) => runBusy(`update-server:${targetServerId}`, async () => {
    if (!workspaceIdRef.current) throw new Error("Select a workspace first.");
    const request: ServerUpdateRequest = {
      name: draft.name,
      description: draft.description ?? "",
      configuration: draft.configuration,
    };
    const updated = await api.updateServer(workspaceIdRef.current, targetServerId, request);
    setServers((current) => current.map((server) => server.id === updated.id ? updated : server));
    if (serverIdRef.current === targetServerId) {
      setDiscovery(null);
      setDiscoveryError(null);
      if (updated.connection.status === "connected") await loadDiscovery();
    }
    notify("success", `Server “${updated.name}” updated.`);
    return updated;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, loadDiscovery, notify]);

  const deleteServer = useCallback((targetServerId: string) => runBusy(`delete-server:${targetServerId}`, async () => {
    if (!workspaceIdRef.current) return;
    await api.deleteServer(workspaceIdRef.current, targetServerId);
    await refreshWorkspace(workspaceIdRef.current);
    notify("success", "Server configuration deleted.");
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, refreshWorkspace, notify]);

  const serverAction = useCallback((action: "connect" | "disconnect" | "reconnect") => runBusy(`server:${action}`, async () => {
    if (!workspaceIdRef.current || !serverIdRef.current) return;
    const updated = await api.serverAction(workspaceIdRef.current, serverIdRef.current, action);
    setServers((current) => current.map((server) => server.id === updated.id ? updated : server));
    notify("info", `${action[0]!.toUpperCase()}${action.slice(1)} requested for “${updated.name}”.`);
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, notify]);

  const refreshDiscovery = useCallback(() => runBusy("discovery", async () => {
    await loadDiscovery(true);
    notify("success", "Discovery refreshed from the connected server.");
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, loadDiscovery, notify]);

  const startExecution = useCallback((request: ExecutionRequest) => runBusy("execute", async () => {
    if (!workspaceIdRef.current || !serverIdRef.current) throw new Error("Select a server first.");
    const execution = await api.startExecution(workspaceIdRef.current, serverIdRef.current, request);
    setExecutions((current) => [execution, ...current.filter((item) => item.id !== execution.id)]);
    notify("success", `Execution ${execution.id.slice(0, 8)} accepted.`);
    return execution;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const cancelExecution = useCallback((executionId: string) => runBusy(`cancel:${executionId}`, async () => {
    if (!workspaceIdRef.current || !serverIdRef.current) return;
    const execution = await api.cancelExecution(workspaceIdRef.current, serverIdRef.current, executionId, "Cancelled from the developer workbench");
    setExecutions((current) => current.map((item) => item.id === execution.id ? execution : item));
    notify("info", `Cancellation requested for ${execution.id.slice(0, 8)}.`);
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, notify]);

  const loadTelemetry = useCallback((executionId: string) => runBusy(`telemetry:${executionId}`, async () => {
    const targetWorkspaceId = workspaceIdRef.current;
    const targetServerId = serverIdRef.current;
    if (!targetWorkspaceId || !targetServerId) return;
    const requestId = ++telemetryRequestRef.current;
    setTelemetryError(null);
    setTelemetry(null);
    try {
      const next = await api.executionTelemetry(targetWorkspaceId, targetServerId, executionId);
      if (requestId === telemetryRequestRef.current && targetWorkspaceId === workspaceIdRef.current && targetServerId === serverIdRef.current) {
        setTelemetry(next);
      }
    } catch (error) {
      if (requestId === telemetryRequestRef.current) setTelemetryError(describeApiError(error));
    }
  }), [runBusy]);

  const createTestCase = useCallback((draft: TestCaseDraft) => runBusy("create-test", async () => {
    if (!workspaceIdRef.current) throw new Error("Select a workspace first.");
    const request: TestCaseCreateRequest = {
      ...draft,
      serverId: draft.serverId as ServerId,
      description: draft.description || undefined,
    };
    const created = await api.createTestCase(workspaceIdRef.current, request);
    setTestCases((current) => [created, ...current]);
    notify("success", `Test case “${created.name}” saved.`);
    return created;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const updateTestCase = useCallback((testCaseId: string, draft: TestCaseDraft) => runBusy(`update-test:${testCaseId}`, async () => {
    if (!workspaceIdRef.current) throw new Error("Select a workspace first.");
    const request: TestCaseUpdateRequest = {
      ...draft,
      serverId: draft.serverId as ServerId,
      description: draft.description ?? "",
    };
    const updated = await api.updateTestCase(workspaceIdRef.current, testCaseId, request);
    setTestCases((current) => current.map((testCase) => testCase.id === updated.id ? updated : testCase));
    notify("success", `Test case “${updated.name}” updated.`);
    return updated;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const deleteTestCase = useCallback((testCaseId: string) => runBusy(`delete-test:${testCaseId}`, async () => {
    if (!workspaceIdRef.current) return;
    await api.deleteTestCase(workspaceIdRef.current, testCaseId);
    setTestCases((current) => current.filter((testCase) => testCase.id !== testCaseId));
    notify("success", "Test case deleted.");
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, notify]);

  const runTestCase = useCallback((testCaseId: string, confirmation: ExecutionConfirmationRequest) => runBusy(`run-test:${testCaseId}`, async () => {
    if (!workspaceIdRef.current) return;
    const run = await api.runTestCase(workspaceIdRef.current, testCaseId, confirmation);
    setEvaluationRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    notify("success", `Evaluation ${run.id.slice(0, 8)} accepted.`);
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const createSuite = useCallback((draft: SuiteDraft) => runBusy("create-suite", async () => {
    if (!workspaceIdRef.current) throw new Error("Select a workspace first.");
    const request: TestSuiteCreateRequest = {
      ...draft,
      testCaseIds: draft.testCaseIds.map((id) => id as TestCaseId),
      description: draft.description || undefined,
    };
    const created = await api.createSuite(workspaceIdRef.current, request);
    setSuites((current) => [created, ...current]);
    notify("success", `Suite “${created.name}” saved.`);
    return created;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const updateSuite = useCallback((suiteId: string, draft: SuiteDraft) => runBusy(`update-suite:${suiteId}`, async () => {
    if (!workspaceIdRef.current) throw new Error("Select a workspace first.");
    const request: TestSuiteUpdateRequest = {
      ...draft,
      testCaseIds: draft.testCaseIds.map((id) => id as TestCaseId),
      description: draft.description ?? "",
    };
    const updated = await api.updateSuite(workspaceIdRef.current, suiteId, request);
    setSuites((current) => current.map((suite) => suite.id === updated.id ? updated : suite));
    notify("success", `Suite “${updated.name}” updated.`);
    return updated;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const deleteSuite = useCallback((suiteId: string) => runBusy(`delete-suite:${suiteId}`, async () => {
    if (!workspaceIdRef.current) return;
    await api.deleteSuite(workspaceIdRef.current, suiteId);
    setSuites((current) => current.filter((suite) => suite.id !== suiteId));
    notify("success", "Evaluation suite deleted.");
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, notify]);

  const runSuite = useCallback((suiteId: string, confirmation: ExecutionConfirmationRequest) => runBusy(`run-suite:${suiteId}`, async () => {
    if (!workspaceIdRef.current) return;
    const run = await api.runSuite(workspaceIdRef.current, suiteId, confirmation);
    setEvaluationRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    notify("success", `Suite evaluation ${run.id.slice(0, 8)} accepted.`);
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, notify]);

  const compareRuns = useCallback((baselineRunId: string, candidateRunId: string) => runBusy("compare", async () => {
    if (!workspaceIdRef.current) return;
    setComparison(await api.compareRuns(workspaceIdRef.current, baselineRunId, candidateRunId));
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, notify]);

  const requestExport = useCallback((runId: string, format: "json" | "report") => runBusy("export", async () => {
    if (!workspaceIdRef.current) return;
    const created = await api.requestExport(workspaceIdRef.current, runId, format);
    setActiveExport(created);
    setExportArtifact(null);
    notify("info", `${format.toUpperCase()} export ${created.status}.`);
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, notify]);

  const refreshExport = useCallback(() => runBusy("export-refresh", async () => {
    if (!workspaceIdRef.current || !activeExport) return;
    const next = await api.getExport(workspaceIdRef.current, activeExport.runId, activeExport.id);
    setActiveExport(next);
    if (next.status === "ready") {
      setExportArtifact(await api.getExportContent(workspaceIdRef.current, next.runId, next.id));
    }
  }).catch((error) => notify("error", describeApiError(error))), [runBusy, activeExport, notify]);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === serverId) ?? null,
    [servers, serverId],
  );

  return {
    session,
    workspaces,
    workspaceId,
    preferences,
    servers,
    serverId,
    selectedServer,
    discovery,
    discoveryError,
    executions,
    protocolEvents,
    testCases,
    suites,
    evaluationRuns,
    comparison,
    activeExport,
    exportArtifact,
    telemetry,
    telemetryError,
    lastRefreshedAt,
    phase,
    busy,
    notices,
    dismissNotice,
    refreshAll,
    selectWorkspace,
    selectServer,
    updatePreference,
    createWorkspace,
    updateWorkspace,
    createServer,
    updateServer,
    deleteServer,
    serverAction,
    refreshDiscovery,
    startExecution,
    cancelExecution,
    loadTelemetry,
    createTestCase,
    updateTestCase,
    deleteTestCase,
    runTestCase,
    createSuite,
    updateSuite,
    deleteSuite,
    runSuite,
    compareRuns,
    requestExport,
    refreshExport,
  };
}
