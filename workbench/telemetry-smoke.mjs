/**
 * End-to-end OTLP smoke test against Qyl's real collector receiver.
 *
 * The collector parses protobuf with the generated OpenTelemetry protocol
 * classes and returns 400 for undecodable payloads, so this is deliberately not
 * a repository-owned JSON/Zod echo server.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTelemetry } from "./dist/src/telemetry.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

const apiKeyHeader = qylOpenApi.components.securitySchemes.ApiKeyAuth.name;

// Contract 8.0.0 publishes the metrics read surface this repo's list_metrics,
// get_metric_series, and query_metric tools are generated from. Until 8.0.0 the
// assertion here was the opposite one — that no such surface existed — so it is
// kept as an assertion rather than deleted: the tools cannot be built from
// operations the contract does not publish, and discovering that at startup
// beats discovering it in a tool call.
const METRICS_OPERATIONS = [
  "/api/v1/metrics",
  "/api/v1/metrics/{metric_name}/series",
  "/api/v1/metrics/{metric_name}/query",
];
for (const operation of METRICS_OPERATIONS) {
  if (!Object.hasOwn(qylOpenApi.paths ?? {}, operation)) {
    throw new Error(`published Qyl contract exposes no GET ${operation}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const collectorProject = resolve(
  process.env.QYL_COLLECTOR_PROJECT ??
    join(here, "..", "..", "qyl", "services", "qyl.collector", "qyl.collector.csproj"),
);
const mcpServerMain = resolve(here, "..", "server", "dist", "main.js");
const workbenchMain = resolve(here, "dist", "main.js");
const collectorExecutable = resolve(
  dirname(collectorProject),
  "..",
  "..",
  "artifacts",
  "bin",
  "qyl.collector",
  "release",
  "qyl.collector",
);
if (!existsSync(collectorProject)) {
  throw new Error(
    `Qyl collector project not found at ${collectorProject}; set QYL_COLLECTOR_PROJECT`,
  );
}

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

async function waitUntil(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let workbenchPort;
do {
  workbenchPort = await freePort();
} while (workbenchPort === port);
const workbenchBaseUrl = `http://127.0.0.1:${workbenchPort}`;
const temp = await mkdtemp(join(tmpdir(), "qyl-mcp-otlp-"));
const collectorApiKey = `qyl-smoke-${randomUUID()}`;
const projectScope = "default";
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key.startsWith("OTEL_EXPORTER_OTLP")) delete childEnv[key];
}
Object.assign(childEnv, {
  DOTNET_ENVIRONMENT: "Development",
  QYL_BIND_ADDRESS: "127.0.0.1",
  QYL_PORT: String(port),
  QYL_OTLP_PORT: "0",
  QYL_GRPC_PORT: "0",
  QYL_OTLP_AUTH_MODE: "ApiKey",
  QYL_OTLP_PRIMARY_API_KEY: collectorApiKey,
  QYL_DATA_PATH: join(temp, "telemetry-smoke.duckdb"),
});

const collector = spawn(
  existsSync(collectorExecutable) ? collectorExecutable : "dotnet",
  existsSync(collectorExecutable)
    ? []
    : ["run", "--no-launch-profile", "--project", collectorProject],
  { cwd: dirname(collectorProject), env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
);
let collectorOutput = "";
let workbench;
let workbenchOutput = "";
for (const stream of [collector.stdout, collector.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    collectorOutput = `${collectorOutput}${chunk}`.slice(-40_000);
  });
}

const secret = `must-not-export-${randomUUID()}`;
const marker = `qyl_otlp_smoke_${randomUUID().replaceAll("-", "")}`;

try {
  await Promise.race([
    waitUntil(async () => {
      const response = await fetch(`${baseUrl}/health`);
      return response.ok;
    }, 180_000, "the Qyl collector"),
    once(collector, "exit").then(([code, signal]) => {
      throw new Error(`collector exited ${code ?? signal}\n${collectorOutput}`);
    }),
  ]);

  const unauthenticated = await fetch(`${baseUrl}/api/v1/traces?limit=1`);
  if (unauthenticated.status !== 401) {
    throw new Error(`secure collector accepted an unauthenticated read (${unauthenticated.status})`);
  }

  const diagnosticRunId = `diagnostic-smoke-${randomUUID()}`;
  const diagnosticSnapshot = {
    extension_id: "qyl.agent.diagnostic.snapshot",
    format_version: 1,
    snapshot_id: "mcp_live_roundtrip",
    capture_nonce: randomUUID().replaceAll("-", ""),
    probe_id: "mcp.live.roundtrip",
    phase: "checkpoint",
    variables: [{
      name: "persisted_trace_count",
      type: "integer",
      classification: "internal",
      capture: "value",
      value: 1,
    }],
    checks: [{
      check_id: "trace_count_exists",
      operator: "exists",
      actual: "persisted_trace_count",
      outcome: "pass",
    }],
    outcome: "pass",
  };
  const diagnosticContent = JSON.stringify(diagnosticSnapshot);
  const diagnosticContentRef = `sha256:${createHash("sha256").update(diagnosticContent).digest("hex")}`;
  const diagnosticSummary = {
    extension_id: diagnosticSnapshot.extension_id,
    format_version: diagnosticSnapshot.format_version,
    snapshot_id: diagnosticSnapshot.snapshot_id,
    probe_id: diagnosticSnapshot.probe_id,
    phase: diagnosticSnapshot.phase,
    outcome: diagnosticSnapshot.outcome,
    variable_count: diagnosticSnapshot.variables.length,
    check_count: diagnosticSnapshot.checks.length,
    failed_check_count: 0,
    content_ref: diagnosticContentRef,
  };
  const workflowHeaders = {
    [apiKeyHeader]: collectorApiKey,
    "x-qyl-project": projectScope,
    "content-type": "application/json",
  };
  const createdWorkflow = await fetch(`${baseUrl}/api/v1/workflow-runs`, {
    method: "POST",
    headers: workflowHeaders,
    body: JSON.stringify({
      run_id: diagnosticRunId,
      thread_id: "qyl-mcp-live-smoke",
      title: "Protected diagnostic snapshot round-trip",
      started_at: new Date().toISOString(),
    }),
  });
  if (!createdWorkflow.ok) {
    throw new Error(`diagnostic workflow create returned ${createdWorkflow.status}: ${await createdWorkflow.text()}`);
  }
  const appendedDiagnostic = await fetch(
    `${baseUrl}/api/v1/workflow-runs/${encodeURIComponent(diagnosticRunId)}/events`,
    {
      method: "POST",
      headers: workflowHeaders,
      body: JSON.stringify({
        client_id: "qyl-mcp-live-smoke",
        events: [{
          event_id: `diagnostic-${randomUUID()}`,
          source_sequence: "1",
          timestamp: new Date().toISOString(),
          kind: "content_captured",
          content_refs: [diagnosticContentRef],
          data: diagnosticSummary,
        }],
        content: [{
          content_ref: diagnosticContentRef,
          content_type: "application/json",
          encoding: "utf8",
          content: diagnosticContent,
        }],
      }),
    },
  );
  if (!appendedDiagnostic.ok) {
    throw new Error(`diagnostic workflow append returned ${appendedDiagnostic.status}: ${await appendedDiagnostic.text()}`);
  }

  const telemetry = new McpTelemetry({
    ...process.env,
    QYL_COLLECTOR_URL: baseUrl,
    QYL_MCP_TELEMETRY: "1",
    QYL_API_KEY: collectorApiKey,
    QYL_PROJECT: projectScope,
  });
  const endTimeMs = Date.now();
  telemetry.recordOperation({
    role: "client",
    method: "tools/call",
    serverId: "qyl-otlp-smoke",
    toolName: marker,
    resourceUri: `https://user:${secret}@example.invalid/resource?token=${secret}#${secret}`,
    transport: "http",
    startTimeMs: endTimeMs - 25,
    endTimeMs,
    // Runtime extras emulate a JavaScript caller attempting to pass content.
    arguments: { prompt: secret },
    result: { content: secret },
    error: secret,
  });
  telemetry.recordOperation({
    role: "server",
    method: "ping",
    transport: "http",
    startTimeMs: endTimeMs - 15,
    endTimeMs,
  });
  await telemetry.close();

  const stored = await waitUntil(async () => {
    const response = await fetch(`${baseUrl}/api/v1/traces?limit=100`, {
      headers: { [apiKeyHeader]: collectorApiKey },
    });
    if (!response.ok) throw new Error(`trace query returned ${response.status}`);
    const body = await response.json();
    return JSON.stringify(body).includes(marker) ? body : undefined;
  }, 15_000, "the exported span to be queryable");

  const persistedJson = JSON.stringify(stored);
  if (persistedJson.includes(secret)) {
    throw new Error("arguments, results, credentials, query values, or errors leaked into OTLP");
  }
  console.log("ok official OTLP/protobuf receiver parsed and persisted the SDK export");
  console.log("ok user content and URI secrets were not exported");
  console.log("ok generated Qyl contract publishes the metrics read surface");

  // The live metrics catalog. Deliberately not "at least one metric is listed":
  // whether this run's exporter flushed a metric before the query is a race, and
  // a smoke that fails on timing teaches people to rerun it. What is asserted is
  // the part that cannot be flaky — a served catalog is shaped like the contract
  // says, and a catalog this build cannot reach fails as Problem Details rather
  // than as some other body a client would have to guess at.
  const metricsResponse = await fetch(`${baseUrl}/api/v1/metrics?limit=10`, {
    headers: { [apiKeyHeader]: collectorApiKey },
  });
  const metricsBody = await metricsResponse.json();
  if (metricsResponse.ok) {
    if (!Array.isArray(metricsBody.items) || typeof metricsBody.has_more !== "boolean") {
      throw new Error("metrics catalog is not the published cursor page");
    }
    for (const descriptor of metricsBody.items) {
      for (const field of ["name", "kind", "temporality", "monotonic", "series_count", "last_seen"]) {
        if (!Object.hasOwn(descriptor, field)) {
          throw new Error(`metrics catalog item is missing the published field ${field}`);
        }
      }
    }
    console.log(`ok live metrics catalog is contract-shaped (${metricsBody.items.length} instruments)`);
  } else if (typeof metricsBody.title === "string" && typeof metricsBody.status === "number") {
    console.log(`ok live metrics catalog answers Problem Details (${metricsResponse.status})`);
  } else {
    throw new Error(
      `metrics catalog returned ${metricsResponse.status} without a Problem Details body`,
    );
  }

  if (!existsSync(workbenchMain)) {
    throw new Error(`qyl MCP workbench build not found at ${workbenchMain}; run npm run build`);
  }
  const workbenchEnv = {
    ...process.env,
    QYL_COLLECTOR_URL: baseUrl,
    QYL_DEMO: "0",
    QYL_MCP_TELEMETRY: "1",
    QYL_MCP_WORKBENCH_PORT: String(workbenchPort),
    QYL_MCP_STATE_PATH: join(temp, "workbench-state.json"),
    QYL_MCP_NATIVE_STATE_PATH: join(temp, "workbench-native-executions.json"),
    QYL_API_KEY: collectorApiKey,
    QYL_PROJECT: projectScope,
  };
  delete workbenchEnv.QYL_OTLP_ENDPOINT;
  for (const key of Object.keys(workbenchEnv)) {
    if (key.startsWith("OTEL_EXPORTER_OTLP")) delete workbenchEnv[key];
  }
  workbench = spawn(process.execPath, [workbenchMain], {
    cwd: resolve(here, ".."),
    env: workbenchEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [workbench.stdout, workbench.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      workbenchOutput = `${workbenchOutput}${chunk}`.slice(-40_000);
    });
  }
  await Promise.race([
    waitUntil(async () => {
      const response = await fetch(`${workbenchBaseUrl}/workbench/session`);
      return response.status === 401;
    }, 30_000, "the qyl.mcp workbench"),
    once(workbench, "exit").then(([code, signal]) => {
      throw new Error(`workbench exited ${code ?? signal}\n${workbenchOutput}`);
    }),
  ]);
  const bootstrap = await fetch(`${workbenchBaseUrl}/workbench/session`, { method: "POST" });
  if (!bootstrap.ok) throw new Error(`workbench session bootstrap returned ${bootstrap.status}`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("workbench session bootstrap returned no cookie");
  const workbenchHeaders = { cookie, "content-type": "application/json" };
  const serversResponse = await fetch(
    `${workbenchBaseUrl}/workbench/workspaces/default/servers`,
    { headers: workbenchHeaders },
  );
  if (!serversResponse.ok) throw new Error(`workbench server list returned ${serversResponse.status}`);
  const servers = await serversResponse.json();
  const workbenchServer = servers.servers?.find((item) => item?.name === "qyl-telemetry");
  if (!workbenchServer?.id || workbenchServer.connection?.status !== "connected") {
    throw new Error("workbench did not auto-connect its in-process qyl-telemetry server");
  }
  const accepted = await fetch(
    `${workbenchBaseUrl}/workbench/workspaces/default/servers/${workbenchServer.id}/executions`,
    {
      method: "POST",
      headers: workbenchHeaders,
      body: JSON.stringify({
        tool_name: "list_traces",
        arguments: { limit: 100 },
        timeout_ms: 10_000,
        idempotency_key: `otlp-workbench-${randomUUID()}`,
        confirmation: {
          acknowledged: true,
          acknowledgement: "Run the read-only live collector trace query for OTLP verification.",
        },
      }),
    },
  );
  if (accepted.status !== 202) {
    throw new Error(`workbench tool execution returned ${accepted.status}: ${await accepted.text()}`);
  }
  const executionId = (await accepted.json()).execution?.id;
  if (!executionId) throw new Error("workbench tool execution returned no execution id");
  await waitUntil(async () => {
    const response = await fetch(
      `${workbenchBaseUrl}/workbench/workspaces/default/servers/${workbenchServer.id}/executions/${executionId}`,
      { headers: workbenchHeaders },
    );
    if (!response.ok) throw new Error(`workbench execution query returned ${response.status}`);
    const execution = await response.json();
    if (["failed", "cancelled", "timed_out"].includes(execution.status)) {
      throw new Error(`workbench execution ended as ${execution.status}: ${JSON.stringify(execution.error)}`);
    }
    return execution.status === "succeeded";
  }, 15_000, "the real workbench tool execution");

  const correlated = await waitUntil(async () => {
    const response = await fetch(
      `${workbenchBaseUrl}/workbench/workspaces/default/servers/${workbenchServer.id}/executions/${executionId}/telemetry`,
      { headers: workbenchHeaders },
    );
    if (!response.ok) throw new Error(`workbench telemetry query returned ${response.status}`);
    const body = await response.json();
    const spans = (body.traces ?? []).flatMap((trace) => trace.spans ?? []);
    const clientSpan = spans.find((span) =>
      span.kind === 3 && span.name === "tools/call list_traces"
    );
    const hasServerChild = spans.some((span) =>
      span.kind === 2 &&
      span.name === "tools/call list_traces" &&
      span.parent_span_id === clientSpan?.span_id
    );
    const correlatedLogs = (body.logs ?? []).filter((log) =>
      log.event_name === "qyl.mcp.operation" &&
      [clientSpan?.span_id, ...spans.filter((span) =>
        span.kind === 2 && span.parent_span_id === clientSpan?.span_id
      ).map((span) => span.span_id)].includes(log.span_id)
    );
    if (body.traces?.length > 0
        && clientSpan
        && hasServerChild
        && correlatedLogs.length >= 2) return body;
    throw new Error(JSON.stringify({
      traceCount: body.traces?.length ?? 0,
      spans: spans.map((span) => ({ name: span.name, kind: span.kind })),
      logCount: body.logs?.length ?? 0,
      signals: body.signals,
      correlation: body.correlation,
    }));
  }, 20_000, "workbench trace evidence");
  if (correlated.self_export_suppressed !== true) {
    throw new Error("workbench telemetry read did not report self-export suppression");
  }
  const correlatedSpans = correlated.traces.flatMap((trace) => trace.spans ?? []);
  const clientToolSpan = correlatedSpans.find((span) =>
    span.kind === 3 && span.name === "tools/call list_traces"
  );
  const serverToolSpans = correlatedSpans.filter((span) =>
    span.kind === 2 &&
    span.name === "tools/call list_traces" &&
    span.parent_span_id === clientToolSpan?.span_id
  );
  const serverToolSpan = serverToolSpans[0];
  if (!clientToolSpan || serverToolSpans.length !== 1) {
    throw new Error(`native qyl.mcp server span was not parented to the workbench client span: ${JSON.stringify(
      correlatedSpans.map((span) => ({
        name: span.name,
        kind: span.kind,
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        attributes: span.attributes,
      })),
    )}`);
  }
  const requestLogs = correlated.logs.filter((log) =>
    log.event_name === "qyl.mcp.operation" &&
    [clientToolSpan.span_id, serverToolSpan.span_id].includes(log.span_id)
  );
  if (requestLogs.length !== 2) {
    throw new Error(`MCP operation logs were not correlated to both operation spans: ${JSON.stringify(requestLogs)}`);
  }
  const toolSpanAttributes = JSON.stringify([
    clientToolSpan.attributes,
    serverToolSpan.attributes,
  ]);
  if (toolSpanAttributes.includes(marker) || toolSpanAttributes.includes(secret)) {
    throw new Error("native MCP spans captured tool arguments or result content");
  }
  console.log("ok real workbench returned exact trace evidence");
  console.log("ok native server span was correlated without tool payload content");
  console.log("ok OTel operation logs carry the matching trace and span identifiers");
  await stop(workbench);
  workbench = undefined;

  if (!existsSync(mcpServerMain)) {
    throw new Error(`qyl MCP server build not found at ${mcpServerMain}; run npm run build`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerMain, "--stdio"],
    env: {
      ...getDefaultEnvironment(),
      QYL_COLLECTOR_URL: baseUrl,
      QYL_DEMO: "0",
      QYL_API_KEY: collectorApiKey,
      QYL_PROJECT: projectScope,
      QYL_MCP_NATIVE_STATE_PATH: join(temp, "stdio-native-executions.json"),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "qyl-live-contract-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(transport);
    const listed = await client.callTool({ name: "list_traces", arguments: { limit: 100 } });
    if (listed.isError) {
      throw new Error(`live list_traces returned isError: ${JSON.stringify(listed.content)}`);
    }
    const traces = listed.structuredContent?.traces;
    const matched = Array.isArray(traces)
      ? traces.find((trace) => trace?.root_span?.name?.includes(marker))
      : undefined;
    if (!matched?.trace_id) throw new Error("live list_traces did not expose the persisted smoke trace");

    const fetched = await client.callTool({
      name: "get_trace",
      arguments: { trace_id: matched.trace_id },
    });
    if (fetched.isError || fetched.structuredContent?.trace?.spans?.length !== 1) {
      throw new Error("live get_trace did not return the persisted span");
    }
    const missing = await client.callTool({
      name: "get_trace",
      arguments: { trace_id: "0".repeat(32) },
    });
    if (!missing.isError || !missing.content?.[0]?.text?.includes("trace not found")) {
      throw new Error("live collector 404 did not flow through generated Problem Details");
    }

    const inspectedEvents = await client.callTool({
      name: "inspect_workflow_events",
      arguments: { run_id: diagnosticRunId, after_sequence: "0", limit: 10 },
    });
    const diagnosticEvent = inspectedEvents.structuredContent?.page?.events?.find((event) =>
      event.kind === "content_captured" && event.content_refs?.includes(diagnosticContentRef)
    );
    if (inspectedEvents.isError || !diagnosticEvent) {
      throw new Error(`live diagnostic summary was not inspectable: ${JSON.stringify(inspectedEvents.content)}`);
    }
    const returnedSummary = diagnosticEvent.data;
    if (
      typeof returnedSummary !== "object"
      || returnedSummary === null
      || Array.isArray(returnedSummary)
      || JSON.stringify(Object.keys(returnedSummary).sort())
        !== JSON.stringify(Object.keys(diagnosticSummary).sort())
      || Object.entries(diagnosticSummary).some(([key, value]) => returnedSummary[key] !== value)
    ) {
      throw new Error(`diagnostic event leaked or changed protected snapshot fields: ${JSON.stringify(returnedSummary)}`);
    }

    const inspectedContent = await client.callTool({
      name: "inspect_workflow_events",
      arguments: {
        run_id: diagnosticRunId,
        after_sequence: inspectedEvents.structuredContent.page.next_sequence,
        content_ref: diagnosticContentRef,
      },
    });
    const returnedContent = inspectedContent.structuredContent?.content;
    if (
      inspectedContent.isError
      || returnedContent?.content_ref !== diagnosticContentRef
      || returnedContent?.content_type !== "application/json"
      || returnedContent?.encoding !== "utf8"
      || returnedContent?.content !== diagnosticContent
    ) {
      throw new Error(`protected diagnostic content did not round-trip: ${JSON.stringify(inspectedContent.content)}`);
    }
    console.log("ok content_captured summary led to explicit protected content retrieval");

    const remainingCalls = [
      ["ci_log", {}],
      ["display_traces", { trace_id: matched.trace_id }],
      ["display_mcp_dashboard", { hours: 1 }],
      ["list_sessions", { limit: 100 }],
      ["search_logs", { limit: 100 }],
      ["fetch_telemetry", { view: "traces", limit: 100 }],
    ];
    for (const [name, args] of remainingCalls) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) {
        throw new Error(`${name} returned isError: ${JSON.stringify(result.content)}`);
      }
    }
    console.log("ok generated API-key auth and Qyl schemas validate live telemetry and diagnostic workflow reads");
  } finally {
    await client.close().catch(() => {});
  }
} catch (error) {
  if (collectorOutput) console.error(collectorOutput);
  if (workbenchOutput) console.error(workbenchOutput);
  throw error;
} finally {
  if (workbench) await stop(workbench);
  await stop(collector);
  await rm(temp, { recursive: true, force: true });
}
