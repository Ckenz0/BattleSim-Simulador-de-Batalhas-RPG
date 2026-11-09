import {BatchMonitor} from './batch.mjs';
import {createSprite} from './arena.mjs';

const states={pending:'Na fila',processing:'Em processamento',completed:'Concluída',failed:'Com erro'};
const number=new Intl.NumberFormat('pt-BR');
function node(tag,className,text) {
  const element=document.createElement(tag);if(className)element.className=className;
  if(text!==undefined)element.textContent=String(text);return element;
}

export class BatchView {
  constructor(root,{api,storage}) {
    this.root=root;this.$=selector=>root.querySelector(selector);
    this.monitor=new BatchMonitor({api,storage,onChange:()=>this.render()});
    this.$('#batch-open').addEventListener('submit',event=>{
      event.preventDefault();const error=this.$('#batch-open-error');error.hidden=true;
      try {this.monitor.select(this.$('#batch-id-input').value.trim());void this.refresh();}
      catch(e) {error.textContent=e.message;error.hidden=false;this.$('#batch-id-input').focus();}
    });
    this.$('#batch-recent').addEventListener('change',event=>{this.monitor.select(event.target.value);void this.refresh();});
    this.$('#batch-prev').addEventListener('click',()=>this.monitor.showPage(this.monitor.page-1));
    this.$('#batch-next').addEventListener('click',()=>this.monitor.showPage(this.monitor.page+1));
    this.$('#batch-refresh').addEventListener('click',()=>void this.refresh());
    this.monitor.resume();this.render();
  }
  accept(result) {this.monitor.accept(result);void this.refresh();}
  refresh() {return this.monitor.refresh();}
  render() {
    const {batch,snapshot,recent,error,loading,page}=this.monitor;
    const select=this.$('#batch-recent'),recentSignature=JSON.stringify(recent);
    if(this.recentSignature!==recentSignature) {
      this.recentSignature=recentSignature;
      select.replaceChildren(...(recent.length?recent.map(batch=>{
        const option=node('option','',(batch.count?number.format(batch.count)+' batalhas · ':'Lote · ')+batch.id.slice(0,8));
        option.value=batch.id;return option;
      }):[node('option','','Nenhum lote salvo')]));
    }
    select.disabled=!recent.length;select.value=batch?.id || '';
    this.$('#batch-empty').hidden=Boolean(batch);this.$('#batch-content').hidden=!batch;
    if(!batch)return;
    this.$('#batch-selected-id').textContent=batch.id;
    const refresh=this.$('#batch-refresh');refresh.disabled=loading || Boolean(snapshot?.terminal);
    refresh.textContent=snapshot?.terminal?'Lote finalizado':loading?'Consultando…':'Atualizar estados';
    const errorNode=this.$('#batch-read-error');errorNode.hidden=!error;
    errorNode.textContent=error?'Não foi possível atualizar os estados. '+error+' O lote selecionado continua salvo; a consulta será repetida.':'';
    for(const element of this.root.querySelectorAll('[data-batch-stat]')) {
      const key=element.dataset.batchStat;
      const value=key==='total'?(snapshot?.total ?? (batch.count || null)):snapshot?.counts[key];
      element.textContent=value===null || value===undefined?'—':number.format(value);
    }
    const progress=this.$('#batch-progress');progress.max=snapshot?.total || batch.count || 1;
    // Missing reports are never presented as queued or completed battles.
    progress.value=snapshot?.finished || 0;
    this.$('#batch-progress-label').textContent=snapshot?number.format(snapshot.finished)+' de '+number.format(snapshot.total):'Aguardando estados';
    this.$('#batch-progress-status').textContent=!snapshot?'Consultando os confrontos registrados…':
      !snapshot.total?'Nenhum confronto encontrado para este identificador. Confira o lote informado.':
      snapshot.terminal?'Todos os resultados recebidos. Atualização automática encerrada.':
      snapshot.missing?number.format(snapshot.missing)+' confronto(s) ainda sem estado recebido.':
      snapshot.counts.unknown?'Há estados ainda não reconhecidos. A consulta continua.':'Acompanhando os resultados automaticamente.';
    this.$('#batch-updated').textContent=snapshot?'Última consulta: '+new Date(snapshot.updatedAt).toLocaleTimeString('pt-BR')+'. Os estados podem chegar com atraso.':'';
    const grid=this.$('#batch-grid'),signature=JSON.stringify([batch.id,page,this.monitor.visibleItems]);
    if(this.gridSignature!==signature) {
      this.gridSignature=signature;
      const focused=document.activeElement?.dataset.batchDetail;
      grid.replaceChildren(...this.monitor.visibleItems.map((battle,index)=>this.card(battle,page*100+index+1)));
      if(focused)grid.querySelector('[data-batch-detail="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
    }
    const count=snapshot?.items.length || 0;
    this.$('#batch-pagination').hidden=!count;
    this.$('#batch-range').textContent=(page*100+1)+'–'+Math.min((page+1)*100,count)+' de '+number.format(snapshot?.total || count)+' confrontos';
    this.$('#batch-prev').disabled=page===0;
    this.$('#batch-next').disabled=(page+1)*100>=count;
  }
  card(battle,index) {
    const known=Object.hasOwn(states,battle.status),card=node('article','batch-card '+(known?battle.status:'unknown'));
    card.dataset.batchBattle=battle.id;
    const head=node('div','batch-card-heading');head.append(node('h3','','Confronto '+number.format(index)),node('span','batch-card-state',states[battle.status] || 'Estado desconhecido'));
    const pair=node('div','batch-card-pair');
    for(const [i,character] of (battle.participants || []).entries()) {
      if(i)pair.append(node('span','batch-card-versus','×'));
      const fighter=node('div','batch-card-fighter'),portrait=node('span','batch-card-portrait');
      portrait.append(createSprite(character.class_name));fighter.append(portrait,node('span','',character.name));pair.append(fighter);
    }
    const winner=battle.participants?.find(character=>character.id===battle.result?.winner_id);
    const result=node('p','batch-card-result',battle.status==='completed'?
      (battle.result?(winner?winner.name+' venceu':'Empate')+' · '+battle.result.turns+' turnos':'Resultado recebido'):
      battle.status==='failed'?'Falha registrada no processamento.':battle.status==='processing'?'Processamento informado pelo sistema.':'Aguardando resultado.');
    const link=node('a','batch-card-link',battle.status==='completed'?'Ver resultado':'Ver confronto');
    link.href='#arena';link.dataset.detail=battle.id;link.dataset.batchDetail=battle.id;
    link.setAttribute('aria-label',(battle.status==='completed'?'Ver resultado':'Ver confronto')+' '+index+' · '+battle.id.slice(0,8));
    card.append(head,pair,result,link);return card;
  }
}
