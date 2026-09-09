import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
const start=source.indexOf('async function runFullAuto()');
const fn=source.slice(start,source.indexOf('\n}',start)+2);
function fixture(overrides={}) {
 const nodes={title:{value:'หัวข้อ'},coverMode:{value:'prompt',dispatchEvent(){}},figureMode:{value:'prompt',dispatchEvent(){}},fullAuto:{}};
 let creates=0;
 const scope={fullAutoRunning:false,machineBusy:false,hasPendingTurn:()=>false,$:id=>nodes[id],status(){},pickedAuthorRefTargets:()=>[],on:()=>false,setupAuthorPhoto:null,Event:class{},addEvent(){},outlineDirection:{titleBase:'หัวข้อ',name:'ผู้ใช้เลือกไว้'},create:async()=>{creates++;return true},stopAutoPilot(){scope.fullAutoRunning=false},ask(){throw Error('unexpected confirmation')},...overrides};
 scope.runState=()=>{};
 const run=vm.runInNewContext('('+fn+')',scope);
 return {run,nodes,scope,count:()=>creates};
}
test('one click starts once, keeps selected outline, converts prompt images without confirmation',async()=>{
 const f=fixture();await f.run();assert.equal(f.count(),1);assert.equal(f.nodes.coverMode.value,'auto');assert.equal(f.nodes.figureMode.value,'auto');
 await f.run();assert.equal(f.count(),1);
});
test('active work blocks a second run; missing author reference stops before creation',async()=>{
 const busy=fixture({machineBusy:true});await busy.run();assert.equal(busy.count(),0);
 const missing=fixture({pickedAuthorRefTargets:()=>['cover-front']});await missing.run();assert.equal(missing.count(),0);assert.equal(missing.scope.fullAutoRunning,false);
});
test('explicit no-cover and uploaded-image choices survive full auto setup',async()=>{
 const f=fixture();f.nodes.coverMode.value='none';f.nodes.figureMode.value='upload';await f.run();assert.equal(f.nodes.coverMode.value,'none');assert.equal(f.nodes.figureMode.value,'upload');
});
