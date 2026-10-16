import assert from "node:assert/strict";
import { createServer as createHttpReceiver } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import protobuf from "protobufjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { API_KEY_HEADER, PROJECT_HEADER } from "./contract-headers.js";
import { createHttpMcpServer, readStreamableHTTPConfig } from "./main.js";
import { closeDefaultNativeExecutionRuntime } from "./native-execution.js";

// Decode the actual exporter requests with official OTLP v1.11.1 definitions,
// not a handwritten wire reader or a mock exporter that skips HTTP routing.
const protoDirectory = fileURLToPath(new URL("../testdata/otlp/", import.meta.url));
const protoRoot = new protobuf.Root();
protoRoot.resolvePath = (_origin, target) => resolve(protoDirectory, target);
await protoRoot.load(["trace", "metrics", "logs"].map(signal =>
  `opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`));
const messageTypes = new Map([
  ["/v1/traces", protoRoot.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest")],
  ["/v1/metrics", protoRoot.lookupType("opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest")],
  ["/v1/logs", protoRoot.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest")],
]);

interface Attribute {
  key: string;
  value: { stringValue?: string };
}
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  status?: { code?: number };
  attributes: Attribute[];
}
interface Receipt {
  project: string | undefined;
  key: string | undefined;
  signal: string;
  body: Record<string, unknown>;
}
const attribute = (attributes: Attribute[], key: string) =>
  attributes.find(item => item.key === key)?.value.stringValue;
const hex = (base64: string) => Buffer.from(base64, "base64").toString("hex");

for (const multiProject of [true, false]) {
  test(`hosted calls export real correlated signals ${multiProject ? "per verified project" : "in single-project mode"}`, async context => {
    const temporary = await mkdtemp(join(tmpdir(), "qyl-hosted-telemetry-"));
    const receipts: Receipt[] = [];
    const receiverErrors: unknown[] = [];
    const receiver = createHttpReceiver((request, response) => {
      const receive = async (): Promise<void> => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const type = messageTypes.get(request.url!);
        assert(type, `unexpected OTLP route ${request.url}`);
        receipts.push({
          project: request.headers[PROJECT_HEADER.toLowerCase()] as string | undefined,
          key: request.headers[API_KEY_HEADER.toLowerCase()] as string | undefined,
          signal: request.url!,
          body: type.toObject(type.decode(Buffer.concat(chunks)), { longs: String, bytes: String }),
        });
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      };
      void receive().catch(error => {
        receiverErrors.push(error);
        response.writeHead(400);
        response.end();
      });
    });
    await new Promise<void>((resolveListening, reject) => {
      receiver.once("error", reject);
      receiver.listen(0, "127.0.0.1", () => {
        receiver.off("error", reject);
        resolveListening();
      });
    });
    const address = receiver.address();
    assert(address && typeof address !== "string");
    const projects = multiProject ? [
      { project: "owner", apiKey: "owner-test-key", subjects: ["auth0|owner"], traceId: "11111111111111111111111111111111" },
      { project: "review", apiKey: "review-test-key", subjects: ["auth0|review"], traceId: "22222222222222222222222222222222" },
    ] : [
      { project: "single", apiKey: "single-test-key", subjects: ["auth0|single"], traceId: "33333333333333333333333333333333" },
    ];
    const savedEnvironment = { ...process.env };
    Object.assign(process.env, {
      QYL_COLLECTOR_URL: `http://127.0.0.1:${address.port}`,
      QYL_API_KEY: multiProject ? "fallback-must-not-be-used" : projects[0]!.apiKey,
      QYL_PROJECT: multiProject ? "fallback-must-not-be-used" : projects[0]!.project,
      QYL_MCP_NATIVE_STATE_PATH: join(temporary, "must-not-exist.json"),
    });
    for (const key of ["QYL_MCP_TELEMETRY", "QYL_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"]) delete process.env[key];
    if (multiProject) process.env.MCP_COLLECTOR_PROJECTS = JSON.stringify(projects.map(({ traceId: _, ...project }) => project));
    else delete process.env.MCP_COLLECTOR_PROJECTS;
    const config = readStreamableHTTPConfig({ MCP_PUBLIC_URL: "https://mcp.qyl.at" });
    const handler = createMcpHandler(() => {
      const server = createHttpMcpServer(config);
      server.registerTool("fixture.telemetry", { inputSchema: z.object({ private_text: z.string(), fail: z.boolean() }) },
        async ({ fail }) => ({ content: [{ type: "text", text: "done" }], ...(fail ? { isError: true } : {}) }));
      return server;
    });
    const clients: Client[] = [];
    context.after(async () => {
      await Promise.allSettled(clients.map(client => client.close()));
      await handler.close();
      await closeDefaultNativeExecutionRuntime();
      receiver.closeAllConnections();
      await new Promise<void>((resolveClosed, reject) => receiver.close(error => error ? reject(error) : resolveClosed()));
      for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
      Object.assign(process.env, savedEnvironment);
      await rm(temporary, { recursive: true, force: true });
    });
    await Promise.all(projects.map(async project => {
      const client = new Client({ name: "hosted-telemetry", version: "1.0.0" });
      clients.push(client);
      const authInfo: AuthInfo = { token: "verified-test-token", clientId: "telemetry-test", scopes: ["qyl:read"],
        extra: { subject: project.subjects[0] } };
      await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.qyl.at/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
      }));
      const fail = multiProject && project.project === "review";
      const result = await client.callTool({ name: "fixture.telemetry", arguments: { private_text: "never-export-this", fail },
        _meta: { traceparent: `00-${project.traceId}-aaaaaaaaaaaaaaaa-01`, subject: "auth0|owner", project: "owner" } });
      assert.equal(result.isError, fail ? true : undefined);
    }));
    await closeDefaultNativeExecutionRuntime();
    assert.deepEqual(receiverErrors, []);
    assert.equal(receipts.length, projects.length * 3, "each project must export traces, metrics and logs");
    for (const project of projects) {
      const signals = receipts.filter(receipt => receipt.project === project.project);
      assert.deepEqual(signals.map(receipt => receipt.signal).sort(), ["/v1/logs", "/v1/metrics", "/v1/traces"]);
      assert(signals.every(receipt => receipt.key === project.apiKey));
      const traces = signals.find(receipt => receipt.signal === "/v1/traces")!.body as unknown as {
        resourceSpans: Array<{ resource: { attributes: Attribute[] }; scopeSpans: Array<{ scope: { name: string }; spans: Span[] }> }> };
      assert.equal(traces.resourceSpans.length, 1);
      assert.equal(attribute(traces.resourceSpans[0]!.resource.attributes, "service.name"), "qyl.mcp");
      const scope = traces.resourceSpans[0]!.scopeSpans[0]!;
      assert.equal(scope.scope.name, "qyl.mcp");
      assert.equal(scope.spans.length, 1);
      const span = scope.spans[0]!;
      assert.equal(hex(span.traceId), project.traceId);
      assert.equal(hex(span.parentSpanId), "aaaaaaaaaaaaaaaa");
      assert.match(hex(span.spanId), /^(?!0{16}$)[0-9a-f]{16}$/u);
      assert.equal(span.name, "tools/call fixture.telemetry");
      assert.equal(span.kind, 2);
      const failed = multiProject && project.project === "review";
      assert.equal(span.status?.code ?? 0, failed ? 2 : 0);
      assert.equal(attribute(span.attributes, "gen_ai.tool.name"), "fixture.telemetry");
      assert.equal(attribute(span.attributes, "error.type"), failed ? "tool_error" : undefined);
      const metrics = signals.find(receipt => receipt.signal === "/v1/metrics")!.body as unknown as {
        resourceMetrics: Array<{ scopeMetrics: Array<{ scope: { name: string }; metrics: Array<{ name: string; unit: string;
          histogram: { dataPoints: Array<{ count: string; attributes: Attribute[] }> } }> }> }> };
      const metricScope = metrics.resourceMetrics[0]!.scopeMetrics[0]!;
      assert.equal(metricScope.scope.name, "qyl.mcp");
      assert.equal(metricScope.metrics.length, 1);
      const metric = metricScope.metrics[0]!;
      assert.equal(metric.name, "mcp.server.operation.duration");
      assert.equal(metric.unit, "s");
      assert.equal(metric.histogram.dataPoints.length, 1);
      assert.equal(metric.histogram.dataPoints[0]!.count, "1");
      assert.equal(attribute(metric.histogram.dataPoints[0]!.attributes, "gen_ai.tool.name"), "fixture.telemetry");
      assert.equal(attribute(metric.histogram.dataPoints[0]!.attributes, "error.type"), failed ? "tool_error" : undefined);
      const logs = signals.find(receipt => receipt.signal === "/v1/logs")!.body as unknown as {
        resourceLogs: Array<{ scopeLogs: Array<{ scope: { name: string }; logRecords: Array<{ traceId: string; spanId: string;
          eventName: string; severityNumber: number }> }> }> };
      const logScope = logs.resourceLogs[0]!.scopeLogs[0]!;
      assert.equal(logScope.scope.name, "qyl.mcp");
      assert.equal(logScope.logRecords.length, 1);
      assert.equal(hex(logScope.logRecords[0]!.traceId), project.traceId);
      assert.equal(hex(logScope.logRecords[0]!.spanId), hex(span.spanId));
      assert.equal(logScope.logRecords[0]!.eventName, "qyl.mcp.operation");
      assert.equal(logScope.logRecords[0]!.severityNumber, failed ? 17 : 9);
      assert.doesNotMatch(JSON.stringify(signals.map(signal => signal.body)), /never-export-this|test-key|private_text/u);
    }
    await assert.rejects(stat(join(temporary, "must-not-exist.json")), { code: "ENOENT" });
  });
}

