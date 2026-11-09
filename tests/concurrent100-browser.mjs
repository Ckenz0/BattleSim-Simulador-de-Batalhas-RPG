import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

// Isolated browser regression fixtures. This does not launch a real worker batch.
const out=path.resolve('.git/concurrent100-ui-browser');await mkdir(out,{recursive:true});
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const characters=[{id:'a',name:'Astra',class_name:'mage',hp:100,attack:70,defense:20,speed:50},
  {id:'b',name:'Borin',class_name:'warrior',hp:160,attack:45,defense:40,speed:30}];
let reads=0,posts=0,readError=true,terminal=false;
const battle=(index,batch=A)=>({id:batch.slice(0,-4)+String(index).padStart(4,'0'),batch_id:batch,
  status:terminal?'failed':index<20?'pending':index<50?'processing':index<95?'completed':'failed',
  participants:characters,result:!terminal && index>=50 && index<95?{winner_id:'a',turns:3,outcome:'victory',total_damage:{a:100,b:30},final_hp:{a:70,b:0}}:null,
  created_at:'2026-11-08T10:00:00Z',processing_ms:25,worker_id:'worker-fixture'});
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://local');const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(url.pathname==='/api/health')return json({broker_connected:true});
    if(url.pathname==='/api/stats')return json({total:0,pending:0,processing:0,completed:0,failed:0,average_processing_ms:0,workers:[],unpublished:0});
    if(url.pathname==='/api/characters')return json({items:characters,total:2,limit:100,offset:0});
    if(url.pathname==='/api/adventures/catalog')return json({classes:{warrior:characters[1],mage:characters[0],archer:characters[0]},initial_gains:{hp:10,attack:2,defense:2,speed:2},stages:[]});
    if(url.pathname==='/api/battles/batch' && req.method==='POST') {
      let data='';for await(const chunk of req)data+=chunk;
      assert.equal(JSON.parse(data).count,100);posts++;
      return json({batch_id:A,count:100,battle_ids:Array.from({length:100},(_,i)=>battle(i).id),status:'pending'},202);
    }
    if(url.pathname==='/api/battles') {
      const batch=url.searchParams.get('batch_id'),offset=Number(url.searchParams.get('offset') || 0);
      if(!batch)return json({items:[],total:0,limit:15,offset:0});
      reads++;
      if(readError)return json({detail:'Consulta temporariamente indisponível.'},503);
      const total=batch===B?1000:100;
      return json({items:Array.from({length:Math.min(100,total-offset)},(_,i)=>battle(offset+i,batch)),total,offset,limit:100});
    }
    if(url.pathname.startsWith('/api/battles/'))return json({...battle(99),id:url.pathname.split('/').at(-1)});
    const requested=path.resolve('frontend','.'+(url.pathname==='/'?'/index.html':url.pathname));
    assert.ok(requested.startsWith(path.resolve('frontend')+path.sep));
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
    res.writeHead(200,{'Content-Type':types[path.extname(requested)] || 'application/octet-stream'});res.end(await readFile(requested));
  } catch(error) {res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const debugPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
  '--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port='+debugPort,
  '--user-data-dir='+path.join(out,'profile-'+Date.now()),'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+15000;while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch{}await delay(75);}throw Error('Browser condition timed out');}
let ws,sequence=0;const pending=new Map(),errors=[];
try {
  await until(async()=>{const r=await fetch('http://127.0.0.1:'+debugPort+'/json/version');return r.ok;});
  const target=await(await fetch('http://127.0.0.1:'+debugPort+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const callback=pending.get(message.id);if(callback){pending.delete(message.id);message.error?callback.reject(Error(message.error.message)):callback.resolve(message.result);}}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);};
  function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
  async function run(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;}
  const check=expression=>until(()=>run(expression));
  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:base+'/#load'});
  await check("document.querySelectorAll('[data-select]').length===2");
  assert.equal(await run("document.querySelector('#batch-count').value"),'100');
  await run("document.querySelector('[data-view=arena]').click();document.querySelector('[data-select=a]').click();document.querySelector('[data-select=b]').click();document.querySelector('[data-view=load]').click();document.querySelector('#start-batch').click()");
  await check("!document.querySelector('#batch-read-error').hidden");
  assert.equal(posts,1);
  assert.ok(await run("document.querySelector('#batch-feedback').textContent.includes('100 batalhas solicitadas')"));
  assert.ok(await run("!document.querySelector('#notice').classList.contains('error')"));
  assert.equal(await run("document.querySelectorAll('.batch-card').length"),0);
  readError=false;await run("document.querySelector('#batch-refresh').click()");
  await check("document.querySelectorAll('.batch-card').length===100");
  assert.deepEqual(await run("[...document.querySelectorAll('[data-batch-stat]')].map(x=>x.textContent)"),['100','20','30','45','5']);
  assert.equal(await run("document.querySelector('#batch-progress').value"),50);
  await run("document.querySelector('#batch-id-input').value='rascunho preservado'");
  await run("document.querySelector('#batch-refresh').click()");await delay(200);
  assert.equal(await run("document.querySelector('#batch-id-input').value"),'rascunho preservado');
  const capture=async name=>{await run('document.fonts.ready');const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(out,name),Buffer.from(result.data,'base64'));};
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false);await capture('desktop.png');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(150);
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false);
  await run("document.querySelector('#batch-content').scrollIntoView({behavior:'instant',block:'start'})");await capture('mobile.png');
  await run("document.querySelector('.batch-card.failed a').click()");
  await check("!document.querySelector('#view-arena').hidden && document.querySelector('#battle-status').textContent==='Com erro'");
  await run("document.querySelector('[data-view=load]').click()");
  await cdp('Page.reload');await check("document.querySelectorAll('.batch-card').length===100");
  assert.equal(await run("document.querySelector('#batch-selected-id').textContent"),A);
  terminal=true;await run("document.querySelector('#batch-refresh').click()");
  await check("document.querySelector('#batch-progress-status').textContent.includes('encerrada')");
  const terminalReads=reads;await delay(2300);assert.equal(reads,terminalReads);
  await run(`document.querySelector('#batch-id-input').value='${B}';document.querySelector('#batch-open').requestSubmit()`);
  await check("document.querySelector('[data-batch-stat=total]').textContent==='1.000' && document.querySelectorAll('.batch-card').length===100");
  await run("document.querySelector('#batch-next').click()");
  assert.ok(await run("document.querySelector('#batch-range').textContent.startsWith('101–200')"));
  assert.ok(await run("document.querySelector('.batch-card h3').textContent==='Confronto 101'"));
  assert.deepEqual(errors,[]);
  const report={source:'isolated HTTP API fixtures; no real worker concurrency claims',passed:['default 100','confirmed POST survives failed GET','reported mixed counts/progress','100 real fixture cards','form draft survives refresh','actual detail navigation','reload persistence','terminal polling stops','1000 total with 100-card pagination','desktop/mobile overflow'],screenshots:['desktop.png','mobile.png'],errors};
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
  ws?.close();if(child.pid){try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}catch{}}
  await new Promise(resolve=>server.close(resolve));
}
