import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CiLogOutputSchema, GetTraceOutputSchema } from "./contract-validation.js";
import { getDemo } from "./demo.js";
import { connectModernTestClient, type ModernTestClient } from "./modern-test-client.test-helper.js";
import { createServer } from "./server.js";
import type { QylSession, QylSpan, QylTrace } from "./wire.js";

function fixtureTrace(): QylTrace {
  const trace = structuredClone(getDemo().traces[0]!);
  const base = trace.spans[0]!;
  const services = ["qyl-ci-build", "custom-ci-build", "custom-ci-test", "web"];
  trace.spans = ([1, 2, 2, 0] as const).map((code, index): QylSpan => ({
    ...structuredClone(base),
    span_id: (index + 1).toString(16).padStart(16, "0") as QylSpan["span_id"],
    name: `phase-${index}`,
    status: { code },
    attributes: [{ key: "payload", value: "span-payload" }, { key: "ci.leg", value: `leg-${index}` }],
    resource: { service_name: services[index]!, attributes: [{ key: "payload", value: "resource-payload" }] },
    events: [{
      name: "event-kept", time_unix_nano: base.start_time_unix_nano,
      attributes: [{ key: "payload", value: "event-payload" }],
    }],
    links: [{
      trace_id: trace.trace_id, span_id: base.span_id,
      attributes: [{ key: "payload", value: "link-payload" }],
    }],
    instrumentation_scope: {
      name: "scope-kept", attributes: [{ key: "payload", value: "scope-payload" }],
    },
  }));
  trace.root_span = structuredClone(trace.spans[0]!);
  trace.span_count = trace.spans.length;
  trace.services = services;
  trace.has_error = true;
  return trace;
}

function fixtureSession(id: string, services: string[]): QylSession {
  return { ...structuredClone(getDemo().sessions[0]!), session_id: id as QylSession["session_id"], services };
}

