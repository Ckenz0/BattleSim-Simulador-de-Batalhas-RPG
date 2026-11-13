const numeric=value=>typeof value==='number' && Number.isFinite(value) && value>=0?value:null;
const copy=value=>JSON.parse(JSON.stringify(value));
const iso=value=>new Date(value).toISOString();

export function seriesSegments(samples,key) {
  const segments=[];let current=null;
  for(const sample of samples) {
    const value=numeric(sample.values[key]);
    if(sample.breakBefore || value===null)current=null;
    if(value===null)continue;
    if(!current){current=[];segments.push(current);}
    current.push([sample.elapsed_seconds,value]);
  }
  return segments;
}

export function profileOf(cluster={}) {
  if(cluster.status==='not_configured')return {kind:'compose',label:'Compose · sem Kubernetes'};
  if(cluster.status!=='ok' || cluster.hpa_error_code)return {kind:'unavailable',label:'HPA indisponível'};
  const min=numeric(cluster.hpa?.min_replicas),max=numeric(cluster.hpa?.max_replicas);
  if(min===null || max===null)return {kind:'unavailable',label:'HPA indisponível'};
  return {kind:min===max?'fixed':'variable',min,max,
    label:min===max?`Capacidade fixa · ${min} workers`:`HPA variável · ${min} a ${max} workers`};
}

export class ExperimentRecorder {
  constructor({now=()=>Date.now(),maxSamples=720}={}) {
    this.now=now;this.maxSamples=maxSamples;this.runId=0;this.reset();
  }
  reset() {
    if(this.state==='recording')throw new Error('Encerre a coleta antes de iniciar outra.');
    this.state='idle';this.samples=[];this.pauses=[];this.paused=false;
    this.startedAt=null;this.endedAt=null;this.stopReason=null;this.breakNext=false;
  }
  start() {
    if(this.state!=='idle')throw new Error('Use Nova coleta para começar outro experimento.');
    this.runId++;this.startedAt=iso(this.now());this.state='recording';
  }
  stop(reason='manual') {
    if(this.state!=='recording')return;
    this.endedAt=iso(this.now());this.stopReason=reason;this.state='stopped';
    if(this.paused)this.pauses.at(-1).ended_at=this.endedAt;
    this.paused=false;
  }
  setPaused(paused) {
    if(this.state!=='recording' || this.paused===paused)return;
    this.paused=paused;this.breakNext=true;
    if(paused)this.pauses.push({started_at:iso(this.now()),ended_at:null});
    else this.pauses.at(-1).ended_at=iso(this.now());
  }
  observe(snapshot,runId=this.runId) {
    if(this.state!=='recording' || this.paused || runId!==this.runId)return;
    const cluster=snapshot.cluster || {},broker=snapshot.broker || {},hpa=cluster.hpa || {};
    const queue=broker.status==='ok'?broker.queues?.find(q=>q.name==='battles.requests.v1'):null;
    const clusterOk=cluster.status==='ok' && !cluster.hpa_error_code;
    this.append({kind:'observation',snapshot:copy(snapshot),profile:profileOf(cluster),values:{
      replicas:clusterOk?numeric(hpa.current_replicas):null,
      desired:clusterOk?numeric(hpa.desired_replicas):null,
      cpu:clusterOk?numeric(hpa.current_cpu_percent):null,
      target:clusterOk?numeric(hpa.target_cpu_percent):null,
      ready:numeric(queue?.ready),unacknowledged:numeric(queue?.unacknowledged)
    }});
  }
  fail(runId=this.runId) {
    if(this.state!=='recording' || this.paused || runId!==this.runId)return;
    this.append({kind:'unavailable',snapshot:null,profile:{kind:'unavailable',label:'Consulta indisponível'},
      values:{replicas:null,desired:null,cpu:null,target:null,ready:null,unacknowledged:null}});
    this.breakNext=true;
  }
  append(sample) {
    const received=this.now(),last=this.samples.at(-1);
    this.samples.push({...sample,received_at:iso(received),elapsed_seconds:Math.max(0,(received-Date.parse(this.startedAt))/1000),
      breakBefore:this.breakNext || Boolean(last && received-Date.parse(last.received_at)>15000)});
    this.breakNext=false;
    if(this.samples.length>=this.maxSamples)this.stop('limit');
  }
  summary() {
    const replicas=[],profiles=new Set();let previous=null,counterReset=false,first=null,last=null;
    for(const sample of this.samples) {
      const value=sample.values.replicas;
      if(value!==null && replicas.at(-1)!==value)replicas.push(value);
      if(['fixed','variable'].includes(sample.profile.kind))profiles.add(`${sample.profile.min}/${sample.profile.max}`);
      const completed=numeric(sample.snapshot?.application?.completed);
      if(completed!==null) {
        if(previous!==null && completed<previous)counterReset=true;
        first ??= completed;last=completed;previous=completed;
      }
    }
    return {replicas,profileChanged:profiles.size>1,counterReset,
      completedDelta:counterReset || first===null?null:last-first,
      successful:this.samples.filter(sample=>sample.kind==='observation').length,
      failed:this.samples.filter(sample=>sample.kind==='unavailable').length};
  }
  exportJSON() {
    return JSON.stringify({schema_version:1,scope:'browser_observation',started_at:this.startedAt,ended_at:this.endedAt,
      exported_at:iso(this.now()),state:this.state,stop_reason:this.stopReason,sample_limit:this.maxSamples,
      interval_seconds:5,source_endpoint:'/api/control',
      limitations:['Coleta somente enquanto a Sala de Controle está visível nesta aba.',
        'As fontes têm horários distintos e podem retornar observações em cache.',
        'Variação de concluídas é global; não identifica um lote nem prova causalidade do HPA.'],
      summary:this.summary(),pauses:this.pauses,samples:this.samples},null,2);
  }
  exportCSV() {
    const columns=['received_at','observed_at','kind','elapsed_seconds','break_before','profile','hpa_min','hpa_max',
      'replicas','desired','cpu_percent_of_request','target_cpu_percent','queue_ready','queue_unacknowledged',
      'completed_global','broker_observed_at','cluster_observed_at'];
    const cell=value=>value===null || value===undefined?'':'"'+String(value).replaceAll('"','""')+'"';
    const rows=this.samples.map(s=>[s.received_at,s.snapshot?.observed_at,s.kind,s.elapsed_seconds,s.breakBefore,
      s.profile.kind,s.profile.min,s.profile.max,s.values.replicas,s.values.desired,s.values.cpu,s.values.target,
      s.values.ready,s.values.unacknowledged,numeric(s.snapshot?.application?.completed),s.snapshot?.broker?.observed_at,s.snapshot?.cluster?.observed_at]);
    return columns.join(',')+'\r\n'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
  }
}
