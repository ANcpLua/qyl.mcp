/**
 * Qyl's CI dogfooding block (the fourth tool block next to traces, sessions,
 * and logs): answers "which CI leg hung on what" from qyl's OWN telemetry
 * instead of wrapping the GitHub API.
 *
 * Emitter convention (what CI runs must send to appear here):
 *   - resource `service.name` starts with "qyl-ci" (e.g. "qyl-ci-smoke"),
 *   - `session.id` identifies one workflow run (e.g. "nuget-publish-<run_id>"),
 *   - one span per phase, named after the phase, carrying a `ci.leg` string
 *     attribute (e.g. "macos-latest"); a failed phase sets span status error.
 *
 */
import type {
  CiPhase,
  CiRunSummary,
} from "@ancplua/qyl-api-schema/types";
import type { McpServer } from "@modelcontextprotocol/server";
import { compactOutputSchema, contractSchema } from "./contract-validation.js";
import { queryAnalysis } from "./analysis-client.js";
import { runTool } from "./request-scope.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";
import type { Mode, QylSession, QylSpan, QylTrace } from "./wire.js";

/** Resource service-name prefix that marks telemetry as CI-emitted. */
export const CI_SERVICE_PREFIX = "qyl-ci";

/** CI sessions carry at least one service matching the requested prefix. */
export function filterCiSessions(
  sessions: QylSession[],
  servicePrefix = CI_SERVICE_PREFIX,
): QylSession[] {
  return sessions.filter((session) =>
    session.services.some((service) => service.startsWith(servicePrefix))
  );
}

function spanLeg(span: QylSpan): string {
  const attribute = span.attributes?.find((entry) => entry.key === "ci.leg");
  return typeof attribute?.value === "string"
    ? attribute.value
    : span.resource.service_name;
}

/** Flatten a run's traces into per-leg phases, failures first. */
export function collectCiPhases(traces: QylTrace[], servicePrefix = CI_SERVICE_PREFIX): CiPhase[] {
  const phases = traces.flatMap((trace) =>
    trace.spans.filter((span) => span.resource.service_name.startsWith(servicePrefix)).map((span): CiPhase => ({
      leg: spanLeg(span),
      phase: span.name,
      status: span.status.code === 2 ? "error" : span.status.code === 1 ? "ok" : "unset",
      duration_ms: Math.max(
        0,
        Math.round(
          Number(BigInt(span.end_time_unix_nano) - BigInt(span.start_time_unix_nano)) / 1_000_000,
        ),
      ),
      ...(span.status.message ? { message: span.status.message } : {}),
    }))
  );
  return phases.sort((a, b) =>
    a.status === b.status
      ? a.leg.localeCompare(b.leg) || a.phase.localeCompare(b.phase)
      : a.status === "error"
        ? -1
        : b.status === "error"
          ? 1
          : 0
  );
}

export function summarizeCiRuns(runs: CiRunSummary[], mode: Mode, servicePrefix = CI_SERVICE_PREFIX): string {
  if (runs.length === 0) {
    return `No CI runs found (${mode} mode). CI telemetry appears once runs emit ` +
      `spans with a '${servicePrefix}*' service.name.`;
  }
  const lines = runs.map((run) => {
    const failure = run.error_count > 0 ? `${run.error_count} error(s)` : "clean";
    const duration = run.duration_ms === undefined ? "?" : `${Math.round(run.duration_ms / 1000)}s`;
    return `- ${run.run_id} [${run.state}] ${run.start_time} ${duration} — ${failure}`;
  });
  return `${runs.length} CI run(s) (${mode} mode), pass a run_id for the per-leg breakdown:\n${lines.join("\n")}`;
}

export function summarizeCiRun(
  runId: string,
  phases: CiPhase[],
  mode: Mode,
  servicePrefix = CI_SERVICE_PREFIX,
): string {
  if (phases.length === 0) {
    return `CI run ${runId} has no phase spans matching '${servicePrefix}*' (${mode} mode).`;
  }
  const legs = new Map<string, CiPhase[]>();
  for (const phase of phases) {
    const existing = legs.get(phase.leg);
    if (existing) existing.push(phase);
    else legs.set(phase.leg, [phase]);
  }
  const lines: string[] = [];
  for (const [leg, legPhases] of legs) {
    const failed = legPhases.filter((phase) => phase.status === "error");
    lines.push(`${failed.length > 0 ? "✗" : "✓"} ${leg}`);
    for (const phase of failed.length > 0 ? failed : legPhases) {
      const detail = phase.message ? ` — ${phase.message}` : "";
      lines.push(`    ${phase.status === "error" ? "✗" : "·"} ${phase.phase} (${phase.duration_ms}ms)${detail}`);
    }
  }
  return `CI run ${runId} (${mode} mode):\n${lines.join("\n")}`;
}

/** Query all matching CI telemetry before pagination. */
export function registerCiTools(server: McpServer): void {
  server.registerTool(
    "ci_log",
    {
      title: "CI Log",
      description: "List or compare CI runs and phase failures when investigating a build or test regression.",
      inputSchema: contractSchema("Mcp.Tools.CiLogInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.CiLogOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("ci_log", args, contractSchema("Mcp.Tools.CiLogOutput"), scope)),
  );
}
