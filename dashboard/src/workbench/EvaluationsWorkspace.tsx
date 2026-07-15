import { useEffect, useMemo, useState } from "react";
import type {
  RunnerMcpEvaluationExport as EvaluationExport,
  RunnerMcpEvaluationRun as EvaluationRun,
  RunnerMcpEvaluationRunComparison as EvaluationComparison,
  RunnerMcpEvaluationSummary as EvaluationSummary,
} from "@ancplua/qyl-api-schema/types";
import { JsonCodeView } from "./JsonCodeView.js";
import { formatDuration } from "./execution.js";

interface EvaluationsWorkspaceProps {
  runs: EvaluationRun[];
  comparison: EvaluationComparison | null;
  activeExport: EvaluationExport | null;
  exportArtifact: unknown;
  busy: ReadonlySet<string>;
  onCompare: (baselineRunId: string, candidateRunId: string) => Promise<void>;
  onExport: (runId: string, format: "json" | "report") => Promise<void>;
  onRefreshExport: () => Promise<void>;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value: number | undefined, unit = ""): string {
  if (value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${unit}`;
}

function runLabel(run: EvaluationRun): string {
  return `${run.suite?.name ?? run.testCases[0]?.name ?? "Evaluation"} · ${run.id.slice(0, 8)}`;
}

function summaryCards(summary: EvaluationSummary) {
  return [
    ["Success", formatPercent(summary.successRate)],
    ["Reliability", formatPercent(summary.reliability)],
    ["Passed", `${summary.passed}/${summary.total}`],
    ["Failed", String(summary.failed)],
    ["Errors", String(summary.errors)],
    ["Skipped", String(summary.skipped)],
  ] as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyText(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

function downloadArtifact(artifact: unknown, exportMetadata: EvaluationExport) {
  if (!isRecord(artifact)) return;
  const payload = artifact.payload;
  let content: string;
  if (exportMetadata.format === "report" && isRecord(payload) && typeof payload.markdown === "string") {
    content = payload.markdown;
  } else {
    content = JSON.stringify(payload, null, 2);
  }
  const blob = new Blob([content], { type: exportMetadata.mediaType ?? (exportMetadata.format === "report" ? "text/markdown" : "application/json") });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = (exportMetadata.fileName ?? `qyl-mcp-evaluation-${exportMetadata.runId}.${exportMetadata.format === "report" ? "md" : "json"}`).replace(/[^A-Za-z0-9._-]/gu, "_");
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function EvaluationsWorkspace({
  runs,
  comparison,
  activeExport,
  exportArtifact,
  busy,
  onCompare,
  onExport,
  onRefreshExport,
}: EvaluationsWorkspaceProps) {
  const [selectedRunId, setSelectedRunId] = useState("");
  const [baselineRunId, setBaselineRunId] = useState("");
  const [candidateRunId, setCandidateRunId] = useState("");
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const completedRuns = useMemo(() => runs.filter((run) => run.status === "completed"), [runs]);

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!baselineRunId && completedRuns[1]) setBaselineRunId(completedRuns[1].id);
    if (!candidateRunId && completedRuns[0]) setCandidateRunId(completedRuns[0].id);
  }, [completedRuns, baselineRunId, candidateRunId]);

  return (
    <div className="evaluations-workspace">
      <section className="workspace-title-row">
        <div><span className="section-kicker">Real execution evidence</span><h2>Evaluation runs</h2><p>Correctness, latency, reliability, usage, cost, regressions, and exports are shown only when recorded.</p></div>
        <span className="count-label">{runs.length} retained runs</span>
      </section>

      <div className="evaluation-layout">
        <aside className="panel-surface run-list">
          <div className="panel-title"><span className="section-kicker">History</span><h3>Runs</h3></div>
          {runs.map((run) => (
            <button type="button" key={run.id} className={`run-row${selectedRun?.id === run.id ? " is-selected" : ""}`} onClick={() => setSelectedRunId(run.id)}>
              <span><strong>{runLabel(run)}</strong><small>{formatTimestamp(run.createdAt)}</small></span>
              <span className={`pill result-${run.status}`}>{run.status}</span>
              <span>{run.summary ? formatPercent(run.summary.successRate) : "—"}</span>
            </button>
          ))}
          {runs.length === 0 ? <p className="empty-note">No evaluation has been executed yet. Run a test case or suite first.</p> : null}
        </aside>

        <main className="evaluation-detail">
          {selectedRun ? (
            <>
              <section className="panel-surface evaluation-summary">
                <div className="section-heading-row">
                  <div><span className="section-kicker">{selectedRun.id}</span><h3>{runLabel(selectedRun)}</h3><p>{selectedRun.testCases.length} immutable test snapshots · {formatTimestamp(selectedRun.startedAt)} → {formatTimestamp(selectedRun.completedAt)}</p></div>
                  <span className={`pill result-${selectedRun.status}`}>{selectedRun.status}</span>
                </div>
                {selectedRun.summary ? (
                  <>
                    <div className="metric-grid">{summaryCards(selectedRun.summary).map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
                    <div className="latency-strip">
                      <span>mean <strong>{formatDuration(selectedRun.summary.meanDurationMs)}</strong></span>
                      <span>p50 <strong>{formatDuration(selectedRun.summary.p50DurationMs)}</strong></span>
                      <span>p95 <strong>{formatDuration(selectedRun.summary.p95DurationMs)}</strong></span>
                      <span>p99 <strong>{formatDuration(selectedRun.summary.p99DurationMs)}</strong></span>
                      <span>tokens <strong>{selectedRun.summary.tokenUsage?.totalTokens ?? "—"}{selectedRun.summary.tokenUsage?.estimated ? " est." : ""}</strong></span>
                      <span>cost <strong>{selectedRun.summary.cost ? `$${selectedRun.summary.cost.amountUsd.toFixed(6)}${selectedRun.summary.cost.estimated ? " est." : ""}` : "—"}</strong></span>
                    </div>
                  </>
                ) : <p className="empty-note">Aggregate metrics are not available until the real run completes.</p>}
                {selectedRun.error ? <section className="inline-error" role="alert"><strong>{selectedRun.error.category}</strong><span>{selectedRun.error.message}</span></section> : null}
                {selectedRun.confirmation ? (
                  <details className="confirmation-evidence">
                    <summary>Explicit run approval retained · {formatTimestamp(selectedRun.confirmation.confirmedAt)}</summary>
                    <JsonCodeView value={selectedRun.confirmation} label="Run confirmation evidence" onCopy={copyText} />
                  </details>
                ) : null}
              </section>

              <section className="panel-surface result-evidence">
                <div className="section-heading-row"><div><span className="section-kicker">Individual evidence</span><h3>Test results</h3></div><span className="count-label">{selectedRun.results.length}</span></div>
                {selectedRun.results.map((result) => <details className={`evaluation-result result-${result.status}`} key={result.testCase.id}><summary><span><strong>{result.testCase.name}</strong><small>{result.testCase.toolName} · {formatDuration(result.durationMs)}</small></span><span className={`pill result-${result.status}`}>{result.status}</span></summary><div className="evaluation-result-body">
                  {result.error ? <div className="inline-error"><strong>{result.error.category}</strong><span>{result.error.message}</span></div> : null}
                  <table className="data-table"><thead><tr><th>Assertion</th><th>Status</th><th>Message</th></tr></thead><tbody>{result.assertions.map((assertion) => <tr key={assertion.assertionId}><td><code>{assertion.kind}</code></td><td><span className={`pill result-${assertion.status}`}>{assertion.status}</span></td><td>{assertion.message ?? "—"}{assertion.actual !== undefined ? <details><summary>Actual value</summary><JsonCodeView value={assertion.actual} label="Actual assertion value" /></details> : null}</td></tr>)}</tbody></table>
                  <JsonCodeView value={result.testCase} label="Immutable test snapshot" onCopy={copyText} />
                </div></details>)}
                {selectedRun.results.length === 0 ? <p className="empty-note">This evaluation has not produced individual results yet.</p> : null}
              </section>

              <section className="panel-surface export-panel">
                <div className="section-heading-row"><div><span className="section-kicker">Portable evidence</span><h3>Export this run</h3></div><div className="button-row"><button className="secondary-button" disabled={selectedRun.status === "running" || busy.has("export")} onClick={() => void onExport(selectedRun.id, "json")}>Export JSON</button><button className="secondary-button" disabled={selectedRun.status === "running" || busy.has("export")} onClick={() => void onExport(selectedRun.id, "report")}>Export report</button></div></div>
                {activeExport?.runId === selectedRun.id ? <div className="export-status"><dl className="detail-grid"><div><dt>Status</dt><dd>{activeExport.status}</dd></div><div><dt>Format</dt><dd>{activeExport.format}</dd></div><div><dt>Size</dt><dd>{activeExport.byteSize ?? "—"}</dd></div><div><dt>SHA-256</dt><dd><code>{activeExport.sha256 ?? "—"}</code></dd></div></dl><div className="button-row"><button className="small-button" disabled={busy.has("export-refresh")} onClick={() => void onRefreshExport()}>Refresh artifact</button><button className="primary-button" disabled={!exportArtifact} onClick={() => downloadArtifact(exportArtifact, activeExport)}>Save file</button></div>{activeExport.error ? <p className="inline-error">{activeExport.error.message}</p> : null}{exportArtifact ? <JsonCodeView value={exportArtifact} label="Export artifact" onCopy={copyText} /> : null}</div> : <p className="empty-note">Choose a format to create a persisted export with protocol and telemetry evidence.</p>}
              </section>
            </>
          ) : <section className="empty-state panel-surface"><strong>No evaluation selected</strong><span>Execute a persisted test case or suite to produce real results.</span></section>}
        </main>
      </div>

      <section className="panel-surface comparison-panel">
        <div className="section-heading-row"><div><span className="section-kicker">Regression analysis</span><h3>Compare two completed runs</h3></div><button className="primary-button" disabled={!baselineRunId || !candidateRunId || baselineRunId === candidateRunId || busy.has("compare")} onClick={() => void onCompare(baselineRunId, candidateRunId)}>Compare</button></div>
        <div className="compare-selectors"><label>Baseline<select value={baselineRunId} onChange={(event) => setBaselineRunId(event.target.value)}><option value="">Select a run</option>{completedRuns.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}</select></label><span>→</span><label>Candidate<select value={candidateRunId} onChange={(event) => setCandidateRunId(event.target.value)}><option value="">Select a run</option>{completedRuns.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}</select></label></div>
        {comparison ? <div className="comparison-results"><div className="metric-grid"><article><span>Success rate</span><strong>{formatDelta(comparison.successRateDelta * 100, " pp")}</strong></article><article><span>Reliability</span><strong>{formatDelta(comparison.reliabilityDelta * 100, " pp")}</strong></article><article><span>p95 latency</span><strong>{formatDelta(comparison.p95DurationDeltaMs, " ms")}</strong></article><article><span>Tokens</span><strong>{formatDelta(comparison.tokenDelta)}</strong></article><article><span>Cost</span><strong>{formatDelta(comparison.costDeltaUsd, " USD")}</strong></article></div><table className="data-table"><thead><tr><th>Test</th><th>Regression</th><th>Baseline</th><th>Candidate</th><th>Duration Δ</th></tr></thead><tbody>{comparison.tests.map((test) => <tr key={test.testCaseId}><td><code>{test.testCaseId.slice(0, 8)}</code></td><td><span className={`pill regression-${test.status}`}>{test.status}</span></td><td>{test.baselineStatus ?? "—"}</td><td>{test.candidateStatus ?? "—"}</td><td>{formatDelta(test.durationDeltaMs, " ms")}</td></tr>)}</tbody></table></div> : <p className="empty-note">Comparison metrics appear only after the server evaluates two retained runs.</p>}
      </section>
    </div>
  );
}