test("telemetry setup failure is reported without exposing credentials or blocking tools", async context => {
  const secret = "mapped-setup-test-secret";
  const keys = ["MCP_COLLECTOR_PROJECTS", "QYL_MCP_TELEMETRY", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  delete process.env.QYL_MCP_TELEMETRY;
  process.env.MCP_COLLECTOR_PROJECTS = JSON.stringify([{ project: "owner", apiKey: secret, subjects: ["auth0|owner"] }]);
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `not-a-url/${secret}`;
  const diagnostics: string[] = [];
  context.mock.method(console, "error", (...values: unknown[]) => diagnostics.push(values.join(" ")));
  const config = readStreamableHTTPConfig({ MCP_PUBLIC_URL: "https://mcp.qyl.at" });
  const handler = createMcpHandler(() => {
    const server = createHttpMcpServer(config);
    server.registerTool("fixture.available", { inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "available" }] }));
    return server;
  });
  const client = new Client({ name: "setup-failure", version: "1.0.0" });
  context.after(async () => {
    await Promise.allSettled([client.close(), handler.close()]);
    await closeDefaultNativeExecutionRuntime();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.qyl.at/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo: {
      token: "verified-test-token", clientId: "test", scopes: ["qyl:read"], extra: { subject: "auth0|owner" },
    } }),
  }));
  const result = await client.callTool({ name: "fixture.available", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "available" }]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /telemetry setup or recording failed.*OTLP traces endpoint/u);
  assert(!diagnostics[0]!.includes(secret));
});
