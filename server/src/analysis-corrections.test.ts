import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { contractSchema, GetTraceOutputSchema } from "./contract-validation.js";
import { queryAnalysis } from "./analysis-client.js";
import { analysisSummary } from "./analysis-summary.js";
import { compactAnalysisResult, responseBytes, ANALYSIS_RESPONSE_BYTES } from "./analysis-budget.js";
import { collectorPost } from "./collector.js";
import { readContext, toolTrace } from "./analysis-context.test-helper.js";
import type { SpanId } from "@ancplua/qyl-api-schema/types";
import { getTelemetryFixture } from "./telemetry-fixtures.test-helper.js";

function environment(context: TestContext): void {
  const keys = ["MCP_COLLECTOR_PROJECTS", "QYL_API_KEY", "QYL_PROJECT", "QYL_COLLECTOR_URL"];
  const prior = keys.map(key => [key, process.env[key]] as const);
  keys.forEach(key => delete process.env[key]);
  process.env.QYL_COLLECTOR_URL = "http://collector.test";
  context.after(() => prior.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
}

test("budget re-query preserves filters and accepts Collector's smaller page and cursor", async context => {
  environment(context);
  const queries: Array<Record<string, unknown>> = [];
  context.mock.method(globalThis, "fetch", async (_: unknown, init?: RequestInit) => {
    assert.equal(typeof init?.body, "string");
    const input = JSON.parse(init?.body as string) as Record<string, unknown>; queries.push(input);
    const count = queries.length === 1 ? 100 : 2;
    return Response.json({ ...readContext(count), has_more:true, next_cursor:"signed-next-page",
      attributes:Array.from({length:count}, (_, i) => ({key:`key-${i}`,scope:"span",type:"string",cardinality:1,cardinality_exact:true,coverage_share:1,
        top_values:[{value:"x".repeat(1000),count:1,share:1}],semconv:null})),
    });
  });
  const result = await queryAnalysis("discover_attributes", {lookback_minutes:60, key_prefix:"key", limit:100}, contractSchema("Mcp.Tools.DiscoverAttributesOutput"), {collector:{},step:async () => {}});
  assert.equal(queries.length,2); assert.equal(queries[1]?.key_prefix,"key"); assert.equal(queries[1]?.lookback_minutes,60);
  assert.equal(queries[1]?.start_time,readContext().window.start_time);
  assert.equal(queries[1]?.end_time,readContext().window.end_time);
  assert.equal(queries[1]?.start,undefined,"output window names are not input fields");
  assert(Number(queries[1]?.limit)<100); assert.equal((result.structuredContent as Record<string, unknown>)?.next_cursor,"signed-next-page");
  assert(responseBytes(result)<=ANALYSIS_RESPONSE_BYTES); assert.match(JSON.stringify(result.content),/Matched 2/u);
});

test("one oversized trace is compacted with explicit omissions and a valid contract", () => {
  const trace = toolTrace(getTelemetryFixture().traces[0]!);
  trace.spans = Array.from({length:300}, (_, index) => ({...trace.spans[0]!,span_id:index.toString(16).padStart(16,"0") as SpanId, name:"large span "+index,
    attributes:[{key:"recorded.evidence",value:"detail ".repeat(2000)}]}));
  const output = { ...readContext(300), trace, has_more:false, logs:[], annotations:[], links:[], span_roles:[], omitted:{matched:0,context:0}, mode:"live", settled:true };
  const result = compactAnalysisResult("get_trace",output);
  assert(responseBytes(result)<=ANALYSIS_RESPONSE_BYTES);
  GetTraceOutputSchema.parse(result.structuredContent);
  const content = GetTraceOutputSchema.parse(result.structuredContent);
  assert.equal(content.coverage.truncated,true); assert.equal(content.coverage.returned,null);
  assert(Object.values(content.page_totals as Record<string, number>).some(value => value>0));
  assert.match(JSON.stringify(result.content),/other evidence item/u);
  assert.equal(trace.spans.length,300,"compaction cannot mutate cached evidence");
});

test("null coverage is reported as unknown rather than zero", () => {
  assert.match(analysisSummary("list_traces",{...readContext(),coverage:{...readContext().coverage,examined:null,matched:null,returned:null,scan_complete:false}}), /Matched unknown; returned unknown/u);
});

test("every nested matcher input rejects 33 matchers and triage rejects 51", () => {
  const matchers = Array.from({length:33},()=>({key:"service.name",op:"eq",value:"checkout"}));
  for (const [name,input] of [
    ["CompareGroupsInput",{signal:"spans",group_a:{matchers},group_b:"rest"}],
    ["CompareGroupsInput",{signal:"spans",group_a:{},group_b:{matchers}}],
    ["QueryMetricInput",{metric_name:"count",ratio_of:{metric_name:"total",matchers}}],
    ["FetchTelemetryInput",{view:"traces",matchers}],
    ["FetchTelemetryInput",{view:"logs",matchers}],
    ["FetchTelemetryInput",{view:"metrics",matchers}],
    ["TriageInput",{limit:51}],
  ] as const) assert.equal(contractSchema(`Mcp.Tools.${name}`).safeParse(input).success,false,name);
});

test("Collector problem details never reach the model-facing exception", async context => {
  environment(context);
  context.mock.method(globalThis,"fetch",async () => Response.json({type:"https://qyl.at/problems/internal-error",title:"secret-title",status:500,code:"internal_error",detail:"private database query with secret"},{status:500,headers:{"content-type":"application/problem+json"}}));
  await assert.rejects(collectorPost("/api/v1/test", {}), error => error instanceof Error && !/secret|private database/u.test(error.message));
});
