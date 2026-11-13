export const validBattleId=value=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Visibility is supplied by the view so no background control-room reads survive navigation.
export class ControlMonitor {
  constructor({api,onChange=()=>{},onSample=()=>{},onFailure=()=>{},contextForRead=()=>undefined,schedule=(callback,delay)=>setTimeout(callback,delay),cancel=timer=>clearTimeout(timer)}) {
    Object.assign(this,{api,onChange,onSample,onFailure,contextForRead,schedule,cancel});
    this.visible=false;this.data=null;this.error=null;this.loading=false;this.generation=0;
  }
  setVisible(visible) {
    if(this.visible===visible)return;
    this.visible=visible;this.generation++;this.cancel(this.timer);this.controller?.abort();this.loading=false;
    if(visible)void this.refresh();else this.onChange();
  }
  async refresh() {
    if(!this.visible || this.loading)return;
    this.cancel(this.timer);
    const generation=this.generation,controller=new AbortController();this.controller=controller;
    const context=this.contextForRead();
    this.loading=true;this.onChange();
    try {
      const data=await this.api('/control',{signal:controller.signal});
      if(generation!==this.generation)return;
      this.data=data;this.error=null;
      this.onSample(data,context);
    } catch(error) {
      if(generation!==this.generation || controller.signal.aborted)return;
      this.error='Não foi possível consultar a sala. A próxima consulta será feita automaticamente.';
      this.onFailure(context);
    } finally {
      if(generation===this.generation) {
        this.loading=false;this.onChange();
        if(this.visible)this.timer=this.schedule(()=>void this.refresh(),5000);
      }
    }
  }
}

export class TraceMonitor {
  constructor({api,onChange=()=>{}}) {
    Object.assign(this,{api,onChange});this.id=null;this.offset=0;this.limit=100;
    this.data=null;this.error=null;this.loading=false;this.generation=0;this.visible=false;
  }
  open(id) {
    if(!validBattleId(id))throw new Error('Informe o UUID completo da batalha.');
    this.invalidate();this.id=id;this.offset=0;this.data=null;this.error=null;this.onChange();
    if(this.visible)void this.refresh();
  }
  invalidate() {this.generation++;this.controller?.abort();this.loading=false;}
  setVisible(visible) {
    if(this.visible===visible)return;
    this.visible=visible;this.invalidate();
    if(visible && this.id)void this.refresh();else this.onChange();
  }
  page(offset) {
    if(!this.id || offset<0 || (this.data && offset>=this.data.total))return;
    this.invalidate();this.offset=offset;this.data=null;void this.refresh();
  }
  async refresh() {
    if(!this.visible || !this.id || this.loading)return;
    const generation=this.generation,controller=new AbortController();this.controller=controller;
    this.loading=true;this.error=null;this.onChange();
    try {
      const data=await this.api('/battles/'+encodeURIComponent(this.id)+'/trace?limit='+this.limit+'&offset='+this.offset,{signal:controller.signal});
      if(generation!==this.generation)return;
      this.data=data;
    } catch(error) {
      if(generation!==this.generation || controller.signal.aborted)return;
      this.error=error.status===404?'Batalha não encontrada. Confira o UUID informado.':'Não foi possível consultar o percurso. Tente atualizar novamente.';
    } finally {if(generation===this.generation){this.loading=false;this.onChange();}}
  }
}

export function formatMetric(value,unit='') {
  if(typeof value!=='number' || !Number.isFinite(value))return 'Indisponível';
  return new Intl.NumberFormat('pt-BR',{maximumFractionDigits:3}).format(value)+(unit?' '+unit:'');
}
export function formatMemory(bytes) {
  return typeof bytes==='number' && Number.isFinite(bytes)?formatMetric(bytes/1048576,'MiB'):'Indisponível';
}
