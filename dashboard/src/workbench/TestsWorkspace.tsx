import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  WorkbenchExecutionConfirmationRequest as ExecutionConfirmationRequest,
  WorkbenchExecutionRecord as ExecutionRecord,
  WorkbenchServer as McpServer,
  WorkbenchTestAssertion as TestAssertion,
  WorkbenchTestCase as TestCase,
  WorkbenchTestSuite as TestSuite,
} from "@ancplua/qyl-api-schema/types";
import type { SuiteDraft, TestCaseDraft } from "./useWorkbench.js";
import { JsonCodeView } from "./JsonCodeView.js";

interface TestsWorkspaceProps {
  servers: McpServer[];
  executions: ExecutionRecord[];
  testCases: TestCase[];
  suites: TestSuite[];
  busy: ReadonlySet<string>;
  initialTab?: "tests" | "suites";
  onCreateTestCase: (draft: TestCaseDraft) => Promise<unknown>;
  onUpdateTestCase: (testCaseId: string, draft: TestCaseDraft) => Promise<unknown>;
  onDeleteTestCase: (testCaseId: string) => Promise<void>;
  onRunTestCase: (testCaseId: string, confirmation: ExecutionConfirmationRequest) => Promise<void>;
  onCreateSuite: (draft: SuiteDraft) => Promise<unknown>;
  onUpdateSuite: (suiteId: string, draft: SuiteDraft) => Promise<unknown>;
  onDeleteSuite: (suiteId: string) => Promise<void>;
  onRunSuite: (suiteId: string, confirmation: ExecutionConfirmationRequest) => Promise<void>;
}

type AssertionKind = TestAssertion["kind"];
type GroupMode = "none" | "server" | "tool" | "tag";
type PendingEvaluation =
  | { kind: "test"; id: string; name: string; testCases: TestCase[] }
  | { kind: "suite"; id: string; name: string; testCases: TestCase[]; unresolvedTestCaseIds: string[] };

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function assertionSummary(assertion: TestAssertion): string {
  switch (assertion.kind) {
    case "status": return `status in ${assertion.expected.join(", ")}`;
    case "latency": return `duration ≤ ${assertion.max_duration_ms} ms`;
    case "pattern": return `${assertion.path ?? "/"} matches /${assertion.pattern}/${assertion.flags ?? ""}`;
    case "schema": return `${assertion.path ?? "/"} matches schema`;
    case "exact": return `${assertion.path ?? "/"} exactly equals expected value`;
    case "partial": return `${assertion.path ?? "/"} contains expected value`;
  }
}

