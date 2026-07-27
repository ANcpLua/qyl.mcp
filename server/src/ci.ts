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
 * The input/output shapes have graduated: they are authored in qyl-api-schema
 * as Mcp.Tools.CiLogInput/CiRunSummary/CiPhase/CiLogOutput. The inline zod below
 * is what remains until the @ancplua/qyl-api-schema pin moves past 3.0.0, which
 * is the first release whose JSON Schema carries those definitions —
 * publishedContractSchema throws at module load on a definition the installed
 * package does not have. On that bump, delete these schemas, take the four
 * validators from contract-validation.ts, and drop the ci.ts entries from
 * verify-generated-shapes.mjs.
 */
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fetchSessions, fetchSessionTraces } from "./data.js";
import { telemetryToolResult } from "./telemetry-redaction.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, toolError } from "./tools.js";
import type { Mode, QylSession, QylSpan, QylTrace } from "./wire.js";

/** Resource service-name prefix that marks telemetry as CI-emitted. */
export const CI_SERVICE_PREFIX = "qyl-ci";

const CiLogInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .optional()
    .describe("Session id of one CI run for a per-leg phase breakdown; omit to list recent runs."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum CI runs to list (default 10)."),
});

const CiRunSummarySchema = z.object({
  run_id: z.string(),
  state: z.string(),
  start_time: z.string(),
  duration_ms: z.number().optional(),
  error_count: z.number(),
  services: z.array(z.string()),
});

const CiPhaseSchema = z.object({
  leg: z.string(),
  phase: z.string(),
  status: z.enum(["ok", "error", "unset"]),
  duration_ms: z.number(),
  message: z.string().optional(),
});

const CiLogOutputSchema = z.object({
  runs: z.array(CiRunSummarySchema).optional(),
  run_id: z.string().optional(),
  phases: z.array(CiPhaseSchema).optional(),
  mode: z.enum(["live", "demo"]),
});

type CiLogInput = z.infer<typeof CiLogInputSchema>;
type CiRunSummary = z.infer<typeof CiRunSummarySchema>;
type CiPhase = z.infer<typeof CiPhaseSchema>;
type CiLogOutput = z.infer<typeof CiLogOutputSchema>;

/** CI sessions are the ones that carry at least one qyl-ci service. */
export function filterCiSessions(sessions: QylSession[]): QylSession[] {
  return sessions.filter((session) =>
    session.services.some((service) => service.startsWith(CI_SERVICE_PREFIX))
  );
}

function spanLeg(span: QylSpan): string {
  const attribute = span.attributes?.find((entry) => entry.key === "ci.leg");
  return typeof attribute?.value === "string"
    ? attribute.value
    : span.resource.service_name;
}

/** Flatten a run's traces into per-leg phases, failures first. */
export function collectCiPhases(traces: QylTrace[]): CiPhase[] {
  const phases = traces.flatMap((trace) =>
    trace.spans.map((span): CiPhase => ({
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

export function summarizeCiRuns(runs: CiRunSummary[], mode: Mode): string {
  if (runs.length === 0) {
    return `No CI runs found (${mode} mode). CI telemetry appears once runs emit ` +
      `spans with a '${CI_SERVICE_PREFIX}*' service.name.`;
  }
  const lines = runs.map((run) => {
    const failure = run.error_count > 0 ? `${run.error_count} error(s)` : "clean";
    const duration = run.duration_ms === undefined ? "?" : `${Math.round(run.duration_ms / 1000)}s`;
    return `- ${run.run_id} [${run.state}] ${run.start_time} ${duration} — ${failure}`;
  });
  return `${runs.length} CI run(s) (${mode} mode), pass a run_id for the per-leg breakdown:\n${lines.join("\n")}`;
}

export function summarizeCiRun(runId: string, phases: CiPhase[], mode: Mode): string {
  if (phases.length === 0) {
    return `CI run ${runId} has no phase spans (${mode} mode).`;
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

/** Register the CI dogfooding block. */
export function registerCiTools(server: McpServer): void {
  server.registerTool(
    "ci_log",
    {
      title: "CI Log",
      description:
        "Read qyl's own CI runs from its telemetry (dogfooding — no GitHub API). " +
        "Without arguments: recent CI runs (sessions whose service.name starts with " +
        `'${CI_SERVICE_PREFIX}'). With run_id: per-leg phase breakdown, failures first, ` +
        "so 'which leg hung on what' is answerable even when GitHub's log API is down.",
      inputSchema: CiLogInputSchema.shape,
      outputSchema: CiLogOutputSchema.shape,
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
    },
    async (args: CiLogInput): Promise<CallToolResult> => {
      try {
        if (args.run_id) {
          const { traces, mode } = await fetchSessionTraces(args.run_id, 100);
          const phases = collectCiPhases(traces);
          const output: CiLogOutput = { run_id: args.run_id, phases, mode };
          return telemetryToolResult(summarizeCiRun(args.run_id, phases, mode), output);
        }
        const { sessions, mode } = await fetchSessions(50, undefined);
        const runs = filterCiSessions(sessions)
          .slice(0, args.limit ?? 10)
          .map((session): CiRunSummary => ({
            run_id: session["session_id"],
            state: session.state,
            start_time: session.start_time,
            ...(session.duration_ms === undefined ? {} : { duration_ms: session.duration_ms }),
            error_count: session.error_count,
            services: session.services,
          }));
        const output: CiLogOutput = { runs, mode };
        return telemetryToolResult(summarizeCiRuns(runs, mode), output);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
