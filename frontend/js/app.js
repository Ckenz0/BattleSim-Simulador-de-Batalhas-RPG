import {PixelArena,createSprite} from "./arena.mjs";
"use strict";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const labels = {warrior:"Guerreiro",mage:"Mago",archer:"Arqueiro"};
const statuses = {pending:"Na fila",processing:"Em combate",completed:"Concluída",failed:"Com erro"};
const presets = {
  warrior:{hp:160,attack:45,defense:40,speed:30},
  mage:{hp:100,attack:75,defense:15,speed:55},
  archer:{hp:120,attack:55,defense:25,speed:85}
};
const number = new Intl.NumberFormat("pt-BR");
const state = {characters:[],selected:[],battle:null,activeId:sessionStorage.getItem("battle-id"),view:"arena",
  offset:0,filter:"",historySignature:"",resultSignature:"",submitting:false,batchSubmitting:false,refreshing:false,formSubmitting:false};
let noticeTimer;
const arena=new PixelArena($("#battle-scene"),{onFinish:renderBattleSummary,onReplay:renderBattleWatching});
function el(tag, className, text) {
  const node=document.createElement(tag);
  if(className) node.className=className;
  if(text !== undefined) node.textContent=String(text);
  return node;
}
function icon(name) {
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  const use=document.createElementNS(svg.namespaceURI,"use");
  use.setAttribute("href","#"+name);
  svg.setAttribute("aria-hidden","true"); svg.append(use); return svg;
}
function avatar(character) {
  const node=el("div","avatar "+character.class_name);
  node.classList.add("sprite-avatar");
  node.append(createSprite(character.class_name)); return node;
}
function notify(text, error=false) {
  clearTimeout(noticeTimer);
  const box=$("#notice"); box.textContent=text; box.classList.toggle("error",error); box.hidden=false;
  if(!error) noticeTimer=setTimeout(()=>{box.hidden=true;},7000);
}
async function api(path,options={}) {
  let response;
  try {
    response=await fetch("/api"+path,{...options,headers:{"Content-Type":"application/json",...options.headers},signal:AbortSignal.timeout(15000)});
  } catch(error) {
    throw new Error(error.name==="TimeoutError"?
      "O sistema demorou para responder. Tente novamente em instantes.":
      "Sem conexão com o sistema. Confira a conexão e tente novamente.", {cause:error});
  }
  if(!response.ok) {
    let message="O sistema não respondeu. Tente novamente em instantes.";
    try {
      const data=await response.json();
      if(typeof data.detail==="string") message=data.detail;
      else if(Array.isArray(data.detail)) message="Confira os campos informados e tente novamente.";
    } catch {}
    const error=new Error(message); error.status=response.status; throw error;
  }
  return response.json();
}
function showView(view) {
  if(!["arena","characters","history","load"].includes(view)) return;
  arena.setVisible(view==="arena");
  state.view=view;
  $$(".view").forEach(node=>node.hidden=node.id!=="view-"+view);
  $$(".nav-item").forEach(node=>{
    const active=node.dataset.view===view;
    node.classList.toggle("active",active);
    if(active) node.setAttribute("aria-current","page"); else node.removeAttribute("aria-current");
  });
  $("#view-label").textContent={arena:"Arena",characters:"Personagens",history:"Histórico",load:"Teste de carga"}[view];
  history.replaceState(null,"","#"+view);
  if(view==="history") loadHistory().catch(e=>notify(e.message,true));
  $("#main").focus({preventScroll:true});
}
function emptyState(title,description,action=false) {
  const node=el("div","empty"), image=el("div","empty-icon");
  image.append(icon("swords")); node.append(image,el("h2","",title),el("p","",description));
  if(action) {const button=el("button","button secondary","Criar personagem");button.dataset.goto="characters";node.append(button);}
  return node;
}
function renderSlots() {
  ["a","b"].forEach((slot,index)=>{
    const root=$("#slot-"+slot), character=state.characters.find(c=>c.id===state.selected[index]);
    root.replaceChildren(); root.classList.toggle("occupied",Boolean(character));
    if(!character) {root.append(el("span","slot-number",index+1),el("p","","Selecione um combatente"));return;}
    const clear=el("button","slot-clear","×"); clear.dataset.remove=character.id;clear.setAttribute("aria-label","Remover "+character.name+" da seleção");
    const hp=el("div","slot-hp",number.format(character.hp)+" de vida"), bar=el("div","hp-bar");bar.append(el("div","hp-fill"));hp.append(bar);
    root.append(clear,avatar(character),el("h3","",character.name),el("p","",labels[character.class_name]),hp);
  });
  arena.previewParticipants(state.selected.map(id=>state.characters.find(c=>c.id===id)).filter(Boolean));
  $("#selection-count").textContent=state.selected.length+" de 2 selecionados";
  $("#start-hint").textContent=state.selected.length===2?"Tudo pronto. Que vença o melhor.":"Escolha dois personagens abaixo para começar.";
  $("#start-battle").disabled=state.selected.length!==2 || state.submitting;
  $("#start-batch").disabled=state.selected.length!==2 || state.batchSubmitting;
  $("#batch-pair").textContent=state.selected.length===2?state.selected.map(id=>state.characters.find(c=>c.id===id)?.name).join(" × "):"Selecione dois combatentes na arena";
}
function characterCard(character,selectable) {
  const node=el("article","character-card"+(state.selected.includes(character.id)?" selected":""));
  const head=el("div","card-heading"), title=el("div");
  title.append(el("h3","",character.name),el("span","class-label",labels[character.class_name]));
  head.append(avatar(character),title);
  const hp=el("div"), line=el("div","card-hp");line.append(el("span","","Vida"),el("span","",number.format(character.hp)));
  const bar=el("div","hp-bar");bar.append(el("div","hp-fill"));hp.append(line,bar);
  const stats=el("dl","card-stats");
  [["Ataque",character.attack],["Defesa",character.defense],["Velocidade",character.speed]].forEach(([label,value])=>{
    const row=el("div");row.append(el("dt","",label),el("dd","",value));stats.append(row);
  });
  node.append(head,hp,stats);
  const button=el("button","select-character",selectable?(state.selected.includes(character.id)?"Selecionado":"Selecionar"):"Levar à arena");
  if(selectable) {
    button.dataset.select=character.id;
    button.setAttribute("aria-pressed",String(state.selected.includes(character.id)));
    button.setAttribute("aria-label",(state.selected.includes(character.id)?"Desmarcar ":"Selecionar ")+character.name);
  } else {button.dataset.take=character.id;button.setAttribute("aria-label","Levar "+character.name+" à arena");}
  node.append(button);return node;
}
function renderCharacters() {
  const focused=document.activeElement?.dataset.select;
  $("#roster-count").textContent=state.characters.length;
  $("#collection-count").textContent=state.characters.length+" "+(state.characters.length===1?"personagem":"personagens");
  for(const [target,selectable] of [["#arena-roster",true],["#character-roster",false]]) {
    const root=$(target);
    root.replaceChildren(...state.characters.map(c=>characterCard(c,selectable)));
    if(!state.characters.length) root.append(emptyState("Toda lenda tem um começo","Crie seus primeiros personagens e prepare o seu primeiro confronto.",selectable));
  }
  renderSlots();
  if(focused) $('[data-select="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
}
function toggleCharacter(id) {
  if(state.selected.includes(id)) state.selected=state.selected.filter(x=>x!==id);
  else if(state.selected.length<2) state.selected.push(id);
  else {notify("Dois combatentes já estão selecionados. Remova um deles para trocar.");return;}
  renderCharacters();
  arena.previewParticipants(state.selected.map(id=>state.characters.find(c=>c.id===id)).filter(Boolean),{force:true});
}
async function loadCharacters() {
  let items=[],page;
  do {
    page=await api("/characters?limit=100&offset="+items.length);
    items.push(...page.items);
  } while(items.length<page.total && page.items.length);
  state.characters=items;
  state.selected=state.selected.filter(id=>items.some(c=>c.id===id));
  renderCharacters();
}
function resultFacts(pairs) {
  const list=el("dl","result-facts");
  pairs.forEach(([label,value])=>{const row=el("div");row.append(el("dt","",label),el("dd","",value));list.append(row);});
  return list;
}
function renderBattleWatching(battle) {
  $("#battle-result").replaceChildren(emptyState("Acompanhe o confronto","Assista aos golpes na arena. O resultado aparece ao fim da batalha."));
}
function renderBattleSummary(battle) {
  const root=$("#battle-result");root.replaceChildren();
  const result=battle.result,winner=battle.participants.find(c=>c.id===result.winner_id);
  const winnerNode=el("div","winner");
  winnerNode.append(winner?avatar(winner):avatar(battle.participants[0]),el("h3","",winner?winner.name:"Empate"),
    el("p","",winner?"Venceu o confronto":"O limite de turnos foi atingido"));
  const duration=number.format(Math.round(battle.processing_ms || 0))+" ms";
  root.append(winnerNode,resultFacts([["Turnos",result.turns],["Dano total",number.format(Object.values(result.total_damage).reduce((a,b)=>a+b,0))],["Processamento",duration]]));
  const details=el("details"),log=el("ol","attack-log");
  result.attacks.forEach(attack=>{
    const attacker=battle.participants.find(c=>c.id===attack.attacker_id),defender=battle.participants.find(c=>c.id===attack.defender_id);
    const row=el("li");row.append(el("strong","","Turno "+attack.turn+" · "+attacker.name),el("div","",attack.damage+" de dano em "+defender.name+" · "+attack.defender_hp+" de vida restante"));log.append(row);
  });
  details.append(el("summary","","Ver histórico dos ataques"),log);root.append(details);
}

function renderResult(battle) {
  const signature=battle?battle.id+":"+battle.status:"empty";
  if(signature===state.resultSignature) return;
  state.resultSignature=signature;
  const root=$("#battle-result"), badge=$("#battle-status");
  root.replaceChildren();
  badge.textContent=battle?statuses[battle.status]:"Aguardando";
  badge.className="badge "+(battle?.status || "");
  if(!battle) {root.append(emptyState("A arena espera por você","Inicie uma batalha para acompanhar o resultado e o histórico dos ataques."));return;}
  if(battle.status==="pending" || battle.status==="processing") {
    arena.waitFor(battle);
    const node=el("div","empty small-empty");
    node.append(el("div","processing-mark"),el("h2","",battle.status==="pending"?"Confronto na fila":"Batalha em andamento"),
      el("p","",battle.status==="pending"?"Seu pedido está salvo. O resultado aparecerá aqui quando o processamento terminar.":"Os combatentes estão na arena. Você pode continuar usando o simulador."));
    root.append(node);return;
  }
  if(battle.status==="failed") {
    arena.failure(battle);
    root.append(emptyState("O confronto não terminou","Houve uma falha no processamento. Você pode solicitar uma nova batalha."));
    return;
  }
  const fresh=state.watchBattleId===battle.id;
  if(fresh)state.watchBattleId=null;
  renderBattleWatching(battle);
  arena.loadBattle(battle,{fresh});
}

function renderStats(stats) {
  $$("[data-stat]").forEach(node=>node.textContent=number.format(stats[node.dataset.stat] || 0));
  $("#average-time").textContent=number.format(Math.round(stats.average_processing_ms))+" ms";
  $("#workers-empty").hidden=stats.workers.length>0;
  $("#worker-body").replaceChildren(...stats.workers.map(worker=>{
    const row=el("tr");[worker.worker_id,number.format(worker.completed),number.format(worker.failed)].forEach(v=>row.append(el("td","",v)));return row;
  }));
  $("#unpublished").textContent=stats.unpublished?number.format(stats.unpublished)+" batalha(s) aguardando envio. Os pedidos estão salvos e serão enviados automaticamente.":"Todos os pedidos foram enviados para processamento.";
}
async function loadHistory() {
  const filter=state.filter,offset=state.offset;
  const page=await api("/battles?limit=15&offset="+offset+(filter?"&status="+filter:""));
  if(state.filter!==filter || state.offset!==offset) return;
  const signature=JSON.stringify(page);
  if(signature!==state.historySignature) {
    state.historySignature=signature;
    const focused=document.activeElement?.dataset.detail;
    $("#history-body").replaceChildren(...page.items.map(battle=>{
      const row=el("tr"),participants=el("td");
      participants.append(el("span","",battle.participants[0].name),el("span","versus-text","vs"),el("span","",battle.participants[1].name));
      const status=el("td");status.append(el("span","badge "+battle.status,statuses[battle.status]));
      const winner=battle.participants.find(c=>c.id===battle.result?.winner_id);
      const result=battle.result?(winner?winner.name:"Empate"):"—";
      const date=new Date(battle.created_at).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
      const action=el("td"),button=el("button","button secondary small","Ver");button.dataset.detail=battle.id;button.setAttribute("aria-label","Ver confronto entre "+battle.participants.map(c=>c.name).join(" e "));action.append(button);
      row.append(participants,status,el("td","",result),el("td","",battle.result?.turns || "—"),el("td","",date),action);
      return row;
    }));
    if(focused) $('[data-detail="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
  }
  $("#history-empty").hidden=page.total>0;
  $("#history-range").textContent=page.total?(offset+1)+"–"+Math.min(offset+page.limit,page.total)+" de "+number.format(page.total)+" batalhas":"Nenhuma batalha";
  $("#history-prev").disabled=offset===0;
  $("#history-next").disabled=offset+page.limit>=page.total;
  if(!state.activeId && page.items.length) {
    state.activeId=page.items[0].id;
  }
}
async function refresh() {
  if(state.refreshing) return;
  state.refreshing=true;
  try {
    const [stats,health]=await Promise.all([api("/stats"),api("/health")]);
    renderStats(stats);
    $("#connection").textContent=health.broker_connected?"Sistema disponível":"Processamento temporariamente indisponível";
    $("#connection").classList.toggle("online",health.broker_connected);
    await loadHistory();
    const terminal=state.battle && state.battle.id===state.activeId && ["completed","failed"].includes(state.battle.status);
    if(state.activeId && !terminal) {
      const requestedId=state.activeId;
      try {
        const updated=await api("/battles/"+requestedId);
        if(state.activeId!==requestedId)return;
        state.battle=updated;
        renderResult(state.battle);
      } catch(e) {
        if(state.activeId!==requestedId)return;
        if(e.status===404) {state.activeId=null;sessionStorage.removeItem("battle-id");renderResult(null);}
        else throw e;
      }
    } else if(!state.activeId) renderResult(null);
  } catch(e) {
    $("#connection").textContent="Sem conexão · tentando novamente";
    $("#connection").classList.remove("online");
  } finally {state.refreshing=false;}
}
async function startBattle() {
  if(state.selected.length!==2 || state.submitting) return;
  state.submitting=true;renderSlots();
  const button=$("#start-battle");button.textContent="Solicitando…";
  try {
    const battle=await api("/battles",{method:"POST",body:JSON.stringify({character_a_id:state.selected[0],character_b_id:state.selected[1]})});
    state.battle=battle;state.activeId=battle.id;state.watchBattleId=battle.id;sessionStorage.setItem("battle-id",battle.id);
    renderResult(battle);notify("Os combatentes estão a caminho da arena!");await refresh();
  } catch(e) {notify(e.message,true);}
  finally {state.submitting=false;button.replaceChildren(document.createTextNode("Iniciar batalha "),icon("arrow"));renderSlots();}
}
async function startBatch() {
  if(state.selected.length!==2 || state.batchSubmitting) return;
  state.batchSubmitting=true;renderSlots();const button=$("#start-batch");button.textContent="Enviando lote…";
  try {
    const result=await api("/battles/batch",{method:"POST",body:JSON.stringify({character_a_id:state.selected[0],character_b_id:state.selected[1],count:Number($("#batch-count").value)})});
    $("#batch-feedback").textContent=number.format(result.count)+" batalhas solicitadas. Acompanhe a evolução nos indicadores de atividade.";
    notify("Lote de "+number.format(result.count)+" batalhas registrado.");
    await refresh();
  } catch(e) {notify(e.message,true);}
  finally {state.batchSubmitting=false;button.replaceChildren(document.createTextNode("Solicitar lote "),icon("arrow"));renderSlots();}
}
$("#character-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(state.formSubmitting) return;
  const form=event.currentTarget,error=$("#form-error"),button=$('[type="submit"]',form);
  const data=Object.fromEntries(new FormData(form));data.name=data.name.trim();
  if(!data.name) {error.textContent="Informe um nome para o personagem.";error.hidden=false;$("#character-name").focus();return;}
  for(const key of ["hp","attack","defense","speed"]) data[key]=Number(data[key]);
  state.formSubmitting=true;button.disabled=true;button.textContent="Criando…";error.hidden=true;
  try {
    const character=await api("/characters",{method:"POST",body:JSON.stringify(data)});
    // A confirmed creation is authoritative, even if a later collection read is unavailable.
    state.characters.push(character);
    renderCharacters();
    form.reset();setPreset("warrior");
    notify(character.name+" entrou para a sua coleção.");
  } catch(e) {error.textContent=e.message;error.hidden=false;}
  finally {state.formSubmitting=false;button.disabled=false;button.replaceChildren(document.createTextNode("Criar personagem "),icon("plus"));}
});
function setPreset(className) {
  Object.entries(presets[className]).forEach(([name,value])=>{$('[name="'+name+'"]',$("#character-form")).value=value;});
}
$$('[name="class_name"]').forEach(radio=>radio.addEventListener("change",()=>setPreset(radio.value)));
document.addEventListener("click",async event=>{
  const button=event.target.closest("button");
  if(!button) return;
  if(button.dataset.view) showView(button.dataset.view);
  if(button.dataset.goto) showView(button.dataset.goto);
  if(button.dataset.select) toggleCharacter(button.dataset.select);
  if(button.dataset.remove) toggleCharacter(button.dataset.remove);
  if(button.dataset.take) {
    if(!state.selected.includes(button.dataset.take)) {
      if(state.selected.length===2) state.selected=[];
      state.selected.push(button.dataset.take);renderCharacters();
    }
    showView("arena");
  }
  if(button.dataset.detail) {
    try {
      const requestedId=button.dataset.detail;state.activeId=requestedId;
      const updated=await api("/battles/"+requestedId);
      if(state.activeId!==requestedId)return;
      state.battle=updated;
      sessionStorage.setItem("battle-id",requestedId);renderResult(state.battle);showView("arena");
    } catch(e) {notify(e.message,true);}
  }
});
$("#start-battle").addEventListener("click",startBattle);
$("#start-batch").addEventListener("click",startBatch);
$("#history-filter").addEventListener("change",event=>{state.filter=event.target.value;state.offset=0;loadHistory().catch(e=>notify(e.message,true));});
$("#history-prev").addEventListener("click",()=>{state.offset=Math.max(0,state.offset-15);loadHistory().catch(e=>notify(e.message,true));});
$("#history-next").addEventListener("click",()=>{state.offset+=15;loadHistory().catch(e=>notify(e.message,true));});
$(".brand").addEventListener("click",event=>{event.preventDefault();showView("arena");});
async function poll() {await refresh();setTimeout(poll,document.hidden?8000:2000);}
async function init() {
  renderResult(null);renderSlots();
  $$(".class-options label").forEach(label=>{const span=$("span",label);$("svg",span)?.remove();span.prepend(createSprite($("input",label).value));});
  const view=location.hash.slice(1);if(view) showView(view);
  try {await loadCharacters();} catch(e) {notify("Não foi possível carregar os personagens. Recarregue a página para tentar novamente.",true);}
  await poll();
}
init();
