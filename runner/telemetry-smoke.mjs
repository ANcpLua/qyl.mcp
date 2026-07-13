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
  "dotnet",
  ["run", "--no-launch-profile", "--project", collectorProject],
  { cwd: dirname(collectorProject), env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
);
let collectorOutput = "";
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
    QYL_OTLP_ENDPOINT: baseUrl,
    QYL_MCP_TELEMETRY: "1",
    QYL_API_KEY: collectorApiKey,
  });
  const endTimeMs = Date.now();
  telemetry.recordCall({
    method: "tools/call",
    serverName: "qyl-otlp-smoke",
    toolName: marker,
    resourceUri: `https://user:${secret}@example.invalid/resource?token=${secret}#${secret}`,
    transport: "http",
    startTimeMs: endTimeMs - 25,
    endTimeMs,
    failed: false,
    // Runtime extras emulate a JavaScript caller attempting to pass content.
    arguments: { prompt: secret },
    result: { content: secret },
    error: secret,
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
    console.log("ok generated API-key auth and Qyl schemas validate all seven tools against the live collector");
  } finally {
    await client.close().catch(() => {});
  }
} catch (error) {
  if (collectorOutput) console.error(collectorOutput);
  throw error;
} finally {
  await stop(collector);
  await rm(temp, { recursive: true, force: true });
}
