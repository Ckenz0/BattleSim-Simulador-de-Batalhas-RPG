import {ControlMonitor,TraceMonitor,formatMetric,formatMemory} from './control.mjs';

const statuses={pending:'Na fila',processing:'Em combate',completed:'Concluída',failed:'Com erro'};
const sources={ok:'Disponível',degraded:'Degradado',partial:'Parcial',unavailable:'Indisponível',not_configured:'Não configurado',error:'Indisponível'};
const events={accepted:'Pedido registrado',published:'Publicado na fila',processing:'Processamento informado',completed:'Resultado concluído',failed:'Falha informada'};
const safeErrors={timeout:'Tempo de consulta excedido',connection_error:'Falha de conexão',unauthorized:'Acesso de leitura indisponível',forbidden:'Acesso de leitura indisponível',metrics_unavailable:'Métricas indisponíveis'};
const create=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=String(text);return el;};
const time=value=>{if(!value)return 'Sem observação';const date=new Date(value);return Number.isNaN(date.getTime())?'Horário indisponível':date.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'medium'});};
const stateLabel=status=>sources[status] || 'Estado indisponível';
function facts(pairs,className='control-facts') {
  const dl=create('dl',className);
  for(const [label,value] of pairs){const row=create('div');row.append(create('dt','',label),create('dd','',value));dl.append(row);}
  return dl;
}
function table(headers,rows,caption) {
  const wrap=create('div','table-wrap'),table=create('table'),head=create('thead'),tr=create('tr'),body=create('tbody');
  const title=create('caption','sr-only',caption);tr.append(...headers.map(text=>create('th','',text)));head.append(tr);
  for(const values of rows){const row=create('tr');row.append(...values.map(value=>create('td','',value)));body.append(row);}
  table.append(title,head,body);wrap.append(table);return wrap;
}
function sourceLine(status,observed,errorCode) {
  const p=create('p','control-source',stateLabel(status)+' · '+(observed?'Observado em '+time(observed):'Sem observação'));
  if(errorCode)p.append(document.createTextNode(' · '+(safeErrors[errorCode] || 'Consulta indisponível. Tente atualizar.')));
  return p;
}
function section(title) {const el=create('section','control-section');el.append(create('h2','',title));return el;}
function asNumber(value,unit) {return formatMetric(value,unit);}

