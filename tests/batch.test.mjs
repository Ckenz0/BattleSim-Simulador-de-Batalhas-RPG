import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchMonitor} from '../frontend/js/batch.mjs';

const A='00000000-0000-4000-8000-000000000001';
const B='00000000-0000-4000-8000-000000000002';
const memory=()=>{const values=new Map();return {getItem:key=>values.get(key) ?? null,setItem:(key,value)=>values.set(key,value)};};
const battle=(index,status='completed')=>({id:'battle-'+index,batch_id:A,status,
  participants:[{id:'a',name:'Astra',class_name:'mage'},{id:'b',name:'Borin',class_name:'warrior'}],
  result:status==='completed'?{winner_id:'a',turns:3}:null,worker_id:'worker-a',processing_ms:25});
const page=(items,total=items.length,offset=0)=>({items,total,limit:100,offset});
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('counts every paginated result while displaying no more than 100 cards',async()=>{
  const urls=[];
  const monitor=new BatchMonitor({api:async path=>{
    urls.push(path);const query=new URL('http://local'+path).searchParams;
    assert.equal(query.get('batch_id'),A);assert.equal(query.get('limit'),'100');
    const offset=Number(query.get('offset'));
    return page(Array.from({length:100},(_,i)=>battle(offset+i,offset+i<930?'completed':offset+i<950?'failed':offset+i<975?'processing':'pending')),1000,offset);
  },storage:memory()});
  monitor.accept({batch_id:A,count:1000,status:'pending'});
  await monitor.refresh();
  assert.equal(urls.length,10);
  assert.deepEqual(monitor.snapshot.counts,{pending:25,processing:25,completed:930,failed:20,unknown:0});
  assert.equal(monitor.snapshot.finished,950);
  assert.equal(monitor.snapshot.terminal,false);
  assert.equal(monitor.visibleItems.length,100);
  monitor.showPage(9);
  assert.equal(monitor.visibleItems[0].id,'battle-900');
  assert.equal(monitor.snapshot.total,1000);
});

test('a completed batch stops all future monitor reads, including failed terminal battles',async()=>{
  let calls=0;
  const monitor=new BatchMonitor({api:async()=>{calls++;return page([battle(1),battle(2,'failed')]);},storage:memory()});
  monitor.select(A,2);await monitor.refresh();await monitor.refresh();
  assert.equal(monitor.snapshot.terminal,true);assert.equal(monitor.snapshot.finished,2);assert.equal(calls,1);
});

test('reload resumes the selected batch and fetches its saved states',async()=>{
  const storage=memory();
  const first=new BatchMonitor({storage,api:async()=>page([])});
  first.accept({batch_id:A,count:100,status:'pending'});
  first.select(B,2);
  const resumed=new BatchMonitor({storage,api:async()=>page([battle(1,'pending'),battle(2,'processing')])});
  resumed.resume();
  assert.equal(resumed.batch.id,B);assert.equal(resumed.batch.count,2);
  assert.deepEqual(resumed.recent.map(x=>x.id),[B,A]);
  await resumed.refresh();assert.equal(resumed.snapshot.counts.processing,1);
});

test('an old batch response cannot replace a newer selected batch or its loading state',async()=>{
  const old=defer(),fresh=defer();
  const monitor=new BatchMonitor({storage:memory(),api:path=>path.includes(A)?old.promise:fresh.promise});
  monitor.select(A,1);const readingOld=monitor.refresh();
  monitor.select(B,1);const readingFresh=monitor.refresh();
  old.resolve(page([battle(1)]));await readingOld;
  assert.equal(monitor.batch.id,B);assert.equal(monitor.snapshot,null);assert.equal(monitor.loading,true);
  fresh.resolve(page([{...battle(2,'pending'),batch_id:B}]));await readingFresh;
  assert.equal(monitor.snapshot.counts.pending,1);assert.equal(monitor.loading,false);
});

test('an old batch error cannot mark the newly selected batch unavailable',async()=>{
  const old=defer();
  const monitor=new BatchMonitor({storage:memory(),api:path=>path.includes(A)?old.promise:Promise.resolve(page([battle(2)]))});
  monitor.select(A,1);const readingOld=monitor.refresh();monitor.select(B,1);await monitor.refresh();
  old.reject(new Error('offline'));await readingOld;
  assert.equal(monitor.batch.id,B);assert.equal(monitor.error,null);assert.equal(monitor.snapshot.terminal,true);
});

test('a failed follow-up GET keeps a confirmed submission saved and retryable',async()=>{
  let online=false;
  const storage=memory();
  const monitor=new BatchMonitor({storage,api:async()=>{if(!online)throw Error('Sem conexão');return page([battle(1,'processing')]);}});
  monitor.accept({batch_id:A,count:1,status:'pending'});await monitor.refresh();
  assert.equal(monitor.batch.id,A);assert.equal(monitor.batch.count,1);assert.equal(monitor.error,'Sem conexão');
  const reloaded=new BatchMonitor({storage,api:async()=>page([])});reloaded.resume();assert.equal(reloaded.batch.id,A);
  online=true;await monitor.refresh();assert.equal(monitor.error,null);assert.equal(monitor.snapshot.counts.processing,1);
});

test('partial persisted results cannot complete an accepted batch or manufacture missing statuses',async()=>{
  const monitor=new BatchMonitor({storage:memory(),api:async()=>page([battle(1)],1)});
  monitor.accept({batch_id:A,count:100,status:'pending'});await monitor.refresh();
  assert.equal(monitor.snapshot.total,100);assert.equal(monitor.snapshot.finished,1);
  assert.equal(monitor.snapshot.counts.pending,0);assert.equal(monitor.snapshot.missing,99);
  assert.equal(monitor.snapshot.terminal,false);
});

test('an overlapping poll does not duplicate requests and unavailable storage does not break monitoring',async()=>{
  const pending=defer();let calls=0;
  const monitor=new BatchMonitor({storage:{getItem(){throw Error('denied');},setItem(){throw Error('denied');}},api:()=>{calls++;return pending.promise;}});
  monitor.resume();monitor.select(A,1);const reading=monitor.refresh();await monitor.refresh();
  assert.equal(calls,1);pending.resolve(page([battle(1)]));await reading;
  assert.equal(monitor.snapshot.terminal,true);
});
