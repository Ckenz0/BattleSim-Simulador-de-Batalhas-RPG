import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';

// Real Compose API smoke, then explicitly isolated CDP responses for unavailable Kubernetes
// and long trace pages. Only the live smoke creates a duel; it never changes infrastructure.
const base=(process.env.BATTLESIM_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/,'');
const out=path.resolve(process.env.BATTLESIM_CONTROL_QA_DIR || '.git/control-ui-browser');await mkdir(out,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await check();if(value)return value;}catch(error){last=error;}await delay(100);}throw Error('Browser condition timed out'+(last?': '+last.message:''));}
async function api(endpoint,options={}){const response=await fetch(base+'/api'+endpoint,{...options,headers:{'Content-Type':'application/json'}});assert.ok(response.ok,endpoint+' returned '+response.status);return response.json();}
const liveControl=await api('/control');
assert.equal(liveControl.broker.source,'rabbitmq_prometheus');
assert.ok(['ok','unavailable','not_configured'].includes(liveControl.broker.status));
let characters=(await api('/characters?limit=100')).items;
if(characters.length<2){for(const [name,class_name] of [['Percurso QA A','mage'],['Percurso QA B','warrior']])characters.push(await api('/characters',{method:'POST',body:JSON.stringify({name,class_name,hp:100,attack:60,defense:20,speed:50})}));}
const battle=await api('/battles',{method:'POST',body:JSON.stringify({character_a_id:characters[0].id,character_b_id:characters[1].id})});
const trace=await until(async()=>{const value=await api('/battles/'+battle.id+'/trace?limit=100&offset=0');return ['completed','failed'].includes(value.status)?value:false;},45000);
assert.equal(trace.coverage,'from_creation');assert.ok(trace.items.some(item=>item.event_type==='accepted'));
const fixtureId='00000000-0000-4000-8000-000000000099';
const observed='2026-11-10T12:30:00Z';
let metricMode='ok',controlFailure=false,traceMode='long';
function controlFixture(){return {observed_at:observed,refresh_after_seconds:5,api:{status:'ok',database:true,broker_connected:true},
  application:{total:104,pending:4,processing:2,completed:97,failed:1,unpublished:0,average_processing_ms:12.5,workers:[{worker_id:'worker-observed',completed:97,failed:1}]},
  broker:{status:'ok',observed_at:observed,source:'rabbitmq_prometheus',queues:[{name:'battles.requests.v1',ready:4,unacknowledged:2,consumers:3},{name:'battles.events.v1',ready:0,unacknowledged:0,consumers:1}]},
  cluster:{status:'ok',observed_at:observed,desired_replicas:3,available_replicas:2,ready_workers:2,slots_per_worker:2,configured_capacity:4,
    hpa:{min_replicas:1,max_replicas:5,current_replicas:3,desired_replicas:3,target_cpu_percent:60,current_cpu_percent:metricMode==='ok'?42:null},
    metrics_status:metricMode,metrics_observed_at:metricMode==='ok'?observed:null,metrics_error_code:metricMode==='unavailable'?'http_503':null,
    pods:[{name:'service-b-observed-worker-a-long-name',uid:'fixture-pod-a',phase:'Running',ready:true,cpu_cores:metricMode==='ok'?0.125:null,memory_bytes:metricMode==='ok'?52428800:null,restarts:0,cpu_request_cores:0.25,cpu_limit_cores:1,memory_request_bytes:67108864,memory_limit_bytes:268435456}]}};}
function traceFixture(url){const offset=Number(new URL(url).searchParams.get('offset') || 0),total=traceMode==='legacy'?2:105;
  return {battle_id:fixtureId,request_id:'qa-request',batch_id:null,status:'completed',created_at:observed,updated_at:observed,published_at:observed,coverage:traceMode==='legacy'?'legacy_partial':'from_creation',
    items:Array.from({length:Math.min(100,total-offset)},(_,i)=>({id:offset+i,event_type:(offset+i)%2?'completed':'processing',event_id:'event-'+(offset+i),worker_id:'worker-observed',attempt_id:'attempt-'+(offset+i),occurred_at:'2026-11-10T12:29:58Z',observed_at:observed,applied:i!==0,reason:i===0?'already_terminal':null,deliveries:i===0?3:1,last_received_at:observed})),total,limit:100,offset};}
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const debugPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
  '--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(out,'profile-'+Date.now()),'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws,seq=0;const pending=new Map(),errors=[],screenshots=[];let controlReads=0;
