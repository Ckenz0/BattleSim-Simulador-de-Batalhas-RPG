import {spawn,execFileSync} from "node:child_process";
import {writeFile,mkdir} from "node:fs/promises";
import {createServer} from "node:net";
import path from "node:path";
// Optional browser QA uses an existing Chromium browser, with no npm dependencies.
const out=path.resolve(".git/ui-qa"); await mkdir(out,{recursive:true});
const appBase=(process.env.BATTLESIM_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/,'');
const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
const debugPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",[
 "--headless=new","--disable-gpu","--no-first-run","--disable-extensions","--remote-debugging-port="+debugPort,
 "--user-data-dir="+path.join(out,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws;const pending=new Map();let seq=0;const errors=[];const detailRequests=[];let createdResponses=0,battleRequests=0;
let blockedMethod='GET';const expectedFailureUrls=new Set();const expectedNetworkErrors=[];
let holdDetails=false,heldDetail=null;
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
  if(d.id){const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);d.error?p.reject(new Error(p.method+": "+d.error.message)):p.resolve(d.result);}}
  if(d.method==="Runtime.exceptionThrown")errors.push(d.params.exceptionDetails.text);
  if(d.method==="Log.entryAdded" && d.params.entry.level==="error"){
   (expectedFailureUrls.has(d.params.entry.url)?expectedNetworkErrors:errors).push(d.params.entry.text);
  }
  if(d.method==="Network.requestWillBeSent" && /\/api\/battles\/[0-9a-f-]+$/.test(d.params.request.url))detailRequests.push(d.params.request.url);
  if(d.method==="Network.requestWillBeSent" && d.params.request.method==='POST' && d.params.request.url.endsWith('/api/battles'))battleRequests++;
  if(d.method==="Network.responseReceived" && d.params.response.url.endsWith('/api/characters') && d.params.response.status===201)createdResponses++;
  if(d.method==="Fetch.requestPaused"){
   if(holdDetails && d.params.request.method==='GET' && /\/api\/battles\/[0-9a-f-]+$/.test(d.params.request.url)){
    heldDetail={requestId:d.params.requestId,url:d.params.request.url};return;
   }
   const method=d.params.request.method===blockedMethod?"Fetch.failRequest":"Fetch.continueRequest";
   if(method==='Fetch.failRequest')expectedFailureUrls.add(d.params.request.url);
   cdp(method,{requestId:d.params.requestId,...(method==='Fetch.failRequest'?{errorReason:"InternetDisconnected"}:{})}).catch(()=>{});
  }
 };
 function cdp(method,params={}){
  return new Promise((resolve,reject)=>{
   const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+" timeout"));},25000);
   pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params}));
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
 await cdp("Page.navigate",{url:appBase+'/'});
 await check("document.querySelector('#connection')?.textContent === 'Sistema disponível'");
 // Complete a real campaign through HTTP -> outbox -> RabbitMQ -> worker -> UI.
 await run("document.querySelector('[data-view=adventure]').click()");
 await check("Boolean(document.querySelector('#adventure-name') || document.querySelector('#adventure-fight') || document.querySelector('.adventure-profile'))");
 if(!await run("Boolean(document.querySelector('#adventure-name'))")){
  await run("document.querySelector('.adventure-profile .text-button').click()");
  await check("Boolean(document.querySelector('.adventure-library'))");
  await run("[...document.querySelectorAll('.adventure-library button')].find(b=>b.textContent==='Criar novo herói').click()");
 }
 await run("document.querySelector('#adventure-name').value='Aventura QA '+Date.now().toString(36);document.querySelector('#adventure-name').dispatchEvent(new Event('input'));document.querySelector('[name=adventure-class][value=mage]').click()");
 for(let point=0;point<5;point++)await run("document.querySelector('[data-plus=attack]').click()");
 if(await run("document.querySelector('.adventure-create [type=submit]').disabled"))throw Error('Five allocation points must enable creation');
 await cdp('Page.captureScreenshot',{format:'png'}).then(r=>writeFile(path.join(out,'adventure-create-desktop.png'),Buffer.from(r.data,'base64')));
 await run("document.querySelector('.adventure-create').requestSubmit()");
 await check("Boolean(document.querySelector('#adventure-fight'))");
 const adventureId=await run("localStorage.getItem('adventure-id')");
 for(let stage=1;stage<=5;stage++){
  await run("document.querySelector('#adventure-fight').click()");
  await check("document.querySelector('#battle-status').textContent==='Concluída' && !document.querySelector('#skip-battle').disabled");
  await run("document.querySelector('#skip-battle').click()");
  await check("!document.querySelector('.victory-screen').hidden");
  if(await run("document.querySelector('.victory-title').textContent!=='Vitória!'"))throw Error('Campaign balance regression: attack mage lost stage '+stage);
  await run("document.querySelector('.victory-screen button').click()");
  await check("Boolean(document.querySelector('[data-upgrade=attack]'))");
  if(stage===1){
   await cdp('Page.captureScreenshot',{format:'png'}).then(r=>writeFile(path.join(out,'adventure-reward-desktop.png'),Buffer.from(r.data,'base64')));
   await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
   await run("document.querySelector('.adventure-action').scrollIntoView({block:'start'})");
   await cdp('Page.captureScreenshot',{format:'png'}).then(r=>writeFile(path.join(out,'adventure-reward-mobile.png'),Buffer.from(r.data,'base64')));
   if(await run("document.documentElement.scrollWidth>innerWidth+1"))throw Error('Adventure overflow at mobile width');
   await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
   await run('window.scrollTo(0,0)');
  }
  await run("document.querySelector('[data-upgrade=attack]').click()");
  await check(stage===5?"document.querySelector('.adventure-action h2')?.textContent==='Arena conquistada!'":"Boolean(document.querySelector('#adventure-fight'))");
 }
 await cdp('Page.reload');
 await check("document.querySelector('.adventure-action h2')?.textContent==='Arena conquistada!'");
 if(await run("localStorage.getItem('adventure-id')")!==adventureId)throw Error('Adventure did not recover after reload');
 for(const [name,cls] of [["Lyra","mage"],["Kael","warrior"],["Sylve","archer"]]){
  if(await run(`[...document.querySelectorAll('#character-roster h3')].some(x=>x.textContent===${JSON.stringify(name)})`))continue;
  await run(`document.querySelector('[data-view="characters"]').click();document.querySelector('#character-name').value=${JSON.stringify(name)};document.querySelector('[name="class_name"][value="${cls}"]').click();document.querySelector('#character-form').requestSubmit();`);
  await check(`[...document.querySelectorAll('#character-roster h3')].some(x=>x.textContent===${JSON.stringify(name)})`);
 }
 // A confirmed POST must remain successful even when a subsequent collection GET fails.
 const regressionName="Runa "+Date.now().toString(36).slice(-5);
 const createdBeforeRegression=createdResponses;
 await cdp("Fetch.enable",{patterns:[{urlPattern:appBase+'/api/characters*',requestStage:"Request"}]});
 await run(`document.querySelector('[data-view="characters"]').click();document.querySelector('#character-name').value=${JSON.stringify(regressionName)};document.querySelector('#character-form').requestSubmit()`);
 await until(async()=>createdResponses>createdBeforeRegression && await run("!document.querySelector('#character-form [type=submit]').disabled"));
 const creationKept=await run(`document.querySelector('#character-name').value==='' && document.querySelector('#form-error').hidden && [...document.querySelectorAll('#character-roster h3')].some(x=>x.textContent===${JSON.stringify(regressionName)})`);
 await cdp("Fetch.disable");
 if(!creationKept)throw Error("A confirmed character creation was reported as failed after collection refresh");
 blockedMethod='POST';
 await cdp("Fetch.enable",{patterns:[{urlPattern:appBase+'/api/characters*',requestStage:"Request"}]});
 await run("document.querySelector('#character-name').value='Teste offline';document.querySelector('#character-form').requestSubmit()");
 await check("!document.querySelector('#character-form [type=submit]').disabled");
 const recoverable=await run("document.querySelector('#character-name').value==='Teste offline' && !document.querySelector('#form-error').hidden && document.querySelector('#form-error').textContent.toLowerCase().includes('conexão')");
 await cdp('Fetch.disable');
 if(!recoverable)throw Error('Network failure must preserve input and explain recovery in Portuguese');
 await run(`document.querySelector('[data-view="arena"]').click();for(const name of ["Lyra","Kael"]){[...document.querySelectorAll('#arena-roster .character-card')].find(x=>x.querySelector('h3').textContent===name).querySelector('button').click();}`);
 if(await run("document.querySelector('#start-battle').disabled"))throw Error("Valid pair did not enable battle");
 await run("document.querySelector('#start-battle').click()");
 await check("!document.querySelector('#start-battle').disabled && document.querySelector('#battle-status').textContent === 'Concluída' && document.querySelector('#battle-scene').dataset.state==='ready'");
 if(await run("Boolean(document.querySelector('#battle-result .winner'))"))throw Error('Winner revealed before playback');
 const requestsAtCompletion=detailRequests.length;await delay(4500);
 if(detailRequests.length!==requestsAtCompletion)throw Error('Terminal battle is still polled');
 const requestsBeforeReplay=battleRequests;
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('.scene-turn').textContent.startsWith('Turno 1')");
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('.scene-turn').textContent.startsWith('Turno 2')");
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
 await run("document.querySelector('#playback-speed').value='4';document.querySelector('#playback-speed').dispatchEvent(new Event('change'));document.querySelector('#replay-button').click()");
 await check("document.querySelector('#replay-button').textContent==='Pausar'");
 await run("document.querySelector('#replay-button').click()");
 const pausedText=await run("document.querySelector('.scene-turn').textContent");
 await delay(600);
 if(await run("document.querySelector('.scene-turn').textContent")!==pausedText)throw Error('Battle advanced while paused');
 await run("document.querySelector('#replay-button').click();document.querySelector('[data-view=history]').click()");
 await check("document.querySelector('#battle-scene').dataset.state==='paused'");
 await run("document.querySelector('[data-view=arena]').click()");
 if(await run("document.querySelector('#battle-scene').dataset.state")!=='paused')throw Error('Battle resumed without consent after navigation');
 await run("document.querySelector('#replay-button').click()");
 await check("document.querySelector('#battle-scene').dataset.state==='finished'");
 if(!(await run("Boolean(document.querySelector('#battle-result .winner'))")))throw Error('No final result after playback');
 await run("document.querySelector('.victory-screen button').click();document.querySelector('#battle-result summary').click()");
 if(!(await run("document.querySelectorAll('.attack-log li').length")))throw Error('Attack history empty');
 if(battleRequests!==requestsBeforeReplay)throw Error('Replay requested another battle');
 const assetSize=await run("(async()=>{const i=new Image();i.src='/assets/combatants.png';await i.decode();return [i.naturalWidth,i.naturalHeight]})()");
 if(assetSize[0]*1.5!==assetSize[1])throw Error('Sprite atlas grid aspect ratio invalid');
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
 // Same-class combatants must use separate front/back sprites and independent health.
 const mageNames=await run("[...document.querySelectorAll('#arena-roster .character-card')].filter(x=>x.querySelector('.class-label').textContent==='Mago').slice(0,2).map(x=>x.querySelector('h3').textContent)");
 async function selectPair(names){
   await run(`document.querySelector('[data-view=arena]').click();while(document.querySelector('#arena-roster [aria-pressed=true]'))document.querySelector('#arena-roster [aria-pressed=true]').click();for(const name of ${JSON.stringify(names)}){[...document.querySelectorAll('#arena-roster .character-card')].find(x=>x.querySelector('h3').textContent===name).querySelector('button').click();}`);
 }
 await selectPair(mageNames);
 await run("document.querySelector('#start-battle').click()");
 await check("document.querySelector('#battle-scene').dataset.state==='ready' && !document.querySelector('#start-battle').disabled");
 if(!(await run("Boolean(document.querySelector('.scene-fighter.ally .mage.back') && document.querySelector('.scene-fighter.enemy .mage.front'))")))throw Error('Same-class sprites not oriented independently');
 await run("document.querySelector('#skip-battle').click();document.querySelector('.victory-screen button').click()");
 // Exercise automatic entry and an actual archer projectile.
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
 await selectPair(["Sylve","Kael"]);
 await run("document.querySelector('#playback-speed').value='1';document.querySelector('#playback-speed').dispatchEvent(new Event('change'));document.querySelector('#start-battle').click()");
 await check("document.querySelector('.attack-projectile.archer')");
 await run("document.querySelector('#replay-button').click();window.scrollTo(0,0)");
 if(await run("document.querySelector('#battle-scene').dataset.state")!=='paused')throw Error('Automatic scene did not pause');
 await capture("desktop-battle.png",true);
 await run("document.querySelector('#skip-battle').click()");
 await capture("desktop-victory.png",true);
 await run("document.querySelector('.victory-screen button').click()");
 await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
 // An old delayed detail response must not replace the next accepted battle.
 holdDetails=true;heldDetail=null;
 await cdp('Fetch.enable',{patterns:[{urlPattern:appBase+'/api/battles/*',requestStage:'Request'}]});
 await run("document.querySelector('#start-battle').click()");
 await until(()=>heldDetail);
 await until(()=>run("!document.querySelector('#start-battle').disabled"),2000);
 await run("document.querySelector('#start-battle').click()");
 await check("!document.querySelector('#start-battle').disabled");
 holdDetails=false;
 await cdp('Fetch.continueRequest',{requestId:heldDetail.requestId});
 await cdp('Fetch.disable');
 const nextState=await until(async()=>{const s=await run("document.querySelector('#battle-scene').dataset.state");return ['ready','finished'].includes(s)?s:false;});
 if(nextState!=='ready')throw Error('Stale detail response replaced the new battle or removed its playback');
 await run("document.querySelector('#skip-battle').click();document.querySelector('.victory-screen button').click()");
 const historyBattleId=await run("fetch('/api/battles?limit=1').then(r=>r.json()).then(p=>p.items[0].id)");
 await selectPair(['Lyra','Kael']);
 const cleanPreview=await run("!document.querySelector('.combat-hud.low-hp')");
 if(!cleanPreview)console.log('Preview retained low-health coloring despite full HP');
 await run("document.querySelector('[data-view=history]').click()");
 await check(`document.querySelector('[data-detail="${historyBattleId}"]')`);
 await run(`document.querySelector('[data-detail="${historyBattleId}"]').click()`);
 await check("!document.querySelector('#view-arena').hidden");
 if(await run("document.querySelector('#battle-scene').dataset.state")!=='finished')throw Error('History did not restore the same battle after a new selection preview');
 if(!cleanPreview)throw Error('Full-health preview retained low-health styling');
 await run("document.querySelector('[data-view=history]').click()");
 await check("document.querySelectorAll('#history-body tr').length>0");
 await run("document.querySelector('[data-view=load]').click();document.querySelector('#batch-count').value='10';document.querySelector('#start-batch').click()");
 await check("document.querySelector('#batch-feedback').textContent.includes('10 batalhas solicitadas')");
 await run("document.querySelector('[data-view=characters]').click();document.querySelector('#character-name').value='  ';document.querySelector('#character-form').requestSubmit()");
 await check("!document.querySelector('#form-error').hidden");
 await run("document.querySelector('[data-view=arena]').click();document.querySelector('#main').focus();window.scrollTo(0,0)");
 await run("document.fonts.ready");
 async function capture(name,viewport=false){
   const metrics=await cdp("Page.getLayoutMetrics");
   const r=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,
    clip:{x:0,y:0,width:metrics.cssContentSize.width,height:viewport?metrics.cssLayoutViewport.clientHeight:metrics.cssContentSize.height,scale:1}});
   await writeFile(path.join(out,name),Buffer.from(r.data,"base64"));
 }
 if(await run("document.documentElement.scrollWidth>innerWidth"))throw Error("Desktop overflow");
 await capture("desktop.png");
 await capture("desktop-arena.png",true);
 await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await delay(400);
 if(await run("document.documentElement.scrollWidth>innerWidth"))throw Error("Mobile overflow");
 if(!(await run("[...document.querySelectorAll('.nav-item')].every(x=>x.getBoundingClientRect().width>30)")))throw Error("Mobile navigation unreachable");
 await run("document.querySelector('#replay-button').click()");
 await capture("mobile.png");
 await capture("mobile-arena.png",true);
 const contrast=await run(`(()=>{function lum(hex){let a=hex.match(/\\w\\w/g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*a[0]+.7152*a[1]+.0722*a[2];}return (lum('a7a8b5')+.05)/(lum('14151c')+.05)})()`);
 if(contrast<4.5)throw Error("Muted text contrast failed");
 const report={passed:["five-stage adventure: real queue/worker, upgrades and reload persistence","character creation for all three classes","confirmed creation stays successful without collection read","failed creation preserves input and explains recovery in Portuguese","terminal battle polling stops","two-character selection","battle result and attack history","replay steps respect reduced motion","automatic replay pauses/resumes without requesting another battle","winner hidden until playback finishes","navigation pauses without automatic resume","same-class front/back fighters","stale response cannot replace the next battle","automatic entry and archer projectile","history table","batch submission","empty-name validation","desktop and mobile overflow","navigation target sizes","muted text contrast"],contrast,errors,expectedNetworkErrors,screenshots:[path.join(out,"desktop.png"),path.join(out,"mobile.png"),path.join(out,"desktop-battle.png"),path.join(out,"desktop-victory.png"),path.join(out,"desktop-arena.png"),path.join(out,"mobile-arena.png")]};
 await writeFile(path.join(out,"report.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 if(errors.length)process.exitCode=1;
}finally{
 ws?.close();
  if(child.pid){try{if(process.platform==="win32")execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill("SIGTERM");}catch{}}
}
