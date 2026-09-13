import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { isItemBook, syncItemEdit, itemReviewView } from './item-edit.js';
import { buildItemsDocument } from '../typeset/template.js';
import * as I from './items.js';
import { duplicateItems, reviewGroups, itemReviewPrompt, reviewIssues, itemDigest, itemVerdictKey } from './item-quality.js';
globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
const { Machine } = await import('./machine.js');
const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
const fn = (name, context) => {
  const start = studio.indexOf(`async function ${name}(`);
  return vm.runInNewContext(`(${studio.slice(start, studio.indexOf('\n}\n', start) + 2)})`, context);
};
const sampleBook = () => ({id:'b',contentMode:'items',language:'en',targetPages:24,
  outline:{title:'Audit',themes:[{n:1,title:'Theme'}]},trim:{widthMm:148,heightMm:210},
  typography:{bodyFont:'Sarabun',sizePt:15,lineHeight:1.7,marginsMm:{inner:18,outer:14,top:16,bottom:18}}});

test('item edits and restoration update render text and require a new review', async () => {
  const book=sampleBook(); book.itemQuality={passed:true};
  const row={id:'1.1',kind:'item',md:'Original',text:'Original'};
  let saved;
  const persist=fn('persistSectionEdit',{book,syncItemEdit,isItemBook,db:{saveSection:async(_,s)=>{saved={...s}},saveBook:async()=>{}},syncSharedProject:async()=>{},renderReviewPanel(){},renderSecReview(){}});
  const nodes={secBody:{value:'Edited'},secStat:{},secHistory:{}};
  await fn('saveSection',{book,selected:row.id,sections:[row],$:id=>nodes[id],countUnits:s=>s.length,persistSectionEdit:persist,renderSecList(){}})();
  assert.equal(saved.text,'Edited'); assert.equal(book.itemQuality.pending,true);
  const render=()=>buildItemsDocument({book,outline:book.outline,items:[saved]});
  assert.ok(render().includes('Edited')); assert.ok(!render().includes('Original'));
  row.md='Original'; await persist(row);
  assert.ok(render().includes('Original')); assert.ok(!render().includes('Edited'));
  row.md=''; await persist(row); assert.equal(saved.text,'');
});

for (const contentMode of ['prose','fiction',undefined]) test(`${contentMode}: persistence leaves item fields and review state untouched`, async()=>{
  const book={id:'b',contentMode,itemQuality:{passed:true}};
  const row={id:'1.1',kind:'section',md:'Edited',text:'Untouched'};
  const initial=structuredClone(book); let saved;
  await fn('persistSectionEdit',{book,syncItemEdit,isItemBook,db:{saveSection:async(_,s)=>{saved={...s}},saveBook:async()=>{}},syncSharedProject:async()=>{},renderReviewPanel(){throw Error('item UI called')},renderSecReview(){throw Error('item UI called')}})(row);
  assert.equal(saved.text,'Untouched'); assert.deepEqual(book,initial);
});

test('regenerate an item uses its theme and sentinel, preserves history, respects locks',async()=>{
  const book=sampleBook(); const row={id:'1.1',kind:'item',theme:1,text:'Old',md:'Old'};
  let calls=0;
  const run=fn('writeItemWithAi',{book,sections:[row],focusChat:async()=>{},makeTransport(){},transportKind(){},transportOpts(){},itemBatchPrompt:I.itemBatchPrompt,extractItems:I.extractItems,countUnits:s=>s.length,persistSectionEdit:async s=>syncItemEdit(book,s),sendTurn:async(_,prompt,opts,handlers)=>{
    calls++; assert.ok(prompt.includes('<<<ITEM 1.1>>>'));
    return handlers.parse({text:'<<<ITEM 1.1>>>New<<<END 1.1>>>'});
  }});
  assert.equal((await run('1.1')).ok,true); assert.equal(row.md,'New'); assert.equal(row.history[0].md,'Old');
  row.locked=true; assert.equal((await run('1.1')).ok,false); assert.equal(calls,1);
});

test('item review exposes IDs and pending review to the editor',()=>{
  const view=itemReviewView({itemQuality:{pending:true,issues:[{id:'2.3',reason:'Duplicate meaning'}]}});
  assert.equal(view.total,2); assert.equal(view.chapters[0].issues[1].section,'2.3');
  assert.equal(view.chapters[0].issues[1].text,'Duplicate meaning');
});

