import type * as QylContracts from "@ancplua/qyl-api-schema/types";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

type ContractValidationModule = typeof import("qyl-mcp-server/contract-validation");

let contractValidationModule: Promise<ContractValidationModule> | undefined;

function loadContractValidation(): Promise<ContractValidationModule> {
  contractValidationModule ??= import("qyl-mcp-server/contract-validation");
  return contractValidationModule;
}

export class WorkbenchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problem?: QylContracts.ApiError,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "WorkbenchApiError";
  }
}

interface PublishedSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path?: PropertyKey[]; message: string }> } };
}

interface PublishedOperation {
  operationId?: string;
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

interface PublishedRoute {
  method: string;
  pattern: RegExp;
  operation: PublishedOperation;
}

const publishedRoutes: readonly PublishedRoute[] = Object.entries(
  qylOpenApi.paths as unknown as Record<string, Record<string, PublishedOperation>>,
).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, operation]) =>
  operation.operationId === undefined
    ? []
    : [{ method: method.toUpperCase(), pattern: openApiPathPattern(path), operation }],
));

function openApiPathPattern(path: string): RegExp {
  const source = path.split("/").map((segment) =>
    /^\{[^}]+\}$/u.test(segment)
      ? "[^/]+"
      : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  ).join("/");
  return new RegExp(`^${source}$`, "u");
}

function publishedOperation(path: string, method: string): PublishedOperation & { operationId: string } {
  const pathname = new URL(path, "http://qyl.invalid").pathname;
  const route = publishedRoutes.find((candidate) =>
    candidate.method === method && candidate.pattern.test(pathname),
  );
  if (route?.operation.operationId === undefined) {
    throw new Error(`Published Qyl contract has no ${method} ${pathname} operation.`);
  }
  return route.operation as PublishedOperation & { operationId: string };
}

async function parsePublished<T>(
  selectSchema: (contracts: ContractValidationModule) => PublishedSchema<T>,
  value: unknown,
  context: string,
): Promise<T> {
  const result = selectSchema(await loadContractValidation()).safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path && issue.path.length > 0 ? issue.path.map(String).join(".") : "response";
    return `${path}: ${issue.message}`;
  }).join("; ");
  throw new Error(`${context} violated the published Qyl contract${details ? ` · ${details}` : ""}.`);
}

