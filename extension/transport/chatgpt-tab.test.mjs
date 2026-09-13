import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./chatgpt-tab.js',import.meta.url),'utf8');
function fixture() {
  let listener, sent, n=0;
  const timers=new Map();
  const context={setTimeout:(fn,ms)=>{timers.set(++n,{fn,ms});return n;},clearTimeout:id=>timers.delete(id),Date,
    chrome:{runtime:{onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{sent=msg;return {ok:true}}}}};
  const Transport=vm.runInNewContext(source.replaceAll('export ','')+'\nChatGptTabTransport',context);
  return {tr:new Transport(),timers,message:()=>sent,send:msg=>listener({...msg,turnId:sent.turnId}),id:()=>sent.turnId};
}

test('only opted-in item text receipts reach the adapter',async()=>{
  for(const opts of [{itemReceipt:true},{},{itemReceipt:true,wantImages:true}]) {
    const f=fixture(); const result=f.tr.send('prompt',opts);
    assert.equal(f.message().opts.itemReceipt===true,opts.itemReceipt===true&&!opts.wantImages);
    if(!opts.itemReceipt||opts.wantImages) assert.equal(Object.hasOwn(f.message().opts,'itemReceipt'),false);
    f.send({type:'gpt.result',status:'ok',text:'answer'}); await result;
  }
});
test('reply deadline starts after accepted prompt, includes effective image timeout, never resets on heartbeat',async()=>{
  const f=fixture(); const p=f.tr.send('draw',{wantImages:true});
  assert.equal([...f.timers.values()][0].ms,600000);
  f.send({type:'gpt.progress',phase:'waiting'});
  assert.equal([...f.timers.values()][0].ms,270000); // 240000 image + 30000 relay/capture
  const id=[...f.timers.keys()][0];
  f.send({type:'gpt.progress',phase:'waiting'});assert.equal([...f.timers.keys()][0],id);
  f.send({type:'gpt.result',status:'ok',text:'',images:['image']});
  assert.equal((await p).status,'ok');assert.equal(f.timers.size,0);
});
test('lost relay is reported as uncertain outcome with measured duration',async()=>{
  const f=fixture();const p=f.tr.send('write');
  f.send({type:'gpt.progress',phase:'waiting'});
  assert.equal([...f.timers.values()][0].ms,330000);
  [...f.timers.values()][0].fn();
  const result=await p;
  assert.equal(result.meta.error,'outcome_unknown');assert.ok(result.meta.elapsedMs>=0);
});