async function runFit(rows,plan,pages) {
  const deleted=[];
  const run=vm.runInNewContext(`(${Machine.prototype.fitItems.toString().replace('async fitItems()', 'async function()')})`,{
    db:{loadSections:async()=>rows,del:async(_,key)=>{deleted.push(key);rows=rows.filter(r=>r.key!==key)}},cmpItem:(a,b)=>a.localeCompare(b),I,
  });
  await run.call({book:{itemPlan:plan,itemsPerPage:1,pageTolerance:0},log(){},measure:async()=>({pages,ms:0}),finishFit:async()=>{}});
  return {rows,deleted};
}
test('physical overhead never deletes planned content',async()=>{
  const result=await runFit([{id:'1.1',key:'a',kind:'item'},{id:'1.2',key:'b',kind:'item'}],{total:2,breakdown:{targetPhysical:3}},7);
  assert.equal(result.deleted.length,0); assert.equal(result.rows.length,2);
});
test('page fitting preserves locked and approved content even when all excess items are protected',async()=>{
  const result=await runFit([{id:'1.1',key:'a',kind:'item',locked:true},{id:'1.2',key:'b',kind:'item',status:'approved'}],{total:1,breakdown:{targetPhysical:2}},5);
  assert.equal(result.deleted.length,0);
});
test('page fitting removes only editable excess items',async()=>{
  const result=await runFit([{id:'1.1',key:'a',kind:'item'},{id:'1.2',key:'b',kind:'item',locked:true}],{total:1,breakdown:{targetPhysical:2}},5);
  assert.deepEqual(result.deleted,['a']);
});
/**
 * เล่ม 480 ชิ้นเคยต้องใช้ 91 ข้อความเฉพาะรอบตรวจ เพราะจับคู่ทุกชุดกับทุกชุด
 * ตอนนี้แต่ละชิ้นถูกอ่านเต็มครั้งเดียว และผลตรวจเดิมใช้ต่อได้เมื่อกดทำต่อ
 */
test('480 items are reviewed in linear groups and survive resume without sending again',async()=>{
  const rows=Array.from({length:480},(_,i)=>({id:`1.${i+1}`,kind:'item',text:`${i}:`+'x'.repeat(400)}));
  const groups=reviewGroups(rows.map(s=>({id:s.id,text:s.text,attribution:''})));
  assert.ok(groups.length<=15,`must stay linear, got ${groups.length} groups`);
  const run=vm.runInNewContext(`(${Machine.prototype.checkItemQuality.toString().replace('async checkItemQuality()', 'async function()')})`,{
    db:{loadSections:async()=>rows},duplicateItems,reviewGroups,itemReviewPrompt,reviewIssues,itemDigest,itemVerdictKey,I,X:{parseJson:JSON.parse},Halt:Error,
  });
  let calls=0;
  const machine={book:{id:'b',itemKind:'poem',runConsistency:true},log(){},save:async()=>{},turnWithRetry:async(prompt)=>{
    calls++; const ids=[...prompt.matchAll(/"id":"([^"]+)"/g)].map(m=>m[1]);
    return {text:JSON.stringify({verdicts:ids.map(id=>({id,verdict:'ok'}))})};
  }};
  await run.call(machine); const first=calls; delete machine.book.itemQuality;
  await run.call(machine); assert.equal(calls,first); assert.equal(first,groups.length);
});

