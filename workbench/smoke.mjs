import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request, createServer as createHttpServer } from "node:http";
import { CONTRACT_REVISION } from "@ancplua/qyl-api-schema/types";
import { getTelemetryFixture } from "../server/src/telemetry-fixtures.test-helper.ts";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (port === 0) throw new Error("failed to reserve a workbench smoke port");
  return port;
}

const workbenchPort = await freePort();
const baseUrl = `http://127.0.0.1:${workbenchPort}`;
const temp = await mkdtemp(join(tmpdir(), "qyl-mcp-smoke-"));
// Exercise the real workbench and SDK against a typed local transport fixture.
// The real collector query behavior is covered by the seeded answer-key suite.
const { spans: _spans, ...trace } = getTelemetryFixture().traces[0];
void _spans;
const fixtureCollector = createHttpServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ contract_revision: CONTRACT_REVISION }));
    return;
  }
  if (request.url !== "/api/v1/analysis/list_traces") {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  const now = new Date().toISOString();
  response.end(JSON.stringify({ mode: "live", has_more: false,
    window: { start_time: new Date(Date.now() - 3_600_000).toISOString(), end_time: now },
    coverage: { examined: 1, matched: 1, returned: 1, truncated: false, scan_complete: true, as_of: now },
    traces: [{ ...trace, root_error: false, contained_error: false, failure_ids: [], annotation_labels: [] }],
  }));
});
await new Promise(resolve => fixtureCollector.listen(0, "127.0.0.1", resolve));
const child = spawn(process.execPath, ["dist/main.js"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    QYL_COLLECTOR_URL: `http://127.0.0.1:${fixtureCollector.address().port}`,
    QYL_MCP_TELEMETRY: "0",
    QYL_MCP_WORKBENCH_PORT: String(workbenchPort),
    QYL_MCP_STATE_PATH: join(temp, "workbench.json"),
    QYL_MCP_NATIVE_STATE_PATH: join(temp, "native-executions.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

function check(name, condition) {
  assert(condition, name);
  console.log(`ok ${name}`);
}

async function waitForServer(status, cookie, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`workbench exited early\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/workbench/workspaces/default/servers`, { headers: { cookie } });
      if (response.ok) {
        const payload = await response.json();
        const server = payload.servers?.find((entry) => entry.name === "qyl-telemetry");
        if (server?.connection?.status === status) return server;
      }
    } catch {
      // Startup has not bound the loopback API yet.
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${status}\n${output}`);
}

async function bootstrapSession(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`workbench exited early\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/workbench/session`, { method: "POST" });
      if (response.ok) {
        const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
        if (!cookie) throw new Error("session bootstrap omitted Set-Cookie");
        return { response, cookie, session: await response.json() };
      }
    } catch {
      // Startup has not bound the loopback API yet.
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for session bootstrap\n${output}`);
}

function getWithHost(host) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: workbenchPort,
        path: "/workbench/session",
        headers: { host },
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function waitForExecution(path, cookie, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    if (!response.ok) throw new Error(`execution lookup returned ${response.status}`);
    const execution = await response.json();
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(execution.status)) {
      return execution;
    }
    await delay(50);
  }
  throw new Error("timed out waiting for workbench execution");
}

