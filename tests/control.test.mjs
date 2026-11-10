import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlMonitor,TraceMonitor,formatMetric,formatMemory,validBattleId} from '../frontend/js/control.mjs';

const A='00000000-0000-4000-8000-000000000001';
const B='00000000-0000-4000-8000-000000000002';
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function scheduler(){const scheduled=new Map();let index=0;return {scheduled,schedule:(callback,delay)=>{scheduled.set(++index,{callback,delay});return index;},cancel:id=>scheduled.delete(id)};}

test('default browser timers never receive the monitor as their Window receiver',async t=>{
  // Node accepts arbitrary timer receivers; browser Window timers throw Illegal invocation.
  // Model that host contract while exercising the real constructor defaults.
  const scheduled=[],cancelled=[];
  const receiverCheck=receiver=>assert.ok(receiver===undefined || receiver===globalThis,'Illegal invocation: timer receiver must be Window');
  t.mock.method(globalThis,'setTimeout',function(callback,delay){receiverCheck(this);scheduled.push({callback,delay});return 123;});
  t.mock.method(globalThis,'clearTimeout',function(timer){receiverCheck(this);cancelled.push(timer);});
  const monitor=new ControlMonitor({api:async()=>({observed_at:'2026-11-10T12:00:00Z'})});
  assert.doesNotThrow(()=>monitor.setVisible(true));await flush();
  assert.equal(monitor.loading,false);assert.equal(scheduled.length,1);assert.equal(scheduled[0].delay,5000);
  assert.doesNotThrow(()=>monitor.setVisible(false));assert.ok(cancelled.includes(123));
});

test('control room only polls while visible, at five-second intervals without overlapping requests',async()=>{
  const timer=scheduler(),first=defer();let calls=0,signal;
  const monitor=new ControlMonitor({...timer,api:(_path,options)=>{calls++;signal=options.signal;return first.promise;}});
  await monitor.refresh();assert.equal(calls,0);
  monitor.setVisible(true);await monitor.refresh();assert.equal(calls,1);assert.equal(monitor.loading,true);
  first.resolve({observed_at:'2026-11-10T12:00:00Z'});await flush();
  assert.equal(monitor.loading,false);assert.equal(timer.scheduled.size,1);assert.equal([...timer.scheduled.values()][0].delay,5000);
  monitor.setVisible(false);assert.equal(timer.scheduled.size,0);assert.equal(signal.aborted,true);
  await monitor.refresh();assert.equal(calls,1);
});

test('hiding the room aborts its request and a stale response cannot replace a resumed observation',async()=>{
  const old=defer(),current=defer(),timer=scheduler();let calls=0,oldSignal;
  const monitor=new ControlMonitor({...timer,api:(_path,{signal})=>{if(!calls++){oldSignal=signal;return old.promise;}return current.promise;}});
  monitor.setVisible(true);monitor.setVisible(false);assert.equal(oldSignal.aborted,true);
  monitor.setVisible(true);current.resolve({value:'fresh'});await flush();old.resolve({value:'stale'});await flush();
  assert.deepEqual(monitor.data,{value:'fresh'});assert.equal(monitor.loading,false);assert.equal(timer.scheduled.size,1);
});

test('a failed control read retains the last observed values, displays a safe error and retries',async()=>{
  const timer=scheduler();let calls=0;
  const monitor=new ControlMonitor({...timer,api:async()=>{if(calls++)throw Error('amqp://secret:password@internal');return {application:{pending:12}};}});
  monitor.setVisible(true);await flush();await monitor.refresh();
  assert.equal(monitor.data.application.pending,12);assert.match(monitor.error,/próxima consulta/);
  assert.doesNotMatch(monitor.error,/secret|password|internal/);assert.equal(timer.scheduled.size,1);
});

test('trace rejects malformed IDs before issuing a request and reads fixed bounded pages',async()=>{
  const paths=[];const monitor=new TraceMonitor({api:async path=>{paths.push(path);return {items:[],total:205};}});
  monitor.setVisible(true);assert.throws(()=>monitor.open('../health'),/UUID/);assert.equal(paths.length,0);
  monitor.open(A);await flush();assert.equal(paths[0],'/battles/'+A+'/trace?limit=100&offset=0');
  monitor.page(100);await flush();assert.match(paths[1],/limit=100&offset=100$/);
  monitor.page(200);await flush();assert.match(paths[2],/offset=200$/);
  monitor.page(300);monitor.page(-100);assert.equal(paths.length,3);
});

test('switching battles cancels the old trace and ignores its later failure',async()=>{
  const old=defer(),current=defer();let signal;
  const monitor=new TraceMonitor({api:(path,options)=>{if(path.includes(A)){signal=options.signal;return old.promise;}return current.promise;}});
  monitor.setVisible(true);monitor.open(A);monitor.open(B);assert.equal(signal.aborted,true);
  current.resolve({battle_id:B,items:[],total:0,coverage:'legacy_partial'});await flush();old.reject(Error('late error'));await flush();
  assert.equal(monitor.data.battle_id,B);assert.equal(monitor.data.coverage,'legacy_partial');assert.equal(monitor.error,null);
});

test('hidden trace requests cannot update data and opening another battle resets pagination',async()=>{
  const pending=defer();let calls=0;
  const monitor=new TraceMonitor({api:async()=>{calls++;return pending.promise;}});
  monitor.open(A);assert.equal(calls,0);monitor.setVisible(true);monitor.setVisible(false);
  pending.resolve({battle_id:A,total:200,items:[]});await flush();assert.equal(monitor.data,null);
  monitor.offset=100;monitor.open(B);assert.equal(monitor.offset,0);assert.equal(calls,1);
});

test('trace errors never expose service details and a missing battle has a recoverable message',async()=>{
  const monitor=new TraceMonitor({api:async()=>{const e=Error('private network details');e.status=404;throw e;}});
  monitor.setVisible(true);monitor.open(A);await flush();assert.match(monitor.error,/não encontrada/);assert.doesNotMatch(monitor.error,/private/);
});

test('missing telemetry stays unavailable while measured zero remains zero',()=>{
  for(const value of [null,undefined,NaN,Infinity,'0']){assert.equal(formatMetric(value),'Indisponível');assert.equal(formatMemory(value),'Indisponível');}
  assert.equal(formatMetric(0,'%'),'0 %');assert.equal(formatMemory(0),'0 MiB');assert.equal(formatMemory(1048576),'1 MiB');
  assert.equal(validBattleId(A),true);assert.equal(validBattleId('not-a-battle'),false);
});
