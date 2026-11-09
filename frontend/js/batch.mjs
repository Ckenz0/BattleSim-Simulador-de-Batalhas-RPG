const storageKey='battlesim-batches';
const batchId=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validBatch=value=>value && batchId.test(value.id) && Number.isInteger(value.count) && value.count>=0 && value.count<=1000;

// API states are eventual reports. They do not measure physical worker concurrency.
export class BatchMonitor {
  constructor({api,storage,onChange=()=>{}}) {
    this.api=api;this.storage=storage;this.onChange=onChange;
    this.batch=null;this.snapshot=null;this.recent=[];this.error=null;this.loading=false;
    this.revision=0;this.page=0;
  }
  get visibleItems() {return this.snapshot?.items.slice(this.page*100,(this.page+1)*100) ?? [];}
  resume() {
    try {
      const saved=JSON.parse(this.storage?.getItem(storageKey) || 'null');
      this.recent=Array.isArray(saved?.recent)?saved.recent.filter(validBatch).slice(0,10):[];
      const selected=this.recent.find(batch=>batch.id===saved?.selected);
      if(selected)this.select(selected.id,selected.count);
    } catch { /* Storage may be disabled or contain data from an older version. */ }
  }
  accept(result) {this.select(result.batch_id,result.count);}
  select(id,count=0) {
    if(!batchId.test(id))throw new Error('Informe o identificador completo do lote.');
    const known=this.recent.find(batch=>batch.id===id);
    this.batch={id,count:count || known?.count || 0};
    this.recent=[this.batch,...this.recent.filter(batch=>batch.id!==id)].slice(0,10);
    this.revision++;this.page=0;this.snapshot=null;this.error=null;this.loading=false;
    this.save();this.onChange();
  }
  save() {
    try {this.storage?.setItem(storageKey,JSON.stringify({selected:this.batch?.id,recent:this.recent}));} catch {}
  }
  showPage(page) {
    this.page=Math.max(0,Math.min(page,Math.ceil((this.snapshot?.items.length || 1)/100)-1));
    this.onChange();
  }
  async refresh() {
    if(!this.batch || this.loading || this.snapshot?.terminal)return;
    const revision=this.revision,batch=this.batch;
    this.loading=true;this.onChange();
    try {
      const path='/battles?batch_id='+encodeURIComponent(batch.id)+'&limit=100&offset=';
      const first=await this.api(path+'0');
      if(this.revision!==revision)return;
      const pages=[first];
      // The API caps accepted batches at 1000. Read every page for truthful totals.
      for(let offset=100;offset<Math.min(first.total,1000);offset+=100) {
        pages.push(await this.api(path+offset));
        if(this.revision!==revision)return;
      }
      const items=[...new Map(pages.flatMap(page=>page.items).map(item=>[item.id,item])).values()];
      const total=Math.max(batch.count,first.total,items.length);
      const counts={pending:0,processing:0,completed:0,failed:0,unknown:0};
      for(const item of items)counts[Object.hasOwn(counts,item.status)?item.status:'unknown']++;
      const finished=counts.completed+counts.failed,missing=Math.max(0,total-items.length);
      this.snapshot={items,total,counts,finished,missing,terminal:total>0 && finished===total,updatedAt:Date.now()};
      if(!batch.count && total<=1000) {batch.count=total;this.save();}
      this.error=null;
    } catch(error) {
      if(this.revision===revision)this.error=error.message;
    } finally {
      if(this.revision===revision) {this.loading=false;this.onChange();}
    }
  }
}