try {
  await until(async()=>{const response=await fetch('http://127.0.0.1:'+debugPort+'/json/version');return response.ok;});
  const target=await(await fetch('http://127.0.0.1:'+debugPort+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},25000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
  ws.onmessage=event=>{const message=JSON.parse(event.data);
    if(message.id){const callback=pending.get(message.id);if(callback){clearTimeout(callback.timer);pending.delete(message.id);message.error?callback.reject(Error(message.error.message)):callback.resolve(message.result);}}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
    if(message.method==='Network.requestWillBeSent' && message.params.request.url.endsWith('/api/control'))controlReads++;
    if(message.method==='Fetch.requestPaused') {
      const {requestId,request}=message.params,isControl=request.url.endsWith('/api/control');
      const body=isControl?(controlFailure?{detail:'secret://private-upstream'}:controlFixture()):traceFixture(request.url);
      cdp('Fetch.fulfillRequest',{requestId,responseCode:isControl && controlFailure?503:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')}).catch(error=>errors.push(error.message));
    }
  };
  async function run(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;}
  const check=async expression=>{
    try {return await until(()=>run(expression));}
    catch(error){
      const state=await run("({hidden:document.hidden,hash:location.hash,text:document.querySelector('#main')?.textContent,errors:"+JSON.stringify(errors)+"})");
      await writeFile(path.join(out,'failure.json'),JSON.stringify({expression,state},null,2));
      throw error;
    }
  };
  async function capture(name){await run('document.fonts.ready');await run("window.scrollTo({top:0,behavior:'instant'})");const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(path.join(out,name),Buffer.from(shot.data,'base64'));screenshots.push(name);}
  async function viewport(width,height,mobile=false){await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});await delay(100);assert.equal(await run('document.documentElement.scrollWidth>innerWidth+1'),false,'Unexpected page overflow at '+width);}
  await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await viewport(1440,1000);await cdp('Page.navigate',{url:base+'/#control'});
  await check("document.querySelector('#control-content')?.textContent.includes('Exportador Prometheus do RabbitMQ')");
  assert.ok(await run("document.querySelector('#control-content').textContent.includes('Tempo médio histórico')"));
  if(liveControl.cluster.status==='not_configured')assert.ok(await run("document.querySelector('#control-content').textContent.includes('Kubernetes não configurado')"));
  await capture('control-live-desktop.png');await viewport(390,844,true);await capture('control-live-mobile.png');
  // A real history entry must lead directly to the same trace returned by the real API.
  await run("document.querySelector('[data-view=history]').click()");await check(`Boolean(document.querySelector('[data-trace="${battle.id}"]'))`);
  await run(`document.querySelector('[data-trace="${battle.id}"]').click()`);
  await check(`document.querySelector('.trace-identity')?.textContent.includes('${battle.id}')`);
  assert.ok(await run("document.querySelector('#trace-content').textContent.includes('Pedido registrado')"));
  assert.ok(await run("document.querySelector('#trace-content').textContent.includes('A chegada ao NGINX não é registrada')"));
  await capture('trace-live-mobile.png');
  await run("document.querySelector('#trace-id').value='00000000-0000-4000-8000-000000000000';document.querySelector('.trace-lookup').requestSubmit()");
  await check("document.querySelector('#trace-feedback').textContent.includes('não encontrada')");
  // Intercept only these two endpoints. Captures below contain explicit API fixtures.
  await cdp('Fetch.enable',{patterns:[{urlPattern:base+'/api/control',requestStage:'Request'},{urlPattern:base+'/api/battles/'+fixtureId+'/trace*',requestStage:'Request'}]});
  await run("document.querySelector('[data-view=control]').click()");await check("document.querySelector('#control-content').textContent.includes('service-b-observed-worker-a-long-name')");
  await viewport(1440,1000);await capture('control-cluster-fixture-desktop.png');
  await viewport(390,844,true);await capture('control-cluster-fixture-mobile.png');
  await run("document.querySelector('.control-pod summary').click()");
  await check("document.querySelector('.control-pod').open");
  metricMode='unavailable';await run("document.querySelector('#control-refresh').click()");
  await check("document.querySelector('.control-pod-usage').textContent.includes('Indisponível')");
  assert.equal(await run("document.querySelector('.control-pod').open"),true,'Polling must preserve expanded pod details');
  assert.equal(await run("document.querySelector('.control-pod-usage').textContent.includes('0 núcleos')"),false);
  controlFailure=true;await run("document.querySelector('#control-refresh').click()");
  await check("!document.querySelector('.control-error').hidden");
  assert.equal(await run("document.querySelector('#control-root').textContent.includes('secret://')"),false);
  assert.ok(await run("document.querySelector('#control-content').textContent.includes('service-b-observed-worker-a-long-name')"));
  const hiddenReads=controlReads;await run("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))");
  await delay(5300);assert.equal(controlReads,hiddenReads,'Hidden document must pause control requests');
  controlFailure=false;await run("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))");
  await check("document.querySelector('.control-error').hidden && !document.querySelector('#control-refresh').disabled");
  await run(`document.querySelector('[data-view=trace]').click();document.querySelector('#trace-id').value='${fixtureId}';document.querySelector('.trace-lookup').requestSubmit()`);
  await check("document.querySelectorAll('.trace-event').length===100");
  assert.ok(await run("document.querySelector('#trace-range').textContent.includes('1–100 de 105')"));
  assert.ok(await run("document.querySelector('#trace-content').textContent.includes('Ignorado · batalha já encerrada')"));
  await run("document.querySelector('#trace-next').click()");await check("document.querySelectorAll('.trace-event').length===5");
  assert.ok(await run("document.querySelector('#trace-range').textContent.includes('101–105 de 105')"));
  assert.equal(await run("document.querySelector('#trace-next').disabled"),true);
  await run("document.querySelector('#trace-prev').click()");await check("document.querySelectorAll('.trace-event').length===100");
  traceMode='legacy';await run("document.querySelector('#trace-refresh').click()");await check("document.querySelector('.trace-coverage').textContent.includes('Cobertura parcial')");
  await viewport(1440,1000);await capture('trace-legacy-fixture-desktop.png');
  const inactiveReads=controlReads;await delay(5300);assert.equal(controlReads,inactiveReads,'Leaving control room must stop its requests');
  assert.deepEqual(errors,[]);
  const report={live:{battle_id:battle.id,broker_status:liveControl.broker.status,cluster_status:liveControl.cluster.status,trace_events:trace.items.length},passed:['real application/control sources','real duel trace/history entry','unknown UUID recovery','desktop/mobile no overflow','fixture cluster/HPA/CPU/memory','missing metrics remain unavailable','pod details survive polling','safe stale/error handling','document visibility pauses reads','trace pagination 100 + 5','explicit legacy partial coverage','leaving control room stops reads'],screenshots,errors};
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
  ws?.close();for(const callback of pending.values())clearTimeout(callback.timer);
  if(child.pid){try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}catch{}}
}