export class ControlView {
  constructor(root,{api}) {
    this.root=root;this.active=false;
    root.innerHTML=`<div class="control-toolbar"><p id="control-freshness" role="status" aria-live="polite">Aguardando consulta.</p><button id="control-refresh" class="button secondary small">Atualizar agora</button></div><p class="control-error" role="status" hidden></p><div id="control-content"></div>`;
    this.monitor=new ControlMonitor({api,onChange:()=>this.render()});
    root.querySelector('#control-refresh').addEventListener('click',()=>void this.monitor.refresh());
    this.visibility=()=>this.monitor.setVisible(this.active && !document.hidden);
    document.addEventListener('visibilitychange',this.visibility);this.render();
  }
  setVisible(visible) {this.active=visible;this.visibility();}
  render() {
    const {data,error,loading,visible}=this.monitor;
    const button=this.root.querySelector('#control-refresh');button.disabled=loading || !visible;button.textContent=loading?'Consultando…':'Atualizar agora';
    const freshness=this.root.querySelector('#control-freshness');
    freshness.textContent=(data?'Última leitura: '+time(data.observed_at)+'. ':'')+(visible?'Atualização a cada 5 segundos.':'Consultas pausadas enquanto a sala não está visível.');
    const errorNode=this.root.querySelector('.control-error');errorNode.hidden=!error;errorNode.textContent=error+(data?' Os dados abaixo são da última leitura recebida.':'');
    const content=this.root.querySelector('#control-content');content.setAttribute('aria-busy',String(loading));
    if(!data){content.replaceChildren(create('p','control-empty',loading?'Consultando aplicação, filas e cluster…':'Abra a sala para consultar o sistema.'));return;}
    // Only rebuild persisted observations, preserving focused controls between polls.
    if(this.lastData===data)return;this.lastData=data;
    const app=data.application || {},api=data.api || {},broker=data.broker || {},cluster=data.cluster || {};
    const application=section('Pedidos da aplicação');
    application.append(create('p','control-description','Estados persistidos das batalhas. Uma batalha em processamento pode aguardar confirmação; este valor não mede ocupação física dos workers.'),facts([
      ['Solicitadas',asNumber(app.total)],['Na fila',asNumber(app.pending)],['Em processamento',asNumber(app.processing)],['Concluídas',asNumber(app.completed)],['Com erro',asNumber(app.failed)],['Aguardando publicação',asNumber(app.unpublished)],['Tempo médio histórico',asNumber(app.average_processing_ms,'ms')]
    ]),create('p','control-source','Fonte: banco da aplicação · Observado em '+time(data.observed_at)));
    const service=section('Serviço de entrada');
    const health=stateLabel(api.status);
    const database=typeof api.database==='boolean'?(api.database?'Disponível':'Indisponível'):stateLabel(api.database);
    service.append(facts([['API',health],['Banco',database],['Conexão ao broker',typeof api.broker_connected==='boolean'?(api.broker_connected?'Conectada':'Desconectada'):'Indisponível']]),create('p','control-source','Fonte: API da aplicação · Observado em '+time(data.observed_at)));
    const queues=section('Filas do RabbitMQ');
    queues.append(sourceLine(broker.status,broker.observed_at,broker.error_code),create('p','control-description','Prontas aguardam entrega. Sem confirmação já foram entregues, mas ainda não receberam ACK. Consumidores são assinaturas da fila, não o número de batalhas ativas.'));
    const source=broker.source==='rabbitmq_prometheus'?'Exportador Prometheus do RabbitMQ':broker.source==='rabbitmq'?'RabbitMQ':'Fonte não disponível';
    queues.append(create('p','control-source','Fonte: '+source));
    if(broker.status==='ok' && Array.isArray(broker.queues) && broker.queues.length)queues.append(table(['Fila','Prontas','Sem confirmação','Consumidores'],broker.queues.map(q=>[q.name,asNumber(q.ready),asNumber(q.unacknowledged),asNumber(q.consumers)]),'Filas observadas no broker'));
    else queues.append(create('p','control-empty',broker.status==='not_configured'?'A consulta às filas não está configurada neste ambiente.':broker.status==='ok'?'Nenhuma fila retornada na observação.':'Não foi possível observar as filas. Quantidades indisponíveis.'));
    const workers=section('Workers e capacidade configurada');
    workers.append(sourceLine(cluster.status,cluster.observed_at,cluster.error_code));
    if(cluster.status==='not_configured')workers.append(create('p','control-empty','Kubernetes não configurado neste ambiente. Réplicas, HPA e uso dos pods ficam indisponíveis no Docker Compose.'));
    else if(cluster.status==='ok') {
      workers.append(facts([['Réplicas desejadas',asNumber(cluster.desired_replicas)],['Réplicas disponíveis',asNumber(cluster.available_replicas)],['Workers prontos',asNumber(cluster.ready_workers)],['Slots por worker',asNumber(cluster.slots_per_worker)],['Slots configurados',asNumber(cluster.configured_capacity)]]),create('p','control-description','Slots são a capacidade configurada de execução. Não representam batalhas simultâneas observadas.'));
      const hpa=cluster.hpa;
      const scaling=section('Escala automática · HPA');
      if(hpa)scaling.append(facts([['Mínimo de réplicas',asNumber(hpa.min_replicas)],['Máximo de réplicas',asNumber(hpa.max_replicas)],['Réplicas atuais',asNumber(hpa.current_replicas)],['Réplicas desejadas pelo HPA',asNumber(hpa.desired_replicas)],['Meta de CPU',asNumber(hpa.target_cpu_percent,'%')],['CPU atual / solicitação',asNumber(hpa.current_cpu_percent,'%')]]));
      else scaling.append(create('p','control-empty','HPA não disponível nesta observação.'));
      if(cluster.hpa_error_code)scaling.append(create('p','control-source','Consulta do HPA indisponível nesta observação.'));
      scaling.append(create('p','control-source','Fonte: API do Kubernetes · Observado em '+time(cluster.observed_at)));workers.append(scaling);
    } else workers.append(create('p','control-empty','Não foi possível observar os workers do cluster.'));
    workers.append(create('p','control-source','Fonte: API do Kubernetes'));
    const pods=section('Uso por pod');
    pods.append(sourceLine(cluster.metrics_status,cluster.metrics_observed_at,cluster.metrics_error_code),create('p','control-source','Fonte: API de métricas do Kubernetes'),create('p','control-description','CPU em núcleos; memória em MiB. Solicitação e limite são configuração. Leituras ausentes aparecem como indisponíveis.'));
    if(cluster.status==='ok' && cluster.pods?.length) {
      for(const pod of cluster.pods){
        const details=create('details','control-pod');
        details.open=this.openPods?.has(pod.uid || pod.name) || false;
        details.dataset.pod=pod.uid || pod.name;
        details.addEventListener('toggle',()=>{this.openPods ??= new Set();if(details.open)this.openPods.add(details.dataset.pod);else this.openPods.delete(details.dataset.pod);});
        const summary=create('summary','',pod.name+' · '+(pod.ready?'Pronto':'Não pronto')+' · '+(pod.phase || 'Fase indisponível'));
        summary.append(create('span','control-pod-usage','CPU: '+asNumber(pod.cpu_cores,'núcleos')+' · Memória: '+formatMemory(pod.memory_bytes)));
        details.append(summary,
          facts([['CPU observada',asNumber(pod.cpu_cores,'núcleos')],['Memória observada',formatMemory(pod.memory_bytes)],['Reinícios',asNumber(pod.restarts)],['CPU solicitada',asNumber(pod.cpu_request_cores,'núcleos')],['Limite de CPU',asNumber(pod.cpu_limit_cores,'núcleos')],['Memória solicitada',formatMemory(pod.memory_request_bytes)],['Limite de memória',formatMemory(pod.memory_limit_bytes)],['UID',pod.uid || 'Indisponível']]));
        pods.append(details);
      }
    } else pods.append(create('p','control-empty',cluster.status==='not_configured'?'Uso dos pods disponível somente com Kubernetes configurado.':'Nenhum pod disponível nesta observação.'));
    const history=section('Resultados históricos por worker');
    history.append(create('p','control-description','Contagem acumulada de resultados recebidos pela aplicação. IDs antigos podem pertencer a workers que já encerraram.'));
    if(app.workers?.length)history.append(table(['Worker','Concluídas','Com erro'],app.workers.map(w=>[w.worker_id,asNumber(w.completed),asNumber(w.failed)]),'Resultados históricos por worker'));
    else history.append(create('p','control-empty','Nenhum resultado por worker recebido ainda.'));
    history.append(create('p','control-source','Fonte: banco da aplicação · Observado em '+time(data.observed_at)));
    content.replaceChildren(service,application,queues,workers,pods,history);
  }
}

