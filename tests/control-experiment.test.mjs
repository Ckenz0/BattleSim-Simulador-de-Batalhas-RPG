import test from 'node:test';
import assert from 'node:assert/strict';
import * as experiment from '../frontend/js/control-experiment.mjs';

const snapshot=(replicas=1,cpu=0)=>({observed_at:'2026-11-13T12:00:00Z',
  application:{completed:10,failed:0,pending:0,processing:0,unpublished:0},
  broker:{status:'ok',observed_at:'2026-11-13T12:00:00Z',queues:[{name:'battles.requests.v1',ready:0,unacknowledged:0}]},
  cluster:{status:'ok',observed_at:'2026-11-13T12:00:00Z',hpa:{min_replicas:1,max_replicas:5,current_replicas:replicas,desired_replicas:replicas,target_cpu_percent:60,current_cpu_percent:cpu}}});
function setup(options={}){let now=Date.parse('2026-11-13T12:00:00Z');return {recorder:new experiment.ExperimentRecorder({now:()=>now,...options}),tick:(ms=5000)=>now+=ms};}

test('collection only accepts observations while running and copies source data',()=>{
  assert.equal(typeof experiment.ExperimentRecorder,'function');
  const {recorder:r,tick}=setup(),data=snapshot();
  r.observe(data);assert.equal(r.samples.length,0);r.start();r.observe(data);
  data.application.completed=999;assert.equal(r.samples[0].snapshot.application.completed,10);
  tick();r.stop();r.observe(snapshot(5));assert.equal(r.samples.length,1);assert.equal(r.state,'stopped');
  assert.throws(()=>r.start(),/Nova coleta/);r.reset();r.start();assert.equal(r.samples.length,0);
});
test('missing or failed sources stay null while measured zero stays zero',()=>{
  const {recorder:r,tick}=setup();r.start();r.observe(snapshot());tick();
  const data=snapshot(3,null);data.broker.status='unavailable';data.cluster.hpa_error_code='http_503';r.observe(data);
  assert.equal(r.samples[0].values.cpu,0);assert.equal(r.samples[0].values.ready,0);
  assert.equal(r.samples[1].values.cpu,null);assert.equal(r.samples[1].values.ready,null);assert.equal(r.samples[1].values.replicas,null);
});
test('failed reads and pauses produce gaps, never reused stale measurements',()=>{
  const {recorder:r,tick}=setup();r.start();r.observe(snapshot());tick();r.fail();tick();
  r.setPaused(true);r.observe(snapshot(5));assert.equal(r.samples.length,2);tick(20000);r.setPaused(false);r.observe(snapshot(3));
  assert.equal(r.samples[1].kind,'unavailable');assert.equal(r.samples[1].values.replicas,null);
  assert.equal(r.samples[2].breakBefore,true);assert.equal(r.pauses.length,1);assert.ok(r.pauses[0].ended_at);
});
test('limit ends the recording without dropping earlier evidence',()=>{
  const {recorder:r,tick}=setup({maxSamples:2});r.start();r.observe(snapshot());tick();r.observe(snapshot(5));
  assert.equal(r.state,'stopped');assert.equal(r.stopReason,'limit');r.observe(snapshot(1));assert.equal(r.samples.length,2);
});
test('summary distinguishes fixed capacity, variable HPA and unavailable cluster',()=>{
  assert.equal(experiment.profileOf(snapshot().cluster).kind,'variable');
  const fixed=snapshot().cluster;fixed.hpa.min_replicas=5;assert.equal(experiment.profileOf(fixed).kind,'fixed');
  assert.equal(experiment.profileOf({status:'not_configured'}).kind,'compose');
  assert.equal(experiment.profileOf({status:'unavailable',hpa:fixed.hpa}).kind,'unavailable');
  const {recorder:r,tick}=setup();r.start();for(const n of [1,3,5,3,1]){r.observe(snapshot(n));tick();}
  assert.deepEqual(r.summary().replicas,[1,3,5,3,1]);assert.equal(r.summary().completedDelta,0);
});
test('profile changes and counter resets remain visible without false batch totals',()=>{
  const {recorder:r,tick}=setup();r.start();r.observe(snapshot());tick();
  const fixed=snapshot(5);fixed.cluster.hpa.min_replicas=5;fixed.application.completed=2;r.observe(fixed);
  assert.equal(r.summary().profileChanged,true);assert.equal(r.summary().completedDelta,null);assert.equal(r.summary().counterReset,true);
});
test('exports include gaps, source timestamps and original snapshots as a stable copy',()=>{
  const {recorder:r,tick}=setup();r.start();r.observe(snapshot());tick();r.fail();r.stop();
  const json=JSON.parse(r.exportJSON()),csv=r.exportCSV();
  assert.equal(json.schema_version,1);assert.equal(json.samples.length,2);assert.ok(json.samples[0].snapshot.broker.observed_at);
  assert.equal(json.scope,'browser_observation');assert.equal(json.samples[1].snapshot,null);
  assert.equal(csv.split('\r\n').length,4);assert.match(csv,/received_at,observed_at,kind/);assert.match(csv,/unavailable/);
  json.samples[0].snapshot.application.completed=500;assert.equal(r.samples[0].snapshot.application.completed,10);
});

test('chart segments break for unavailable measurements, explicit pauses and clock gaps',()=>{
  assert.equal(typeof experiment.seriesSegments,'function');
  const rows=[{elapsed_seconds:0,values:{cpu:0}},{elapsed_seconds:5,values:{cpu:null}},
    {elapsed_seconds:10,values:{cpu:60}},{elapsed_seconds:15,breakBefore:true,values:{cpu:80}}];
  assert.deepEqual(experiment.seriesSegments(rows,'cpu'),[[[0,0]],[[10,60]],[[15,80]]]);
});

test('a response or failure from an earlier collection cannot contaminate a new one',()=>{
  const {recorder:r}=setup();r.start();const oldRun=r.runId;r.stop();r.reset();r.start();
  r.observe(snapshot(5),oldRun);r.fail(oldRun);assert.equal(r.samples.length,0);
  r.observe(snapshot(1),r.runId);assert.equal(r.samples.length,1);
});