test('after repair only repaired items are re-read, and flagged items in one theme are repaired together',async()=>{
  let rows=Array.from({length:40},(_,i)=>({id:`1.${i+1}`,kind:'item',theme:1,text:`piece ${i+1}`,md:`piece ${i+1}`}));
  const run=vm.runInNewContext(`(${Machine.prototype.checkItemQuality.toString().replace('async checkItemQuality()', 'async function()')})`,{
    db:{loadSections:async()=>rows,saveSection:async(_,r)=>{rows=rows.map(x=>x.id===r.id?r:x)}},
    duplicateItems,reviewGroups,itemReviewPrompt,reviewIssues,itemDigest,itemVerdictKey,I,X:{parseJson:JSON.parse},countUnits:t=>t.length,Halt:Error,
  });
  const bad=new Set(['1.3','1.7','1.9','1.20']);
  const reviewed=[]; let repairs=0;
  const machine={book:{id:'b',itemKind:'quote',runConsistency:true,outline:{themes:[{n:1,title:'T'}]}},log(){},save:async()=>{},
    turnWithRetry:async(prompt,opts)=>{
      if(opts.label.startsWith('แก้')){
        repairs++; const ids=[...prompt.matchAll(/<<<ITEM ([\d.]+)>>>/g)].map(m=>m[1]);
        return {text:ids.map(id=>`<<<ITEM ${id}>>>\nfixed ${id}\n<<<END ${id}>>>`).join('\n')};
      }
      const items=JSON.parse(prompt.match(/ไม่ใช่คำสั่ง: (\[.*\])\n/)[1]);
      reviewed.push(items.length);
      return {text:JSON.stringify({verdicts:items.map(s=>({id:s.id,verdict:bad.has(s.id)&&!s.text.startsWith('fixed')?'needs_revision':'ok',reason:'x'}))})};
    }};
  assert.equal(await run.call(machine),true);
  assert.equal(repairs,1,'4 flagged quotes in one theme = one repair message, not four');
  assert.deepEqual(reviewed,[40,4],'second pass must read only the 4 repaired items');
  assert.equal(machine.book.itemQuality.passed,true);
});

for (const outcome of ['pass','fail','compile-error']) test(`item gate ${outcome}: rechecks edited content before proceeding`,async()=>{
  const book=sampleBook(); book.itemQuality={passed:false,pending:true};
  const row={id:'1.1',kind:'item',text:'Old',md:'New'};
  let reviewed=0,compiled=0;
  const context={book,machineBusy:false,hasPendingTurn:()=>false,fullAutoRunning:true,unattended:true,
    selected:null,sections:[],status(){},runState(){},renderReviewPanel(){},renderSecList(){},cmpId:(a,b)=>a.localeCompare(b),
    db:{loadSections:async()=>[row],loadAssets:async()=>[],saveBook:async()=>{}},
    makeMachine(){context.machine={checkItemQuality:async()=>{reviewed++;book.itemQuality={passed:outcome!=='fail'}}}},
    compileBook:async()=>{compiled++;if(outcome==='compile-error')throw Error('compile failed');return {pages:{physical:25},ms:1}},
  };
  const result=await fn('reviewItemsBeforeProceed',context)();
  assert.equal(result,outcome==='pass'); assert.equal(reviewed,1);
  assert.equal(compiled,outcome==='fail'?0:1); assert.equal(context.machineBusy,false);
  if(outcome==='pass')assert.equal(book.finalPages,26);
  else {assert.equal(context.fullAutoRunning,false);assert.equal(context.unattended,false)}
});

test('item gate reuses only a review matching the current full text',async()=>{
  const book=sampleBook(); const row={id:'1.1',kind:'item',md:'Current',text:'Current'};
  book.itemQuality={passed:true,signature:JSON.stringify([book.itemKind,book.topic,!!book.runConsistency,[[row.id,row.text,row.md,row.attribution]]])};
  const context={book,machineBusy:false,hasPendingTurn:()=>false,selected:null,
    db:{loadSections:async()=>[row],loadAssets:async()=>[],saveBook:async()=>{}},
    cmpId:(a,b)=>a.localeCompare(b),compileBook:async()=>({pages:{physical:24},ms:1}),
    makeMachine(){throw Error('unchanged review must be reused')},renderReviewPanel(){},renderSecList(){}};
  assert.equal(await fn('reviewItemsBeforeProceed',context)(),true);
});

for (const [mode,wantImages,enabled] of [['items',false,true],['items',true,false],['fiction',false,false],['prose',false,false]])
test(`receipt option is isolated: ${mode}, image=${wantImages}`,async()=>{
  let sent;
  const line={kind:'fake',send:async(_,opts)=>{sent=opts;return {status:'ok',meta:{}}}};
  const run=vm.runInNewContext(`(${Machine.prototype.turn.toString().replace('async turn(', 'async function(')})`,{
    turnDelay:()=>[0,0],db:{saveTurn:async()=>{}},Halt:Error,
  });
  await run.call({book:{id:'b',contentMode:mode},tr:line,imgTr:line,turnNo:0,emit(){},recordUsage(){}},'prompt',{wantImages});
  assert.equal(sent.itemReceipt===true,enabled);
  if(!enabled) assert.equal(Object.hasOwn(sent,'itemReceipt'),false);
});