export class TraceView {
  constructor(root,{api}) {
    this.root=root;this.active=false;
    root.innerHTML=`<form class="trace-lookup"><label for="trace-id">UUID da batalha</label><div><input id="trace-id" name="battle_id" placeholder="UUID completo da batalha" required autocomplete="off" spellcheck="false" aria-describedby="trace-lookup-error"><button class="button primary">Consultar percurso</button></div><p id="trace-lookup-error" class="form-error" role="alert" hidden></p></form><div class="trace-toolbar"><p id="trace-feedback" role="status" aria-live="polite">Abra uma batalha para acompanhar os registros do seu percurso.</p><button id="trace-refresh" class="button secondary small" disabled>Atualizar percurso</button></div><div id="trace-content"></div><div class="pagination" id="trace-pagination" hidden><span id="trace-range"></span><div><button id="trace-prev" class="button secondary small">Anterior</button><button id="trace-next" class="button secondary small">Próxima</button></div></div>`;
    this.$=selector=>root.querySelector(selector);this.monitor=new TraceMonitor({api,onChange:()=>this.render()});
    this.$('form').addEventListener('submit',e=>{e.preventDefault();this.open(this.$('#trace-id').value.trim());});
    this.$('#trace-refresh').addEventListener('click',()=>void this.monitor.refresh());
    this.$('#trace-prev').addEventListener('click',()=>this.monitor.page(Math.max(0,this.monitor.offset-this.monitor.limit)));
    this.$('#trace-next').addEventListener('click',()=>this.monitor.page(this.monitor.offset+this.monitor.limit));
    this.visibility=()=>this.monitor.setVisible(this.active && !document.hidden);document.addEventListener('visibilitychange',this.visibility);this.render();
  }
  setVisible(visible) {this.active=visible;this.visibility();}
  open(id) {
    const error=this.$('#trace-lookup-error');error.hidden=true;
    try {this.monitor.open(id);this.$('#trace-id').value=id;}
    catch(e){error.textContent=e.message;error.hidden=false;this.$('#trace-id').focus();}
  }
  render() {
    const {data,id,error,loading,offset,limit}=this.monitor;
    this.$('#trace-refresh').disabled=!id || loading || !this.monitor.visible;
    this.$('#trace-refresh').textContent=loading?'Consultando…':'Atualizar percurso';
    this.$('#trace-feedback').textContent=error || (loading?'Consultando registros da batalha…':data?'Registros recebidos. Atualize para consultar novos eventos.':'Abra uma batalha para acompanhar os registros do seu percurso.');
    const content=this.$('#trace-content');content.setAttribute('aria-busy',String(loading));
    this.$('#trace-pagination').hidden=!data;
    if(!data){content.replaceChildren();return;}
    this.$('#trace-range').textContent=data.total?(offset+1)+'–'+Math.min(offset+data.items.length,data.total)+' de '+data.total+' registros':'Nenhum registro';
    this.$('#trace-prev').disabled=loading || offset===0;this.$('#trace-next').disabled=loading || offset+limit>=data.total;
    if(this.lastData===data)return;this.lastData=data;
    const identity=create('div','trace-identity');
    identity.append(facts([['Batalha',data.battle_id],['Estado registrado',statuses[data.status] || 'Desconhecido'],['Requisição',data.request_id || 'Não registrado'],['Lote',data.batch_id || 'Batalha avulsa'],['Criada na aplicação',time(data.created_at)],['Atualizada na aplicação',time(data.updated_at)],['Publicada em',data.published_at?time(data.published_at):'Sem confirmação registrada']]));
    const coverage=create('p','trace-coverage',data.coverage==='from_creation'?'Cobertura desde a criação do pedido.':'Cobertura parcial: esta batalha é anterior ao registro completo do percurso. Etapas antigas podem não estar disponíveis.');
    const explanation=create('p','control-description','Origem é o horário informado pelo produtor do evento; observação é quando a aplicação o registrou. Entregas repetidas podem aparecer no mesmo registro. A chegada ao NGINX não é registrada.');
    const list=create('ol','trace-events');
    for(const item of data.items || []) {
      const row=create('li','trace-event'),heading=create('div','trace-event-heading');
      const label=item.applied?'Aplicado':item.reason==='already_terminal'?'Ignorado · batalha já encerrada':item.reason==='duplicate_before_tracing'?'Ignorado · evento já registrado':'Não aplicado';
      heading.append(create('h2','',events[item.event_type] || 'Evento não reconhecido'),create('span','badge '+(item.applied?'completed':'pending'),label));
      row.append(heading,facts([['Origem do evento',time(item.occurred_at)],['Observado pela aplicação',time(item.observed_at)],['Worker',item.worker_id || 'Não informado'],['Tentativa',item.attempt_id || 'Não informada'],['Evento',item.event_id || 'Não informado'],['Entregas observadas',asNumber(item.deliveries)],['Última entrega recebida',time(item.last_received_at)]]));list.append(row);
    }
    content.replaceChildren(identity,coverage,explanation,list);
    if(!data.items?.length)content.append(create('p','control-empty','Nenhum evento registrado nesta página.'));
  }
}
