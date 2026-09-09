import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as P from './prompts.js';
import * as I from './items.js';
import {duplicateItems,reviewGroups,itemReviewPrompt,reviewIssues} from './item-quality.js';
globalThis.chrome={runtime:{onMessage:{addListener(){}}}};
const {Machine}=await import('./machine.js');

test('fiction review includes full scenes and requests per-scene verdicts',()=>{
 const s={id:'1.1',title:'ฉาก',md:'เนื้อหา'.repeat(1000)+'TAIL_EVENT'};
 const p=P.consistencyPrompt({n:1,title:'บท'},[s],{sectionSummaries:{'1.1':'ย่อสั้น'},characters:[{name:'CANON_PERSON'}]},{contentMode:'fiction'});
 assert.ok(p.includes(s.md)); assert.ok(p.includes('CANON_PERSON')); assert.ok(p.includes('section_verdicts'));
 const repair=P.repairPrompt({book:{contentMode:'fiction',outline:{title:'เรื่อง'},bible:{}},section:s,currentText:s.md,issues:['POV']});
 assert.ok(repair.includes('แก้ฉากนิยาย')); assert.ok(repair.includes(s.md));
});

test('item checks detect empty and punctuation-only duplicates, preserve all cross-group comparisons',()=>{
 const items=[{id:'1',text:'Same text'},{id:'2',text:'Same text!'},{id:'3',text:''}];
 assert.deepEqual(duplicateItems(items).map(x=>x.id),['2','3']);
 const groups=reviewGroups(items,1);
 for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) assert.ok(groups.some(g=>g.includes(items[i])&&g.includes(items[j])));
 assert.equal(reviewIssues({verdicts:[{id:'1',verdict:'ok'}]},items).length,2);
 assert.equal(reviewIssues({verdicts:[{id:'1',verdict:'ok'},{id:'1',verdict:'ok'}]},[items[0]]).length,1);
});

test('item prompts use exact missing IDs, full text and genre-specific review',()=>{
 const p=I.itemBatchPrompt({book:{itemKind:'poem'},outline:{},theme:{n:1},count:2,requestedIds:['1.2','1.7']});
 assert.ok(p.includes('<<<ITEM 1.7>>>')); assert.ok(!p.includes('<<<ITEM 1.1>>>'));
 const review=itemReviewPrompt({itemKind:'poem'},[{id:'1',text:'FULL_TEXT_END'}]);
 assert.ok(review.includes('ฉันทลักษณ์')); assert.ok(review.includes('FULL_TEXT_END'));
});

test('item quality repairs then rechecks, keeps history and never overwrites locked work',async()=>{
 let rows=[{id:'1.1',kind:'item',theme:1,text:'same',md:'same'},{id:'1.2',kind:'item',theme:1,text:'same',md:'same'}];
 const run=vm.runInNewContext('(async function '+Machine.prototype.checkItemQuality.toString().replace(/^async /,'')+')',{
  db:{loadSections:async()=>rows,saveSection:async(id,r)=>{rows=rows.map(x=>x.id===r.id?r:x)}},
  duplicateItems,reviewGroups,itemReviewPrompt,reviewIssues,I,X:{parseJson:JSON.parse},countUnits:t=>t.length,Halt:Error,
 });
 const machine={book:{id:'b',itemKind:'quote',runConsistency:true,outline:{themes:[{n:1,title:'หมวด'}]}},log(){},save:async()=>{},
  turnWithRetry:async(p,opts)=> opts.label.startsWith('แก้')?{text:'<<<ITEM 1.2>>>\nnew content\n<<<END 1.2>>>'}:{text:JSON.stringify({verdicts:rows.map(x=>({id:x.id,verdict:'ok'}))})}};
 assert.equal(await run.call(machine),true); assert.equal(rows[1].text,'new content'); assert.equal(rows[1].history[0].md,'same'); assert.equal(machine.book.itemQuality.passed,true);
 rows[1]={...rows[1],text:'same',md:'same',locked:true};
 await assert.rejects(run.call(machine),/ล็อก/);
 assert.equal(rows[1].text,'same');
});

test('incomplete review is filled automatically; unchanged full-text review is reused on resume',async()=>{
 const rows=[{id:'1.1',kind:'item',text:'first'},{id:'1.2',kind:'item',text:'second'}];
 const run=vm.runInNewContext('(async function '+Machine.prototype.checkItemQuality.toString().replace(/^async /,'')+')',{
  db:{loadSections:async()=>rows},duplicateItems,reviewGroups,itemReviewPrompt,reviewIssues,I,X:{parseJson:JSON.parse},Halt:Error,
 });
 let calls=0;
 const machine={book:{id:'b',itemKind:'quote',runConsistency:true},log(){},save:async()=>{},turnWithRetry:async()=>({text:JSON.stringify({verdicts:[{id:++calls===1?'1.1':'1.2',verdict:'ok'}]})})};
 await run.call(machine);assert.equal(calls,2);assert.equal(machine.book.itemQuality.passed,true);
 delete machine.book.itemQuality; // simulate an interrupted fit after review was saved
 await run.call(machine);assert.equal(calls,2,'must not pay again for the same complete review');
});
