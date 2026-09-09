import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const src=await readFile(new URL('./studio.js',import.meta.url),'utf8');
function fn(name) {const start=src.indexOf(`async function ${name}(`);return src.slice(start,src.indexOf('\n}',start)+2);}
for (const mode of ['fast','standard','detailed',undefined]) test(`awaits outline → writing → editor → images → export (${mode || 'legacy'})`,async()=>{
 const events=[];
 const book={id:'b',productionMode:mode,job:{step:'outline'},outline:{chapters:[]}};
 let gate=0;
 const ctx={book,Date,machineBusy:false,lastActivityAt:0,runState(){},addEvent(){},makeMachine(){},
  db:{loadBook:async()=>book,saveBook:async()=>{}},machine:{runUntilGate:async()=>{
    const next=['gate_outline','gate_edit','gate_images','done'][gate++];
    events.push(next);book.job.step=next;return next==='done'?{done:true}:{gate:next};}},
  openEditor:async()=>{events.push('approve');await ctx.runMachine();},
  openImagePhaseGate:async()=>{events.push('generate-and-insert');await ctx.runMachine();},
  finish:async()=>{await Promise.resolve();events.push('export');},fail:()=>assert.fail('unexpected failure'),halted:()=>assert.fail('unexpected halt')};
 vm.createContext(ctx);vm.runInContext(fn('runMachine'),ctx);await ctx.runMachine();
 assert.deepEqual(events,['gate_outline','gate_edit','approve','gate_images','generate-and-insert','done','export']);
 assert.equal(ctx.machineBusy,false);
});
test('stopped machine does not export and always releases busy flag',async()=>{
 const ctx={book:{id:'b'},Date,runState(){},machineBusy:false,db:{loadBook:async()=>({id:'b'})},machine:{runUntilGate:async()=>({stopped:'paused'})},halted:()=>true,finish:()=>assert.fail('exported stopped job')};
 vm.createContext(ctx);vm.runInContext(fn('runMachine'),ctx);await ctx.runMachine();assert.equal(ctx.machineBusy,false);
 ctx.machine.runUntilGate=async()=>{throw Error('storage failed')};
 await assert.rejects(ctx.runMachine(),/storage failed/);assert.equal(ctx.machineBusy,false);
});

for(const [mode,step,expected] of [['full','done','export'],['full','gate_images','images'],[undefined,'gate_images','gate']]) {
 test(`resume preserves ${mode || 'legacy guided'} intent at ${step}`,async()=>{
  let action='';
  const book={id:'b',automation:mode?{mode}:undefined,job:{step}};
  const node={classList:{add(){}}};
  const ctx={book,machineBusy:false,hasPendingTurn:()=>false,$:()=>node,fullAutoRunning:false,
    hasManualImages:()=>false,finish:async()=>{action='export'},startPhase2:async()=>{action='images'},openImagePhaseGate:async()=>{action='gate'}};
  vm.createContext(ctx);vm.runInContext(fn('resumeGo'),ctx);await ctx.resumeGo();
  assert.equal(action,expected);assert.equal(ctx.fullAutoRunning,mode==='full');
 });
}
