/** Integration answer key: real OTLP ingest -> collector -> MCP -> generated validators. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from './dist/server.js';
const fixture = JSON.parse(await readFile(process.env.QYL_ANSWER_KEY_FILE ?? new URL('missing-answer-key-use-run-answer-key', import.meta.url),'utf8'));
process.env.QYL_COLLECTOR_URL = process.env.QYL_ANSWER_KEY_COLLECTOR ?? 'http://127.0.0.1:5510';
process.env.QYL_PROJECT = fixture.project;
delete process.env.QYL_API_KEY;
delete process.env.MCP_COLLECTOR_PROJECTS;
const w=fixture.window, key=fixture.keys;
const scoped=(service)=>({ ...w, matchers:[{key:'service.name',op:'eq',value:service,scope:'resource'}] });
async function withClient(run, project = fixture.project) {
 const previousProject=process.env.QYL_PROJECT;
 process.env.QYL_PROJECT=project;
 const handler=createMcpHandler(()=>createServer({nativeExecution:false}));
 const client=new Client({name:'qyl-answer-key',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
 await client.connect(new StreamableHTTPClientTransport(new URL('http://qyl.test/mcp'),{fetch:(url,init)=>handler.fetch(new Request(url,init))}));
 try {return await run(async(name,args={})=>{
   const result=await client.callTool({name,arguments:args});
   assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
   assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 24_000, name+' exceeds response budget');
   if (!['create_annotation','update_failure_status'].includes(name)) {
     assert(result.structuredContent.window, name+' omits absolute window');
     assert(result.structuredContent.coverage, name+' omits coverage');
   }
   return result.structuredContent;
 });} finally {await client.close();await handler.close();process.env.QYL_PROJECT=previousProject;}
}
async function failures(call) {
 return (await call('list_failures',{...w,service_name:'checkout',status:'all'})).failures;
}
const registrations=[];
function verify(name,run){registrations.push(name);void test(name,{concurrency:false},()=>withClient(run));}
function verifyIsolated(name,run){
 registrations.push(name);
 void test(name,{concurrency:false},async()=>{
  const project='answer-key-'+randomBytes(8).toString('hex');
  const output=join(dirname(process.env.QYL_ANSWER_KEY_FILE),project+'.json');
  const repo=process.env.QYL_COLLECTOR_REPO??fileURLToPath(new URL('../../qyl',import.meta.url));
  await promisify(execFile)('python3',[join(repo,'tests/Qyl.Collector.Tests/Fixtures/seed-answer-key.py'),process.env.QYL_ANSWER_KEY_OTLP,output,project]);
  await withClient(run,project);
 });
}
verify('01 triage ranks F first, includes rare R and silent billing, excludes healthy sess_ok',async call=>{
 const data=await call('triage',{...w,matchers:[{key:'service.name',op:'in',values:['checkout','orders-db','payments','billing','sessions'],scope:'resource'}]});
 const F=(await failures(call)).find(f=>f.operation==='checkout'); assert(F);
 assert.equal(data.failures[0].failure_id,F.failure_id);
 assert.equal(data.failures[0].coinciding_release.version,'1.4.1');
 assert(data.failures.some(f=>f.count===2 && f.services.includes('payments')));
 assert(data.silent_services.some(s=>s.service==='billing'));
 const sessionFailures = data.failures.filter(f => f.services.includes('sessions'));
 assert.equal(sessionFailures.length, 1);
 assert.equal(sessionFailures[0].count, 3, 'only sess_bad contributes failures');
 const badIds = new Set(Object.entries(key).filter(([name]) => name.startsWith('sess_bad-')).map(([, id]) => id.trace_id));
 assert(badIds.has(sessionFailures[0].example_trace_id));
 const healthyIds = new Set(Object.entries(key).filter(([name]) => name.startsWith('sess_ok-')).map(([, id]) => id.trace_id));
 assert(data.failures.every(f => !healthyIds.has(f.example_trace_id)));
 assert(!data.regressions.some(r => r.service === 'sessions'));
 assert(!data.silent_services.some(r => r.service === 'sessions'));
});
verify('02 db chain yields two stable failure ids',async call=>{
 const time=Date.parse(fixture.T)+60_000;
 const args={start_time:new Date(time-10).toISOString(),end_time:new Date(time+500).toISOString()};
 const a=await call('list_failures',args),b=await call('list_failures',args);
 assert.equal(a.failures.length,2);assert.deepEqual(a.failures.map(f=>f.failure_id),b.failures.map(f=>f.failure_id));
});
verify('03a db child is the root cause, not propagated checkout error',async call=>{
 const data=await call('get_failure_context',{...w,trace_id:key['db-root'].trace_id});
 assert.equal(data.observed.root_cause_span.span_id,key['db-timeout'].span_id);
});
verify('03b newly arrived execution remains unsettled',async call=>{
 const trace=randomBytes(16).toString('hex'),span=randomBytes(8).toString('hex'),now=BigInt(Date.now())*1_000_000n;
 const response=await fetch((process.env.QYL_ANSWER_KEY_OTLP ?? 'http://127.0.0.1:5518')+'/v1/traces',{method:'POST',headers:{'content-type':'application/json','x-qyl-project':fixture.project},body:JSON.stringify({resourceSpans:[{resource:{attributes:[{key:'qyl.project.id',value:{stringValue:fixture.project}},{key:'service.name',value:{stringValue:'arrival-test'}}]},scopeSpans:[{spans:[{traceId:trace,spanId:span,name:'arrival',kind:2,startTimeUnixNano:String(now-1_000_000n),endTimeUnixNano:String(now),status:{code:2}}]}]}]})});assert.equal(response.status,200);
 const data=await call('get_failure_context',{trace_id:trace,lookback_minutes:60});assert.equal(data.settled,false);
});
verify('04 error-group discriminators are eu and service version 2.3',async call=>{
 const data=await call('compare_groups',{...scoped('regional'),signal:'spans',group_a:{matchers:[{key:'error.type',op:'exists'}]},group_b:'rest',attribute_scope:'both'});
 assert.deepEqual(new Set(data.discriminators.slice(0,2).map(x=>`${x.key}=${x.value}`)),new Set(['cloud.region=eu','service.version=2.3']));
});
verify('05 db executions first diverge at db status',async call=>{
 const data=await call('compare_traces',{...w,a:{trace_id:key['db-root'].trace_id},b:{trace_id:key['db-success-root'].trace_id}});
 assert.equal(data.first_divergence.kind,'status');assert.equal(data.first_divergence.a_span.span_id,key['db-timeout'].span_id);
});
verify('06 four requests after fix need another96',async call=>{
 const F=(await failures(call)).find(f=>f.operation==='checkout');assert(F);
 const data=await call('verify_fix',{...w,failure_id:F.failure_id,since:fixture.T2});assert.equal(data.verdict,'pending');assert.equal(data.needs.requests,96);
});
verify('07a checkout span p95 is1840ms',async call=>{
 const data=await call('aggregate_telemetry',{...scoped('http'),signal:'spans',group_by:['http.route'],measures:['duration_p95']});
 assert(Math.abs(data.groups.find(g=>g.key['http.route']==='/checkout').measures.duration_p95-1840)<1);
});
verify('07b MCP aggregate error rate is8/40',async call=>{
 const data=await call('aggregate_telemetry',{...w,signal:'spans',matchers:[{key:'mcp.method.name',op:'eq',value:'tools/call'}],group_by:['gen_ai.tool.name'],measures:['count','error_count','error_rate']});
 const group=data.groups.find(g=>g.key['gen_ai.tool.name']==='search_logs');assert.equal(group.measures.count,40);assert.equal(group.measures.error_rate,.2);
});
verify('08 region cardinality2 includes semantic definition',async call=>{
 const data=await call('discover_attributes',{...scoped('regional'),signal:'resources'});const region=data.attributes.find(a=>a.key==='cloud.region');assert.equal(region.cardinality,2);assert(region.semconv.brief.length>0);
});
verify('09 identical agent call and argument hashes repeated3times',async call=>{
 const data=await call('get_agent_run',{...w,session_id:'agent_run'});assert.equal(data.findings.repeated_calls[0].count,3);
});
verify('10 release1.4.1 first observed atT with F',async call=>{
 const F=(await failures(call)).find(f=>f.operation==='checkout');assert(F);
 const data=await call('list_releases',{...w,service_name:'checkout'});const release=data.releases.find(r=>r.version==='1.4.1');assert.equal(Date.parse(release.first_seen),Date.parse(fixture.T));assert(release.new_failure_ids.includes(F.failure_id));
});
verify('11 checkout calls orders-db with errors',async call=>{
 const data=await call('get_service_map',w);const edge=data.edges.find(e=>e.from==='checkout'&&e.to==='orders-db');assert(edge);assert(edge.error_rate>0);
});
verify('12 silent billing last seen2hours beforeseed',async call=>{
 const data=await call('check_telemetry_health',w);const service=data.silent_services.find(s=>s.service==='billing');assert.equal(Date.parse(service.last_seen),Date.parse(fixture.now)-7_200_000);
});
verify('13 MCP stats preserve denominator, failure class and exampleids',async call=>{
 const data=await call('get_mcp_stats',{...w,tool_name:'search_logs'});const group=data.groups.find(g=>g.name==='search_logs');assert.equal(group.requests,40);assert.equal(group.errors,8);assert.equal(group.error_rate,.2);assert.equal(data.failure_classes.timeout,8);assert(group.example_trace_ids.length>0);
 for (const id of group.example_trace_ids) {
   const trace = await call('get_trace', {...w, trace_id:id});
   assert(trace.trace.spans.some(span => span.status.code === 2), 'example must contain an error');
 }
});
verify('14 active error filter returns only sess_bad',async call=>{
 const data=await call('list_sessions',{...w,active_only:true,has_error:true});assert.deepEqual(data.sessions.map(s=>s.session_id),['sess_bad']);
});
verify('15 sess_bad errors returns3traces',async call=>{const data=await call('list_traces',{...w,session_id:'sess_bad',errors_only:true});assert.equal(data.traces.length,3);});
verify('16a critical path is rooted under checkout',async call=>{const data=await call('get_trace',{...w,trace_id:key['latency-/checkout-0'].trace_id,selection:'critical_path'});assert(data.trace.spans.every(s=>s.name.includes('/checkout')));assert(data.trace.spans.length>0);});
verify('16b error ancestors include root as context',async call=>{const data=await call('get_trace',{...w,trace_id:key['db-root'].trace_id,selection:'errors_with_ancestors'});assert.equal(data.trace.spans.find(s=>s.span_id===key['db-root'].span_id).role,'context');});
verify('17 grouped timeout log pattern count8',async call=>{const data=await call('search_logs',{...scoped('qyl-mcp'),group_by:'pattern'});assert(data.patterns.some(p=>p.count===8&&/timeout/.test(p.template)));});
verify('18 duration histogram reports seconds and p95support',async call=>{const data=await call('list_metrics',{...w,text:'http.server.request.duration'});const metric=data.items.find(m=>m.name==='http.server.request.duration');assert.equal(metric.kind,'histogram');assert.equal(metric.unit,'s');assert(metric.supported_aggregations.includes('p95'));});
verify('19 metric route cardinality2 suggested for grouping',async call=>{const data=await call('get_metric_series',{...w,metric_name:'http.server.request.duration'});assert.equal(data.keys.find(k=>k.key==='http.route').cardinality,2);assert(data.suggested_group_by.includes('http.route'));});
verify('20a histogram p95 remains seconds and approximate',async call=>{const data=await call('query_metric',{...w,metric_name:'http.server.request.duration',aggregation:'p95',group_by:['http.route'],step_ms:3_600_000});assert.equal(data.unit,'s');assert.equal(data.approximate,true);const checkout=data.series.find(s=>s.attributes.some(a=>a.key==='http.route'&&a.value==='/checkout'));assert(checkout);const values=checkout.buckets.map(b=>b.value).filter(v=>v!==null);assert(values.some(v=>Math.abs(v-1.84)<.1),JSON.stringify(values));});
verify('20b cumulative100,150,190 increase90',async call=>{const data=await call('query_metric',{...w,metric_name:'requests.total',function:'increase',step_ms:3_600_000});assert.equal(data.series.flatMap(s=>s.buckets).reduce((sum,b)=>sum+(b.value??0),0),90);});
verify('21 CI new test failure and build3xregression',async call=>{const data=await call('ci_log',{...w,run_id:'ci_current',compare_to:'last_success'});assert(data.comparison.new_failures.some(p=>p.leg==='test'));assert(data.comparison.duration_regressions.some(p=>p.leg==='build'&&p.ratio===3));});
verifyIsolated('27 annotation on F read back as count1',async call=>{const F=(await failures(call)).find(f=>f.operation==='checkout');assert(F);await call('create_annotation',{target:{kind:'failure',failure_id:F.failure_id},text:'Answer-key finding',classification:'finding',labels:['answer-key'],idempotency_key:'answer-key-finding'});const data=await call('list_failures',{...w,failure_id:F.failure_id});assert.equal(data.failures[0].annotation_count,1);});
verifyIsolated('32a ignored F suppressed fromtriage',async call=>{const F=(await failures(call)).find(f=>f.operation==='checkout');assert(F);const saved=await call('update_failure_status',{failure_id:F.failure_id,etag:F.etag,status:'ignored'});assert.equal(saved.failure.status,'ignored');try { assert(!(await call('triage',w)).failures.some(f=>f.failure_id===F.failure_id)); } finally { await call('update_failure_status',{failure_id:F.failure_id,etag:saved.failure.etag,status:'open'}); }});
verifyIsolated('32b resolved F recurrence markedregressed',async call=>{
 const F=(await failures(call)).find(f=>f.operation==='checkout');assert(F);const resolved=await call('update_failure_status',{failure_id:F.failure_id,etag:F.etag,status:'resolved'});
 const now=BigInt(Date.now())*1_000_000n;
 const response=await fetch((process.env.QYL_ANSWER_KEY_OTLP??'http://127.0.0.1:5518')+'/v1/traces',{method:'POST',headers:{'content-type':'application/json','x-qyl-project':process.env.QYL_PROJECT},body:JSON.stringify({resourceSpans:[{resource:{attributes:[{key:'qyl.project.id',value:{stringValue:process.env.QYL_PROJECT}},{key:'service.name',value:{stringValue:'checkout'}},{key:'service.version',value:{stringValue:'1.4.1'}}]},scopeSpans:[{spans:[{traceId:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),name:'checkout',kind:2,startTimeUnixNano:String(now-1_000_000n),endTimeUnixNano:String(now),status:{code:2,message:'dependency failed'},attributes:[{key:'error.type',value:{stringValue:'downstream'}}]}]}]}]})});assert.equal(response.status,200);
 try { const data=await call('triage',{lookback_minutes:60});assert.equal(data.failures.find(f=>f.failure_id===F.failure_id).change,'regressed'); } finally { await call('update_failure_status',{failure_id:F.failure_id,etag:resolved.failure.etag,status:'open'}); }
});


// Existing projection and paging semantics stay exercised against real storage.
verify('regression get_trace removes all attribute collections without changing totals', async call=>{
 const args={...w,trace_id:key['db-root'].trace_id};
 const complete=await call('get_trace',args);
 const compact=await call('get_trace',{...args,include_attributes:false,max_spans:1});
 assert.equal(compact.trace.span_count,complete.trace.span_count);
 assert.equal(compact.trace.duration_ns,complete.trace.duration_ns);
 assert.equal(compact.trace.spans.length,1);
 assert(!JSON.stringify(compact.trace).includes('"attributes"'));
 const repeated=await call('get_trace',args);assert.deepEqual(repeated.trace,complete.trace);
});
verify('regression get_trace filters errors before capping and returns empty matches honestly', async call=>{
 const selected=await call('get_trace',{...w,trace_id:key['db-root'].trace_id,errors_only:true,max_spans:1});
 assert.equal(selected.trace.spans.length,1);assert.equal(selected.trace.spans[0].status.code,2);
 const empty=await call('get_trace',{...w,trace_id:key['db-success-root'].trace_id,errors_only:true});
 assert.deepEqual(empty.trace.spans,[]);assert.equal(empty.trace.root_span,undefined);assert(empty.trace.span_count>0);
});
verify('regression pagination filters before issuing opaque cursors', async call=>{
 const args={...w,session_id:'sess_bad',errors_only:true,limit:1};
 const first=await call('list_traces',args);assert.equal(first.traces.length,1);assert(first.has_more);assert(first.next_cursor);
 const second=await call('list_traces',{...args,cursor:first.next_cursor});
 assert.equal(second.traces.length,1);assert.notEqual(first.traces[0].trace_id,second.traces[0].trace_id);
 assert(first.traces[0].has_error && second.traces[0].has_error);
});

console.log(`Registered ${registrations.length} answer-key Verify checks through real MCP calls.`);
