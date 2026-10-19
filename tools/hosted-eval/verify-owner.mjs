/** Successful hosted operations and two-way project isolation over the official MCP client. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  fixture: { type: "string" }, "foreign-fixture": { type: "string" },
  token: { type: "string", default: join(here, "out/hosted-owner-token.json") },
  "reviewer-token": { type: "string", default: join(here, "out/hosted-token.json") },
  endpoint: { type: "string", default: "https://mcp.qyl.at/mcp" }, out: { type: "string" },
} });
assert(values.fixture && values["foreign-fixture"], "Pass --fixture and --foreign-fixture from fresh isolated OTLP ingestion.");
const fixture = JSON.parse(readFileSync(values.fixture, "utf8"));
const foreign = JSON.parse(readFileSync(values["foreign-fixture"], "utf8"));
assert(fixture.run_id && foreign.run_id && fixture.run_id !== foreign.run_id, "Fresh independent run IDs are required.");
assert.notEqual(fixture.project, foreign.project, "Project isolation requires two distinct configured projects.");
const output = values.out ?? join(here, "out", `owner-results-${fixture.run_id}.json`);
const evidence = { started_at: new Date().toISOString(), endpoint: values.endpoint, run_id: fixture.run_id,
  calls: [], assertions: [], cleanup_errors: [] };
const succeeded = new Set();
const owned = new Map();
const w = fixture.window, key = fixture.keys, services = fixture.services, sessions = fixture.sessions;
const scoped = (service) => ({ ...w, matchers: [{ key: "service.name", op: "eq", value: service, scope: "resource" }] });
const all = { ...w, matchers: [{ key: "service.name", op: "in", values: Object.values(services), scope: "resource" }] };
const metricMatchers = [{ key: "test.run.id", value: fixture.run_id, op: "eq" }];
const connections = [];
let originalFailure;
let latestFailure;
let listing;
let failed = false;

async function connect(path, name) {
  const login = JSON.parse(readFileSync(path, "utf8"));
  if (name === "owner") {
    const scopes = new Set((login.scope ?? "").split(" "));
    for (const scope of ["qyl:read", "qyl:write", "qyl:delete"]) assert(scopes.has(scope), `Owner login omits ${scope}.`);
  }
  const client = new Client({ name: `qyl hosted ${name} verification`, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  connections.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(values.endpoint), { fetch: (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${login.access_token}`);
    return fetch(url, { ...init, headers });
  } }));
  evidence[`${name}_server`] = client.getServerVersion();
  return client;
}

async function raw(client, identity, name, args) {
  const started = new Date().toISOString();
  try {
    const result = await client.callTool({ name, arguments: args });
    evidence.calls.push({ identity, name, arguments: args, started_at: started, result });
    return result;
  } catch (error) {
    evidence.calls.push({ identity, name, arguments: args, started_at: started,
      error: { code: error.code, message: error.message } });
    throw error;
  }
}

async function call(client, name, args) {
  const result = await raw(client, "owner", name, args);
  assert(!result.isError && result.structuredContent && !result.structuredContent.error,
    `${name} did not succeed: ${JSON.stringify(result)}`);
  succeeded.add(name);
  return result.structuredContent;
}

function check(ok, label) {
  evidence.assertions.push({ label, passed: !!ok });
  assert(ok, label);
  console.log(`pass\t${label}`);
}

async function notFound(client, identity, name, args) {
  const result = await raw(client, identity, name, args);
  const data = result.structuredContent;
  const text = (result.content ?? []).filter(item => item.type === "text").map(item => item.text).join(" ");
  check(!!(result.isError || data?.error) && /not[._ -]?found|does not exist/iu.test(JSON.stringify(data?.error ?? text)),
    `${identity} cannot read the other project's ${name} target`);
}

let owner;
try {
  owner = await connect(values.token, "owner");
  const reviewer = await connect(values["reviewer-token"], "reviewer");
  listing = await owner.listTools();
  const published = listing.tools.map(tool => tool.name);
  check(new Set(published).size === published.length, "Hosted manifest names every tool once");
  check(["display_traces", "display_mcp_dashboard", "fetch_telemetry", "delete"].every(name => !published.includes(name)),
    "Hosted manifest publishes no viewer, app-only or pre-rename tool");

  const failures = await call(owner, "list_failures", { ...w, service_name: services.checkout, status: "all" });
  const failure = failures.failures.find(item => item.operation === "checkout");
  check(!!failure && failure.count > 0, "Owner reads the isolated checkout failure family");
  originalFailure = failure;
  const triage = await call(owner, "triage", all);
  check(triage.failures.some(item => item.failure_id === failure.failure_id), "Triage includes that exact failure");
  const context = await call(owner, "get_failure_context", { ...w, trace_id: key["db-root"].trace_id });
  check(context.observed.root_cause_span.span_id === key["db-timeout"].span_id, "Failure context identifies the recorded database child");
  const groups = await call(owner, "compare_groups", { ...scoped(services.regional), signal: "spans",
    group_a: { matchers: [{ key: "error.type", op: "exists" }] }, group_b: "rest", attribute_scope: "both" });
  check(groups.discriminators.some(item => item.key === "cloud.region" && item.value === "eu"), "Group comparison finds the seeded region");
  const comparison = await call(owner, "compare_traces", { ...w, a: { trace_id: key["db-root"].trace_id }, b: { trace_id: key["db-success-root"].trace_id } });
  check(comparison.first_divergence.kind === "status", "Trace comparison finds the recorded status difference");
  const fix = await call(owner, "verify_fix", { ...w, failure_id: failure.failure_id, since: fixture.T2 });
  check(fix.verdict === "pending" && fix.needs.requests === 96, "Fix verification retains the insufficient-sample verdict");
  const aggregate = await call(owner, "aggregate_telemetry", { ...scoped(services.http), signal: "spans", group_by: ["http.route"], measures: ["duration_p95"] });
  check(Math.abs(aggregate.groups.find(item => item.key["http.route"] === "/checkout").measures.duration_p95 - 1840) < 1,
    "Aggregation measures the seeded 1840 ms p95");
  const attributes = await call(owner, "discover_attributes", { ...scoped(services.regional), signal: "resources" });
  check(attributes.attributes.find(item => item.key === "cloud.region").cardinality === 2, "Attribute discovery sees both regions");
  const agent = await call(owner, "get_agent_run", { ...w, session_id: sessions.agent_run });
  check(agent.findings.repeated_calls.some(item => item.count === 3), "Agent analysis identifies the three actual repeated calls");
  const releases = await call(owner, "list_releases", { ...w, service_name: services.checkout });
  check(releases.releases.some(item => item.version === "1.4.1" && Date.parse(item.first_seen) === Date.parse(fixture.T)), "Release timeline retains the seeded first observation");
  const map = await call(owner, "get_service_map", all);
  check(map.edges.some(edge => edge.from === services.checkout && edge.to === services["orders-db"] && edge.error_rate > 0), "Service map contains the real failing dependency edge");
  const health = await call(owner, "check_telemetry_health", all);
  check(health.silent_services.some(item => item.service === services.billing), "Health identifies the isolated silent service");
  const stats = await call(owner, "get_mcp_stats", { ...w, server_name: fixture.mcp_server_name, tool_name: "search_logs" });
  const searches = stats.groups.find(item => item.name === "search_logs");
  check(searches.requests === 40 && searches.errors === 8 && searches.error_rate === .2, "MCP statistics preserve all 40 requests and eight expected errors");

  const sessionPage = await call(owner, "list_sessions", { ...w, service_name: services.sessions, has_error: true });
  check(sessionPage.sessions.some(item => item.session_id === sessions.sess_bad), "Session query returns the failing invocation group");
  const traces = await call(owner, "list_traces", { ...w, session_id: sessions.sess_bad, errors_only: true });
  check(traces.traces.length === 3, "Trace query returns all three seeded session errors");
  const trace = await call(owner, "get_trace", { ...w, trace_id: key["db-root"].trace_id });
  check(trace.trace.spans.some(span => span.span_id === key["db-timeout"].span_id), "Trace retrieval returns the actual child span");
  const logs = await call(owner, "search_logs", { ...w, service_name: services["qyl-mcp"], severity_min: 17 });
  check(logs.logs.length === 8, "Log query retains every seeded expected timeout error");

  const metrics = await call(owner, "list_metrics", { ...w, service_name: services.http, text: "http.server.request.duration" });
  check(metrics.items.some(item => item.kind === "histogram" && item.unit === "s"), "Metric catalog preserves histogram kind and seconds");
  const streams = await call(owner, "get_metric_series", { ...w, metric_name: "http.server.request.duration", matchers: metricMatchers });
  check(streams.items.length === 2, "Metric series selector isolates both fixture routes");
  const points = await call(owner, "get_metric_series", { ...w, metric_name: "http.server.request.duration", series_id: streams.items[0].series_id, points_limit: 2 });
  check(points.points.items.length > 0, "Original metric points are returned without substituting projections");
  const increase = await call(owner, "query_metric", { ...w, metric_name: "requests.total", function: "increase", step_ms: 3_600_000, matchers: metricMatchers });
  check(increase.series.flatMap(stream => stream.buckets).reduce((sum, bucket) => sum + (bucket.value ?? 0), 0) === 90, "Counter query measures the actual increase of 90");
  const ci = await call(owner, "ci_log", { ...w, run_id: sessions.ci_current, compare_to: "last_success" });
  check(ci.comparison.new_failures.some(item => item.leg === "test"), "CI analysis retains the deliberately failed test leg");

  const created = await call(owner, "create_annotation", { target: { kind: "trace", trace_id: key["db-root"].trace_id },
    text: `Owner verification ${fixture.run_id}`, labels: ["owner-verification"], classification: "finding", idempotency_key: `${fixture.run_id}-annotation` });
  owned.set(created.annotation.id, { kind: "annotation", ...created.annotation });
  const annotated = await call(owner, "get_trace", { ...w, trace_id: key["db-root"].trace_id });
  check(annotated.annotations.some(item => item.id === created.annotation.id), "Created annotation is read back through the trace tool");
  const changed = await call(owner, "update_annotation", { id: created.annotation.id, etag: created.annotation.etag, text: `Verified update ${fixture.run_id}` });
  owned.set(changed.annotation.id, { kind: "annotation", ...changed.annotation });
  const reread = await call(owner, "get_trace", { ...w, trace_id: key["db-root"].trace_id });
  check(reread.annotations.some(item => item.id === changed.annotation.id && item.text === changed.annotation.text), "Updated annotation persists with its new text");

  const saved = await call(owner, "create_saved_query", { name: `owner-verification-${fixture.run_id}`, filter: { signal: "traces", service_name: services.checkout, lookback_minutes: 60 }, idempotency_key: `${fixture.run_id}-query` });
  owned.set(saved.saved_query.id, { kind: "saved_query", ...saved.saved_query });
  const updated = await call(owner, "update_saved_query", { id: saved.saved_query.id, etag: saved.saved_query.etag, description: `Verified owner query ${fixture.run_id}` });
  owned.set(updated.saved_query.id, { kind: "saved_query", ...updated.saved_query });
  const queries = await call(owner, "list_saved_queries", { signal: "traces", limit: 100 });
  check(queries.saved_queries.some(item => item.id === updated.saved_query.id && item.description === updated.saved_query.description), "Updated saved query is listed with persisted metadata");
  const run = await call(owner, "run_saved_query", { ...w, id: updated.saved_query.id });
  check(run.result.items.some(item => item.trace_id === key["db-root"].trace_id), "Saved query executes against recorded fixture telemetry");

  latestFailure = (await call(owner, "update_failure_status", { failure_id: failure.failure_id, etag: failure.etag, status: "ignored" })).failure;
  check(latestFailure.status === "ignored", "Owner can update only the isolated fixture's failure status");
  const changedFailures = await call(owner, "list_failures", { ...w, failure_id: failure.failure_id, status: "all" });
  check(changedFailures.failures[0].status === "ignored", "Changed failure status is read back");

  const reviewerOwn = await raw(reviewer, "reviewer", "get_trace", { ...foreign.window, trace_id: foreign.keys["db-root"].trace_id });
  check(!reviewerOwn.isError && reviewerOwn.structuredContent.trace.spans.length > 0, "Reviewer reads its own fixture with the real login");
  await notFound(reviewer, "reviewer", "get_trace", { ...w, trace_id: key["db-root"].trace_id });
  await notFound(owner, "owner", "get_trace", { ...foreign.window, trace_id: foreign.keys["db-root"].trace_id });
  await notFound(reviewer, "reviewer", "run_saved_query", { ...w, id: updated.saved_query.id });
} catch (error) {
  failed = true;
  evidence.failure = { name: error.name, message: error.message };
  console.error(`FAIL\t${error.message}`);
} finally {
  if (owner && latestFailure) {
    try {
      const restored = await call(owner, "update_failure_status", { failure_id: originalFailure.failure_id, etag: latestFailure.etag, status: originalFailure.status });
      check(restored.failure.status === originalFailure.status, "Fixture failure status is restored");
    } catch (error) { failed = true; evidence.cleanup_errors.push({ kind: "failure_status", message: error.message }); }
  }
  if (owner) for (const item of owned.values()) {
    try {
      const deleted = await call(owner, "delete_record", { kind: item.kind, id: item.id, etag: item.etag });
      check(deleted.deleted === true, `Owned ${item.kind} is deleted after verification`);
    } catch (error) { failed = true; evidence.cleanup_errors.push({ kind: item.kind, id: item.id, message: error.message }); }
  }
  // delete_record is exercised during cleanup. Evaluate completeness only after every owned
  // object was removed, and never count an expected rejection as a successful operation.
  const complete = !!listing && listing.tools.every(tool => succeeded.has(tool.name));
  if (listing && !complete) {
    failed = true;
    evidence.missing_successes = listing.tools.map(tool => tool.name).filter(name => !succeeded.has(name));
  }
  evidence.assertions.push({ label: "Every listed hosted tool completed a successful authorized operation; isolation refusals are separate", passed: complete });
  for (const client of connections) {
    try { await client.close(); }
    catch (error) { failed = true; evidence.cleanup_errors.push({ kind: "client", message: error.message }); }
  }
  evidence.finished_at = new Date().toISOString();
  evidence.successful_tools = [...succeeded].sort((left, right) => left.localeCompare(right));
  evidence.passed = !failed;
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  chmodSync(output, 0o600);
}
console.log(`${failed ? "FAILED" : "VERIFIED"}: ${succeeded.size}/${listing?.tools.length ?? "?"} listed hosted tools succeeded; evidence ${output}`);
process.exitCode = failed ? 1 : 0;
