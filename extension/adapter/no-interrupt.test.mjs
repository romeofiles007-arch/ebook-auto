import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const src=await readFile(new URL('./chatgpt.js',import.meta.url),'utf8');
function extract(name,async=true) {
 const start=src.indexOf(`${async?'async ':''}function ${name}(`);
 return src.slice(start,src.indexOf('\n  }',start)+4);
}
test('quiet reasoning with a visible Stop button is not returned as a finished answer',async()=>{
 let time=1000,hb,busy=true,bar=false,finished=false;
 const turn={innerText:'partial answer',querySelector:()=>null};
 const run=vm.runInNewContext('('+extract('waitForAnswer',false)+')',{
  $:()=>null,$$:()=>[turn],S:{},document:{body:{}},Date:{now:()=>time},
  assistantAfter:()=>turn,hitLimit:()=>false,streamErrorAfter:()=>null,isThinkingOnly:()=>false,stopButtonVisible:()=>busy,actionBarFor:()=>bar,
  setupJson:()=>'',report(){},imageQuotaNotice:()=>'',MutationObserver:class {observe(){} disconnect(){}},
  setInterval:fn=>{hb=fn;return 1},clearInterval(){},setTimeout:()=>2,clearTimeout(){},BAR_STUCK_MS:2500,BAR_CONFIRM_MS:500,
 });
 const p=run('t',{}).then(v=>{finished=true;return v});
 time+=1000;hb();time+=1000;hb();time+=60000;hb();await Promise.resolve();
 assert.equal(finished,false,'60 seconds of silence must not truncate a thinking turn');
 busy=false;bar=true;hb();time+=1000;hb();assert.equal(await p,'ok');
});
test('send recovery never clicks Stop on an existing turn',async()=>{
 let clicked=0;
 const stop={disabled:false,getBoundingClientRect:()=>({width:20,height:20}),click:()=>clicked++};
 const run=vm.runInNewContext('('+extract('clickSend')+')',{
  Date,$$:s=>s.includes('stop-button')?[stop]:[],stopButtonVisible:()=>true,
  waitForBusyToClear:async()=> 'timeout',
 });
 await assert.rejects(run({isConnected:true,innerText:'prompt'}),/previous_turn_running/);
 assert.equal(clicked,0);
});
test('new-thread navigation waits for existing work before changing chats',async()=>{
 const run=vm.runInNewContext('('+extract('runTurn')+')',{
  Date,report(){},waitForComposer:async()=>({}),waitUntilIdle:async()=>false,
  newThread:()=>assert.fail('navigated away from active work'),
 });
 const result=await run('t','prompt',{newThread:true});
 assert.equal(result.meta.error,'previous_turn_running');
});

test('complete expected setup JSON can finish with stuck Stop; partial, unrelated and prose cannot',async()=>{
 let raw='{"titles":[',time=1000,hb,finished=false;
 const code={get textContent(){return raw}};
 const turn={innerText:'JSON',querySelector:()=>null};
 const scope={S:{codeBlock:'code'},$$:s=>s==='code'?[code]:[turn],$:()=>null,document:{body:{}},Date:{now:()=>time},
  assistantAfter:()=>turn,hitLimit:()=>false,streamErrorAfter:()=>null,isThinkingOnly:()=>false,stopButtonVisible:()=>true,actionBarFor:()=>false,
  report(){},imageQuotaNotice:()=>'',MutationObserver:class {observe(){} disconnect(){}},setInterval:fn=>{hb=fn;return 1},clearInterval(){},setTimeout:()=>2,clearTimeout(){},BAR_STUCK_MS:2500};
 vm.createContext(scope);vm.runInContext(extract('setupJson',false)+'\n'+extract('waitForAnswer',false),scope);
 const p=scope.waitForAnswer('t',{}, {expectedJsonKeys:['titles']}).then(v=>{finished=true;return v});
 time+=1000;hb();time+=60000;hb();await Promise.resolve();assert.equal(finished,false);
 raw='{"topics":[{"topic":"wrong contract"}]}';time+=1000;hb();time+=5000;hb();await Promise.resolve();assert.equal(finished,false);
 raw='{"titles":[{"title":"complete"}]}';time+=1000;hb();time+=3000;hb();assert.equal(await p,'ok');
 assert.equal(scope.completedSetupReply.raw,raw);
 assert.equal(scope.setupJson(turn,[]),'','plain writing never opts in');
 raw+=' trailing unfinished prose';assert.equal(scope.setupJson(turn,['titles']),'');
});

test('only unchanged accepted setup reply permits recovery into a new chat',()=>{
 const turn={};let current=turn,raw='complete';
 const scope={completedSetupReply:{turn,keys:['titles'],raw},lastAssistantTurn:()=>current,setupJson:()=>raw};
 const check=vm.runInNewContext('('+extract('acceptedSetupStillCurrent',false)+')',scope);
 assert.equal(check(),true);raw='changed';assert.equal(check(),false);raw='complete';current={};assert.equal(check(),false);
});
