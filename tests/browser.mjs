import {spawn,execFileSync} from "node:child_process";
import {writeFile,mkdir} from "node:fs/promises";
import {createServer} from "node:net";
import path from "node:path";
// Optional browser QA uses an existing Chromium browser, with no npm dependencies.
const out=path.resolve(".git/ui-qa"); await mkdir(out,{recursive:true});
const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
const debugPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",[
 "--headless=new","--disable-gpu","--no-first-run","--disable-extensions","--remote-debugging-port="+debugPort,
 "--user-data-dir="+path.join(out,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws;const pending=new Map();let seq=0;const errors=[];const detailRequests=[];let createdResponses=0,battleRequests=0;
let blockedMethod='GET';const expectedFailureUrls=new Set();const expectedNetworkErrors=[];
async function until(check,timeout=20000){
 const end=Date.now()+timeout;
 while(Date.now()<end){try{const x=await check();if(x)return x;}catch{}await delay(100);}
 throw new Error("Timed out waiting for browser condition");
}
try{
 await until(async()=>{const r=await fetch("http://127.0.0.1:"+debugPort+"/json/version");return r.ok;});
 const target=await (await fetch("http://127.0.0.1:"+debugPort+"/json/new?about:blank",{method:"PUT"})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.onmessage=event=>{
  const d=JSON.parse(event.data);
  if(d.id){const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);d.error?p.reject(d.error):p.resolve(d.result);}}
  if(d.method==="Runtime.exceptionThrown")errors.push(d.params.exceptionDetails.text);
  if(d.method==="Log.entryAdded" && d.params.entry.level==="error"){
   (expectedFailureUrls.has(d.params.entry.url)?expectedNetworkErrors:errors).push(d.params.entry.text);
  }
  if(d.method==="Network.requestWillBeSent" && /\/api\/battles\/[0-9a-f-]+$/.test(d.params.request.url))detailRequests.push(d.params.request.url);
  if(d.method==="Network.requestWillBeSent" && d.params.request.method==='POST' && d.params.request.url.endsWith('/api/battles'))battleRequests++;
  if(d.method==="Network.responseReceived" && d.params.response.url.endsWith('/api/characters') && d.params.response.status===201)createdResponses++;
  if(d.method==="Fetch.requestPaused"){
   const method=d.params.request.method===blockedMethod?"Fetch.failRequest":"Fetch.continueRequest";
   if(method==='Fetch.failRequest')expectedFailureUrls.add(d.params.request.url);
   cdp(method,{requestId:d.params.requestId,...(method==='Fetch.failRequest'?{errorReason:"InternetDisconnected"}:{})}).catch(()=>{});
  }
 };
 function cdp(method,params={}){
  return new Promise((resolve,reject)=>{
   const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+" timeout"));},25000);
   pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
 }
 async function run(expression){
  const r=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;
 }
 const check=expression=>until(()=>run(expression));
 await cdp("Page.enable");await cdp("Runtime.enable");await cdp("Log.enable");await cdp("Network.enable");await cdp("Network.setCacheDisabled",{cacheDisabled:true});
 await cdp("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
 await cdp("Page.navigate",{url:"http://127.0.0.1:8080/"});
 await check("document.querySelector('#connection')?.textContent === 'Sistema disponível'");
 for(const [name,cls] of [["Lyra","mage"],["Kael","warrior"],["Sylve","archer"]]){
  if(await run(`[...document.querySelectorAll('#character-roster h3')].some(x=>x.textContent===${JSON.stringify(name)})`))continue;
  await run(`document.querySelector('[data-view="characters"]').click();document.querySelector('#character-name').value=${JSON.stringify(name)};document.querySelector('[name="class_name"][value="${cls}"]').click();document.querySelector('#character-form').requestSubmit();`);
  await check(`[...document.querySelectorAll('#character-roster h3')].some(x=>x.textContent===${JSON.stringify(name)})`);
 }
 // A confirmed POST must remain successful even when a subsequent collection GET fails.
 const regressionName="Runa "+Date.now().toString(36).slice(-5);
 const createdBeforeRegression=createdResponses;
 await cdp("Fetch.enable",{patterns:[{urlPattern:"http://127.0.0.1:8080/api/characters*",requestStage:"Request"}]});
 await run(`document.querySelector('[data-view="characters"]').click();document.querySelector('#character-name').value=${JSON.stringify(regressionName)};document.querySelector('#character-form').requestSubmit()`);
 await until(async()=>createdResponses>createdBeforeRegression && await run("!document.querySelector('#character-form [type=submit]').disabled"));
 const creationKept=await run(`document.querySelector('#character-name').value==='' && document.querySelector('#form-error').hidden && [...document.querySelectorAll('#character-roster h3')].some(x=>x.textContent===${JSON.stringify(regressionName)})`);
 await cdp("Fetch.disable");
 if(!creationKept)throw Error("A confirmed character creation was reported as failed after collection refresh");
 blockedMethod='POST';
 await cdp("Fetch.enable",{patterns:[{urlPattern:"http://127.0.0.1:8080/api/characters*",requestStage:"Request"}]});
 await run("document.querySelector('#character-name').value='Teste offline';document.querySelector('#character-form').requestSubmit()");
 await check("!document.querySelector('#character-form [type=submit]').disabled");
 const recoverable=await run("document.querySelector('#character-name').value==='Teste offline' && !document.querySelector('#form-error').hidden && document.querySelector('#form-error').textContent.toLowerCase().includes('conexão')");
 await cdp('Fetch.disable');
 if(!recoverable)throw Error('Network failure must preserve input and explain recovery in Portuguese');
 await run(`document.querySelector('[data-view="arena"]').click();for(const name of ["Lyra","Kael"]){[...document.querySelectorAll('#arena-roster .character-card')].find(x=>x.querySelector('h3').textContent===name).querySelector('button').click();}`);
 if(await run("document.querySelector('#start-battle').disabled"))throw Error("Valid pair did not enable battle");
 await run("document.querySelector('#start-battle').click()");
 await check("!document.querySelector('#start-battle').disabled && document.querySelector('#battle-status').textContent === 'Concluída'");
 const requestsAtCompletion=detailRequests.length;await delay(4500);
 if(detailRequests.length!==requestsAtCompletion)throw Error('Terminal battle is still polled');
 await run("document.querySelector('#battle-result summary').click()");
 if(!(await run("document.querySelectorAll('.attack-log li').length")))throw Error("Attack history empty");
 await check("document.querySelector('#replay-button')");
 const requestsBeforeReplay=battleRequests;
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('.replay-line').textContent.startsWith('Turno 1')");
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('.replay-line').textContent.startsWith('Turno 2')");
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('#replay-button').textContent==='Pausar replay'");
 await run("document.querySelector('#replay-button').click()");
 const pausedLine=await run("document.querySelector('.replay-line').textContent");
 await delay(800);
 if(await run("document.querySelector('.replay-line').textContent")!==pausedLine)throw Error('Replay advanced while paused');
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('#replay-button').textContent==='Rever combate'");
 if(battleRequests!==requestsBeforeReplay)throw Error('Replay requested another battle');
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
 await run("document.querySelector('[data-view=history]').click()");
 await check("document.querySelectorAll('#history-body tr').length>0");
 await run("document.querySelector('[data-view=load]').click();document.querySelector('#batch-count').value='10';document.querySelector('#start-batch').click()");
 await check("document.querySelector('#batch-feedback').textContent.includes('10 batalhas solicitadas')");
 await run("document.querySelector('[data-view=characters]').click();document.querySelector('#character-name').value='  ';document.querySelector('#character-form').requestSubmit()");
 await check("!document.querySelector('#form-error').hidden");
 await run("document.querySelector('[data-view=arena]').click();document.querySelector('#main').focus();window.scrollTo(0,0)");
 await run("document.fonts.ready");
 async function capture(name){
   const metrics=await cdp("Page.getLayoutMetrics");
   const r=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,
    clip:{x:0,y:0,width:metrics.cssContentSize.width,height:metrics.cssContentSize.height,scale:1}});
   await writeFile(path.join(out,name),Buffer.from(r.data,"base64"));
 }
 if(await run("document.documentElement.scrollWidth>innerWidth"))throw Error("Desktop overflow");
 await capture("desktop.png");
 await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await delay(400);
 if(await run("document.documentElement.scrollWidth>innerWidth"))throw Error("Mobile overflow");
 if(!(await run("[...document.querySelectorAll('.nav-item')].every(x=>x.getBoundingClientRect().width>30)")))throw Error("Mobile navigation unreachable");
 await capture("mobile.png");
 const contrast=await run(`(()=>{function lum(hex){let a=hex.match(/\\w\\w/g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*a[0]+.7152*a[1]+.0722*a[2];}return (lum('a7a8b5')+.05)/(lum('14151c')+.05)})()`);
 if(contrast<4.5)throw Error("Muted text contrast failed");
 const report={passed:["character creation for all three classes","confirmed creation stays successful without collection read","failed creation preserves input and explains recovery in Portuguese","terminal battle polling stops","two-character selection","battle result and attack history","replay steps respect reduced motion","automatic replay pauses/resumes without requesting another battle","history table","batch submission","empty-name validation","desktop and mobile overflow","navigation target sizes","muted text contrast"],contrast,errors,expectedNetworkErrors,screenshots:[path.join(out,"desktop.png"),path.join(out,"mobile.png")]};
 await writeFile(path.join(out,"report.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 if(errors.length)process.exitCode=1;
}finally{
 ws?.close();
  if(child.pid){try{if(process.platform==="win32")execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill("SIGTERM");}catch{}}
}
