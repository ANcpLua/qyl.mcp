import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EvaluationsWorkspace } from "./EvaluationsWorkspace.js";
import { TelemetryPanel } from "./InspectorWorkspace.js";
import { TestsWorkspace } from "./TestsWorkspace.js";
import {
  SERVER_TRANSPORT_OPTIONS,
  WorkbenchSidebar,
  isUserConfigurableServer,
} from "./WorkbenchSidebar.js";
import {
  RunnerMcpEvaluationRunSchema,
  RunnerMcpExecutionTelemetryResponseSchema,
  RunnerMcpServerSchema,
  RunnerMcpTestCaseSchema,
  RunnerMcpTestSuiteSchema,
  RunnerMcpWorkspaceSchema,
} from "qyl-mcp-server/contract-validation";

const timestamp = "2026-07-15T10:00:00.000Z";

const server = RunnerMcpServerSchema.parse({
  id: "server-1",
  workspaceId: "workspace-1",
  name: "Fixture server",
  configuration: { transport: "builtin", name: "fixture" },
  connection: { status: "connected", changedAt: timestamp },
  createdAt: timestamp,
  updatedAt: timestamp,
});

const userServer = RunnerMcpServerSchema.parse({
  id: "server-user",
  workspaceId: "workspace-1",
  name: "Remote user server",
  configuration: {
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    headers: [{ name: "Authorization", secret: { source: "environment", environmentVariable: "MCP_TOKEN" }, scheme: "bearer" }],
  },
  connection: { status: "disconnected", changedAt: timestamp },
  createdAt: timestamp,
  updatedAt: timestamp,
});