function groupedTests(testCases: TestCase[], mode: GroupMode, servers: McpServer[]): Array<[string, TestCase[]]> {
  if (mode === "none") return [["All test cases", testCases]];
  const serverNames = new Map(servers.map((server) => [server.id, server.name]));
  const groups = new Map<string, TestCase[]>();
  for (const testCase of testCases) {
    const keys = mode === "server"
      ? [serverNames.get(testCase.server_id) ?? testCase.server_id]
      : mode === "tool"
        ? [testCase.tool_name]
        : testCase.tags.length > 0 ? testCase.tags : ["untagged"];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), testCase]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function AssertionBuilder({ assertions, onChange }: { assertions: TestAssertion[]; onChange: (assertions: TestAssertion[]) => void }) {
  const [kind, setKind] = useState<AssertionKind>("status");
  const [path, setPath] = useState("");
  const [expected, setExpected] = useState("null");
  const [statuses, setStatuses] = useState("succeeded");
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("");
  const [maxDurationMs, setMaxDurationMs] = useState(1_000);
  const [error, setError] = useState<string | null>(null);

  function addAssertion() {
    setError(null);
    try {
      const id = crypto.randomUUID();
      let next: TestAssertion;
      switch (kind) {
        case "status": {
          const allowed = new Set(["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "timed_out"]);
          const expectedStatuses = statuses.split(",").map((value) => value.trim()).filter((value): value is "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out" => allowed.has(value));
          if (expectedStatuses.length === 0) throw new Error("Choose at least one valid execution status.");
          next = { id, kind, expected: expectedStatuses };
          break;
        }
        case "latency": next = { id, kind, max_duration_ms: maxDurationMs }; break;
        case "pattern":
          if (!pattern) throw new Error("A pattern is required.");
          next = { id, kind, path: path || undefined, pattern, flags: flags || undefined };
          break;
        case "schema": next = { id, kind, path: path || undefined, schema: parseJson(expected, "Schema") }; break;
        case "exact":
        case "partial": next = { id, kind, path: path || undefined, expected: parseJson(expected, "Expected value") }; break;
      }
      onChange([...assertions, next]);
    } catch (builderError) {
      setError(builderError instanceof Error ? builderError.message : String(builderError));
    }
  }

  return (
    <section className="assertion-builder">
      <div className="form-grid compact-form-grid">
        <label>Assertion
          <select value={kind} onChange={(event) => setKind(event.target.value as AssertionKind)}>
            <option value="status">Execution status</option>
            <option value="exact">Exact value</option>
            <option value="partial">Partial object</option>
            <option value="schema">JSON Schema</option>
            <option value="pattern">Pattern</option>
            <option value="latency">Latency threshold</option>
          </select>
        </label>
        {kind === "status" ? <label>Expected statuses<input value={statuses} onChange={(event) => setStatuses(event.target.value)} /></label> : null}
        {kind === "latency" ? <label>Maximum ms<input type="number" min={0} value={maxDurationMs} onChange={(event) => setMaxDurationMs(Math.max(0, Number(event.target.value)))} /></label> : null}
        {(["exact", "partial", "schema", "pattern"] as AssertionKind[]).includes(kind) ? <label>JSON Pointer<input placeholder="/content/0/text" value={path} onChange={(event) => setPath(event.target.value)} /></label> : null}
        {kind === "pattern" ? <><label>Pattern<input value={pattern} onChange={(event) => setPattern(event.target.value)} /></label><label>Flags<input value={flags} onChange={(event) => setFlags(event.target.value)} /></label></> : null}
        {(["exact", "partial", "schema"] as AssertionKind[]).includes(kind) ? <label className="wide-field">{kind === "schema" ? "Schema JSON" : "Expected JSON"}<textarea rows={4} value={expected} onChange={(event) => setExpected(event.target.value)} spellCheck={false} /></label> : null}
      </div>
      <button type="button" className="small-button" onClick={addAssertion}>Add assertion</button>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="assertion-list">
        {assertions.map((assertion) => (
          <div key={assertion.id} className="assertion-row"><code>{assertion.kind}</code><span>{assertionSummary(assertion)}</span><button type="button" className="icon-button" aria-label="Remove assertion" onClick={() => onChange(assertions.filter((item) => item.id !== assertion.id))}>×</button></div>
        ))}
        {assertions.length === 0 ? <p className="empty-note">Add at least one executable assertion.</p> : null}
      </div>
    </section>
  );
}

export function TestsWorkspace({
  servers,
  executions,
  testCases,
  suites,
  busy,
  initialTab = "tests",
  onCreateTestCase,
  onUpdateTestCase,
  onDeleteTestCase,
  onRunTestCase,
  onCreateSuite,
  onUpdateSuite,
  onDeleteSuite,
  onRunSuite,
}: TestsWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<"tests" | "suites">(initialTab);
  const [showBuilder, setShowBuilder] = useState(false);
  const [editingTestCaseId, setEditingTestCaseId] = useState<string | null>(null);
  const [sourceExecutionId, setSourceExecutionId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [serverId, setServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const [argumentsJson, setArgumentsJson] = useState("{}");
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [tags, setTags] = useState("");
  const [assertions, setAssertions] = useState<TestAssertion[]>([
    { id: crypto.randomUUID(), kind: "status", expected: ["succeeded"] },
  ]);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>("tool");
  const [suiteName, setSuiteName] = useState("");
  const [editingSuiteId, setEditingSuiteId] = useState<string | null>(null);
  const [suiteDescription, setSuiteDescription] = useState("");
  const [suiteTags, setSuiteTags] = useState("");
  const [suiteTests, setSuiteTests] = useState<Set<string>>(() => new Set());
  const [suiteError, setSuiteError] = useState<string | null>(null);
  const [pendingEvaluation, setPendingEvaluation] = useState<PendingEvaluation | null>(null);
  const [evaluationReviewed, setEvaluationReviewed] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);

  const sourceExecution = executions.find((execution) => execution.id === sourceExecutionId);
  const groups = useMemo(() => groupedTests(testCases, groupMode, servers), [testCases, groupMode, servers]);
  const editingSuite = suites.find((suite) => suite.id === editingSuiteId);
  const unresolvedEditingSuiteIds = editingSuite?.test_case_ids.filter(
    (id) => !testCases.some((testCase) => testCase.id === id),
  ) ?? [];

  useEffect(() => {
    if (!sourceExecution) return;
    setServerId(sourceExecution.server_id);
    setToolName(sourceExecution.request.tool_name);
    setArgumentsJson(JSON.stringify(sourceExecution.request.arguments ?? {}, null, 2));
    setTimeoutMs(sourceExecution.request.timeout_ms);
    if (!name) setName(`${sourceExecution.request.tool_name} regression`);
  }, [sourceExecution, name]);

  useEffect(() => {
    if (!serverId && servers[0]) setServerId(servers[0].id);
  }, [servers, serverId]);

  function resetTestBuilder() {
    setShowBuilder(false);
    setEditingTestCaseId(null);
    setName("");
    setDescription("");
    setToolName("");
    setArgumentsJson("{}");
    setTimeoutMs(30_000);
    setTags("");
    setSourceExecutionId("");
    setAssertions([{ id: crypto.randomUUID(), kind: "status", expected: ["succeeded"] }]);
    setBuilderError(null);
  }

  function beginCreateTestCase() {
    resetTestBuilder();
    setServerId(servers[0]?.id ?? "");
    setShowBuilder(true);
  }

  function beginEditTestCase(testCase: TestCase) {
    setEditingTestCaseId(testCase.id);
    setName(testCase.name);
    setDescription(testCase.description ?? "");
    setServerId(testCase.server_id);
    setToolName(testCase.tool_name);
    setArgumentsJson(JSON.stringify(testCase.arguments ?? {}, null, 2));
    setTimeoutMs(testCase.timeout_ms);
    setTags(testCase.tags.join(", "));
    setSourceExecutionId("");
    setAssertions(structuredClone(testCase.assertions));
    setBuilderError(null);
    setShowBuilder(true);
  }

  function resetSuiteBuilder() {
    setEditingSuiteId(null);
    setSuiteName("");
    setSuiteDescription("");
    setSuiteTags("");
    setSuiteTests(new Set());
    setSuiteError(null);
  }

  function beginEditSuite(suite: TestSuite) {
    setEditingSuiteId(suite.id);
    setSuiteName(suite.name);
    setSuiteDescription(suite.description ?? "");
    setSuiteTags(suite.tags.join(", "));
    const availableIds = new Set(testCases.map((testCase) => testCase.id));
    setSuiteTests(new Set(suite.test_case_ids.filter((id) => availableIds.has(id))));
    setSuiteError(null);
  }

  async function saveTest(event: FormEvent) {
    event.preventDefault();
    setBuilderError(null);
    try {
      if (assertions.length === 0) throw new Error("Add at least one assertion.");
      const draft = {
        name: name.trim(),
        description: description.trim() || undefined,
        serverId,
        toolName: toolName.trim(),
        arguments: parseJson(argumentsJson, "Arguments"),
        timeoutMs,
        assertions,
        tags: splitTags(tags),
      };
      if (editingTestCaseId) await onUpdateTestCase(editingTestCaseId, draft);
      else await onCreateTestCase(draft);
      resetTestBuilder();
    } catch (error) {
      setBuilderError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveSuite(event: FormEvent) {
    event.preventDefault();
    setSuiteError(null);
    try {
      const draft = {
        name: suiteName.trim(),
        description: suiteDescription.trim() || undefined,
        testCaseIds: [...suiteTests],
        tags: splitTags(suiteTags),
      };
      if (editingSuiteId) await onUpdateSuite(editingSuiteId, draft);
      else await onCreateSuite(draft);
      resetSuiteBuilder();
    } catch (error) {
      setSuiteError(error instanceof Error ? error.message : String(error));
    }
  }

  function reviewTestRun(testCase: TestCase) {
    setEvaluationReviewed(false);
    setEvaluationError(null);
    setPendingEvaluation({ kind: "test", id: testCase.id, name: testCase.name, testCases: [testCase] });
  }

  function reviewSuiteRun(suite: TestSuite) {
    const selected = suite.test_case_ids
      .map((id) => testCases.find((testCase) => testCase.id === id))
      .filter((testCase): testCase is TestCase => testCase !== undefined);
    const selectedIds = new Set(selected.map((testCase) => testCase.id));
    setEvaluationReviewed(false);
    setEvaluationError(null);
    setPendingEvaluation({
      kind: "suite",
      id: suite.id,
      name: suite.name,
      testCases: selected,
      unresolvedTestCaseIds: suite.test_case_ids.filter((id) => !selectedIds.has(id)),
    });
  }

  async function confirmEvaluationRun() {
    if (!pendingEvaluation || !evaluationReviewed) return;
    setEvaluationError(null);
    const count = pendingEvaluation.kind === "suite"
      ? pendingEvaluation.testCases.length + pendingEvaluation.unresolvedTestCaseIds.length
      : 1;
    const confirmation: ExecutionConfirmationRequest = {
      acknowledged: true,
      acknowledgement: `Reviewed and approved ${count} persisted MCP tool call${count === 1 ? "" : "s"} for ${pendingEvaluation.name}`,
    };
    try {
      if (pendingEvaluation.kind === "test") {
        await onRunTestCase(pendingEvaluation.id, confirmation);
      } else {
        await onRunSuite(pendingEvaluation.id, confirmation);
      }
      setPendingEvaluation(null);
      setEvaluationReviewed(false);
    } catch (error) {
      setEvaluationError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="tests-workspace">
      <section className="workspace-title-row">
        <div><span className="section-kicker">Persistent verification</span><h2>Tests & suites</h2><p>Assertions run against real MCP executions and retain their execution evidence. Every run pauses for exact-call review; no approval is synthesized.</p></div>
        <div className="tab-list" role="tablist" aria-label="Test authoring sections">
          <button type="button" role="tab" aria-selected={activeTab === "tests"} onClick={() => setActiveTab("tests")}>Test cases · {testCases.length}</button>
          <button type="button" role="tab" aria-selected={activeTab === "suites"} onClick={() => setActiveTab("suites")}>Suites · {suites.length}</button>
        </div>
      </section>

      {activeTab === "tests" ? (
        <>
          <section className="panel-surface test-toolbar">
            <div><span className="section-kicker">Reusable tool checks</span><h3>Test cases</h3></div>
            <div className="button-row">
              <label className="inline-select">Group by<select value={groupMode} onChange={(event) => setGroupMode(event.target.value as GroupMode)}><option value="none">None</option><option value="tool">Tool</option><option value="server">Server</option><option value="tag">Feature tag</option></select></label>
              <button className="primary-button" disabled={servers.length === 0} onClick={showBuilder ? resetTestBuilder : beginCreateTestCase}>{showBuilder ? "Close builder" : "New test case"}</button>
            </div>
          </section>
          {showBuilder ? (
            <form className="panel-surface test-builder" onSubmit={(event) => void saveTest(event)}>
              <div className="section-heading-row"><div><span className="section-kicker">Test-case builder</span><h3>{editingTestCaseId ? "Edit persisted invocation" : "Save an invocation"}</h3></div><span className="safe-marker">Workspace isolated</span></div>
              <label>Source invocation
                <select value={sourceExecutionId} onChange={(event) => setSourceExecutionId(event.target.value)}>
                  <option value="">Enter request manually</option>
                  {executions.map((execution) => <option key={execution.id} value={execution.id}>{execution.request.tool_name} · {execution.id.slice(0, 8)} · {execution.status}</option>)}
                </select>
              </label>
              <div className="form-grid">
                <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label>Server<select required value={serverId} onChange={(event) => setServerId(event.target.value)}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label>
                <label>Tool name<input required value={toolName} onChange={(event) => setToolName(event.target.value)} /></label>
                <label>Timeout ms<input required type="number" min={1} max={3_600_000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} /></label>
                <label className="wide-field">Description<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
                <label className="wide-field">Arguments JSON<textarea rows={8} value={argumentsJson} onChange={(event) => setArgumentsJson(event.target.value)} spellCheck={false} /></label>
                <label className="wide-field">Feature tags, comma separated<input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
              </div>
              <AssertionBuilder assertions={assertions} onChange={setAssertions} />
              {builderError ? <p className="field-error" role="alert">{builderError}</p> : null}
              <div className="button-row">
                <button className="primary-button" disabled={!name.trim() || !toolName.trim() || !serverId || assertions.length === 0 || busy.has(editingTestCaseId ? `update-test:${editingTestCaseId}` : "create-test")}>{editingTestCaseId ? "Save changes" : "Save test case"}</button>
                {editingTestCaseId ? <button type="button" className="ghost-button" onClick={resetTestBuilder}>Cancel</button> : null}
              </div>
            </form>
          ) : null}

          <div className="test-groups">
            {groups.map(([group, tests]) => (
              <section className="panel-surface test-group" key={group}>
                <div className="section-heading-row"><h3>{group}</h3><span className="count-label">{tests.length}</span></div>
                <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>Tool</th><th>Assertions</th><th>Updated</th><th>Actions</th></tr></thead><tbody>
                  {tests.map((testCase) => <tr key={testCase.id}><td><strong>{testCase.name}</strong>{testCase.description ? <small>{testCase.description}</small> : null}</td><td><code>{testCase.tool_name}</code><small>{testCase.tags.join(", ") || "untagged"}</small></td><td>{testCase.assertions.length}<details><summary>Inspect</summary><JsonCodeView value={testCase.assertions} label="Assertions" /></details></td><td>{formatTimestamp(testCase.updated_at)}</td><td><div className="button-row"><button className="small-button" disabled={busy.has(`run-test:${testCase.id}`)} onClick={() => reviewTestRun(testCase)}>Run</button><button className="small-button" disabled={busy.has(`update-test:${testCase.id}`)} onClick={() => beginEditTestCase(testCase)}>Edit</button><button className="danger-button" disabled={busy.has(`delete-test:${testCase.id}`)} onClick={() => {
                    if (window.confirm(`Delete test case “${testCase.name}”?`)) void onDeleteTestCase(testCase.id);
                  }}>Delete</button></div></td></tr>)}
                </tbody></table></div>
              </section>
            ))}
            {testCases.length === 0 ? <section className="empty-state panel-surface"><strong>No test cases yet</strong><span>Save a real invocation with explicit assertions to create one.</span></section> : null}
          </div>
        </>
      ) : (
        <div className="suite-layout">
          <form className="panel-surface suite-builder" onSubmit={(event) => void saveSuite(event)}>
            <span className="section-kicker">Evaluation suite</span><h3>{editingSuiteId ? "Edit evaluation group" : "Group repeatable checks"}</h3>
            <label>Name<input required value={suiteName} onChange={(event) => setSuiteName(event.target.value)} /></label>
            <label>Description<textarea rows={3} value={suiteDescription} onChange={(event) => setSuiteDescription(event.target.value)} /></label>
            <label>Feature tags<input value={suiteTags} onChange={(event) => setSuiteTags(event.target.value)} /></label>
            <fieldset className="test-picker"><legend>Test cases</legend>{testCases.map((testCase) => <label key={testCase.id} className="check-label"><input type="checkbox" checked={suiteTests.has(testCase.id)} onChange={(event) => setSuiteTests((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(testCase.id); else next.delete(testCase.id);
              return next;
            })} /><span><strong>{testCase.name}</strong><small>{testCase.tool_name}</small></span></label>)}</fieldset>
            {unresolvedEditingSuiteIds.length > 0 ? <p className="form-help">Saving removes {unresolvedEditingSuiteIds.length} unavailable test-case reference{unresolvedEditingSuiteIds.length === 1 ? "" : "s"} from this suite.</p> : null}
            {suiteError ? <p className="field-error" role="alert">{suiteError}</p> : null}
            <div className="button-row">
              <button className="primary-button" disabled={!suiteName.trim() || suiteTests.size === 0 || busy.has(editingSuiteId ? `update-suite:${editingSuiteId}` : "create-suite")}>{editingSuiteId ? "Save changes" : "Save suite"}</button>
              {editingSuiteId ? <button type="button" className="ghost-button" onClick={resetSuiteBuilder}>Cancel</button> : null}
            </div>
          </form>
          <section className="panel-surface suite-list"><div className="section-heading-row"><div><span className="section-kicker">Persisted suites</span><h3>Evaluation groups</h3></div><span className="count-label">{suites.length}</span></div>
            {suites.map((suite) => <article className="suite-card" key={suite.id}><div><h4>{suite.name}</h4><p>{suite.description ?? "No description"}</p><span>{suite.test_case_ids.length} tests · {suite.tags.join(", ") || "untagged"}</span></div><div className="button-row"><button className="primary-button" disabled={busy.has(`run-suite:${suite.id}`)} onClick={() => reviewSuiteRun(suite)}>Run suite</button><button className="small-button" disabled={busy.has(`update-suite:${suite.id}`)} onClick={() => beginEditSuite(suite)}>Edit</button><button className="danger-button" disabled={busy.has(`delete-suite:${suite.id}`)} onClick={() => {
              if (window.confirm(`Delete evaluation suite “${suite.name}”?`)) void onDeleteSuite(suite.id);
            }}>Delete</button></div></article>)}
            {suites.length === 0 ? <p className="empty-note">No suites saved.</p> : null}
          </section>
        </div>
      )}
      {pendingEvaluation ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="evaluation-confirmation-title">
            <span className="section-kicker">Explicit evaluation confirmation</span>
            <h2 id="evaluation-confirmation-title">Review {pendingEvaluation.name}</h2>
            <p>This evaluation invokes {pendingEvaluation.testCases.length} persisted MCP tool call{pendingEvaluation.testCases.length === 1 ? "" : "s"}. Review every target and argument before approving external effects.</p>
            {pendingEvaluation.kind === "suite" && pendingEvaluation.unresolvedTestCaseIds.length > 0 ? (
              <p className="field-error" role="alert">The suite references {pendingEvaluation.unresolvedTestCaseIds.length} unavailable test case{pendingEvaluation.unresolvedTestCaseIds.length === 1 ? "" : "s"}; cancel and repair the suite before running it.</p>
            ) : null}
            <div className="assertion-list">
              {pendingEvaluation.testCases.map((testCase) => (
                <details key={testCase.id}>
                  <summary><strong>{testCase.name}</strong> · <code>{testCase.tool_name}</code></summary>
                  <JsonCodeView value={{ serverId: testCase.server_id, toolName: testCase.tool_name, arguments: testCase.arguments, timeoutMs: testCase.timeout_ms }} label={`${testCase.name} invocation`} />
                </details>
              ))}
            </div>
            <label className="check-label confirmation-check"><input type="checkbox" checked={evaluationReviewed} onChange={(event) => setEvaluationReviewed(event.target.checked)} />I reviewed every persisted tool target and argument and approve this evaluation run.</label>
            {evaluationError ? <p className="field-error" role="alert">{evaluationError}</p> : null}
            <div className="button-row dialog-actions">
              <button
                className="danger-primary-button"
                disabled={!evaluationReviewed
                  || busy.has(`${pendingEvaluation.kind === "test" ? "run-test" : "run-suite"}:${pendingEvaluation.id}`)
                  || (pendingEvaluation.kind === "suite" && pendingEvaluation.unresolvedTestCaseIds.length > 0)}
                onClick={() => void confirmEvaluationRun()}
              >Run evaluation</button>
              <button type="button" onClick={() => {
                setPendingEvaluation(null);
                setEvaluationReviewed(false);
                setEvaluationError(null);
              }}>Cancel</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
