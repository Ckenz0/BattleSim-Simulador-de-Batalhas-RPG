import {createSprite} from './arena.mjs';

const labels={warrior:'Guerreiro',mage:'Mago',archer:'Arqueiro',hp:'Vida',attack:'Ataque',defense:'Defesa',speed:'Velocidade'};
const descriptions={warrior:'Resistente e equilibrado.',mage:'Magia poderosa, defesa delicada.',archer:'Agilidade para atacar primeiro.'};
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function button(text,fn,cls='button secondary'){const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;}

export class AdventureView {
  constructor(root,{api,notify,showBattle,onCharacterChange}){
    Object.assign(this,{root,api,notify,showBattle,onCharacterChange});
    this.catalog=null;this.run=null;this.busy=false;this.visible=false;this.loading=false;this.revision=0;
    this.savedId=localStorage.getItem('adventure-id');this.allocation={hp:0,attack:0,defense:0,speed:0};this.className='warrior';
    this.root.append(el('p','muted','Carregando sua aventura…'));
  }
  async init(){
    try{
      this.catalog=await this.api('/adventures/catalog');
      if(this.savedId){
        try{this.run=await this.api('/adventures/'+this.savedId);}
        catch(e){if(e.status!==404)throw e;localStorage.removeItem('adventure-id');this.savedId=null;}
      }
      this.render();
    }catch(e){this.root.replaceChildren(el('p','form-error',e.message),button('Tentar novamente',()=>this.init()));}
  }
  setVisible(value){this.visible=value;if(value)this.refresh().catch(e=>this.notify(e.message,true));}
  async refresh(){
    if(!this.run || this.loading || this.busy || this.showLibrary)return;
    this.loading=true;
    try{
      const id=this.run.id,revision=this.revision,updated=await this.api('/adventures/'+id);
      if(this.run?.id!==id || revision!==this.revision || this.busy || this.showLibrary)return;
      const changed=JSON.stringify(updated)!==JSON.stringify(this.run);this.run=updated;
      if(changed)this.render();
    }finally{this.loading=false;}
  }
  async action(fn){
    if(this.busy)return;this.busy=true;this.revision++;
    this.root.querySelectorAll('button,input').forEach(n=>n.disabled=true);
    try{await fn();}catch(e){this.notify(e.message,true);}
    finally{this.busy=false;this.render();}
  }
  remember(run){this.revision++;this.run=run;this.savedId=run.id;localStorage.setItem('adventure-id',run.id);}
  async open(adventureId){
    if(this.run?.id===adventureId){this.showLibrary=false;this.render();await this.refresh();return;}
    await this.action(async()=>{this.remember(await this.api('/adventures/'+adventureId));this.showLibrary=false;});
  }
  render(){
    if(!this.catalog)return;
    this.root.replaceChildren();
    if(!this.run){this.renderCreation();return;}
    const run=this.run,hero=run.hero;
    const layout=el('div','adventure-layout'),profile=el('section','adventure-profile');
    profile.append(createSprite(hero.class_name),el('h2','',hero.name),el('p','adventure-level',labels[hero.class_name]+' · Nível '+run.level));
    const stats=el('dl','adventure-stats');
    for(const key of Object.keys(this.allocation)){const row=el('div');row.append(el('dt','',labels[key]),el('dd','',hero[key]));stats.append(row);}
    profile.append(stats,el('p','field-note','Sua vida é restaurada antes de cada tentativa.'));
    profile.append(button('Trocar ou criar herói',()=>this.openLibrary(),'text-button'));
    const journey=el('div','adventure-journey'),map=el('ol','adventure-map');map.setAttribute('aria-label','Cinco fases da aventura');
    this.catalog.stages.forEach(stage=>{
      const done=stage.number<run.stage,current=stage.number===run.stage;
      const item=el('li',done?'done':current?'current':'locked');
      if(current)item.setAttribute('aria-current','step');
      item.append(el('span','stage-number',String(stage.number)),el('strong','',stage.name),el('small','',done?'Vencida':current?'Fase atual':'Bloqueada'));map.append(item);
    });
    journey.append(map);
    const panel=el('section','adventure-action');
    if(run.status==='reward'){
      panel.append(el('h2','','Você subiu para o nível '+run.level+'!'),el('p','','Vitória conquistada. Escolha uma melhoria permanente para continuar.'));
      const rewards=el('div','adventure-rewards');
      Object.entries(run.upgrades).forEach(([key,gain])=>{
        const b=button('',()=>this.action(async()=>{
          const updated=await this.api('/adventures/'+run.id+'/upgrades',{method:'POST',body:JSON.stringify({battle_id:run.last_battle_id,attribute:key})});
          this.remember(updated);this.notify(labels[key]+' melhorado!');void this.onCharacterChange().catch(e=>this.notify(e.message,true));
        }),'upgrade-choice');
        b.dataset.upgrade=key;b.append(el('span','',labels[key]),el('strong','','+'+Math.min(gain,this.catalog.caps[key]-hero[key])));rewards.append(b);
      });panel.append(rewards);
    }else if(run.status==='completed'){
      panel.append(el('h2','','Arena conquistada!'),el('p','','Cinco fases vencidas. Seu herói chegou ao nível '+run.level+'.'),button('Criar outro herói',()=>{this.run=null;this.render();}));
    }else{
      const stage=run.current_stage;
      panel.append(el('h2','',(run.last_outcome==='defeat' || run.last_outcome==='draw')?'Mais uma tentativa?':'Próximo confronto: '+stage.name));
      const pending=run.status==='pending';
      panel.append(el('p','',pending?'Seu confronto está salvo. Acompanhe a batalha na arena.':
        run.last_outcome==='failed'?'O confronto foi interrompido. Tente a mesma fase novamente.':'Vença a fase '+run.stage+' para subir de nível e escolher uma melhoria.'));
      const fight=button(pending?'Acompanhar batalha':run.last_outcome==='defeat'?'Tentar novamente':'Entrar na fase '+run.stage,()=>this.action(async()=>{
        const battle=await this.api('/adventures/'+run.id+'/battles',{method:'POST'});
        // POST acceptance is authoritative; opening the arena cannot depend on a follow-up read.
        this.run={...this.run,status:'pending',last_battle_id:battle.id};this.showBattle(battle);
      }),'button primary');fight.id='adventure-fight';panel.append(fight);
    }
    journey.append(panel);layout.append(profile,journey);this.root.append(layout);
  }
  renderCreation(){
    const form=el('form','adventure-create'),nameLabel=el('label','','Nome do herói');nameLabel.htmlFor='adventure-name';
    const name=el('input');name.id='adventure-name';name.name='name';name.required=true;name.maxLength=60;name.placeholder='Como sua lenda será chamada?';name.autocomplete='off';
    name.value=this.draftName || '';name.addEventListener('input',()=>{this.draftName=name.value;});
    const field=el('fieldset','adventure-classes');field.append(el('legend','','Escolha sua classe'));
    const options=el('div','adventure-class-options');
    Object.keys(this.catalog.classes).forEach(cls=>{
      const label=el('label','adventure-class'),radio=el('input');radio.type='radio';radio.name='adventure-class';radio.value=cls;radio.checked=cls===this.className;
      radio.addEventListener('change',()=>{this.className=cls;this.render();this.root.querySelector('[value="'+cls+'"]').focus();});
      const face=el('span','class-face');face.append(createSprite(cls),el('strong','',labels[cls]),el('small','',descriptions[cls]));label.append(radio,face);options.append(label);
    });field.append(options);
    const budget=el('div','allocation-heading'),remaining=5-Object.values(this.allocation).reduce((a,b)=>a+b,0);
    budget.append(el('h2','','Dê o seu toque'),el('p','',remaining+' pontos disponíveis'));
    const allocations=el('div','adventure-allocations');
    Object.entries(this.allocation).forEach(([key,points])=>{
      const row=el('div','allocation-row'),value=this.catalog.classes[this.className][key]+points*this.catalog.initial_gains[key];
      row.append(el('span','',labels[key]),el('strong','',value));
      const minus=button('−',()=>{this.allocation[key]--;this.render();this.root.querySelector('[data-minus="'+key+'"]').focus();});minus.dataset.minus=key;minus.disabled=points===0;minus.setAttribute('aria-label','Remover ponto de '+labels[key]);
      const plus=button('+',()=>{this.allocation[key]++;this.render();this.root.querySelector('[data-plus="'+key+'"]').focus();});plus.dataset.plus=key;plus.disabled=remaining===0;plus.setAttribute('aria-label','Adicionar ponto em '+labels[key]);
      row.append(minus,el('span','allocated-points',points),plus);allocations.append(row);
    });
    const submit=el('button','button primary','Começar aventura');submit.type='submit';submit.disabled=remaining!==0;
    const intro=el('div','adventure-intro');intro.append(el('h2','','Sua história começa aqui'),el('p','','Crie um herói, distribua cinco pontos e conquiste a arena. Cada vitória rende um nível e uma nova melhoria.'));
    form.append(intro,nameLabel,name,field,budget,allocations,submit,button('Continuar um herói salvo',()=>this.openLibrary(),'text-button'));
    form.addEventListener('submit',event=>{event.preventDefault();this.action(async()=>{
      const run=await this.api('/adventures',{method:'POST',body:JSON.stringify({name:name.value.trim(),class_name:this.className,allocation:this.allocation})});
      this.remember(run);this.draftName='';this.allocation={hp:0,attack:0,defense:0,speed:0};void this.onCharacterChange().catch(e=>this.notify(e.message,true));
    });});this.root.append(form);
  }
  async openLibrary(){
    await this.action(async()=>{
      const page=await this.api('/adventures?limit=100');this.library=page;
      this.showLibrary=true;
    });
    if(!this.showLibrary)return;
    const section=el('section','adventure-library');section.append(el('h2','','Seus heróis'));
    this.library.items.forEach(run=>section.append(button(run.hero.name+' · '+labels[run.hero.class_name]+' · Nível '+run.level,()=>{this.remember(run);this.showLibrary=false;this.render();})));
    if(!this.library.items.length)section.append(el('p','','Você ainda não tem um herói salvo.'));
    section.append(button('Criar novo herói',()=>{this.run=null;this.showLibrary=false;this.render();}),button('Voltar',()=>{this.showLibrary=false;this.render();},'text-button'));
    this.root.replaceChildren(section);
  }
}
