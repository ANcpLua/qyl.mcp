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
const ALWAYS_ACTIVE = () => true;

export interface Notice {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
  key?: string;
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
const RUNNER_CONNECTION_NOTICE_KEY = "runner-connection";

export function mergeNotice(current: Notice[], next: Notice): Notice[] {
  if (next.key !== undefined) {
    const existing = current.find((notice) => notice.key === next.key);
    if (existing?.tone === next.tone && existing.message === next.message) return current;
    return [...current.filter((notice) => notice.key !== next.key).slice(-3), next];
  }
  return [...current.slice(-3), next];
}

export function removeNoticeByKey(current: Notice[], key: string): Notice[] {
  if (!current.some((notice) => notice.key === key)) return current;
  return current.filter((notice) => notice.key !== key);
}

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
  const telemetryInFlightRef = useRef(new Map<string, Promise<void>>());
  const sessionRecoveryRef = useRef<Promise<WorkbenchSession> | null>(null);
  workspaceIdRef.current = workspaceId;
  serverIdRef.current = serverId;

  const setWorkspaceId = useCallback((nextWorkspaceId: string) => {
    workspaceIdRef.current = nextWorkspaceId;
    setWorkspaceIdState(nextWorkspaceId);
  }, []);

  const setServerId = useCallback((nextServerId: string) => {
    serverIdRef.current = nextServerId;
    setServerIdState(nextServerId);
  }, []);

  const notify = useCallback((tone: Notice["tone"], message: string, key?: string) => {
    const notice: Notice = { id: nextNoticeId++, tone, message, ...(key === undefined ? {} : { key }) };
    setNotices((current) => mergeNotice(current, notice));
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const clearConnectionNotice = useCallback(() => {
    setNotices((current) => removeNoticeByKey(current, RUNNER_CONNECTION_NOTICE_KEY));
  }, []);

  const recoverSession = useCallback((): Promise<WorkbenchSession> => {
    const active = sessionRecoveryRef.current;
    if (active) return active;
    const request = api.bootstrapSession().then((nextSession) => {
      setSession(nextSession);
      return nextSession;
    });
    let tracked: Promise<WorkbenchSession>;
    tracked = request.finally(() => {
      if (sessionRecoveryRef.current === tracked) sessionRecoveryRef.current = null;
    });
    sessionRecoveryRef.current = tracked;
    return tracked;
  }, []);

  const reportBackgroundError = useCallback((error: unknown) => {
    notify(
      "error",
      describeApiError(error),
      error instanceof WorkbenchApiError && error.status === 0
        ? RUNNER_CONNECTION_NOTICE_KEY
        : undefined,
    );
  }, [notify]);

  const handleBackgroundError = useCallback(async (error: unknown) => {
    if (error instanceof WorkbenchApiError && error.status === 401) {
      try {
        await recoverSession();
        clearConnectionNotice();
        return;
      } catch (recoveryError) {
        reportBackgroundError(recoveryError);
        return;
      }
    }
    reportBackgroundError(error);
  }, [recoverSession, clearConnectionNotice, reportBackgroundError]);

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

  const refreshWorkspace = useCallback(async (
    targetWorkspaceId = workspaceIdRef.current,
    isActive: () => boolean = ALWAYS_ACTIVE,
  ) => {
    if (!targetWorkspaceId) return;
    const [nextPreferences, nextServers, nextTests, nextSuites, nextRuns] = await Promise.all([
      api.getPreferences(targetWorkspaceId),
      api.listServers(targetWorkspaceId),
      api.listTestCases(targetWorkspaceId),
      api.listSuites(targetWorkspaceId),
      api.listEvaluationRuns(targetWorkspaceId),
    ]);
    if (!isActive() || targetWorkspaceId !== workspaceIdRef.current) return;
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
    setServerId(nextServerId);
  }, [setServerId]);

  const refreshSelectedServer = useCallback(async (
    targetWorkspaceId = workspaceIdRef.current,
    targetServerId = serverIdRef.current,
    isActive: () => boolean = ALWAYS_ACTIVE,
  ) => {
    if (!targetWorkspaceId || !targetServerId) return;
    const [nextExecutions, nextEvents] = await Promise.all([
      api.listExecutions(targetWorkspaceId, targetServerId),
      api.protocolEvents(targetWorkspaceId, targetServerId),
    ]);
    if (!isActive()
      || targetWorkspaceId !== workspaceIdRef.current
      || targetServerId !== serverIdRef.current) return;
    setExecutions(nextExecutions);
    setProtocolEvents(nextEvents);
  }, []);

  const loadDiscovery = useCallback(async (
    refresh = false,
    isActive: () => boolean = ALWAYS_ACTIVE,
  ): Promise<boolean> => {
    const targetWorkspaceId = workspaceIdRef.current;
    const targetServerId = serverIdRef.current;
    if (!targetWorkspaceId || !targetServerId) return false;
    setDiscoveryError(null);
    try {
      const next = refresh
        ? await api.refreshDiscovery(targetWorkspaceId, targetServerId)
        : await api.discovery(targetWorkspaceId, targetServerId);
      if (!isActive()
        || targetWorkspaceId !== workspaceIdRef.current
        || targetServerId !== serverIdRef.current) return false;
      setDiscovery(next);
      return true;
    } catch (error) {
      if (!isActive()
        || targetWorkspaceId !== workspaceIdRef.current
        || targetServerId !== serverIdRef.current) return false;
      setDiscovery(null);
      setDiscoveryError(describeApiError(error));
      if (refresh) throw error;
      return false;
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
        setWorkspaceId(initialWorkspace);
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
  }, [notify, setWorkspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setPreferences(null);
      setServers([]);
      setServerId("");
      setTestCases([]);
      setSuites([]);
      setEvaluationRuns([]);
      return;
    }
    let active = true;
    let timer: number | undefined;
    const poll = async (initial: boolean) => {
      try {
        if (initial) {
          await refreshWorkspace(workspaceId, () => active);
        } else {
          const [nextServers, nextRuns] = await Promise.all([
            api.listServers(workspaceId),
            api.listEvaluationRuns(workspaceId),
          ]);
          if (!active || workspaceId !== workspaceIdRef.current) return;
          setServers(nextServers);
          setEvaluationRuns(nextRuns);
        }
        if (active) clearConnectionNotice();
      } catch (error) {
        if (active) await handleBackgroundError(error);
      } finally {
        if (active) timer = window.setTimeout(() => void poll(false), 4_000);
      }
    };
    void poll(true);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [workspaceId, refreshWorkspace, clearConnectionNotice, handleBackgroundError, setServerId]);

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
    let timer: number | undefined;
    const poll = async (initial: boolean) => {
      try {
        if (initial) {
          await Promise.all([
            refreshSelectedServer(workspaceId, serverId, () => active),
            loadDiscovery(false, () => active),
          ]);
        } else {
          await refreshSelectedServer(workspaceId, serverId, () => active);
        }
        if (active) clearConnectionNotice();
      } catch (error) {
        if (active) await handleBackgroundError(error);
      } finally {
        if (active) timer = window.setTimeout(() => void poll(false), 2_000);
      }
    };
    void poll(true);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [workspaceId, serverId, refreshSelectedServer, loadDiscovery, clearConnectionNotice, handleBackgroundError]);

  const selectWorkspace = useCallback((nextWorkspaceId: string) => {
    setWorkspaceId(nextWorkspaceId);
    setServerId("");
  }, [setWorkspaceId, setServerId]);

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
    setServerId(nextServerId);
    void updatePreference({
      selectedServerId: nextServerId ? nextServerId as ServerId : undefined,
    });
  }, [updatePreference, setServerId]);

