import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (port === 0) throw new Error("failed to reserve a runner smoke port");
  return port;
}

const runnerPort = await freePort();
const baseUrl = `http://127.0.0.1:${runnerPort}`;
const temp = await mkdtemp(join(tmpdir(), "qyl-mcp-smoke-"));
const child = spawn(process.execPath, ["dist/main.js"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    QYL_DEMO: "1",
    QYL_MCP_TELEMETRY: "0",
    QYL_MCP_RUNNER_PORT: String(runnerPort),
    QYL_MCP_STATE_PATH: join(temp, "workbench.json"),
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

async function waitForResource(lifecycle, cookie, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runner exited early\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/runner/resources`, { headers: { cookie } });
      if (response.ok) {
        const resources = await response.json();
        const resource = resources.find((entry) => entry.name === "qyl-telemetry");
        if (resource?.lifecycle === lifecycle) return resource;
      }
    } catch {
      // Startup has not bound the loopback API yet.
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${lifecycle}\n${output}`);
}

async function bootstrapSession(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runner exited early\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/runner/session`, { method: "POST" });
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
        port: runnerPort,
        path: "/runner/resources",
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

function publishedSseEvent(path) {
  return qylOpenApi.paths[path].get.responses["200"].content["text/event-stream"]
    .itemSchema.oneOf[0].properties.event.const;
}

async function firstSseFrame(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  assert(response.ok && response.body, `${path} did not open an SSE response`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let frame = "";
  while (!frame.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    frame += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return frame;
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
  const ready = await waitForResource("ready", cookie);
  check("runner publishes lowercase lifecycle", ready.lifecycle === "ready");
  check("absent endpoint is omitted", !("endpoint" in ready));
  check("absent allocatedPort is omitted", !("allocatedPort" in ready));
  check("MCP handshake facts are present", ready.serverIdentity?.name === "qyl.mcp" && ready.toolCount === 7);

  const dashboard = await fetch(`${baseUrl}/`);
  const dashboardHtml = await dashboard.text();
  check("runner serves the built dashboard", dashboard.ok && dashboardHtml.includes('id="root"'));

  const health = await fetch(`${baseUrl}/health`);
  check("no fabricated runner health endpoint", health.status === 404);

  const logs = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/logs`, {
    headers: { cookie },
  });
  check("real log snapshot endpoint answers", logs.ok && Array.isArray(await logs.json()));

  const resourceFrame = await firstSseFrame("/runner/resources/stream", cookie);
  const resourceEvent = publishedSseEvent("/runner/resources/stream");
  const logEvent = publishedSseEvent("/runner/resources/{resource}/logs/stream");
  check(
    "runner SSE emits the published resource/log event name",
    resourceEvent === logEvent && resourceFrame.startsWith(`event: ${resourceEvent}\n`),
  );

  check(
    "workbench session is authenticated without exposing its token",
    bootstrap.ok && cookie?.startsWith("qyl-mcp-session=") && !("token" in session),
  );
  const unauthenticatedWorkspaces = await fetch(`${baseUrl}/runner/workspaces`);
  check("private workbench routes reject missing sessions", unauthenticatedWorkspaces.status === 401);

  const serversResponse = await fetch(`${baseUrl}/runner/workspaces/default/servers`, {
    headers: { cookie },
  });
  const servers = await serversResponse.json();
  const workbenchServer = servers.servers?.find((entry) => entry.name === "qyl-telemetry");
  check(
    "workbench restores and connects the built-in MCP server",
    serversResponse.ok && workbenchServer?.connection?.status === "connected",
  );
  const serverId = workbenchServer.id;
  const discoveryResponse = await fetch(
    `${baseUrl}/runner/workspaces/default/servers/${serverId}/discovery`,
    { headers: { cookie } },
  );
  const discovery = await discoveryResponse.json();
  check(
    "real SDK discovery returns seven contract tools and server surfaces",
    discoveryResponse.ok && discovery.tools?.count === 7 && Array.isArray(discovery.prompts?.items),
  );

  const executionUrl = `${baseUrl}/runner/workspaces/default/servers/${serverId}/executions`;
  const invocation = {
    toolName: "list_traces",
    arguments: { limit: 1 },
    timeoutMs: 5_000,
    idempotencyKey: "smoke-list-traces-0001",
  };
  const unconfirmedCall = await fetch(executionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(invocation),
  });
  check(
    "tools without complete safety annotations require confirmation",
    unconfirmedCall.status === 409,
  );
  const call = await fetch(executionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      ...invocation,
      confirmation: {
        acknowledged: true,
        acknowledgement: "Approved for the local smoke invocation.",
      },
    }),
  });
  const accepted = await call.json();
  if (call.status !== 202 || !accepted.execution?.id) {
    throw new Error(`workbench invocation was not accepted (${call.status}): ${JSON.stringify(accepted)}`);
  }
  const executionPath = `/runner/workspaces/default/servers/${serverId}/executions/${accepted.execution?.id}`;
  const callResult = await waitForExecution(executionPath, cookie);
  check(
    "schema-aware workbench invocation retains real execution evidence",
    call.status === 202 && callResult.status === "succeeded" && callResult.result?.structuredContent?.traces?.length === 1,
  );

  const invalid = await fetch(`${baseUrl}/runner/workspaces/default/servers/${serverId}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      toolName: "list_traces",
      arguments: "not-an-object",
      timeoutMs: 5_000,
      idempotencyKey: "smoke-invalid-args-0001",
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

  const malformed = await fetch(`${baseUrl}/runner/workspaces/default/servers/${serverId}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{",
  });
  check(
    "malformed JSON returns generated validation Problem Details",
    malformed.status === 400 &&
      malformed.headers.get("content-type")?.startsWith("application/problem+json"),
  );

  const rebound = await getWithHost(`attacker.example:${runnerPort}`);
  check("rebound Host is rejected", rebound.status === 403);
  const crossOrigin = await fetch(`${baseUrl}/runner/resources`, {
    headers: { origin: "https://attacker.example" },
  });
  check("untrusted browser Origin is rejected", crossOrigin.status === 403);
  const stopped = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/stop`, {
    method: "POST",
    headers: { cookie },
  });
  check("stop acceptance is an empty 202", stopped.status === 202 && (await stopped.text()) === "");
  await waitForResource("stopped", cookie);
  const duplicateStop = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/stop`, {
    method: "POST",
    headers: { cookie },
  });
  check("completed stop is reported as conflict", duplicateStop.status === 409);

  const restarted = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/restart`, {
    method: "POST",
    headers: { cookie },
  });
  check("restart acceptance is an empty 202", restarted.status === 202 && (await restarted.text()) === "");
  await waitForResource("ready", cookie);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
  await rm(temp, { recursive: true, force: true });
}