try {
  const { response: bootstrap, cookie, session } = await bootstrapSession();
  const workbenchServer = await waitForServer("connected", cookie);
  check("workbench connects its built-in MCP server", workbenchServer.connection.status === "connected");

  const dashboard = await fetch(`${baseUrl}/`);
  const dashboardHtml = await dashboard.text();
  check("workbench serves the built dashboard", dashboard.ok && dashboardHtml.includes('id="root"'));

  const health = await fetch(`${baseUrl}/health`);
  check("no fabricated workbench health endpoint", health.status === 404);

  check(
    "workbench session is authenticated without exposing its token",
    bootstrap.ok && cookie?.startsWith("qyl-workbench-session=") && !("token" in session),
  );
  const unauthenticatedWorkspaces = await fetch(`${baseUrl}/workbench/workspaces`);
  check("private workbench routes reject missing sessions", unauthenticatedWorkspaces.status === 401);

  const serversResponse = await fetch(`${baseUrl}/workbench/workspaces/default/servers`, {
    headers: { cookie },
  });
  const servers = await serversResponse.json();
  const listedServer = servers.servers?.find((entry) => entry.name === "qyl-telemetry");
  check(
    "workbench restores and connects the built-in MCP server",
    serversResponse.ok && listedServer?.connection?.status === "connected",
  );
  const serverId = listedServer.id;
  const discoveryResponse = await fetch(
    `${baseUrl}/workbench/workspaces/default/servers/${serverId}/discovery`,
    { headers: { cookie } },
  );
  const discovery = await discoveryResponse.json();
  check(
    "real SDK discovery returns32 tools and server surfaces",
    discoveryResponse.ok && discovery.tools?.count === 32 && Array.isArray(discovery.prompts?.items),
  );
  const writeTools = new Set(["create_annotation", "update_annotation", "create_saved_query", "update_saved_query", "delete", "update_failure_status"]);
  check(
    "all qyl inspection tools publish complete read-only safety annotations",
    discovery.tools?.items
      ?.filter((tool) => !writeTools.has(tool.name))
      .every((tool) =>
        tool.annotations?.readOnlyHint === true
        && tool.annotations?.destructiveHint === false
        && tool.annotations?.idempotentHint === true
        && tool.annotations?.openWorldHint === false),
  );
  check(
    "the six qyl write tools are not read-only, and update and delete are destructive",
    discovery.tools?.items
      ?.filter((tool) => writeTools.has(tool.name))
      .every((tool) =>
        tool.annotations?.readOnlyHint === false
        && tool.annotations?.destructiveHint === !tool.name.startsWith("create_")
        && tool.annotations?.openWorldHint === false)
      && discovery.tools?.items?.filter((tool) => writeTools.has(tool.name)).length === 6,
  );

  const executionUrl = `${baseUrl}/workbench/workspaces/default/servers/${serverId}/executions`;
  const invocation = {
    tool_name: "list_traces",
    arguments: { limit: 1 },
    timeout_ms: 5_000,
    idempotency_key: "smoke-list-traces-0001",
  };
  const call = await fetch(executionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(invocation),
  });
  const accepted = await call.json();
  check("explicitly read-only tools run without synthesized confirmation", call.status === 202);
  if (call.status !== 202 || !accepted.execution?.id) {
    throw new Error(`workbench invocation was not accepted (${call.status}): ${JSON.stringify(accepted)}`);
  }
  const executionPath = `/workbench/workspaces/default/servers/${serverId}/executions/${accepted.execution?.id}`;
  const callResult = await waitForExecution(executionPath, cookie);
  check(
    "schema-aware workbench invocation retains real execution evidence",
    call.status === 202 && callResult.status === "succeeded" && callResult.result?.structuredContent?.traces?.length === 1,
  );
  const nativeState = JSON.parse(
    await readFile(join(temp, "native-executions.json"), "utf8"),
  );
  const nativeCall = nativeState.executions?.find(
    (execution) => execution.toolName === "list_traces",
  );
  check(
    "in-process tools/call recording is native and automatic",
    nativeCall?.status === "succeeded" &&
      nativeCall.durationMs >= 0 &&
      Object.keys(nativeCall).every((key) => [
        "id", "toolName", "status", "createdAt", "startedAt", "completedAt", "durationMs", "errorType",
      ].includes(key)),
  );

  const telemetryResponse = await fetch(`${baseUrl}${executionPath}/telemetry`, {
    headers: { cookie },
  });
  const telemetry = await telemetryResponse.json();
  const signalAvailability = Object.values(telemetry.signals ?? {});
  check(
    "disabled MCP telemetry is explicit and does not fabricate evidence",
    telemetryResponse.ok
      && signalAvailability.length === 4
      && !("metrics" in (telemetry.signals ?? {}))
      && signalAvailability.every((signal) =>
        signal.status === "unavailable"
        && signal.unavailable_reason?.includes("QYL_MCP_TELEMETRY=0"))
      && telemetry.correlation?.trace_ids?.length === 0
      && telemetry.correlation?.span_ids?.length === 0
      && telemetry.self_export_suppressed === true,
  );

  const invalid = await fetch(`${baseUrl}/workbench/workspaces/default/servers/${serverId}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      tool_name: "list_traces",
      arguments: "not-an-object",
      timeout_ms: 5_000,
      idempotency_key: "smoke-invalid-args-0001",
    }),
  });
  const problem = await invalid.json();
  check(
    "invalid tool arguments return generated Problem Details",
    invalid.status === 400 &&
      invalid.headers.get("content-type")?.startsWith("application/problem+json") &&
      problem.title === "Validation Failed" &&
      Array.isArray(problem.errors),
  );

  const malformed = await fetch(`${baseUrl}/workbench/workspaces/default/servers/${serverId}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{",
  });
  check(
    "malformed JSON returns generated validation Problem Details",
    malformed.status === 400 &&
      malformed.headers.get("content-type")?.startsWith("application/problem+json"),
  );

  const rebound = await getWithHost(`attacker.example:${workbenchPort}`);
  check("rebound Host is rejected", rebound.status === 403);
  const crossOrigin = await fetch(`${baseUrl}/workbench/workspaces`, {
    headers: { origin: "https://attacker.example" },
  });
  check("untrusted browser Origin is rejected", crossOrigin.status === 403);
  const disconnected = await fetch(`${baseUrl}/workbench/workspaces/default/servers/${serverId}/disconnect`, {
    method: "POST",
    headers: { cookie },
  });
  check("workbench disconnects the built-in MCP server", disconnected.status === 202);
  await waitForServer("disconnected", cookie);
  const reconnected = await fetch(`${baseUrl}/workbench/workspaces/default/servers/${serverId}/reconnect`, {
    method: "POST",
    headers: { cookie },
  });
  check("workbench reconnects the built-in MCP server", reconnected.status === 202);
  await waitForServer("connected", cookie);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
  await new Promise(resolve => fixtureCollector.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
