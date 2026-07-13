import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };

const baseUrl = "http://127.0.0.1:18888";
const child = spawn(process.execPath, ["dist/main.js"], {
  cwd: import.meta.dirname,
  env: { ...process.env, QYL_DEMO: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

function check(name, condition) {
  assert(condition, name);
  console.log(`ok ${name}`);
}

async function waitForResource(lifecycle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runner exited early\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/runner/resources`);
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

function getWithHost(host) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: 18888,
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

async function firstSseFrame(path) {
  const response = await fetch(`${baseUrl}${path}`);
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

try {
  const ready = await waitForResource("ready");
  check("runner publishes lowercase lifecycle", ready.lifecycle === "ready");
  check("absent endpoint is omitted", !("endpoint" in ready));
  check("absent allocatedPort is omitted", !("allocatedPort" in ready));
  check("MCP handshake facts are present", ready.serverInfo?.name === "qyl.mcp" && ready.toolCount === 7);

  const dashboard = await fetch(`${baseUrl}/`);
  const dashboardHtml = await dashboard.text();
  check("runner serves the built dashboard", dashboard.ok && dashboardHtml.includes('id="root"'));

  const sandbox = await fetch("http://127.0.0.1:18889/sandbox.html");
  const sandboxBody = await sandbox.text();
  check(
    "sandbox is served separately with a restrictive CSP header",
    sandbox.ok &&
      sandboxBody.includes("sandbox") &&
      sandbox.headers.get("content-security-policy")?.includes("connect-src 'self'") &&
      sandbox.headers.get("content-security-policy")?.includes("frame-src 'none'") &&
      sandbox.headers.get("content-security-policy")?.includes("base-uri 'self'"),
  );

  const health = await fetch(`${baseUrl}/health`);
  check("no fabricated runner health endpoint", health.status === 404);

  const logs = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/logs`);
  check("real log snapshot endpoint answers", logs.ok && Array.isArray(await logs.json()));

  const resourceFrame = await firstSseFrame("/runner/resources/stream");
  const resourceEvent = publishedSseEvent("/runner/resources/stream");
  const logEvent = publishedSseEvent("/runner/resources/{resource}/logs/stream");
  check(
    "runner SSE emits the published resource/log event name",
    resourceEvent === logEvent && resourceFrame.startsWith(`event: ${resourceEvent}\n`),
  );

  const tools = await fetch(`${baseUrl}/runner/mcp/qyl-telemetry/tools`).then((response) => response.json());
  check("runner MCP facade returns seven contract tools", tools.tools?.length === 7);

  const call = await fetch(`${baseUrl}/runner/mcp/qyl-telemetry/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "list_traces", arguments: { limit: 1 } }),
  });
  const callResult = await call.json();
  check(
    "runner MCP call is a validated product projection",
    call.ok && callResult.isError === false && callResult.structuredContent?.traces?.length === 1,
  );

  const invalid = await fetch(`${baseUrl}/runner/mcp/qyl-telemetry/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "list_traces", arguments: "not-an-object" }),
  });
  const problem = await invalid.json();
  check(
    "invalid facade request returns generated Problem Details",
    invalid.status === 400 &&
      invalid.headers.get("content-type")?.startsWith("application/problem+json") &&
      problem.title === "Validation Failed" &&
      Array.isArray(problem.errors),
  );

  const malformed = await fetch(`${baseUrl}/runner/mcp/qyl-telemetry/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  check(
    "malformed JSON returns generated validation Problem Details",
    malformed.status === 400 &&
      malformed.headers.get("content-type")?.startsWith("application/problem+json"),
  );

  const rebound = await getWithHost("attacker.example:18888");
  check("rebound Host is rejected", rebound.status === 403);
  const crossOrigin = await fetch(`${baseUrl}/runner/resources`, {
    headers: { origin: "https://attacker.example" },
  });
  check("untrusted browser Origin is rejected", crossOrigin.status === 403);
  const invalidCsp = await fetch(
    `http://127.0.0.1:18889/sandbox.html?csp=${encodeURIComponent(
      JSON.stringify({ connectDomains: ["https://example.invalid; img-src *"] }),
    )}`,
  );
  check(
    "CSP directive injection is rejected as generated Problem Details",
    invalidCsp.status === 400 &&
      invalidCsp.headers.get("content-type")?.startsWith("application/problem+json"),
  );

  const stopped = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/stop`, { method: "POST" });
  check("stop acceptance is an empty 202", stopped.status === 202 && (await stopped.text()) === "");
  await waitForResource("stopped");
  const duplicateStop = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/stop`, { method: "POST" });
  check("completed stop is reported as conflict", duplicateStop.status === 409);

  const restarted = await fetch(`${baseUrl}/runner/resources/qyl-telemetry/restart`, { method: "POST" });
  check("restart acceptance is an empty 202", restarted.status === 202 && (await restarted.text()) === "");
  await waitForResource("ready");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}