  const createWorkspace = useCallback((name: string, description?: string) => runBusy("create-workspace", async () => {
    const created = await api.createWorkspace({ name, description: description || undefined });
    await refreshWorkspaceList();
    setWorkspaceId(created.id);
    notify("success", `Workspace “${created.name}” created.`);
    return created;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, refreshWorkspaceList, notify, setWorkspaceId]);

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
    setServerId(created.id);
    notify("success", `Server “${created.name}” saved${draft.autoConnect ? " and connection started" : ""}.`);
    return created;
  }).catch((error) => {
    notify("error", describeApiError(error));
    throw error;
  }), [runBusy, refreshWorkspace, notify, setServerId]);

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
    if (await loadDiscovery(true)) notify("success", "Discovery refreshed from the connected server.");
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

  const loadTelemetry = useCallback((executionId: string): Promise<void> => {
    const targetWorkspaceId = workspaceIdRef.current;
    const targetServerId = serverIdRef.current;
    if (!targetWorkspaceId || !targetServerId) return Promise.resolve();
    const inFlightKey = JSON.stringify([targetWorkspaceId, targetServerId, executionId]);
    const active = telemetryInFlightRef.current.get(inFlightKey);
    if (active) return active;

    const request = runBusy(`telemetry:${executionId}`, async () => {
      const requestId = ++telemetryRequestRef.current;
      setTelemetryError(null);
      setTelemetry(null);
      try {
        const next = await api.executionTelemetry(targetWorkspaceId, targetServerId, executionId);
        if (requestId === telemetryRequestRef.current && targetWorkspaceId === workspaceIdRef.current && targetServerId === serverIdRef.current) {
          setTelemetry(next);
        }
      } catch (error) {
        if (requestId === telemetryRequestRef.current
          && targetWorkspaceId === workspaceIdRef.current
          && targetServerId === serverIdRef.current) {
          setTelemetryError(describeApiError(error));
        }
      }
    });
    let tracked: Promise<void>;
    tracked = request.finally(() => {
      if (telemetryInFlightRef.current.get(inFlightKey) === tracked) {
        telemetryInFlightRef.current.delete(inFlightKey);
      }
    });
    telemetryInFlightRef.current.set(inFlightKey, tracked);
    return tracked;
  }, [runBusy]);

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
