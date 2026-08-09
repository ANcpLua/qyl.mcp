import type {
  ControlWorkflowRunInput,
  FetchWorkflowGraphUpdatesInput,
  FetchWorkflowGraphUpdatesOutput,
  GetWorkflowGraphInput,
  ListWorkflowRunsInput,
  ListWorkflowRunsOutput,
  WorkflowContent,
  WorkflowControlCommand,
  WorkflowEventPage,
  WorkflowGraphSnapshot,
  WorkflowRun,
  WorkflowRunPage,
} from "@ancplua/qyl-api-schema/types";
import { z } from "zod";
import {
  CollectorError,
  collectorGet,
  collectorPost,
} from "./collector.js";
import {
  WorkflowContentSchema,
  WorkflowControlCommandSchema,
  WorkflowEventPageSchema,
  WorkflowGraphSnapshotSchema,
  WorkflowRunPageSchema,
  WorkflowRunSchema,
} from "./contract-validation.js";

const rfc3339 = z.iso.datetime({ offset: true });
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollectorError(`collector contract mismatch for ${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalDateTime(value: unknown, context: string): string {
  const parsed = rfc3339.safeParse(value);
  if (!parsed.success) {
    throw new CollectorError(
      `collector contract mismatch for ${context}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return new Date(parsed.data).toISOString();
}