const testCase = RunnerMcpTestCaseSchema.parse({
  id: "test-1",
  workspaceId: "workspace-1",
  serverId: server.id,
  name: "Echo remains stable",
  toolName: "echo",
  arguments: { text: "hello" },
  timeoutMs: 1_000,
  assertions: [{ id: "assertion-1", kind: "status", expected: ["succeeded"] }],
  tags: ["smoke"],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const suite = RunnerMcpTestSuiteSchema.parse({
  id: "suite-1",
  workspaceId: "workspace-1",
  name: "Smoke suite",
  testCaseIds: [testCase.id],
  tags: ["smoke"],
  createdAt: timestamp,
  updatedAt: timestamp,
});

test("the workbench sidebar limits creation to routable transports and retains internal server display", () => {
  assert.deepEqual(SERVER_TRANSPORT_OPTIONS.map((option) => option.value), ["streamable_http", "stdio"]);
  assert.equal(isUserConfigurableServer(server), false);
  assert.equal(isUserConfigurableServer(userServer), true);
  const workspaces = [RunnerMcpWorkspaceSchema.parse({
    id: "workspace-1",
    ownerId: "local",
    name: "Local workspace",
    createdAt: timestamp,
    updatedAt: timestamp,
  })];
  const html = renderToStaticMarkup(<WorkbenchSidebar
    workspaces={workspaces}
    workspaceId="workspace-1"
    servers={[server]}
    serverId={server.id}
    busy={new Set()}
    onSelectWorkspace={() => undefined}
    onCreateWorkspace={() => Promise.resolve()}
    onUpdateWorkspace={() => Promise.resolve()}
    onSelectServer={() => undefined}
    onCreateServer={() => Promise.resolve()}
    onUpdateServer={() => Promise.resolve()}
  />);
  assert.match(html, /MCP servers/u);
  assert.match(html, /BUILTIN · connected/u);
  assert.match(html, /Secrets: environment references only/u);
  assert.match(html, /Session: loopback cookie/u);
  assert.match(html, /Edit workspace/u);
  assert.match(html, /Runner-owned built-in and in-process servers cannot be edited/u);

  const userHtml = renderToStaticMarkup(<WorkbenchSidebar
    workspaces={workspaces}
    workspaceId="workspace-1"
    servers={[userServer]}
    serverId={userServer.id}
    busy={new Set()}
    onSelectWorkspace={() => undefined}
    onCreateWorkspace={() => Promise.resolve()}
    onUpdateWorkspace={() => Promise.resolve()}
    onSelectServer={() => undefined}
    onCreateServer={() => Promise.resolve()}
    onUpdateServer={() => Promise.resolve()}
  />);
  assert.match(userHtml, /title="Edit selected server"/u);
});

test("test and evaluation surfaces retain real execution evidence, comparison, and export controls", () => {
  const testsHtml = renderToStaticMarkup(<TestsWorkspace
    servers={[server]}
    executions={[]}
    testCases={[testCase]}
    suites={[suite]}
    busy={new Set()}
    onCreateTestCase={() => Promise.resolve()}
    onUpdateTestCase={() => Promise.resolve()}
    onDeleteTestCase={() => Promise.resolve()}
    onRunTestCase={() => Promise.resolve()}
    onCreateSuite={() => Promise.resolve()}
    onUpdateSuite={() => Promise.resolve()}
    onDeleteSuite={() => Promise.resolve()}
    onRunSuite={() => Promise.resolve()}
  />);
  assert.match(testsHtml, /Persistent verification/u);
  assert.match(testsHtml, /no approval is synthesized/u);
  assert.match(testsHtml, /Echo remains stable/u);
  assert.match(testsHtml, /&quot;succeeded&quot;/u);
  assert.match(testsHtml, />Run</u);
  assert.match(testsHtml, />Edit</u);

  const suitesHtml = renderToStaticMarkup(<TestsWorkspace
    initialTab="suites"
    servers={[server]}
    executions={[]}
    testCases={[testCase]}
    suites={[suite]}
    busy={new Set()}
    onCreateTestCase={() => Promise.resolve()}
    onUpdateTestCase={() => Promise.resolve()}
    onDeleteTestCase={() => Promise.resolve()}
    onRunTestCase={() => Promise.resolve()}
    onCreateSuite={() => Promise.resolve()}
    onUpdateSuite={() => Promise.resolve()}
    onDeleteSuite={() => Promise.resolve()}
    onRunSuite={() => Promise.resolve()}
  />);
  assert.match(suitesHtml, /Smoke suite/u);
  assert.match(suitesHtml, />Edit</u);

  const run = RunnerMcpEvaluationRunSchema.parse({
    id: "run-1",
    workspaceId: "workspace-1",
    suite: { id: suite.id, name: suite.name, testCaseIds: suite.testCaseIds, tags: suite.tags },
    testCases: [{
      id: testCase.id,
      serverId: testCase.serverId,
      name: testCase.name,
      toolName: testCase.toolName,
      arguments: testCase.arguments,
      timeoutMs: testCase.timeoutMs,
      assertions: testCase.assertions,
      tags: testCase.tags,
    }],
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    confirmation: {
      acknowledged: true,
      acknowledgement: "Reviewed persisted targets and approved their external effects",
      confirmedAt: timestamp,
    },
    results: [{
      testCase: {
        id: testCase.id,
        serverId: testCase.serverId,
        name: testCase.name,
        toolName: testCase.toolName,
        arguments: testCase.arguments,
        timeoutMs: testCase.timeoutMs,
        assertions: testCase.assertions,
        tags: testCase.tags,
      },
      status: "passed",
      durationMs: 12,
      assertions: [{ assertionId: "assertion-1", kind: "status", status: "passed" }],
    }],
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 0,
      successRate: 1,
      reliability: 1,
      p95DurationMs: 12,
    },
  });
  const evaluationsHtml = renderToStaticMarkup(<EvaluationsWorkspace
    runs={[run]}
    comparison={null}
    activeExport={null}
    exportArtifact={null}
    busy={new Set()}
    onCompare={() => Promise.resolve()}
    onExport={() => Promise.resolve()}
    onRefreshExport={() => Promise.resolve()}
  />);
  assert.match(evaluationsHtml, /Real execution evidence/u);
  assert.match(evaluationsHtml, /Export JSON/u);
  assert.match(evaluationsHtml, /Compare two completed runs/u);
  assert.match(evaluationsHtml, /Explicit run approval retained/u);
  assert.match(evaluationsHtml, /100\.0%/u);
});

test("Qyl observability renders available, partial, and unavailable states without inventing evidence", () => {
  const telemetry = RunnerMcpExecutionTelemetryResponseSchema.parse({
    signals: {
      traces: { status: "available", itemCount: 1 },
      logs: { status: "partial", itemCount: 2, unavailableReason: "retention window" },
      exceptions: { status: "unavailable", itemCount: 0, unavailableReason: "<script>collector disabled</script>" },
      toolCallEvents: { status: "available", itemCount: 1 },
    },
    correlation: {
      executionId: "execution-1",
      traceIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      spanIds: ["bbbbbbbbbbbbbbbb"],
    },
    traces: [],
    logs: [],
    queriedAt: timestamp,
    selfExportSuppressed: true,
  });
  const html = renderToStaticMarkup(<TelemetryPanel telemetry={telemetry} error={null} loading={false} onRefresh={() => undefined} />);
  assert.match(html, /signal-available/u);
  assert.match(html, /signal-partial/u);
  assert.match(html, /signal-unavailable/u);
  assert.match(html, /Self-export suppressed/u);
  assert.match(html, /collector disabled/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;/u);
});
