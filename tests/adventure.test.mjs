import test from 'node:test';
import assert from 'node:assert/strict';
import {AdventureView} from '../frontend/js/adventure.mjs';

function fixture(){
  let resolveRead;
  const old={id:'hero-a',status:'reward',stage:1,hero:{attack:52}};
  const view=Object.assign(Object.create(AdventureView.prototype),{
    run:old,loading:false,busy:false,revision:0,showLibrary:false,
    root:{querySelectorAll:()=>[]},render(){this.renders=(this.renders || 0)+1;},
    notify(message){throw Error(message);},api:()=>new Promise(resolve=>{resolveRead=resolve;})
  });
  return {view,old,resolve:value=>resolveRead(value)};
}

test('an older GET cannot undo an accepted upgrade for the same adventure',async()=>{
  const {view,old,resolve}=fixture();
  const read=view.refresh();
  const updated={...old,status:'ready',stage:2,hero:{attack:56}};
  await view.action(async()=>{view.run=updated;});
  resolve(old);await read;
  assert.equal(view.run,updated);
  assert.equal(view.renders,1);
});

test('an older GET cannot undo a pending attempt while its POST is in flight',async()=>{
  const {view,old,resolve}=fixture();
  const read=view.refresh();let accept;
  const mutation=view.action(()=>new Promise(r=>{accept=r;}));
  resolve(old);await read;
  assert.equal(view.renders,undefined);
  view.run={...old,status:'pending'};accept();await mutation;
  assert.equal(view.run.status,'pending');
});

test('a background refresh cannot replace the open hero library',async()=>{
  const {view,old,resolve}=fixture();
  const read=view.refresh();view.showLibrary=true;
  resolve({...old,status:'ready'});await read;
  assert.equal(view.run,old);assert.equal(view.renders,undefined);
  await view.refresh();assert.equal(view.loading,false);
});

test('an older hero read cannot replace a newly selected hero',async()=>{
  const {view,old,resolve}=fixture();const read=view.refresh();
  view.run={...old,id:'hero-b'};resolve(old);await read;
  assert.equal(view.run.id,'hero-b');assert.equal(view.renders,undefined);
});
