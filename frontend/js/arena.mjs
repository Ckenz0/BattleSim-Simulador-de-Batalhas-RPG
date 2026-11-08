import {BattlePlayback} from "./playback.mjs";

const classes={warrior:"Guerreiro",mage:"Mago",archer:"Arqueiro"};
const moves={warrior:"Golpe de Espada",mage:"Pulso Arcano",archer:"Flecha Certeira"};
function node(tag,className,text){
  const n=document.createElement(tag);if(className)n.className=className;
  if(text!==undefined)n.textContent=String(text);return n;
}
export function createSprite(className,back=false){
  const sprite=node("div","pixel-sprite "+(classes[className]?className:"warrior")+" "+(back?"back":"front"));
  sprite.setAttribute("aria-hidden","true");sprite.dataset.pose="idle";return sprite;
}

export class PixelArena {
  constructor(root,{onFinish=()=>{},onReplay=()=>{},onContinue=()=>{}}={}){
    this.root=root;this.onFinish=onFinish;this.onReplay=onReplay;this.onContinue=onContinue;this.playback=null;
    this.visible=true;this.animations=[];this.introTimer=null;this.phaseKey=null;this.mode="preview";
    this.media=matchMedia("(prefers-reduced-motion: reduce)");
    this.scene=node("div","pixel-field");this.scene.setAttribute("role","group");
    this.scene.setAttribute("aria-label","Campo de batalha com dois combatentes");
    this.scene.append(node("div","scene-vignette"));
    this.actors=new Map();
    this.prompt=node("div","field-prompt","Escolha seus combatentes");
    this.effects=node("div","battle-effects");this.effects.setAttribute("aria-hidden","true");
    this.victory=node("div","victory-screen");this.victory.hidden=true;
    this.scene.append(this.prompt,this.effects,this.victory);
    this.enemyHud=this.hud("enemy");this.allyHud=this.hud("ally");
    this.scene.append(this.enemyHud.root,this.allyHud.root);
    this.dialog=node("div","battle-dialog");
    this.turn=node("span","scene-turn","A arena está pronta");
    this.line=node("p","replay-line","Escolha dois personagens para entrar na arena.");
    this.line.setAttribute("role","status");this.line.setAttribute("aria-live","polite");
    const story=node("div","battle-story");story.append(this.turn,this.line);
    this.play=node("button","game-command","Assistir");this.play.id="replay-button";
    this.next=node("button","game-command","Avançar turno");this.next.id="next-turn";
    this.skip=node("button","game-command","Ver desfecho");this.skip.id="skip-battle";
    this.speed=node("select","game-speed");this.speed.id="playback-speed";this.speed.setAttribute("aria-label","Velocidade da batalha");
    [1,2,4].forEach(value=>{const option=node("option","",value+"×");option.value=value;this.speed.append(option);});
    const commands=node("div","battle-commands");commands.append(this.play,this.next,this.skip,this.speed);
    this.dialog.append(story,commands);this.root.append(this.scene,this.dialog);
    this.setControls(false);
    this.play.addEventListener("click",()=>{
      if(!this.playback)return;this.cancelIntro();
      if(this.playback.snapshot().status==="playing")this.pause();
      else if(this.media.matches)this.playback.step();
      else this.playback.play();
    });
    this.next.addEventListener("click",()=>{this.cancelIntro();this.playback?.step();});
    this.skip.addEventListener("click",()=>{this.cancelIntro();this.playback?.finish();});
    this.speed.addEventListener("change",()=>this.playback?.setSpeed(Number(this.speed.value)));
    this.visibility=()=>this.updateMotion();
    document.addEventListener("visibilitychange",this.visibility);
    this.motionChange=()=>{if(this.media.matches)this.pause();this.updateMotion();};
    this.media.addEventListener("change",this.motionChange);
    this.updateMotion();
  }
  hud(side){
    const root=node("div","combat-hud "+side),name=node("strong","hud-name",side==="ally"?"Seu combatente":"Adversário");
    const cls=node("span","hud-class","Aguardando seleção");
    const headline=node("div","hud-headline");headline.append(name,cls);
    const bar=node("progress");bar.max=100;bar.value=100;bar.setAttribute("aria-label","Vida do combatente");
    const hp=node("span","hud-hp","—"), label=node("span","hp-label","HP");
    const track=node("div","hud-track");track.append(label,bar);
    root.append(headline,track,hp);root.hidden=true;return{root,name,cls,bar,hp};
  }
  setControls(enabled){
    [this.play,this.next,this.skip,this.speed].forEach(control=>control.disabled=!enabled);
  }
  clearMotion(){
    this.animations.forEach(a=>a.cancel());this.animations=[];
    this.effects.replaceChildren();
    this.actors.forEach(({element,sprite})=>{element.classList.remove("fainted","victor");sprite.dataset.pose="idle";});
  }
  cancelIntro(){if(this.introTimer!==null)clearTimeout(this.introTimer);this.introTimer=null;}
  clearPlayback(){
    this.cancelIntro();this.playback?.dispose();this.playback=null;this.clearMotion();this.phaseKey=null;
  }
  participants(characters){
    this.actors.forEach(({element})=>element.remove());this.actors.clear();
    [this.allyHud,this.enemyHud].forEach(h=>h.root.hidden=true);
    characters.slice(0,2).forEach((character,index)=>{
      const side=index===0?"ally":"enemy",hud=index===0?this.allyHud:this.enemyHud;
      hud.root.hidden=false;hud.root.classList.remove("low-hp");hud.name.textContent=character.name;hud.cls.textContent=classes[character.class_name];
      if(this.battle?.adventure && this.battle.participants===characters && index===0)hud.cls.textContent+=' · Nv. '+this.battle.adventure.hero_level;
      hud.bar.max=character.hp;hud.bar.value=character.hp;hud.bar.setAttribute("aria-label","Vida de "+character.name);
      hud.hp.textContent=character.hp+" / "+character.hp;
      const element=node("div","scene-fighter "+side+" "+character.class_name);
      const sprite=createSprite(character.class_name,index===0);element.append(sprite);
      this.scene.insertBefore(element,this.effects);
      this.actors.set(character.id,{element,sprite,hud,character,side});
    });
    this.prompt.hidden=characters.length===2;
    this.scene.setAttribute("aria-label",characters.length===2?"Arena: "+characters.map(c=>c.name).join(" contra "):"Campo de batalha aguardando combatentes");
  }
  previewParticipants(characters,{force=false}={}){
    if(this.mode==="waiting" || this.playback?.snapshot().status==="playing" || this.playback?.snapshot().status==="paused")return;
    if(this.playback && !force)return;
    this.clearPlayback();this.mode="preview";this.root.dataset.state="preview";this.victory.hidden=true;
    this.participants(characters);this.setControls(false);
    this.turn.textContent="Prepare o confronto";
    this.line.textContent=characters.length===2?characters[0].name+" e "+characters[1].name+" estão prontos para batalhar.":"Escolha dois personagens para entrar na arena.";
    this.updateMotion();
  }
  waitFor(battle){
    this.clearPlayback();this.battle=battle;this.mode="waiting";this.root.dataset.state="waiting";
    this.victory.hidden=true;this.participants(battle.participants);this.setControls(false);
    this.turn.textContent=battle.status==="pending"?"Na fila":"Preparando a batalha";
    this.line.textContent=battle.status==="pending"?"Seu confronto foi solicitado. A arena está esperando.":"Os combatentes se preparam para entrar em ação.";
    this.updateMotion();
  }
  failure(battle){
    this.clearPlayback();this.mode="error";this.root.dataset.state="error";this.victory.hidden=true;
    this.participants(battle.participants);this.setControls(false);this.turn.textContent="Confronto interrompido";
    this.line.textContent="Não foi possível concluir esta batalha. Você pode iniciar outro confronto.";this.updateMotion();
  }
  loadBattle(battle,{fresh=false}={}){
    this.clearPlayback();this.mode="battle";this.battle=battle;this.victory.hidden=true;this.participants(battle.participants);
    this.suppressVictory=!fresh;this.root.dataset.state="ready";
    this.playback=new BattlePlayback(battle,{onChange:s=>this.render(s)});
    this.playback.setSpeed(Number(this.speed.value));this.setControls(true);
    if(!fresh){this.playback.finish();return;}
    this.render(this.playback.snapshot());
    if(this.visible && !document.hidden && !this.media.matches){
      this.introTimer=setTimeout(()=>{this.introTimer=null;if(this.visible && !document.hidden)this.playback?.play();},550);
    }
  }
  render(snapshot){
    const previous=this.root.dataset.state;
    if(this.lastSpeed && this.lastSpeed!==snapshot.speed){
      this.animations.forEach(a=>a.updatePlaybackRate(a.playbackRate*snapshot.speed/this.lastSpeed));
    }
    this.lastSpeed=snapshot.speed;
    this.root.dataset.state=snapshot.status;
    this.root.dataset.phase=snapshot.phase;
    this.root.style.setProperty("--playback-speed",snapshot.speed);
    this.actors.forEach(({hud,character,element})=>{
      const hp=snapshot.hp[character.id];hud.bar.value=hp;hud.hp.textContent=hp+" / "+character.hp;
      hud.root.classList.toggle("low-hp",hp<=character.hp*.25);element.classList.toggle("fainted",hp===0);
    });
    this.play.textContent=snapshot.status==="playing"?"Pausar":this.media.matches?
      (snapshot.status==="finished"?"Rever combate":"Avançar turno"):
      snapshot.status==="finished"?"Rever combate":snapshot.status==="paused"?"Continuar":"Assistir";
    this.next.disabled=snapshot.status==="finished";
    this.skip.disabled=snapshot.status==="finished";
    if(snapshot.status==="finished"){
      this.cancelIntro();this.clearMotion();
      this.actors.forEach(({element,character})=>element.classList.toggle("fainted",snapshot.hp[character.id]===0));
      this.turn.textContent="Batalha encerrada";
      const winner=this.battle.participants.find(c=>c.id===snapshot.winner_id);
      this.line.textContent=winner?winner.name+" venceu o confronto!":"Os combatentes resistiram até o limite. Empate!";
      if(previous!=="finished"){
        if(!this.suppressVictory)this.showVictory(winner);else this.victory.hidden=true;
        this.onFinish(this.battle);
      }
      this.updateMotion();return;
    }
    this.victory.hidden=true;
    if(previous==="finished"){this.suppressVictory=false;this.onReplay(this.battle);}
    if(snapshot.phase==="ready"){
      this.turn.textContent="Prontos para a batalha";
      this.line.textContent=this.media.matches?"Avance os turnos para acompanhar cada golpe.":"Os combatentes entraram na arena. Que vença o melhor!";
    }else{
      const a=snapshot.attack;
      const actor=this.actors.get(a.attacker_id),target=this.actors.get(a.defender_id);
      this.turn.textContent="Turno "+a.turn+" de "+snapshot.total;
      this.line.textContent=snapshot.phase==="windup"?actor.character.name+" usou "+moves[actor.character.class_name]+"!":
        target.character.name+" recebeu "+a.damage+" de dano.";
    }
    if(snapshot.status==="paused")this.animations.forEach(a=>a.pause());
    else this.animations.forEach(a=>a.play());
    const key=snapshot.phase+":"+snapshot.applied;
    if(key!==this.phaseKey){
      this.clearMotion();this.phaseKey=key;
      if(snapshot.phase==="windup" && !this.media.matches)this.attackMotion(snapshot);
      if(["impact","manual"].includes(snapshot.phase))this.hitMotion(snapshot);
    }
    this.updateMotion();
  }
  animate(element,keyframes,options){
    const a=element.animate(keyframes,{...options,fill:"none"});this.animations.push(a);return a;
  }
  point(actor){
    const stage=this.scene.getBoundingClientRect(),rect=actor.element.getBoundingClientRect();
    return{x:rect.left-stage.left+rect.width*.5,y:rect.top-stage.top+rect.height*.45};
  }
  attackMotion(s){
    const attacker=this.actors.get(s.attack.attacker_id),target=this.actors.get(s.attack.defender_id);
    attacker.sprite.dataset.pose="attack";
    const direction=attacker.side==="ally"?1:-1;
    if(attacker.character.class_name==="warrior"){
      const distance=Math.min(this.scene.clientWidth*.13,85)*direction;
      this.animate(attacker.element,[{transform:"translateX(0)"},{transform:"translateX("+distance+"px)"},{transform:"translateX(0)"}],
        {duration:280/s.speed,easing:"cubic-bezier(.2,.7,.3,1)"});
    }else{
      const from=this.point(attacker),to=this.point(target);
      const effect=node("div","attack-projectile "+attacker.character.class_name);
      effect.style.left=from.x+"px";effect.style.top=from.y+"px";this.effects.append(effect);
      if(attacker.character.class_name==="archer"){
        effect.textContent="";
        const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 60 16");
        const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d","M3 8h50M44 2l11 6-11 6M10 3l6 5-6 5");
        svg.append(path);effect.append(svg);
      }
      const angle=attacker.character.class_name==="archer"?Math.atan2(to.y-from.y,to.x-from.x)*180/Math.PI:0;
      this.animate(effect,[{transform:"translate(-50%,-50%) rotate("+angle+"deg) scale(.6)",opacity:.5},
        {transform:"translate("+(to.x-from.x)+"px,"+(to.y-from.y)+"px) rotate("+angle+"deg) scale(1)",opacity:1}],
        {duration:280/s.speed,easing:"ease-in"});
      this.animate(attacker.element,[{transform:"translateY(0)"},{transform:"translateY(-5px)"},{transform:"translateY(0)"}],{duration:280/s.speed});
    }
  }
  hitMotion(s){
    const target=this.actors.get(s.attack.defender_id);target.sprite.dataset.pose="hurt";
    if(this.media.matches)return;
    const location=this.point(target),damage=node("div","damage-number","−"+s.attack.damage);
    damage.style.left=location.x+"px";damage.style.top=(location.y-20)+"px";this.effects.append(damage);
    this.animate(damage,[{transform:"translate(-50%,0)",opacity:1},{transform:"translate(-50%,-38px)",opacity:0}],{duration:420/s.speed,easing:"ease-out"});
    const hit=node("div","hit-spark "+this.actors.get(s.attack.attacker_id).character.class_name);
    hit.style.left=location.x+"px";hit.style.top=location.y+"px";this.effects.append(hit);
    this.animate(hit,[{transform:"translate(-50%,-50%) scale(.3)",opacity:.9},{transform:"translate(-50%,-50%) scale(1.4)",opacity:0}],
      {duration:300/s.speed,easing:"ease-out"});
    const direction=target.side==="ally"?-1:1;
    this.animate(target.element,[{transform:"translateX(0)",filter:"brightness(1)"},{transform:"translateX("+(direction*9)+"px)",filter:"brightness(1.35)"},{transform:"translateX(0)",filter:"brightness(1)"}],
      {duration:320/s.speed,easing:"ease-out"});
  }
  showVictory(winner){
    this.victory.replaceChildren();this.victory.hidden=false;
    const lost=this.battle?.adventure && winner && winner.id!==this.battle.adventure.hero_id;
    const title=node("h3","victory-title",lost?"Tente novamente!":winner?"Vitória!":"Empate!");
    const text=node("p","",lost?"Seu herói pode tentar esta fase novamente.":winner?winner.name+" levou a melhor neste confronto.":"Uma disputa à altura dos dois combatentes.");
    if(winner){const portrait=node("div","victory-portrait");portrait.append(createSprite(winner.class_name));this.victory.append(portrait);}
    const close=node("button","game-command","Continuar");
    close.addEventListener("click",()=>{this.victory.hidden=true;this.onContinue(this.battle);});
    this.victory.append(title,text,close);
  }
  pause(){this.cancelIntro();this.playback?.pause();this.animations.forEach(a=>a.pause());}
  setVisible(value){this.visible=value;if(!value)this.pause();this.updateMotion();}
  updateMotion(){
    if(document.hidden)this.pause();
    this.root.classList.toggle("motion-paused",!this.visible || document.hidden || this.media.matches || this.playback?.snapshot().status==="paused" || this.playback?.snapshot().status==="finished");
  }
}