function parseContract<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CollectorError(
      `collector contract mismatch for ${context}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function normalizeRun(value: unknown, context: string): Record<string, unknown> {
  const run = asRecord(value, context);
  return {
    ...run,
    started_at: canonicalDateTime(run.started_at, `${context}.started_at`),
    ...(run.ended_at === undefined
      ? {}
      : { ended_at: canonicalDateTime(run.ended_at, `${context}.ended_at`) }),
  };
}

export function parseWorkflowRun(value: unknown, context = "workflow run"): WorkflowRun {
  return parseContract(WorkflowRunSchema, normalizeRun(value, context), context);
}

export function parseWorkflowRunPage(
  value: unknown,
  context = "workflow run page",
): WorkflowRunPage {
  const page = asRecord(value, context);
  const items = z.array(z.unknown()).safeParse(page.items);
  if (!items.success) {
    throw new CollectorError(
      `collector contract mismatch for ${context}.items: ${z.prettifyError(items.error)}`,
    );
  }
  return parseContract(
    WorkflowRunPageSchema,
    {
      ...page,
      items: items.data.map((item, index) =>
        normalizeRun(item, `${context}.items[${index}]`)),
    },
    context,
  );
}

export function parseWorkflowGraph(
  value: unknown,
  context = "workflow graph",
): WorkflowGraphSnapshot {
  const graph = asRecord(value, context);
  const nodes = z.array(z.unknown()).safeParse(graph.nodes);
  if (!nodes.success) {
    throw new CollectorError(
      `collector contract mismatch for ${context}.nodes: ${z.prettifyError(nodes.error)}`,
    );
  }
  return parseContract(
    WorkflowGraphSnapshotSchema,
    {
      ...graph,
      run: normalizeRun(graph.run, `${context}.run`),
      nodes: nodes.data.map((value, index) => {
        const node = asRecord(value, `${context}.nodes[${index}]`);
        return {
          ...node,
          ...(node.started_at === undefined
            ? {}
            : {
                started_at: canonicalDateTime(
                  node.started_at,
                  `${context}.nodes[${index}].started_at`,
                ),
              }),
          ...(node.ended_at === undefined
            ? {}
            : {
                ended_at: canonicalDateTime(
                  node.ended_at,
                  `${context}.nodes[${index}].ended_at`,
                ),
              }),
        };
      }),
    },
    context,
  );
}

export function parseWorkflowEvents(
  value: unknown,
  context = "workflow event page",
): WorkflowEventPage {
  const page = asRecord(value, context);
  const events = z.array(z.unknown()).safeParse(page.events);
  if (!events.success) {
    throw new CollectorError(
      `collector contract mismatch for ${context}.events: ${z.prettifyError(events.error)}`,
    );
  }
  return parseContract(
    WorkflowEventPageSchema,
    {
      ...page,
      events: events.data.map((value, index) => {
        const event = asRecord(value, `${context}.events[${index}]`);
        return {
          ...event,
          timestamp: canonicalDateTime(
            event.timestamp,
            `${context}.events[${index}].timestamp`,
          ),
        };
      }),
    },
    context,
  );
}

export function parseWorkflowContent(
  value: unknown,
  context = "workflow content",
): WorkflowContent {
  return parseContract(WorkflowContentSchema, value, context);
}

export function parseWorkflowControlCommand(
  value: unknown,
  context = "workflow control command",
): WorkflowControlCommand {
  const command = asRecord(value, context);
  return parseContract(
    WorkflowControlCommandSchema,
    {
      ...command,
      requested_at: canonicalDateTime(command.requested_at, `${context}.requested_at`),
      updated_at: canonicalDateTime(command.updated_at, `${context}.updated_at`),
    },
    context,
  );
}

export async function listWorkflowRuns(
  input: ListWorkflowRunsInput,
  signal?: AbortSignal,
): Promise<ListWorkflowRunsOutput> {
  const page = parseWorkflowRunPage(
    await collectorGet(
      "/api/v1/workflow-runs",
      {
        status: input.status,
        cursor: input.cursor,
        limit: input.limit ?? 50,
      },
      { signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    ),
    "/api/v1/workflow-runs",
  );
  return {
    runs: page.items,
    ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
    has_more: page.has_more,
    mode: "live",
  };
}

export async function getWorkflowGraph(
  input: GetWorkflowGraphInput,
  signal?: AbortSignal,
): Promise<WorkflowGraphSnapshot> {
  return parseWorkflowGraph(
    await collectorGet(
      `/api/v1/workflow-runs/${encodeURIComponent(input.run_id)}/graph`,
      {
        node_cursor: input.node_cursor,
        node_limit: input.node_limit ?? 250,
        edge_cursor: input.edge_cursor,
        edge_limit: input.edge_limit ?? 500,
      },
      { signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    ),
    `/api/v1/workflow-runs/${input.run_id}/graph`,
  );
}

export async function getMostRecentWorkflowRun(
  signal?: AbortSignal,
): Promise<WorkflowRun> {
  const page = await listWorkflowRuns({ limit: 1 }, signal);
  const run = page.runs[0];
  if (!run) throw new CollectorError("no workflow runs are available");
  return run;
}

export async function fetchWorkflowGraphUpdates(
  input: FetchWorkflowGraphUpdatesInput,
  signal?: AbortSignal,
  options: { includeGraphOnJournalChange?: boolean } = {},
): Promise<FetchWorkflowGraphUpdatesOutput> {
  const waitMs = input.content_ref === undefined ? input.wait_ms ?? 20_000 : 0;
  const page = parseWorkflowEvents(
    await collectorGet(
      `/api/v1/workflow-runs/${encodeURIComponent(input.run_id)}/events`,
      {
        after_sequence: input.after_sequence,
        limit: input.limit ?? 250,
        wait_ms: waitMs,
      },
      { signal, timeoutMs: waitMs + 5_000 },
    ),
    `/api/v1/workflow-runs/${input.run_id}/events`,
  );

  const graphRequested =
    (options.includeGraphOnJournalChange !== false
      && (page.events.length > 0 || page.cursor_gap))
    || input.node_cursor !== undefined
    || input.edge_cursor !== undefined
    || (input.node_limit !== undefined && input.node_limit !== 250)
    || (input.edge_limit !== undefined && input.edge_limit !== 500);
  const graph = graphRequested
    ? await getWorkflowGraph(
        {
          run_id: input.run_id,
          node_cursor: input.node_cursor,
          node_limit: input.node_limit,
          edge_cursor: input.edge_cursor,
          edge_limit: input.edge_limit,
        },
        signal,
      )
    : undefined;
  const content = input.content_ref === undefined
    ? undefined
    : parseWorkflowContent(
        await collectorGet(
          `/api/v1/workflow-runs/${encodeURIComponent(input.run_id)}/content/${encodeURIComponent(input.content_ref)}`,
          {},
          { signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
        ),
        `/api/v1/workflow-runs/${input.run_id}/content/${input.content_ref}`,
      );

  return {
    page,
    ...(graph === undefined ? {} : { graph }),
    ...(content === undefined ? {} : { content }),
    mode: "live",
  };
}

export async function submitWorkflowControl(
  input: ControlWorkflowRunInput,
  signal?: AbortSignal,
): Promise<WorkflowControlCommand> {
  return parseWorkflowControlCommand(
    await collectorPost(
      `/api/v1/workflow-runs/${encodeURIComponent(input.run_id)}/commands`,
      {
        action: input.action,
        idempotency_key: input.idempotency_key,
        ...(input.input === undefined ? {} : { input: input.input }),
      },
      { signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    ),
    `/api/v1/workflow-runs/${input.run_id}/commands`,
  );
}
