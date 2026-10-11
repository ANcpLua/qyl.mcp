/**
 * End-to-end OTLP smoke test against Qyl's real collector receiver.
 *
 * The collector parses protobuf with the generated OpenTelemetry protocol
 * classes and returns 400 for undecodable payloads, so this is deliberately not
 * a repository-owned JSON/Zod echo server.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  // Keys are bound to projects since ANcpLua/qyl#626.
  QYL_OTLP_PROJECT_KEYS: JSON.stringify({ [projectScope]: [{ key: collectorApiKey, roles: ["ingest", "read"] }] }),
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
    executionId: "wire-execution",
    evaluationRunId: "wire-evaluation",
    testCaseId: "wire-test",
    protocolVersion: "2026-07-28",
    jsonRpcProtocolVersion: "2.1",
    jsonRpcRequestId: 7,
    networkProtocolVersion: "2",
    peerAddress: "mcp.example.test",
    peerPort: 443,
    rpcResponseStatusCode: "-32602",
    errorType: "-32602",
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

  // The SDK has been shut down and flushed. Wait for ingestion, then check the
  // literal names and units persisted by the real Collector, independently of
  // the generated constants used by the producer.
  const metricNames = ["mcp.client.operation.duration", "mcp.server.operation.duration"];
  const metricsBody = await waitUntil(async () => {
    const response = await fetch(`${baseUrl}/api/v1/metrics?limit=100`, {
      headers: { [apiKeyHeader]: collectorApiKey },
    });
    if (!response.ok) throw new Error(`metrics catalog returned ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.items) || typeof body.has_more !== "boolean") {
      throw new Error("metrics catalog is not the published cursor page");
    }
    return metricNames.every((name) => body.items.some((item) => item.name === name))
      ? body : undefined;
  }, 15_000, "both exported MCP duration metrics");
  for (const name of metricNames) {
    const descriptor = metricsBody.items.find((item) => item.name === name);
    if (descriptor.unit !== "s" || descriptor.kind !== "histogram") {
      throw new Error(`incorrect persisted MCP metric: ${JSON.stringify(descriptor)}`);
    }
    const query = new URLSearchParams({
      start_time: new Date(endTimeMs - 60_000).toISOString(),
      end_time: new Date(endTimeMs + 60_000).toISOString(),
      aggregation: "sum",
      step_ms: "120000",
    });
    const response = await fetch(`${baseUrl}/api/v1/metrics/${name}/query?${query}`, {
      headers: { [apiKeyHeader]: collectorApiKey },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const values = result.series.flatMap((series) => series.buckets)
      .filter((bucket) => bucket.value !== null).map((bucket) => bucket.value);
    assert.deepEqual(values, [name === "mcp.client.operation.duration" ? 0.025 : 0.015]);
  }
  console.log("ok both MCP operation duration histograms persist with literal names and seconds");
  if (!existsSync(workbenchMain)) {
    throw new Error(`qyl MCP workbench build not found at ${workbenchMain}; run bun run build`);
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
    throw new Error(`qyl MCP server build not found at ${mcpServerMain}; run bun run --cwd ../server build`);
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
    const wireSpan = fetched.structuredContent.trace.spans[0];
    const wireAttributes = Object.fromEntries(wireSpan.attributes.map(({ key, value }) => [key, value]));
    assert.deepEqual(wireAttributes, {
      // The Collector promotes the resource service name into queried attributes.
      "service.name": "qyl.mcp",
      "mcp.method.name": "tools/call",
      "mcp.protocol.version": "2026-07-28",
      "jsonrpc.protocol.version": "2.1",
      "jsonrpc.request.id": "7",
      "rpc.response.status_code": "-32602",
      "error.type": "-32602",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": marker,
      "network.transport": "tcp",
      "network.protocol.name": "http",
      "network.protocol.version": "2",
      "server.address": "mcp.example.test",
      "server.port": { type: "int", value: "443" },
      "qyl.mcp.server.id": "qyl-otlp-smoke",
      "qyl.mcp.execution.id": "wire-execution",
      "qyl.mcp.evaluation_run.id": "wire-evaluation",
      "qyl.mcp.test_case.id": "wire-test",
    });
    assert.equal(BigInt(wireSpan.end_time_unix_nano) - BigInt(wireSpan.start_time_unix_nano), 25_000_000n);
    console.log("ok persisted span attributes, enum values and duration match the literal wire fixture");
    const missing = await client.callTool({
      name: "get_trace",
      arguments: { trace_id: "0".repeat(32) },
    });
    if (!missing.isError || !missing.content?.[0]?.text?.includes("trace not found")) {
      throw new Error("live collector 404 did not flow through generated Problem Details");
    }

    // Every distractor differs in one filter, so silently ignoring any of the
    // published query names produces more than one row through the real MCP tool.
    const logMarker = `${marker}_log_filter`;
    const logService = `${logMarker}_service`;
    const logBody = `${logMarker} matching error`;
    const logTime = BigInt(Date.now()) * 1_000_000n;
    const matchingLog = {
      severityNumber: 17,
      severityText: "ERROR",
      traceId: matched.trace_id,
      body: { stringValue: logBody },
    };
    const logFixtures = [
      { service: logService, record: matchingLog },
      { service: `${logService}_other`, record: matchingLog },
      { service: logService, record: { ...matchingLog, severityNumber: 9, severityText: "INFO" } },
      { service: logService, record: { ...matchingLog, traceId: randomUUID().replaceAll("-", "") } },
      { service: logService, record: { ...matchingLog, body: { stringValue: `${logMarker} unrelated body` } } },
    ];
    const logExport = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: { [apiKeyHeader]: collectorApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: logFixtures.map(({ service, record }, index) => ({
          resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
          scopeLogs: [{
            scope: { name: "qyl-mcp-filter-smoke" },
            logRecords: [{
              ...record,
              timeUnixNano: String(logTime + BigInt(index)),
              spanId: randomUUID().replaceAll("-", "").slice(0, 16),
            }],
          }],
        })),
      }),
    });
    if (!logExport.ok) throw new Error(`log filter fixture export returned ${logExport.status}`);
    await waitUntil(async () => {
      const response = await fetch(
        `${baseUrl}/api/v1/logs?${new URLSearchParams({ query: logMarker, limit: "100" })}`,
        { headers: { [apiKeyHeader]: collectorApiKey } },
      );
      if (!response.ok) throw new Error(`log fixture query returned ${response.status}`);
      const body = await response.json();
      if (body.items?.length !== logFixtures.length) {
        throw new Error(`expected ${logFixtures.length} log fixtures, found ${body.items?.length}`);
      }
      return true;
    }, 15_000, "all log filter fixtures to be persisted");

    const logFilters = {
      service_name: logService,
      severity_min: 17,
      trace_id: matched.trace_id,
      query: logBody,
      limit: 20,
    };
    const filteredLogs = await client.callTool({ name: "search_logs", arguments: logFilters });
    const logs = filteredLogs.structuredContent?.logs;
    if (filteredLogs.isError || filteredLogs.structuredContent?.mode !== "live"
        || !Array.isArray(logs) || logs.length !== 1
        || logs[0].resource?.service_name !== logService
        || logs[0].severity_number !== 17 || logs[0].trace_id !== matched.trace_id
        || logs[0].body !== logBody) {
      throw new Error(`live search_logs did not honor its combined filters: ${JSON.stringify(filteredLogs)}`);
    }
    const noLogs = await client.callTool({
      name: "search_logs",
      arguments: { ...logFilters, service_name: `${logService}_missing` },
    });
    if (noLogs.isError || noLogs.structuredContent?.logs?.length !== 0) {
      throw new Error(`live search_logs returned logs for a missing service: ${JSON.stringify(noLogs)}`);
    }
    const limitedLogs = await client.callTool({
      name: "search_logs",
      arguments: { query: logMarker, limit: 2 },
    });
    if (limitedLogs.isError || limitedLogs.structuredContent?.logs?.length !== 2) {
      throw new Error(`live search_logs did not honor its limit: ${JSON.stringify(limitedLogs)}`);
    }
    console.log("ok live MCP log filters exclude unrelated services, severities, traces and bodies");
    console.log("ok live MCP log searches preserve empty results and the requested limit");

    /** @type {ReadonlyArray<readonly [string, Record<string, unknown>]>} */
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
    console.log("ok generated API-key auth and Qyl schemas validate live telemetry reads");
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