async function parseApiProblem(value: unknown): Promise<QylContracts.ApiError | undefined> {
  const contracts = await loadContractValidation();
  const result = contracts.publishedContractSchema<QylContracts.ApiError>("Common.Errors.ApiError").safeParse(value);
  return result.success ? result.data : undefined;
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export class WorkbenchApi {
  constructor(private readonly baseUrl = "") {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const method = (init?.method ?? "GET").toUpperCase();
    const operation = publishedOperation(path, method);
    const headers = new Headers(init?.headers);
    let body = init?.body;
    if (body !== undefined) {
      if (typeof body !== "string") {
        throw new Error(`${operation.operationId} request body must be JSON text.`);
      }
      const candidate = JSON.parse(body) as unknown;
      const validated = await parsePublished(
        (contracts) => contracts.publishedContractSchema<unknown>(
          `Operations.${operation.operationId}.Request`,
        ),
        candidate,
        `${operation.operationId} request`,
      );
      body = JSON.stringify(validated);
      headers.set("Content-Type", "application/json");
    }
    headers.set("Accept", "application/json, application/problem+json");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        // A GET has no body at all; `body: undefined` is a different RequestInit
        // than one without the key once exactOptionalPropertyTypes is on.
        ...(body === undefined ? {} : { body }),
        headers,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new WorkbenchApiError(
        error instanceof Error ? error.message : "The runner could not be reached.",
        0,
      );
    }

    const text = response.status === 204 ? "" : await response.text();
    let payload: unknown;
    if (text !== "") {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new WorkbenchApiError("The runner returned malformed JSON.", response.status);
      }
    }
    const publishedResponse = operation.responses?.[String(response.status)];
    if (publishedResponse === undefined) {
      throw new WorkbenchApiError(
        `The runner returned undocumented HTTP ${response.status} for ${operation.operationId}.`,
        response.status,
      );
    }
    if (payload !== undefined) {
      payload = await parsePublished(
        (contracts) => contracts.publishedContractSchema<unknown>(
          `Operations.${operation.operationId}.Response.${response.status}`,
        ),
        payload,
        `${operation.operationId} response`,
      );
    } else if (Object.keys(publishedResponse.content ?? {}).length > 0) {
      throw new WorkbenchApiError(
        `The runner omitted the documented response body for ${operation.operationId}.`,
        response.status,
      );
    }
    if (!response.ok) {
      const problem = await parseApiProblem(payload);
      const message = problem?.detail ?? problem?.title ?? `Runner request failed with HTTP ${response.status}.`;
      throw new WorkbenchApiError(
        message,
        response.status,
        problem,
        response.headers.get("X-Request-Id") ?? undefined,
      );
    }
    return payload;
  }

  private json(path: string, method: "POST" | "PUT" | "PATCH", body: object): Promise<unknown> {
    return this.request(path, { method, body: JSON.stringify(body) });
  }

  getSession(): Promise<QylContracts.WorkbenchSession> {
    return this.request("/workbench/session")
      .then((value) => parsePublished((contracts) => contracts.WorkbenchSessionSchema, value, "Session"));
  }

  bootstrapSession(): Promise<QylContracts.WorkbenchSessionBootstrapResponse> {
    return this.request("/workbench/session", { method: "POST" })
      .then((value) => parsePublished((contracts) => contracts.WorkbenchSessionBootstrapResponseSchema, value, "Session bootstrap"));
  }

  listWorkspaces(): Promise<QylContracts.WorkbenchWorkspace[]> {
    return this.request("/workbench/workspaces")
      .then(async (value) => (await parsePublished(
        (contracts) => contracts.WorkbenchWorkspaceListResponseSchema,
        value,
        "Workspace list",
      )).workspaces);
  }

  createWorkspace(body: QylContracts.WorkbenchWorkspaceCreateRequest): Promise<QylContracts.WorkbenchWorkspace> {
    return this.json("/workbench/workspaces", "POST", body)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchWorkspaceSchema, value, "Workspace"));
  }

  updateWorkspace(
    workspaceId: string,
    body: QylContracts.WorkbenchWorkspaceUpdateRequest,
  ): Promise<QylContracts.WorkbenchWorkspace> {
    return parsePublished(
      (contracts) => contracts.WorkbenchWorkspaceUpdateRequestSchema,
      body,
      "Workspace update request",
    ).then((request) => this.json(`/workbench/workspaces/${pathPart(workspaceId)}`, "PATCH", request))
      .then((value) => parsePublished((contracts) => contracts.WorkbenchWorkspaceSchema, value, "Workspace"));
  }

  getPreferences(workspaceId: string): Promise<QylContracts.WorkbenchWorkspacePreferences> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/preferences`)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchWorkspacePreferencesSchema, value, "Workspace preferences"));
  }

  updatePreferences(
    workspaceId: string,
    body: QylContracts.WorkbenchWorkspacePreferencesUpdateRequest,
  ): Promise<QylContracts.WorkbenchWorkspacePreferences> {
    return this.json(`/workbench/workspaces/${pathPart(workspaceId)}/preferences`, "PUT", body)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchWorkspacePreferencesSchema, value, "Workspace preferences"));
  }

  listServers(workspaceId: string): Promise<QylContracts.WorkbenchServer[]> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/servers`)
      .then(async (value) => (await parsePublished(
        (contracts) => contracts.WorkbenchServerListResponseSchema,
        value,
        "Server list",
      )).servers);
  }

  createServer(
    workspaceId: string,
    body: QylContracts.WorkbenchServerCreateRequest,
  ): Promise<QylContracts.WorkbenchServer> {
    return this.json(`/workbench/workspaces/${pathPart(workspaceId)}/servers`, "POST", body)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchServerSchema, value, "Server"));
  }

  updateServer(
    workspaceId: string,
    serverId: string,
    body: QylContracts.WorkbenchServerUpdateRequest,
  ): Promise<QylContracts.WorkbenchServer> {
    return parsePublished(
      (contracts) => contracts.WorkbenchServerUpdateRequestSchema,
      body,
      "Server update request",
    ).then((request) => this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}`,
      "PATCH",
      request,
    )).then((value) => parsePublished((contracts) => contracts.WorkbenchServerSchema, value, "Server"));
  }

  deleteServer(workspaceId: string, serverId: string): Promise<void> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}`, {
      method: "DELETE",
    }).then(() => undefined);
  }

  serverAction(
    workspaceId: string,
    serverId: string,
    action: "connect" | "disconnect" | "reconnect",
  ): Promise<QylContracts.WorkbenchServer> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/${action}`,
      { method: "POST" },
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchServerActionAcceptedSchema,
      value,
      "Server action",
    )).server);
  }

  discovery(workspaceId: string, serverId: string): Promise<QylContracts.WorkbenchDiscoverySnapshot> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/discovery`)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchDiscoverySnapshotSchema, value, "Discovery snapshot"));
  }

  refreshDiscovery(workspaceId: string, serverId: string): Promise<QylContracts.WorkbenchDiscoverySnapshot> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/discovery/refresh`,
      { method: "POST" },
    ).then((value) => parsePublished((contracts) => contracts.WorkbenchDiscoverySnapshotSchema, value, "Discovery snapshot"));
  }

  protocolEvents(
    workspaceId: string,
    serverId: string,
    limit = 200,
  ): Promise<QylContracts.WorkbenchProtocolEvent[]> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/protocol${query({ limit })}`,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchProtocolEventPageSchema,
      value,
      "Protocol event page",
    )).events);
  }

  listExecutions(
    workspaceId: string,
    serverId: string,
    limit = 100,
  ): Promise<QylContracts.WorkbenchExecutionRecord[]> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/executions${query({ limit })}`,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchExecutionPageSchema,
      value,
      "Execution page",
    )).executions);
  }

  startExecution(
    workspaceId: string,
    serverId: string,
    body: QylContracts.WorkbenchExecutionRequest,
  ): Promise<QylContracts.WorkbenchExecutionRecord> {
    return this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/executions`,
      "POST",
      body,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchExecutionAcceptedSchema,
      value,
      "Execution acceptance",
    )).execution);
  }

  cancelExecution(
    workspaceId: string,
    serverId: string,
    executionId: string,
    reason: string,
  ): Promise<QylContracts.WorkbenchExecutionRecord> {
    const body: QylContracts.WorkbenchExecutionCancelRequest = {
      reason,
      idempotency_key: crypto.randomUUID(),
    };
    return this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/executions/${pathPart(executionId)}/cancel`,
      "POST",
      body,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchExecutionAcceptedSchema,
      value,
      "Execution cancellation",
    )).execution);
  }

  executionTelemetry(
    workspaceId: string,
    serverId: string,
    executionId: string,
  ): Promise<QylContracts.WorkbenchExecutionTelemetryResponse> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/servers/${pathPart(serverId)}/executions/${pathPart(executionId)}/telemetry`,
    ).then((value) => parsePublished(
      (contracts) => contracts.WorkbenchExecutionTelemetryResponseSchema,
      value,
      "Execution telemetry",
    ));
  }

  listTestCases(workspaceId: string): Promise<QylContracts.WorkbenchTestCase[]> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/test-cases${query({ limit: 1000 })}`)
      .then(async (value) => (await parsePublished(
        (contracts) => contracts.WorkbenchTestCasePageSchema,
        value,
        "Test case page",
      )).test_cases);
  }

  createTestCase(
    workspaceId: string,
    body: QylContracts.WorkbenchTestCaseCreateRequest,
  ): Promise<QylContracts.WorkbenchTestCase> {
    return this.json(`/workbench/workspaces/${pathPart(workspaceId)}/test-cases`, "POST", body)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchTestCaseSchema, value, "Test case"));
  }

  updateTestCase(
    workspaceId: string,
    testCaseId: string,
    body: QylContracts.WorkbenchTestCaseUpdateRequest,
  ): Promise<QylContracts.WorkbenchTestCase> {
    return parsePublished(
      (contracts) => contracts.WorkbenchTestCaseUpdateRequestSchema,
      body,
      "Test case update request",
    ).then((request) => this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/test-cases/${pathPart(testCaseId)}`,
      "PATCH",
      request,
    )).then((value) => parsePublished((contracts) => contracts.WorkbenchTestCaseSchema, value, "Test case"));
  }

  deleteTestCase(workspaceId: string, testCaseId: string): Promise<void> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/test-cases/${pathPart(testCaseId)}`, {
      method: "DELETE",
    }).then(() => undefined);
  }

  runTestCase(
    workspaceId: string,
    testCaseId: string,
    confirmation?: QylContracts.WorkbenchExecutionConfirmationRequest,
  ): Promise<QylContracts.WorkbenchEvaluationRun> {
    const body: QylContracts.WorkbenchTestCaseRunRequest = {
      idempotency_key: crypto.randomUUID(),
      ...(confirmation === undefined ? {} : { confirmation }),
    };
    return this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/test-cases/${pathPart(testCaseId)}/run`,
      "POST",
      body,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchEvaluationRunAcceptedSchema,
      value,
      "Evaluation acceptance",
    )).run);
  }

  listSuites(workspaceId: string): Promise<QylContracts.WorkbenchTestSuite[]> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/suites${query({ limit: 1000 })}`)
      .then(async (value) => (await parsePublished(
        (contracts) => contracts.WorkbenchTestSuitePageSchema,
        value,
        "Suite page",
      )).suites);
  }

  createSuite(
    workspaceId: string,
    body: QylContracts.WorkbenchTestSuiteCreateRequest,
  ): Promise<QylContracts.WorkbenchTestSuite> {
    return this.json(`/workbench/workspaces/${pathPart(workspaceId)}/suites`, "POST", body)
      .then((value) => parsePublished((contracts) => contracts.WorkbenchTestSuiteSchema, value, "Suite"));
  }

  updateSuite(
    workspaceId: string,
    suiteId: string,
    body: QylContracts.WorkbenchTestSuiteUpdateRequest,
  ): Promise<QylContracts.WorkbenchTestSuite> {
    return parsePublished(
      (contracts) => contracts.WorkbenchTestSuiteUpdateRequestSchema,
      body,
      "Suite update request",
    ).then((request) => this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/suites/${pathPart(suiteId)}`,
      "PATCH",
      request,
    )).then((value) => parsePublished((contracts) => contracts.WorkbenchTestSuiteSchema, value, "Suite"));
  }

  deleteSuite(workspaceId: string, suiteId: string): Promise<void> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/suites/${pathPart(suiteId)}`, {
      method: "DELETE",
    }).then(() => undefined);
  }

  runSuite(
    workspaceId: string,
    suiteId: string,
    confirmation?: QylContracts.WorkbenchExecutionConfirmationRequest,
  ): Promise<QylContracts.WorkbenchEvaluationRun> {
    const body: QylContracts.WorkbenchSuiteRunRequest = {
      idempotency_key: crypto.randomUUID(),
      ...(confirmation === undefined ? {} : { confirmation }),
    };
    return this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/suites/${pathPart(suiteId)}/run`,
      "POST",
      body,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchEvaluationRunAcceptedSchema,
      value,
      "Evaluation acceptance",
    )).run);
  }

  listEvaluationRuns(workspaceId: string): Promise<QylContracts.WorkbenchEvaluationRun[]> {
    return this.request(`/workbench/workspaces/${pathPart(workspaceId)}/evaluation-runs${query({ limit: 1000 })}`)
      .then(async (value) => (await parsePublished(
        (contracts) => contracts.WorkbenchEvaluationRunPageSchema,
        value,
        "Evaluation page",
      )).runs);
  }

  compareRuns(
    workspaceId: string,
    baselineRunId: string,
    candidateRunId: string,
  ): Promise<QylContracts.WorkbenchEvaluationRunComparison> {
    const body = {
      baselineRunId,
      candidateRunId,
    };
    return parsePublished(
      (contracts) => contracts.WorkbenchEvaluationComparisonRequestSchema,
      body,
      "Evaluation comparison request",
    ).then((request) => this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/evaluation-runs/compare`,
      "POST",
      request,
    ))
      .then((value) => parsePublished(
        (contracts) => contracts.WorkbenchEvaluationRunComparisonSchema,
        value,
        "Evaluation comparison",
      ));
  }

  requestExport(
    workspaceId: string,
    runId: string,
    format: QylContracts.WorkbenchEvaluationExportFormat,
  ): Promise<QylContracts.WorkbenchEvaluationExport> {
    const body: QylContracts.WorkbenchEvaluationExportRequest = {
      format,
      include_protocol_events: true,
      include_telemetry: true,
      idempotency_key: crypto.randomUUID(),
    };
    return this.json(
      `/workbench/workspaces/${pathPart(workspaceId)}/evaluation-runs/${pathPart(runId)}/export`,
      "POST",
      body,
    ).then(async (value) => (await parsePublished(
      (contracts) => contracts.WorkbenchEvaluationExportAcceptedSchema,
      value,
      "Export acceptance",
    )).export);
  }

  getExport(
    workspaceId: string,
    runId: string,
    exportId: string,
  ): Promise<QylContracts.WorkbenchEvaluationExport> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/evaluation-runs/${pathPart(runId)}/exports/${pathPart(exportId)}`,
    ).then((value) => parsePublished(
      (contracts) => contracts.WorkbenchEvaluationExportSchema,
      value,
      "Evaluation export",
    ));
  }

  getExportContent(
    workspaceId: string,
    runId: string,
    exportId: string,
  ): Promise<QylContracts.WorkbenchEvaluationExportArtifact> {
    return this.request(
      `/workbench/workspaces/${pathPart(workspaceId)}/evaluation-runs/${pathPart(runId)}/exports/${pathPart(exportId)}/content`,
    ).then((value) => parsePublished(
      (contracts) => contracts.WorkbenchEvaluationExportArtifactSchema,
      value,
      "Evaluation export artifact",
    ));
  }
}

export function describeApiError(error: unknown): string {
  if (error instanceof WorkbenchApiError) {
    const request = error.requestId ? ` · request ${error.requestId}` : "";
    return `${error.status === 0 ? "Connection" : `HTTP ${error.status}`} · ${error.message}${request}`;
  }
  return error instanceof Error ? error.message : String(error);
}
