import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocx } from './docx.js';
import { normalizeWork, searchReferences, formatReference, referenceLines, referenceProblem, backMatterSections, REFERENCE_STYLES, REFERENCE_EXAMPLES, referenceContext } from './references.js';
const work = { DOI:'10.1038/nrd842', title:['Selective anticancer drugs'], type:'journal-article', published:{'date-parts':[[2002]]}, author:[{family:'Atkins',given:'Joshua H.'},{family:'Gershell',given:'Leland J.'}], publisher:'Springer Nature', 'container-title':['Nature Reviews Drug Discovery'], volume:'1', issue:'7', page:'491-492' };
test('six supported styles have fixed bibliography and in-text examples', () => {
  assert.equal(Object.keys(REFERENCE_STYLES).length,6);
  for(const id of Object.keys(REFERENCE_STYLES)) assert.equal(REFERENCE_EXAMPLES[id].length,3);
});
test('search retains deposited metadata and excludes duplicate, incomplete and withdrawn works', async () => {
  const fetcher = async () => ({ok:true,json:async()=>({message:{items:[work,work,{...work,title:['Retraction: wrong study']},{...work,author:[]}]}})});
  const found = await searchReferences('communication',fetcher);
  assert.equal(found.length,1); assert.equal(found[0].registry,'Crossref'); assert.equal(found[0].year,2002);
});
test('Vancouver uses real fields without a network call; IEEE numbering follows selection order', async () => {
  const source = normalizeWork(work);
  const text = await formatReference(source,'vancouver',()=>{throw Error('must not fetch');});
  assert.match(text,/Atkins JH, Gershell LJ\./);
  assert.match(text,/2002;1\(7\):491-492/);
  const lines = referenceLines({referenceStyle:'ieee',referenceSources:[{citations:{ieee:'Z'}},{citations:{ieee:'A'}}]});
  assert.deepEqual(lines,['[1] Z','[2] A']);
});
test('legacy or partially formatted bibliography cannot pass as ready', () => {
  const b={backMatter:['references'],references:['invented book']};
  assert.ok(referenceProblem(b));
  b.referenceStyle='apa'; b.referenceSources=[{...normalizeWork(work),reviewed:true,citations:{apa:'Real formatted entry'}}];
  assert.equal(referenceProblem(b),'');
  b.referenceStyle='ieee'; assert.ok(referenceProblem(b));
});
test('all export formats can consume the same selected back matter', () => {
  const b={backMatter:['glossary','references','about_author'],bible:{glossary:[{term:'Test',def:'Definition'},{term:'Empty'}]},aboutAuthor:'ข้อมูลจริง',referenceStyle:'apa',referenceSources:[{citations:{apa:'Same reference'}}]};
  assert.deepEqual(backMatterSections(b).map(s=>s.lines),[['Test — Definition'],['Same reference'],['ข้อมูลจริง']]);
  assert.match(referenceContext(b),/ห้ามแต่งผลวิจัย/);
});
test('Word export includes formatted bibliography, glossary and real biography', async () => {
  const book = { backMatter:['glossary','references','about_author'],referenceStyle:'ieee',referenceSources:[{citations:{ieee:'Verified reference entry'}}],
    bible:{glossary:[{term:'Term',def:'Meaning'}]}, aboutAuthor:'Real author biography',
    typography:{bodyFont:'Sarabun',bodyPt:14,marginsMm:{top:20,bottom:20,inner:20,outer:20}},trim:{widthMm:148,heightMm:210} };
  const blob = await buildDocx({book,outline:{title:'Test',chapters:[]},sections:[]});
  const zipText = new TextDecoder().decode(await blob.arrayBuffer());
  assert.match(zipText,/\[1\] Verified reference entry/);
  assert.match(zipText,/Term — Meaning/);
  assert.match(zipText,/Real author biography/);
});
