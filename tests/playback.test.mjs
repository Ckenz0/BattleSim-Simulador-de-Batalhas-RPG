import test from "node:test";
import assert from "node:assert/strict";
import {BattlePlayback} from "../frontend/js/playback.mjs";

function fakeClock(){
 let time=0,id=0;const jobs=new Map();
 return {now:()=>time,setTimeout(fn,delay){jobs.set(++id,{at:time+delay,fn});return id;},
 clearTimeout(key){jobs.delete(key);},
 tick(ms){const until=time+ms;while(true){const due=[...jobs].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;jobs.delete(due[0]);due[1].fn();}time=until;},
 pending:()=>jobs.size};
}
const battle=()=>({id:"battle-a",participants:[{id:"a",name:"Lyra",class_name:"mage",hp:100},{id:"b",name:"Kael",class_name:"warrior",hp:80}],
 result:{outcome:"victory",winner_id:"a",final_hp:{a:80,b:0},attacks:[
 {turn:1,attacker_id:"a",defender_id:"b",damage:30,defender_hp:50},
 {turn:2,attacker_id:"b",defender_id:"a",damage:20,defender_hp:80},
 {turn:3,attacker_id:"a",defender_id:"b",damage:50,defender_hp:0}]}});
test("life only changes at impact and winner is hidden until final recovery",()=>{
 const clock=fakeClock(),p=new BattlePlayback(battle(),{clock});
 p.play();assert.equal(p.snapshot().phase,"windup");assert.equal(p.snapshot().hp.b,80);
 clock.tick(279);assert.equal(p.snapshot().applied,0);clock.tick(1);
 assert.equal(p.snapshot().hp.b,50);assert.equal(p.snapshot().applied,1);
 assert.equal(p.snapshot().winner_id,null);clock.tick(2600);
 assert.equal(p.snapshot().status,"finished");assert.equal(p.snapshot().winner_id,"a");
 assert.deepEqual(p.snapshot().hp,{a:80,b:0});
});
test("pause and resume preserve remaining windup without skipping a hit",()=>{
 const clock=fakeClock(),p=new BattlePlayback(battle(),{clock});
 p.play();clock.tick(100);p.pause();clock.tick(10000);
 assert.equal(p.snapshot().applied,0);assert.equal(clock.pending(),0);
 p.play();clock.tick(179);assert.equal(p.snapshot().applied,0);
 clock.tick(1);assert.equal(p.snapshot().applied,1);
});
test("changing speed scales only remaining time and never applies damage early",()=>{
 const clock=fakeClock(),p=new BattlePlayback(battle(),{clock});
 p.play();clock.tick(100);p.setSpeed(2);clock.tick(89);
 assert.equal(p.snapshot().applied,0);clock.tick(1);assert.equal(p.snapshot().hp.b,50);
 p.setSpeed(4);clock.tick(1000);assert.equal(p.snapshot().status,"finished");
 assert.throws(()=>p.setSpeed(0),RangeError);
});
test("manual step works without timers and replay resets after finishing",()=>{
 const clock=fakeClock(),p=new BattlePlayback(battle(),{clock});
 p.step();assert.equal(p.snapshot().applied,1);assert.equal(p.snapshot().hp.b,50);
 assert.equal(clock.pending(),0);p.step();p.step();assert.equal(p.snapshot().winner_id,"a");
 p.step();assert.equal(p.snapshot().applied,1);assert.equal(p.snapshot().hp.a,100);
});
test("step after an applied impact advances to the next attack without duplicating damage",()=>{
 const clock=fakeClock(),p=new BattlePlayback(battle(),{clock});
 p.play();clock.tick(280);p.pause();p.step();
 assert.equal(p.snapshot().applied,2);assert.deepEqual(p.snapshot().hp,{a:80,b:50});
});
test("skip reveals the real final result and dispose suppresses stale callbacks",()=>{
 const clock=fakeClock(),seen=[],p=new BattlePlayback(battle(),{clock,onChange:s=>seen.push(s)});
 p.play();p.finish();assert.deepEqual(p.snapshot().hp,{a:80,b:0});assert.equal(clock.pending(),0);
 p.play();const before=seen.length;p.dispose();clock.tick(10000);
 assert.equal(seen.length,before);assert.equal(clock.pending(),0);assert.equal(p.snapshot().status,"disposed");
});
test("draw has no winner and snapshots cannot mutate playback health",()=>{
 const data=battle();data.result.outcome="draw";data.result.winner_id=null;data.result.final_hp={a:80,b:50};
 data.result.attacks=data.result.attacks.slice(0,2);
 const p=new BattlePlayback(data);const snap=p.snapshot();snap.hp.a=0;
 assert.equal(p.snapshot().hp.a,100);p.finish();assert.equal(p.snapshot().winner_id,null);
 assert.equal(p.snapshot().outcome,"draw");
});
test("manual step during the final hit finishes instead of reading a nonexistent next attack",()=>{
 const clock=fakeClock(),p=new BattlePlayback(battle(),{clock});
 p.play();clock.tick(2200);
 assert.equal(p.snapshot().applied,3);assert.equal(p.snapshot().status,"playing");
 p.step();assert.equal(p.snapshot().status,"finished");assert.equal(p.snapshot().winner_id,"a");
});
test("pause from a phase observer leaves no timer and resumes the full remaining phase",()=>{
 const clock=fakeClock();let paused=false;
 const p=new BattlePlayback(battle(),{clock,onChange:s=>{
  if(s.phase==="impact" && !paused){paused=true;p.pause();}
 }});
 p.play();clock.tick(280);
 assert.equal(p.snapshot().status,"paused");assert.equal(clock.pending(),0);
 clock.tick(1000);assert.equal(p.snapshot().applied,1);
 p.play();clock.tick(419);assert.equal(p.snapshot().phase,"impact");
 clock.tick(1);assert.equal(p.snapshot().phase,"recover");
});
