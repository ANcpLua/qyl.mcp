/**
 * Project isolation through SDK v2 HTTP handling and a real Collector/DuckDB.
 * Uses local test principals at the OAuth-verifier seam, never Auth0 credentials.
 * Starts its own Collector with two random project keys and an ephemeral database.
 * Run after build; QYL_COLLECTOR_PROJECT selects the Collector source checkout.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createResourceAuthorization } from "./dist/authorization.js";
import { API_KEY_HEADER, PROJECT_HEADER } from "./dist/contract-headers.js";
import { EventsRuntime, createEventStore } from "./dist/events.js";
import { QYL_MCP_RESOURCE, QYL_MCP_SCOPE } from "./dist/oauth.js";
import { createServer } from "./dist/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectFile = resolve(process.env.QYL_COLLECTOR_PROJECT ??
  join(here, "../../qyl/services/qyl.collector/qyl.collector.csproj"));
assert(existsSync(projectFile), "set QYL_COLLECTOR_PROJECT to a real Collector checkout");
const executable = resolve(dirname(projectFile), "../../artifacts/bin/qyl.collector/release/qyl.collector");
const temp = await mkdtemp(join(tmpdir(), "qyl-project-smoke-"));
const fixtures = ["owner", "reviewer"].map((project) => ({
  project, marker: `qyl_scope_${project}`, subject: `auth0|local-smoke-${project}`,
  apiKey: randomUUID(), token: randomUUID(), traceId: randomBytes(16).toString("hex"),
}));
const portProbe = createNetServer().listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolveClose) => portProbe.close(resolveClose));
const baseUrl = `http://127.0.0.1:${port}`;
const collectorEnv = { ...process.env };
for (const key of Object.keys(collectorEnv)) {
  if (key.startsWith("OTEL_EXPORTER_OTLP")) delete collectorEnv[key];
}
Object.assign(collectorEnv, {
  DOTNET_ENVIRONMENT: "Development", QYL_BIND_ADDRESS: "127.0.0.1", QYL_PORT: String(port),
  QYL_OTLP_PORT: "0", QYL_GRPC_PORT: "0", QYL_OTLP_AUTH_MODE: "ApiKey",
  QYL_OTLP_PROJECT_KEYS: JSON.stringify(Object.fromEntries(fixtures.map((f) => [f.project, [f.apiKey]]))),
  QYL_DATA_PATH: join(temp, "project-scope.duckdb"),
});
const collector = spawn(existsSync(executable) ? executable : "dotnet",
  existsSync(executable) ? [] : ["run", "--no-launch-profile", "--project", projectFile],
  { cwd: dirname(projectFile), env: collectorEnv, stdio: ["ignore", "pipe", "pipe"] });
let collectorLog = "";
let startupError;
collector.on("error", (error) => { startupError = error; });
for (const stream of [collector.stdout, collector.stderr]) {
  stream.on("data", (chunk) => { collectorLog = `${collectorLog}${chunk}`.slice(-20_000); });
}
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (collector.exitCode !== null) throw new Error(`Collector exited ${collector.exitCode}: ${collectorLog}`);
    try { if (await check()) return; } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}
const headers = (f) => ({ [API_KEY_HEADER]: f.apiKey, [PROJECT_HEADER]: f.project });
async function read(f, path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: headers(f) });
  assert.equal(response.status, 200, `Collector GET ${path}`);
  return response.json();
}
const attr = (key, value) => ({ key, value: { stringValue: value } });
const start = BigInt(Date.now() - 2_000) * 1_000_000n;
function resource(f) { return { attributes: [attr("service.name", `qyl-ci-${f.marker}`)] }; }
function spans(f, traceId) {
  return { resourceSpans: [{ resource: resource(f), scopeSpans: [{
    scope: { name: "qyl-project-smoke" }, spans: [{
      traceId, spanId: randomBytes(8).toString("hex"), name: `tools/call ${f.marker}_tool`, kind: 1,
      startTimeUnixNano: String(start), endTimeUnixNano: String(start + 10_000_000n),
      attributes: [attr("session.id", `${f.marker}_session`), attr("mcp.method.name", "tools/call"),
        attr("gen_ai.tool.name", `${f.marker}_tool`), attr("ci.leg", f.marker)],
      status: { code: 2, message: `${f.marker} intentional test error` },
    }],
  }] }] };
}
async function ingest(f, signal, body) {
  const response = await fetch(`${baseUrl}/v1/${signal}`, {
    method: "POST", headers: { ...headers(f), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `OTLP ${signal}: ${text}`);
  assert.doesNotMatch(text, /rejected/u, `OTLP ${signal} partially rejected data`);
}
let handler;
let runtime;
const clients = [];
try {
  await waitFor(async () => (await fetch(`${baseUrl}/health`)).ok, "Collector startup", 120_000);
  assert.equal((await fetch(`${baseUrl}/api/v1/traces`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/v1/traces`, {
    headers: { ...headers(fixtures[0]), [PROJECT_HEADER]: fixtures[1].project },
  })).status, 400, "a key cannot select the other project through a header");

  for (const f of fixtures) {
    await ingest(f, "traces", spans(f, f.traceId));
    await ingest(f, "logs", { resourceLogs: [{ resource: resource(f), scopeLogs: [{ logRecords: [{
      timeUnixNano: String(start), severityNumber: 17, severityText: "ERROR",
      // Deliberately echo the disposable fixture key to exercise value redaction.
      body: { stringValue: `${f.marker} sample log ${f.apiKey}` }, traceId: f.traceId,
    }] }] }] });
    await ingest(f, "metrics", { resourceMetrics: [{ resource: resource(f), scopeMetrics: [{ metrics: [{
      name: `${f.marker}.requests`, gauge: { dataPoints: [{
        timeUnixNano: String(start), asDouble: f.project === "owner" ? 41 : 7,
        attributes: [attr("fixture", f.marker)],
      }] },
    }] }] }] });
    await waitFor(async () => {
      const [traces, metrics, logs] = await Promise.all([
        read(f, "/api/v1/traces?limit=10"), read(f, "/api/v1/metrics?limit=10"), read(f, "/api/v1/logs?limit=10"),
      ]);
      return traces.items.some((trace) => trace.trace_id === f.traceId)
        && metrics.items.length === 1 && logs.items.length === 1;
    }, `${f.project} ingestion`);
  }
  console.log("ok real OTLP traces, logs and metrics stored under two separate project credentials");

  delete process.env.QYL_DEMO;
  Object.assign(process.env, {
    QYL_COLLECTOR_URL: baseUrl, QYL_MCP_TELEMETRY: "0", QYL_API_KEY: "must-not-fall-back",
    MCP_COLLECTOR_PROJECTS: JSON.stringify(fixtures.map((f) => ({
      project: f.project, apiKey: f.apiKey, subjects: [f.subject],
    }))),
  });
  handler = createMcpHandler(() => createServer({ nativeExecution: false }));
  const gate = createResourceAuthorization({
    verifier: { async verifyAccessToken(token) {
      const f = fixtures.find((entry) => entry.token === token);
      if (!f && token !== "unassigned-local-test") throw new Error("unknown test token");
      return { token, clientId: "local-scope-test", scopes: [QYL_MCP_SCOPE],
        resource: new URL(QYL_MCP_RESOURCE), expiresAt: Math.floor(Date.now() / 1_000) + 300,
        extra: { subject: f?.subject ?? "auth0|unassigned-local-test" } };
    } },
    requiredScopes: [QYL_MCP_SCOPE],
    resourceMetadataUrl: "https://mcp.qyl.at/.well-known/oauth-protected-resource/mcp",
  });
  const serve = async (input, init) => {
    const request = new Request(input, init);
    const auth = await gate(request);
    return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
  };
  const window = { start_time: new Date(Number(start / 1_000_000n) - 10_000).toISOString(),
    end_time: new Date(Number(start / 1_000_000n) + 10_000).toISOString(), step_ms: 20_000 };
  /** @type {(f: typeof fixtures[number]) => ReadonlyArray<readonly [string, Record<string, unknown>]>} */
  const cases = (f) => [
    ["list_traces", { limit: 10 }], ["get_trace", { trace_id: f.traceId }],
    ["list_sessions", {}], ["search_logs", {}], ["ci_log", {}],
    ["ci_log", { run_id: `${f.marker}_session` }], ["list_metrics", {}],
    ["get_metric_series", { metric_name: `${f.marker}.requests` }],
    ["query_metric", { metric_name: `${f.marker}.requests`, ...window, aggregation: "avg" }],
    ["display_traces", {}], ["display_traces", { session_id: `${f.marker}_session` }],
    ["display_mcp_dashboard", { hours: 1 }], ["fetch_telemetry", { view: "traces" }],
    ["fetch_telemetry", { view: "trace", trace_id: f.traceId }],
    ["fetch_telemetry", { view: "logs" }], ["fetch_telemetry", { view: "mcp_stats", hours: 1 }],
  ];
  for (const revision of ["2026-07-28", "2025-11-25"]) {
    async function connect(token) {
      const client = new Client({ name: "project-smoke", version: "1.0.0" }, {
        versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
      });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(QYL_MCP_RESOURCE), {
        fetch: serve, requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));
      assert.equal(client.getNegotiatedProtocolVersion(), revision);
      return client;
    }
    await Promise.all(fixtures.map(async (f) => {
      const client = await connect(f.token);
      const foreign = fixtures.find((entry) => entry !== f);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
        [...new Set(cases(f).map(([name]) => name))].sort((a, b) => a.localeCompare(b)));
      for (const [name, args] of cases(f)) {
        const result = await client.callTool({ name, arguments: args,
          _meta: { subject: foreign.subject, project: foreign.project } });
        assert(!result.isError, `${revision} ${f.project} ${name}: ${JSON.stringify(result)}`);
        const json = JSON.stringify(result);
        assert(json.includes(f.marker), `${name} contains no seeded ${f.project} data`);
        assert(!json.includes(foreign.marker), `${name} leaked the other project's data`);
        for (const entry of fixtures) assert(!json.includes(entry.apiKey), `${name} exposed a key`);
      }
      /** @type {ReadonlyArray<readonly [string, Record<string, unknown>]>} */
      const foreignCases = [
        ["get_trace", { trace_id: foreign.traceId }],
        ["fetch_telemetry", { view: "trace", trace_id: foreign.traceId }],
        ["display_traces", { trace_id: foreign.traceId }],
      ];
      for (const [name, args] of foreignCases) {
        const denied = await client.callTool({ name, arguments: args });
        assert.equal(denied.isError, true, `${name} accepted a foreign trace`);
        assert(!JSON.stringify(denied).includes(foreign.marker));
      }
    }));
    const unassigned = await connect("unassigned-local-test");
    for (const [name, args] of cases(fixtures[0])) {
      const result = await unassigned.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} accepted an unassigned account`);
      assert.match(JSON.stringify(result), /No Collector project is assigned/u);
    }
    console.log(`ok ${revision}: all 11 tools and viewer paths isolate concurrent accounts; foreign trace IDs and unassigned accounts denied`);
  }

  const store = createEventStore(join(temp, "events.json"));
  const deliveries = [];
  const signingKey = randomBytes(32);
  const secret = `whsec_${signingKey.toString("base64")}`;
  const params = (f) => ({ name: "trace.error", arguments: {},
    delivery: { mode: "webhook", url: `https://callback.example.test/${f.project}`, secret } });
  const principal = (f) => ({ subject: f.subject, clientId: "local-scope-test" });
  runtime = new EventsRuntime({ store, isAuthorized: async () => true, pollIntervalMs: 60_000,
    post: async (url, body, signedHeaders) => {
      const signature = createHmac("sha256", signingKey)
        .update(`${signedHeaders["webhook-id"]}.${signedHeaders["webhook-timestamp"]}.${body}`).digest("base64");
      assert.equal(signedHeaders["webhook-signature"], `v1,${signature}`);
      const value = JSON.parse(body);
      if (value.type === "verification") return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
      deliveries.push({ project: url.pathname.slice(1), value });
      return { status: 200, body: "" };
    },
  });
  for (const f of fixtures) await runtime.subscribe(params(f), principal(f));
  await runtime.poll();
  const sharedTraceId = randomBytes(16).toString("hex");
  for (const f of fixtures) await ingest(f, "traces", spans(f, sharedTraceId));
  await waitFor(async () => {
    await runtime.poll();
    return deliveries.length === 2;
  }, "two project-scoped Events");
  for (const delivery of deliveries) {
    const f = fixtures.find((entry) => entry.project === delivery.project);
    assert.equal(delivery.value.data.trace_id, sharedTraceId);
    assert.equal(delivery.value.data.root_span, `tools/call ${f.marker}_tool`);
    assert.deepEqual(delivery.value.data.services, [`qyl-ci-${f.marker}`]);
  }
  await runtime.unsubscribe(params(fixtures[1]), principal(fixtures[1]));
  for (const f of fixtures) await ingest(f, "traces", spans(f, randomBytes(16).toString("hex")));
  await waitFor(async () => { await runtime.poll(); return deliveries.length === 3; }, "remaining owner's event");
  assert.equal(deliveries[2].project, "owner");
  process.env.MCP_COLLECTOR_PROJECTS = JSON.stringify([{
    project: fixtures[1].project, apiKey: fixtures[1].apiKey, subjects: [fixtures[1].subject],
  }]);
  await runtime.poll();
  assert.equal((await store.read()).subscriptions.length, 0);
  console.log("ok Events: same trace ID stays project-scoped; signatures, unsubscribe and assignment revocation pass");
  console.log("all real-Collector project-isolation checks passed (local test identities; hosted reviewer login still required)");
} catch (error) {
  let message = error instanceof Error ? error.stack : String(error);
  for (const f of fixtures) message = message.replaceAll(f.apiKey, "[test key]").replaceAll(f.token, "[test token]");
  console.error(message);
  process.exitCode = 1;
} finally {
  await runtime?.stop();
  await Promise.allSettled(clients.map((client) => client.close()));
  await handler?.close();
  if (collector.exitCode === null && collector.signalCode === null) {
    const exited = once(collector, "exit");
    collector.kill("SIGTERM");
    await Promise.race([exited, pause(5_000)]);
    if (collector.exitCode === null && collector.signalCode === null) {
      collector.kill("SIGKILL");
      await exited;
    }
  }
  await rm(temp, { recursive: true, force: true });
}
