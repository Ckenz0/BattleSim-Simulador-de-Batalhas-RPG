/** Playback of a completed battle. Never calculates combat or calls the API. */
export class BattlePlayback {
  constructor(battle,{clock,onChange=()=>{}}={}) {
    if(!battle.result?.attacks?.length) throw new RangeError("A completed attack history is required");
    this.battle=battle;
    this.clock=clock || {now:()=>performance.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)};
    this.onChange=onChange;
    this.speed=1;this.timer=null;this.remaining=0;
    this.reset();
  }
  reset() {
    this.cancelTimer();
    this.hp=Object.fromEntries(this.battle.participants.map(c=>[c.id,c.hp]));
    this.applied=0;this.attack=null;this.phase="ready";this.status="ready";
  }
  snapshot() {
    return {status:this.status,phase:this.phase,applied:this.applied,total:this.battle.result.attacks.length,
      hp:{...this.hp},attack:this.attack,speed:this.speed,
      winner_id:this.status==="finished"?this.battle.result.winner_id:null,
      outcome:this.status==="finished"?this.battle.result.outcome:null};
  }
  emit() {this.onChange(this.snapshot());}
  cancelTimer() {
    if(this.timer!==null) {
      this.remaining=Math.max(0,this.remaining-(this.clock.now()-this.startedAt)*this.scheduledSpeed);
      this.clock.clearTimeout(this.timer);this.timer=null;
    }
  }
  schedule(duration) {
    this.remaining=duration;this.startedAt=this.clock.now();this.scheduledSpeed=this.speed;
    this.timer=this.clock.setTimeout(()=>{
      this.timer=null;this.remaining=0;
      if(this.status!=="playing")return;
      this.advancePhase();
    },duration/this.speed);
  }
  windup() {
    this.attack=this.battle.result.attacks[this.applied];
    this.phase="windup";this.emit();this.schedule(280);
  }
  advancePhase() {
    if(this.phase==="windup") {
      this.hp[this.attack.defender_id]=this.attack.defender_hp;
      this.applied++;this.phase="impact";this.emit();this.schedule(420);
    } else if(this.phase==="impact") {
      this.phase="recover";this.emit();this.schedule(260);
    } else if(this.applied>=this.battle.result.attacks.length) {
      this.finish();
    } else this.windup();
  }
  play() {
    if(this.status==="disposed" || this.status==="playing")return;
    if(this.status==="finished")this.reset();
    const resume=this.status==="paused" && !["manual","ready"].includes(this.phase);
    this.status="playing";
    if(resume) {this.emit();this.schedule(this.remaining);}
    else this.windup();
  }
  pause() {
    if(this.status!=="playing")return;
    this.cancelTimer();this.status="paused";this.emit();
  }
  step() {
    if(this.status==="disposed")return;
    if(this.status==="playing")this.pause();
    if(this.status==="finished")this.reset();
    this.cancelTimer();
    this.attack=this.battle.result.attacks[this.applied];
    this.hp[this.attack.defender_id]=this.attack.defender_hp;
    this.applied++;this.phase="manual";this.status="paused";
    if(this.applied===this.battle.result.attacks.length)this.finish();
    else this.emit();
  }
  finish() {
    if(this.status==="disposed")return;
    this.cancelTimer();
    this.hp={...this.battle.result.final_hp};
    this.applied=this.battle.result.attacks.length;
    this.phase="finished";this.status="finished";this.emit();
  }
  setSpeed(value) {
    if(![1,2,4].includes(value))throw new RangeError("Playback speed must be 1, 2 or 4");
    if(this.status==="disposed")return;
    const playing=this.status==="playing";
    if(playing)this.cancelTimer();
    this.speed=value;
    if(playing)this.schedule(this.remaining);
    this.emit();
  }
  dispose() {
    this.cancelTimer();this.status="disposed";
  }
}
