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
  WorkbenchEvaluationRunSchema,
  WorkbenchExecutionTelemetryResponseSchema,
  WorkbenchServerSchema,
  WorkbenchTestCaseSchema,
  WorkbenchTestSuiteSchema,
  WorkbenchWorkspaceSchema,
} from "qyl-mcp-server/contract-validation";

const timestamp = "2026-07-15T10:00:00.000Z";

const server = WorkbenchServerSchema.parse({
  id: "server-1",
  workspace_id: "workspace-1",
  name: "Fixture server",
  configuration: { transport: "builtin", name: "fixture" },
  connection: { status: "connected", changed_at: timestamp },
  created_at: timestamp,
  updated_at: timestamp,
});

const userServer = WorkbenchServerSchema.parse({
  id: "server-user",
  workspace_id: "workspace-1",
  name: "Remote user server",
  configuration: {
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    headers: [{ name: "Authorization", secret: { source: "environment", environment_variable: "MCP_TOKEN" }, scheme: "bearer" }],
  },
  connection: { status: "disconnected", changed_at: timestamp },
  created_at: timestamp,
  updated_at: timestamp,
});

const testCase = WorkbenchTestCaseSchema.parse({
  id: "test-1",
  workspace_id: "workspace-1",
  server_id: server.id,
  name: "Echo remains stable",
  tool_name: "echo",
  arguments: { text: "hello" },
  timeout_ms: 1_000,
  assertions: [{ id: "assertion-1", kind: "status", expected: ["succeeded"] }],
  tags: ["smoke"],
  created_at: timestamp,
  updated_at: timestamp,
});

const suite = WorkbenchTestSuiteSchema.parse({
  id: "suite-1",
  workspace_id: "workspace-1",
  name: "Smoke suite",
  test_case_ids: [testCase.id],
  tags: ["smoke"],
  created_at: timestamp,
  updated_at: timestamp,
});

test("the workbench sidebar limits creation to routable transports and retains internal server display", () => {
  assert.deepEqual(SERVER_TRANSPORT_OPTIONS.map((option) => option.value), ["streamable_http", "stdio"]);
  assert.equal(isUserConfigurableServer(server), false);
  assert.equal(isUserConfigurableServer(userServer), true);
  const workspaces = [WorkbenchWorkspaceSchema.parse({
    id: "workspace-1",
    owner_id: "local",
    name: "Local workspace",
    created_at: timestamp,
    updated_at: timestamp,
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

  const run = WorkbenchEvaluationRunSchema.parse({
    id: "run-1",
    workspace_id: "workspace-1",
    suite: { id: suite.id, name: suite.name, test_case_ids: suite.test_case_ids, tags: suite.tags },
    test_cases: [{
      id: testCase.id,
      server_id: testCase.server_id,
      name: testCase.name,
      tool_name: testCase.tool_name,
      arguments: testCase.arguments,
      timeout_ms: testCase.timeout_ms,
      assertions: testCase.assertions,
      tags: testCase.tags,
    }],
    status: "completed",
    created_at: timestamp,
    started_at: timestamp,
    completed_at: timestamp,
    confirmation: {
      acknowledged: true,
      acknowledgement: "Reviewed persisted targets and approved their external effects",
      confirmed_at: timestamp,
    },
    results: [{
      test_case: {
        id: testCase.id,
        server_id: testCase.server_id,
        name: testCase.name,
        tool_name: testCase.tool_name,
        arguments: testCase.arguments,
        timeout_ms: testCase.timeout_ms,
        assertions: testCase.assertions,
        tags: testCase.tags,
      },
      status: "passed",
      duration_ms: 12,
      assertions: [{ assertion_id: "assertion-1", kind: "status", status: "passed" }],
    }],
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 0,
      success_rate: 1,
      reliability: 1,
      p95_duration_ms: 12,
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
  const telemetry = WorkbenchExecutionTelemetryResponseSchema.parse({
    signals: {
      traces: { status: "available", item_count: 1 },
      logs: { status: "partial", item_count: 2, unavailable_reason: "retention window" },
      exceptions: { status: "unavailable", item_count: 0, unavailable_reason: "<script>collector disabled</script>" },
      tool_call_events: { status: "available", item_count: 1 },
    },
    correlation: {
      execution_id: "execution-1",
      trace_ids: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      span_ids: ["bbbbbbbbbbbbbbbb"],
    },
    traces: [],
    logs: [],
    queried_at: timestamp,
    self_export_suppressed: true,
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
