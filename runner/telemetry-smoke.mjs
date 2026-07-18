/**
 * End-to-end OTLP smoke test against Qyl's real collector receiver.
 *
 * The collector parses protobuf with the generated OpenTelemetry protocol
 * classes and returns 400 for undecodable payloads, so this is deliberately not
 * a repository-owned JSON/Zod echo server.
 */

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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

const apiKeyHeader = qylOpenApi.components.securitySchemes.ApiKeyAuth.name;

const here = dirname(fileURLToPath(import.meta.url));
const collectorProject = resolve(
  process.env.QYL_COLLECTOR_PROJECT ??
    join(here, "..", "..", "qyl", "services", "qyl.collector", "qyl.collector.csproj"),
);
const mcpServerMain = resolve(here, "..", "server", "dist", "main.js");
const runnerMain = resolve(here, "dist", "main.js");
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
let runnerPort;
do {
  runnerPort = await freePort();
} while (runnerPort === port);
const runnerBaseUrl = `http://127.0.0.1:${runnerPort}`;
const temp = await mkdtemp(join(tmpdir(), "qyl-mcp-otlp-"));
const collectorApiKey = `qyl-smoke-${randomUUID()}`;
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
let runner;
let runnerOutput = "";
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
  telemetry.recordSession({
    role: "client",
    transport: "http",
    startTimeMs: endTimeMs - 1_000,
    endTimeMs,
  });
  telemetry.recordSession({
    role: "server",
    transport: "http",
    startTimeMs: endTimeMs - 1_000,
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

  const expectedMetrics = new Set([
    "mcp.client.operation.duration",
    "mcp.client.session.duration",
    "mcp.server.operation.duration",
    "mcp.server.session.duration",
  ]);
  const persistedMetrics = await waitUntil(async () => {
    const response = await fetch(`${baseUrl}/api/v1/metrics?limit=1000`, {
      headers: { [apiKeyHeader]: collectorApiKey },
    });
    if (!response.ok) throw new Error(`metric query returned ${response.status}`);
    const body = await response.json();
    const names = new Set((body.items ?? []).map((item) => item?.name));
    return [...expectedMetrics].every((name) => names.has(name)) ? body : undefined;
  }, 15_000, "all four MCP duration histograms to be queryable");
  console.log("ok all four pinned MCP duration histograms were persisted");
  const persistedMetricJson = JSON.stringify(persistedMetrics);
  if (!persistedMetricJson.includes(marker) || !persistedMetricJson.includes("mcp.method.name")) {
    throw new Error("client operation histogram did not retain its pinned semantic identity");
  }
  console.log("ok MCP operation histogram retained its pinned semantic identity");

  if (!existsSync(runnerMain)) {
    throw new Error(`qyl MCP runner build not found at ${runnerMain}; run npm run build`);
  }
  const runnerEnv = {
    ...process.env,
    QYL_COLLECTOR_URL: baseUrl,
    QYL_DEMO: "0",
    QYL_MCP_TELEMETRY: "1",
    QYL_MCP_RUNNER_PORT: String(runnerPort),
    QYL_MCP_STATE_PATH: join(temp, "workbench-state.json"),
    QYL_MCP_NATIVE_STATE_PATH: join(temp, "runner-native-executions.json"),
    QYL_API_KEY: collectorApiKey,
  };
  delete runnerEnv.QYL_OTLP_ENDPOINT;
  for (const key of Object.keys(runnerEnv)) {
    if (key.startsWith("OTEL_EXPORTER_OTLP")) delete runnerEnv[key];
  }
  runner = spawn(process.execPath, [runnerMain], {
    cwd: resolve(here, ".."),
    env: runnerEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [runner.stdout, runner.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      runnerOutput = `${runnerOutput}${chunk}`.slice(-40_000);
    });
  }
  await Promise.race([
    waitUntil(async () => {
      const response = await fetch(`${runnerBaseUrl}/runner/session`);
      return response.status === 401;
    }, 30_000, "the qyl.mcp runner"),
    once(runner, "exit").then(([code, signal]) => {
      throw new Error(`runner exited ${code ?? signal}\n${runnerOutput}`);
    }),
  ]);
  const bootstrap = await fetch(`${runnerBaseUrl}/runner/session`, { method: "POST" });
  if (!bootstrap.ok) throw new Error(`runner session bootstrap returned ${bootstrap.status}`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("runner session bootstrap returned no cookie");
  const runnerHeaders = { cookie, "content-type": "application/json" };
  const serversResponse = await fetch(
    `${runnerBaseUrl}/runner/workspaces/default/servers`,
    { headers: runnerHeaders },
  );
  if (!serversResponse.ok) throw new Error(`runner server list returned ${serversResponse.status}`);
  const servers = await serversResponse.json();
  const workbenchServer = servers.servers?.find((item) => item?.name === "qyl-telemetry");
  if (!workbenchServer?.id || workbenchServer.connection?.status !== "connected") {
    throw new Error("runner did not auto-connect its in-process qyl-telemetry server");
  }
  const accepted = await fetch(
    `${runnerBaseUrl}/runner/workspaces/default/servers/${workbenchServer.id}/executions`,
    {
      method: "POST",
      headers: runnerHeaders,
      body: JSON.stringify({
        toolName: "list_traces",
        arguments: { limit: 100 },
        timeoutMs: 10_000,
        idempotencyKey: `otlp-runner-${randomUUID()}`,
        confirmation: {
          acknowledged: true,
          acknowledgement: "Run the read-only live collector trace query for OTLP verification.",
        },
      }),
    },
  );
  if (accepted.status !== 202) {
    throw new Error(`runner tool execution returned ${accepted.status}: ${await accepted.text()}`);
  }
  const executionId = (await accepted.json()).execution?.id;
  if (!executionId) throw new Error("runner tool execution returned no execution id");
  await waitUntil(async () => {
    const response = await fetch(
      `${runnerBaseUrl}/runner/workspaces/default/servers/${workbenchServer.id}/executions/${executionId}`,
      { headers: runnerHeaders },
    );
    if (!response.ok) throw new Error(`runner execution query returned ${response.status}`);
    const execution = await response.json();
    if (["failed", "cancelled", "timed_out"].includes(execution.status)) {
      throw new Error(`runner execution ended as ${execution.status}: ${JSON.stringify(execution.error)}`);
    }
    return execution.status === "succeeded";
  }, 15_000, "the real workbench tool execution");

  const correlated = await waitUntil(async () => {
    const response = await fetch(
      `${runnerBaseUrl}/runner/workspaces/default/servers/${workbenchServer.id}/executions/${executionId}/telemetry`,
      { headers: runnerHeaders },
    );
    if (!response.ok) throw new Error(`runner telemetry query returned ${response.status}`);
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
    const metricNames = new Set((body.metrics ?? []).map((metric) => metric.name));
    if (body.traces?.length > 0
        && clientSpan
        && hasServerChild
        && metricNames.has("mcp.client.operation.duration")
        && body.signals?.metrics?.status === "partial") return body;
    throw new Error(JSON.stringify({
      traceCount: body.traces?.length ?? 0,
      spans: spans.map((span) => ({ name: span.name, kind: span.kind })),
      logCount: body.logs?.length ?? 0,
      metricCount: body.metrics?.length ?? 0,
      metricNames: [...metricNames],
      signals: body.signals,
      correlation: body.correlation,
    }));
  }, 20_000, "workbench traces and explicitly approximate MCP metrics");
  if (correlated.selfExportSuppressed !== true) {
    throw new Error("workbench telemetry read did not report self-export suppression");
  }
  if (!correlated.signals.metrics.unavailableReason?.includes("does not export exemplars")) {
    throw new Error("workbench telemetry did not label time-window metric evidence as approximate");
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
    throw new Error(`native qyl.mcp server span was not parented to the runner client span: ${JSON.stringify(
      correlatedSpans.map((span) => ({
        name: span.name,
        kind: span.kind,
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        attributes: span.attributes,
      })),
    )}`);
  }
  const toolSpanAttributes = JSON.stringify([
    clientToolSpan.attributes,
    serverToolSpan.attributes,
  ]);
  if (toolSpanAttributes.includes(marker) || toolSpanAttributes.includes(secret)) {
    throw new Error("native MCP spans captured tool arguments or result content");
  }
  const nativeServerMetric = await waitUntil(async () => {
    const response = await fetch(`${baseUrl}/api/v1/metrics?limit=1000`, {
      headers: { [apiKeyHeader]: collectorApiKey },
    });
    if (!response.ok) throw new Error(`metric query returned ${response.status}`);
    const body = await response.json();
    return (body.items ?? []).find((metric) =>
      metric.name === "mcp.server.operation.duration" &&
      metric.attributes?.some((attribute) =>
        attribute?.key === "gen_ai.tool.name" && attribute.value === "list_traces"
      )
    );
  }, 15_000, "the native server operation duration metric");
  if (JSON.stringify(nativeServerMetric.attributes).includes(marker) ||
      JSON.stringify(nativeServerMetric.attributes).includes(secret)) {
    throw new Error("native MCP duration metric captured tool arguments or result content");
  }
  console.log("ok real runner returned exact trace evidence and labelled semantic/time-window metric evidence as partial");
  console.log("ok native server span and duration metric were correlated without tool payload content");
  await stop(runner);
  runner = undefined;

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
      QYL_MCP_NATIVE_STATE_PATH: join(temp, "stdio-native-executions.json"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "qyl-live-contract-smoke", version: "1.0.0" });
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
    console.log("ok generated API-key auth and Qyl schemas validate all eight tools against the live collector");
  } finally {
    await client.close().catch(() => {});
  }
} catch (error) {
  if (collectorOutput) console.error(collectorOutput);
  if (runnerOutput) console.error(runnerOutput);
  throw error;
} finally {
  if (runner) await stop(runner);
  await stop(collector);
  await rm(temp, { recursive: true, force: true });
}
