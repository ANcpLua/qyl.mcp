import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { getDemo } from "./demo.js";
import { createServer } from "./server.js";

const TraceAuthorizationSecret = "TRACE_AUTHORIZATION_SENTINEL";
const TracePasswordSecret = "TRACE_PASSWORD_SENTINEL";
const TraceNameSecret = "TRACE_NAME_SENTINEL";
const EnvironmentSecret = "ENVIRONMENT_API_KEY_SENTINEL";
const LogTokenSecret = "LOG_TOKEN_SENTINEL";
const LogPasswordSecret = "LOG_PASSWORD_SENTINEL";
const LogSecretSecret = "LOG_SECRET_SENTINEL";
const LogAuthorizationSecret = "LOG_AUTHORIZATION_SENTINEL";

test("telemetry tools redact secrets before model text and structured content", async () => {
  const trace = structuredClone(getDemo().traces[0]);
  const root = trace.spans[0];
  assert(root);
  root.name = `${EnvironmentSecret} secret=${TraceNameSecret}; ordinary-span-kept`;
  root.status = {
    code: 2,
    message: `password=${TracePasswordSecret}; ordinary-status-kept`,
  };
  root.attributes = [
    ...(root.attributes ?? []),
    { key: "authorization", value: `Bearer ${TraceAuthorizationSecret}` },
    { key: "gen_ai.usage.input_tokens", value: { type: "int", value: "42" } },
  ];
  trace.root_span = structuredClone(root);
  trace.has_error = true;

  const textualLog = structuredClone(getDemo().logs[0]);
  textualLog.body = {
    string_value:
      `token=${LogTokenSecret}; password=${LogPasswordSecret}; ` +
      `secret=${LogSecretSecret}; ordinary-log-kept`,
  };
  textualLog.attributes = [
    { key: "gen_ai.usage.output_tokens", value: { type: "int", value: "17" } },
  ];

  const semanticLog = structuredClone(getDemo().logs[1]);
  semanticLog.body = {
    kv_list_value: [
      { key: "authorization", value: `Bearer ${LogAuthorizationSecret}` },
      { key: "message", value: "ordinary-semantic-kept" },
    ],
  };

  const collector = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/v1/logs")) {
      response.end(JSON.stringify({ items: [textualLog, semanticLog], has_more: false }));
      return;
    }
    if (request.url?.startsWith(`/api/v1/traces/${trace.trace_id}`)) {
      response.end(JSON.stringify(trace));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({}));
  });
  await listen(collector);

  const address = collector.address();
  assert(address && typeof address === "object");
  const previousCollectorUrl = process.env.QYL_COLLECTOR_URL;
  const previousDemo = process.env.QYL_DEMO;
  const previousApiKey = process.env.QYL_API_KEY;
  process.env.QYL_COLLECTOR_URL = `http://127.0.0.1:${address.port}`;
  process.env.QYL_API_KEY = EnvironmentSecret;
  delete process.env.QYL_DEMO;

  const mcpServer = createServer({ nativeExecution: false });
  const client = new Client({ name: "redaction-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const traceResult = CallToolResultSchema.parse(await client.callTool({
      name: "get_trace",
      arguments: { trace_id: trace.trace_id },
    }));
    assertResultIsRedacted(traceResult, [
      TraceAuthorizationSecret,
      TracePasswordSecret,
      TraceNameSecret,
      EnvironmentSecret,
    ]);
    const serializedTrace = JSON.stringify(traceResult);
    assert.match(serializedTrace, /ordinary-span-kept/u);
    assert.match(serializedTrace, /ordinary-status-kept/u);
    assert.match(serializedTrace, /gen_ai\.usage\.input_tokens/u);
    assert.match(serializedTrace, /"type":"int","value":"42"/u);

    const logsResult = CallToolResultSchema.parse(await client.callTool({
      name: "search_logs",
      arguments: {},
    }));
    assertResultIsRedacted(logsResult, [
      LogTokenSecret,
      LogPasswordSecret,
      LogSecretSecret,
      LogAuthorizationSecret,
    ]);
    const serializedLogs = JSON.stringify(logsResult);
    assert.match(serializedLogs, /ordinary-log-kept/u);
    assert.match(serializedLogs, /ordinary-semantic-kept/u);
    assert.match(serializedLogs, /gen_ai\.usage\.output_tokens/u);
    assert.match(serializedLogs, /"type":"int","value":"17"/u);
  } finally {
    await client.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    restoreEnvironment("QYL_COLLECTOR_URL", previousCollectorUrl);
    restoreEnvironment("QYL_DEMO", previousDemo);
    restoreEnvironment("QYL_API_KEY", previousApiKey);
    await close(collector);
  }
});

function assertResultIsRedacted(result: unknown, sentinels: readonly string[]): void {
  const serialized = JSON.stringify(result);
  for (const sentinel of sentinels) {
    assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
  }
  assert.match(serialized, /\[REDACTED\]/u);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function listen(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
