import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReferences } from './auto-references.js';
const source=i=>({doi:`10.1234/${i}`,abstract:'Evidence '.repeat(30)});
test('one DOI result triggers new searches and keeps accepted sources, rejecting invented DOI',async()=>{
 let calls=0;
 const result=await collectReferences({query:'Thai title',search:async()=>++calls===1?[source(1)]:[source(1),source(2),source(3),source(4),source(5)],
 choose:async(found,ctx)=>ctx.searchOnly?{queries:['critical thinking artificial intelligence']}:{dois:[...found.map(s=>s.doi),'fake'],queries:[]}});
 assert.equal(calls,2);assert.equal(result.sources.length,5);assert.ok(result.sources.every(s=>s.doi!=='fake'));
});
test('empty initial search can expand to scholarly keywords',async()=>{
 const result=await collectReferences({query:'title',minimum:1,search:async q=>q==='title'?[]:[source(1)],choose:async found=>({dois:found.map(s=>s.doi),queries:['research']})});
 assert.equal(result.sources.length,1);assert.equal(result.searches,2);
});
test('unproductive searches are bounded and preserve previous accepted records',async()=>{
 let n=0;const existing=source(0);
 const r=await collectReferences({query:'start',selected:[existing],search:async()=>[],choose:async()=>({dois:[],queries:[`next ${++n}`]}),maxSearches:3});
 assert.equal(r.searches,3);assert.deepEqual(r.sources,[existing]);
});