async function connectCollector(
  context: TestContext,
  trace: QylTrace,
  sessions: QylSession[] = [],
  failureStatus?: number,
): Promise<ModernTestClient> {
  const env = {
    QYL_COLLECTOR_URL: "https://collector.example.test",
    QYL_DEMO: undefined,
    MCP_COLLECTOR_PROJECTS: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  context.mock.method(globalThis, "fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    assert.equal(url.origin, "https://collector.example.test");
    if (failureStatus !== undefined) return Response.json({ error: "fixture failure" }, { status: failureStatus });
    if (url.pathname === `/api/v1/traces/${trace.trace_id}`) return Response.json(trace);
    if (url.pathname === "/api/v1/sessions") return Response.json({ items: sessions, has_more: false });
    if (url.pathname === "/api/v1/sessions/custom-run/traces") {
      return Response.json({ items: [trace], has_more: false });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  const connection = await connectModernTestClient(
    { name: "tool-options-test", version: "1.0.0" },
    () => createServer({ nativeExecution: false }),
  );
  context.after(() => connection.close());
  return connection;
}

async function readTrace(connection: ModernTestClient, args: Record<string, unknown>) {
  const result = await connection.client.callTool({ name: "get_trace", arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return { result, output: GetTraceOutputSchema.parse(result.structuredContent) };
}

test("get_trace defaults preserve the complete trace and attributes", async (context) => {
  const trace = fixtureTrace();
  const connection = await connectCollector(context, trace);
  for (const options of [{}, { errors_only: false, include_attributes: true }]) {
    const { result, output } = await readTrace(connection, { trace_id: trace.trace_id, ...options });
    assert.equal(output.mode, "live");
    assert.deepEqual(output.trace, trace);
    assert.match(JSON.stringify(result.content), /Root: phase-0/);
  }
});

test("get_trace filters errors before capping spans and retains honest trace totals", async (context) => {
  const trace = fixtureTrace();
  const connection = await connectCollector(context, trace);
  const { result, output } = await readTrace(connection, {
    trace_id: trace.trace_id, errors_only: true, max_spans: 1, include_attributes: false,
  });
  assert.deepEqual(output.trace.spans.map((span) => span.span_id), [trace.spans[1]!.span_id]);
  assert.equal(output.trace.spans[0]!.status.code, 2);
  assert.equal(output.trace.root_span, undefined);
  assert.equal(output.trace.span_count, 4);
  assert.equal(output.trace.duration_ns, trace.duration_ns);
  assert.equal(output.trace.has_error, true);
  assert.match(JSON.stringify(result.content), /Returned 1 of 2 matching spans \(4 total\); error status only/);
  assert.match(JSON.stringify(result.content), /Root: not included in selected spans/);
  assert.doesNotMatch(JSON.stringify(result.content), /phase-0/);
  assert.doesNotMatch(JSON.stringify(output.trace), /"attributes"|\w+-payload/);
  const full = await readTrace(connection, { trace_id: trace.trace_id });
  assert.deepEqual(full.output.trace, trace, "projection must not mutate later reads");
});

test("get_trace omits all attribute collections including the root copy and keeps event and link identities", async (context) => {
  const trace = fixtureTrace();
  const connection = await connectCollector(context, trace);
  const { output } = await readTrace(connection, { trace_id: trace.trace_id, include_attributes: false, max_spans: 1 });
  assert.equal(output.trace.spans.length, 1);
  assert.equal(output.trace.root_span?.span_id, trace.spans[0]!.span_id);
  assert.doesNotMatch(JSON.stringify(output.trace), /"attributes"|\w+-payload/);
  assert.equal(output.trace.spans[0]!.events?.[0]?.name, "event-kept");
  assert.equal(output.trace.spans[0]!.links?.[0]?.trace_id, trace.trace_id);
  assert.equal(output.trace.spans[0]!.resource.service_name, "qyl-ci-build");
  assert.equal(output.trace.spans[0]!.instrumentation_scope?.name, "scope-kept");
});

test("get_trace reports empty error matches without adding a nonmatching root", async (context) => {
  const trace = fixtureTrace();
  for (const span of trace.spans) span.status = { code: 1 };
  trace.has_error = false;
  const connection = await connectCollector(context, trace);
  const { result, output } = await readTrace(connection, { trace_id: trace.trace_id, errors_only: true });
  assert.deepEqual(output.trace.spans, []);
  assert.equal(output.trace.root_span, undefined);
  assert.equal(output.trace.span_count, 4);
  assert.equal(output.mode, "live");
  assert.match(JSON.stringify(result.content), /Returned 0 of 0 matching spans \(4 total\)/);
  assert.match(JSON.stringify(result.content), /Root: not included in selected spans/);
  assert.doesNotMatch(JSON.stringify(result.content), /phase-0/);
});

test("get_trace does not name a root excluded by the cap in its text summary", async (context) => {
  const trace = fixtureTrace();
  trace.spans.push(trace.spans.shift()!);
  const connection = await connectCollector(context, trace);
  const { result, output } = await readTrace(connection, { trace_id: trace.trace_id, max_spans: 1 });
  assert.equal(output.trace.root_span, undefined);
  assert.deepEqual(output.trace.spans.map((span) => span.name), ["phase-1"]);
  assert.match(JSON.stringify(result.content), /Root: not included in selected spans/);
  assert.doesNotMatch(JSON.stringify(result.content), /phase-0/);
});

test("ci_log applies the case-sensitive service prefix to run lists before their limit and to phase breakdowns", async (context) => {
  const connection = await connectCollector(context, fixtureTrace(), [
    fixtureSession("default-run", ["qyl-ci-build"]),
    fixtureSession("custom-run", ["web", "custom-ci-build"]),
    fixtureSession("custom-run-2", ["custom-ci-test"]),
    fixtureSession("other-run", ["Custom-ci-build"]),
  ]);
  async function readCi(args: Record<string, unknown>) {
    const result = await connection.client.callTool({ name: "ci_log", arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return { result, output: CiLogOutputSchema.parse(result.structuredContent) };
  }
  const defaults = await readCi({});
  assert.deepEqual(defaults.output.runs?.map((run) => run.run_id), ["default-run"]);
  const custom = await readCi({ service_prefix: "custom-ci", limit: 1 });
  assert.deepEqual(custom.output.runs?.map((run) => run.run_id), ["custom-run"]);
  const phases = await readCi({ run_id: "custom-run", service_prefix: "custom-ci" });
  assert.deepEqual(phases.output.phases?.map((phase) => phase.phase), ["phase-1", "phase-2"]);
  const defaultPhases = await readCi({ run_id: "custom-run" });
  assert.deepEqual(defaultPhases.output.phases?.map((phase) => phase.phase), ["phase-0"]);
  const emptyRuns = await readCi({ service_prefix: "CUSTOM-ci" });
  assert.deepEqual(emptyRuns.output.runs, []);
  assert.match(JSON.stringify(emptyRuns.result.content), /CUSTOM-ci\*/);
  const emptyPhases = await readCi({ run_id: "custom-run", service_prefix: "CUSTOM-ci" });
  assert.deepEqual(emptyPhases.output.phases, []);
  assert.match(JSON.stringify(emptyPhases.result.content), /CUSTOM-ci\*/);
});

test("filtered tools preserve upstream errors instead of manufacturing empty or demo results", async (context) => {
  const trace = fixtureTrace();
  const connection = await connectCollector(context, trace, [], 503);
  for (const call of [
    { name: "get_trace", arguments: { trace_id: trace.trace_id, errors_only: true, max_spans: 1 } },
    { name: "ci_log", arguments: { service_prefix: "custom-ci" } },
  ]) {
    const result = await connection.client.callTool(call);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  }
});
