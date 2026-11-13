import {ExperimentRecorder,profileOf,seriesSegments} from './control-experiment.mjs';
import {formatMetric} from './control.mjs';

const create=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
const elapsed=seconds=>seconds<60?`${Math.round(seconds)} s`:`${Math.floor(seconds/60)} min ${Math.round(seconds%60)} s`;
const localTime=value=>new Date(value).toLocaleTimeString('pt-BR');
const svg=(tag,attrs={})=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;};
const charts=[
  {title:'Workers',unit:'réplicas',step:true,series:[['replicas','Atuais'],['desired','Desejadas pelo HPA']]},
  {title:'CPU dos workers',unit:'% do request',series:[['cpu','CPU / request'],['target','Meta do HPA']]},
  {title:'Fila de pedidos',unit:'mensagens',series:[['ready','Prontas'],['unacknowledged','Sem ACK']]}
];

export class ExperimentView {
  constructor(root,{refresh=()=>{}}={}) {
    this.root=root;this.refresh=refresh;this.recorder=new ExperimentRecorder();this.visible=false;
    root.className='experiment';root.setAttribute('aria-labelledby','experiment-heading');
    root.innerHTML=`<div class="experiment-heading"><div><h2 id="experiment-heading">Experimento de elasticidade</h2><p class="control-description">Registre a relação entre carga, fila e workers ao longo do tempo.</p></div><span id="experiment-profile" class="experiment-profile">Aguardando perfil</span></div>
      <div class="experiment-actions"><button id="experiment-start" class="button primary small">Iniciar coleta</button><button id="experiment-stop" class="button secondary small" hidden>Encerrar coleta</button><button id="experiment-reset" class="button secondary small" hidden>Nova coleta</button><div class="experiment-exports"><button id="experiment-json" class="button secondary small" disabled>Exportar JSON</button><button id="experiment-csv" class="button secondary small" disabled>Exportar CSV</button></div></div>
      <div id="experiment-confirm" class="experiment-confirm" hidden><p>A coleta anterior será descartada desta aba. Exporte os dados antes de continuar.</p><button id="experiment-discard" class="button secondary small">Descartar e iniciar outra</button><button id="experiment-cancel" class="button secondary small">Manter coleta anterior</button></div>
      <p id="experiment-status" class="experiment-status" role="status" aria-live="polite"></p>
      <p id="experiment-note" class="control-description">A coleta fica apenas nesta aba. Exporte antes de recarregar ou fechar. Navegar ou ocultar a sala pausa as leituras.</p>
      <div id="experiment-empty" class="experiment-empty"><h3>Da carga à elasticidade, em uma linha do tempo</h3><p>Inicie a coleta antes de gerar carga. Acompanhe a fila crescer, observe as réplicas e continue coletando após a fila esvaziar para registrar a redução.</p><button class="text-button" data-goto="load">Abrir teste de carga</button><p>A coleta será pausada fora desta sala. Para observar sem interrupções, gere a carga pelo roteiro da entrega em outro terminal.</p></div>
      <div id="experiment-results" hidden><div id="experiment-summary" class="experiment-summary"></div><div class="experiment-charts"></div><p class="experiment-chart-note">Cada ponto é uma consulta recebida. Lacunas indicam pausas ou dados ausentes; as fontes podem ter horários diferentes. CPU de 100% equivale ao request, não à CPU total da máquina.</p><details class="experiment-readings"><summary>Leituras recentes · tabela acessível</summary><div class="table-wrap"><table><caption>Últimas 12 leituras; exporte para obter a coleta completa.</caption><thead><tr><th scope="col">Tempo</th><th scope="col">Workers atuais</th><th scope="col">Desejados pelo HPA</th><th scope="col">CPU / request</th><th scope="col">Meta CPU</th><th scope="col">Prontas</th><th scope="col">Sem ACK</th><th scope="col">Leitura</th></tr></thead><tbody id="experiment-readings"></tbody></table></div></details></div>`;
    const find=id=>root.querySelector('#experiment-'+id);this.find=find;
    find('start').addEventListener('click',()=>this.start());
    find('stop').addEventListener('click',()=>{this.recorder.stop();this.render();find('reset').focus();});
    find('reset').addEventListener('click',()=>{find('confirm').hidden=false;find('cancel').focus();});
    find('cancel').addEventListener('click',()=>{find('confirm').hidden=true;find('reset').focus();});
    find('discard').addEventListener('click',()=>{this.recorder.reset();find('confirm').hidden=true;this.start();});
    for(const extension of ['json','csv'])find(extension).addEventListener('click',()=>this.download(extension));
    this.beforeUnload=event=>{if(this.recorder.state==='recording'){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',this.beforeUnload);
    this.resize=new ResizeObserver(()=>this.renderCharts());this.resize.observe(root);this.render();
  }
  start() {this.recorder.start();this.recorder.setPaused(!this.visible);this.render();this.find('stop').focus();void this.refresh();}
  setVisible(visible) {this.visible=visible;this.recorder.setPaused(!visible);this.render();}
  observe(data,context) {this.currentProfile=profileOf(data.cluster);this.recorder.observe(data,context);this.render();}
  fail(context) {this.recorder.fail(context);this.render();}
  render() {
    const r=this.recorder,count=r.samples.length,running=r.state==='recording',stopped=r.state==='stopped';
    this.find('start').hidden=r.state!=='idle';this.find('start').disabled=!this.visible;
    this.find('stop').hidden=!running;this.find('reset').hidden=!stopped;
    this.find('json').disabled=this.find('csv').disabled=count===0;
    this.find('empty').hidden=count>0;this.find('results').hidden=count===0;
    const profile=stopped?r.samples.at(-1)?.profile:this.currentProfile;
    this.find('profile').textContent=profile?.label || 'Aguardando perfil';
    const status=r.state==='idle'?'Pronto para iniciar.':running?(r.paused?'Coleta pausada · volte à sala para continuar.':`Coletando · ${count} de ${r.maxSamples} leituras.`):
      `Coleta encerrada · ${count} leituras.${r.stopReason==='limit'?' Limite de coleta atingido.':''} Exporte o resultado.`;
    this.find('status').textContent=status;
    if(!count)return;
    const summary=r.summary(),sequence=summary.replicas.slice(-20).join(' → ') || 'Indisponíveis';
    const facts=create('dl','control-facts');
    for(const [label,value] of [
      ['Réplicas observadas'+(summary.replicas.length>20?' (últimas 20 transições)':''),sequence],
      ['Duração até a última leitura',elapsed(r.samples.at(-1).elapsed_seconds)],
      ['Consultas recebidas / falhas',`${summary.successful} / ${summary.failed}`],
      ['Concluídas durante as leituras (global)',formatMetric(summary.completedDelta)]
    ]){const row=create('div');row.append(create('dt','',label),create('dd','',value));facts.append(row);}
    const note=create('p','control-description',summary.counterReset?'O contador global diminuiu; a variação de concluídas ficou indisponível.':
      'A contagem inclui toda a aplicação, inclusive outras cargas. Mudanças de réplicas observadas não comprovam, isoladamente, uma decisão automática do HPA.');
    this.find('summary').replaceChildren(facts,note);
    if(summary.profileChanged)this.find('summary').append(create('p','experiment-warning','Os limites do HPA mudaram durante esta coleta. Confira os perfis por amostra no JSON.'));
    const rows=r.samples.slice(-12).map(sample=>{const tr=create('tr');for(const value of [elapsed(sample.elapsed_seconds),formatMetric(sample.values.replicas),formatMetric(sample.values.desired),formatMetric(sample.values.cpu,'%'),formatMetric(sample.values.target,'%'),formatMetric(sample.values.ready),formatMetric(sample.values.unacknowledged),sample.kind==='unavailable'?'Consulta indisponível':localTime(sample.received_at)])tr.append(create('td','',value));return tr;});
    this.find('readings').replaceChildren(...rows);this.renderCharts();
  }
  renderCharts() {
    if(!this.recorder.samples.length || !this.visible)return;
    const host=this.root.querySelector('.experiment-charts');
    if(!host.children.length)for(const config of charts){const figure=create('figure','experiment-chart');figure.append(create('h3','',config.title),create('div','experiment-plot'),create('figcaption','experiment-legend'));host.append(figure);}
    charts.forEach((config,index)=>{
      const figure=host.children[index],plot=figure.querySelector('.experiment-plot'),legend=figure.querySelector('figcaption');
      legend.replaceChildren(...config.series.map(([,label],i)=>create('span','experiment-series series-'+i,label)));
      const samples=this.recorder.samples,width=Math.max(260,Math.round(plot.clientWidth)),height=184,left=44,right=14,top=24,bottom=30;
      const maxTime=Math.max(5,samples.at(-1).elapsed_seconds);
      const values=samples.flatMap(s=>config.series.map(([key])=>s.values[key])).filter(v=>v!==null);
      const maxValue=Math.max(1,...values),ceiling=config.step?Math.max(2,Math.ceil(maxValue)):Math.ceil(maxValue*1.1);
      const x=t=>left+t/maxTime*(width-left-right),y=v=>height-bottom-v/ceiling*(height-top-bottom);
      const chart=svg('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':config.title+' ao longo do tempo. Valores e horários na tabela de leituras recentes.'});
      const text=(value,px,py,anchor='start')=>{const node=svg('text',{x:px,y:py,'text-anchor':anchor});node.textContent=value;chart.append(node);};
      text(config.unit,left,13);
      for(const value of [0,ceiling]){chart.append(svg('line',{x1:left,y1:y(value),x2:width-right,y2:y(value),class:'experiment-grid'}));text(formatMetric(value),left-7,y(value)+4,'end');}
      text('0 s',left,height-7);text(elapsed(maxTime),width-right,height-7,'end');
      config.series.forEach(([key],series)=>{
        for(const segment of seriesSegments(samples,key)) {
          const path=segment.map(([t,value],i)=>(i?(config.step?`H${x(t)}V${y(value)}`:`L${x(t)},${y(value)}`):`M${x(t)},${y(value)}`)).join(' ');
          chart.append(svg('path',{d:path,class:'experiment-line series-'+series}));
          for(const [t,value] of segment)chart.append(svg('circle',{cx:x(t),cy:y(value),r:2.5,class:'experiment-point series-'+series}));
        }
      });
      if(!values.length){const node=svg('text',{x:(width+left)/2,y:height/2,'text-anchor':'middle'});node.textContent='Sem métricas disponíveis';chart.append(node);}
      plot.replaceChildren(chart);
    });
  }
  download(extension) {
    const r=this.recorder,content=extension==='json'?r.exportJSON():r.exportCSV();
    const blob=new Blob([extension==='csv'?'\ufeff':'',content],{type:extension==='json'?'application/json;charset=utf-8':'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=create('a');link.href=url;link.download='battlesim-elasticidade-'+r.startedAt.replace(/[:.]/g,'-')+'.'+extension;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
