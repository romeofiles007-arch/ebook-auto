import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {preflight} from './preflight.js';
const src = await readFile(new URL('./machine.js',import.meta.url),'utf8');
const start = src.indexOf('  async reviewChapterFully(');
const method = src.slice(start,src.indexOf('\n  }',start)+4);
function fixture(decision, threadMode) {
  const options = [];
  const scope = { Halt: Error, Machine:{batchSections:r=>[r]}, P:{consistencyPrompt:()=>''},
    X:{parseJson:s=>{try{return JSON.parse(s);}catch{return null;}}} };
  vm.runInNewContext(`globalThis.obj = {${method}}`,scope);
  Object.assign(scope.obj,{book:{threadMode},job:{status:'ok'}, log(){},
    askSupervisor:async()=>decision,
    turnWithRetry:async(p,opts)=>{ options.push(opts); return {status:'ok',text:options.length<=2?'broken':'{"section_verdicts":[{"section":"1.1"}]}'}; }});
  return {options, run:()=>scope.obj.reviewChapterFully({n:1},[{id:'1.1',md:'full text'}])};
}
test('CEO new_thread actually reaches editorial transport',async()=>{
  const f=fixture({action:'new_thread'}); const r=await f.run();
  assert.equal(f.options[2].newThread,true); assert.equal(r.coverage.reviewed,1);
});
test('protected editorial conversation cannot be replaced',async()=>{
  const f=fixture({action:'new_thread'},'reuse'); await assert.rejects(f.run()); assert.equal(f.options.length,2);
});
test('skip_step never counts unread chapter as passed',async()=>{
  const f=fixture({action:'skip_step'}); await assert.rejects(f.run());
});
test('repaired review still requires every section verdict',async()=>{
  const f=fixture({action:'repair_json',repaired:{section_verdicts:[]}});
  const r=await f.run(); assert.equal(f.options.length,3); assert.equal(r.coverage.reviewed,1);
});
test('legacy skipped review blocks export, untouched legacy reviews retain behavior',()=>{
  const base={targetPages:24,typography:{marginsMm:{inner:20}},trim:{widthMm:148,heightMm:210},outline:{chapters:[]}};
  for (const coverage of [{skipped:true},{sections:3,reviewed:2,missed:['1.3']}]) {
    const book={...base,review:{1:{coverage}}};
    const before=structuredClone(book);
    assert.equal(preflight({book,sections:[],pages:24}).checks.find(x=>x.id==='review_coverage').level,'fail');
    assert.deepEqual(book,before);
  }
  for (const review of [{}, {1:{chapter_summary:'legacy'}}, {1:{coverage:{sections:1,reviewed:1,missed:[]}}}]) {
    assert.equal(preflight({book:{...base,review},sections:[],pages:24}).checks.some(x=>x.id==='review_coverage'),false);
  }
});

test('a stuck disabled ChatGPT composer is a no-cost failure CEO can recover', () => {
  const block = src.slice(src.indexOf('const NO_COST_ERRORS'), src.indexOf('export class Machine'));
  const scope = {};
  vm.runInNewContext(`${block}\nglobalThis.check=isNoCostFailure;`, scope);
  assert.equal(scope.check({status:'error',meta:{error:'composer_busy_stuck'}}), true);
  assert.match(src, /res\.meta\?\.error === 'composer_busy_stuck'[\s\S]*i = MAX_RETRIES;[\s\S]*break/);

  const imageRecovery = src.slice(
    src.indexOf('if (isNoCostFailure(res) || res.meta?.error === \'previous_turn_running\')', src.indexOf('async images(')),
    src.indexOf('let url = res.images?.[0]', src.indexOf('async images(')),
  );
  assert.match(imageRecovery, /askSupervisor/);
  assert.match(imageRecovery, /sw\.reloadChat/);
  assert.match(imageRecovery, /ceoRecoveries < 1/);
});

/**
 * จุดที่ขั้นสร้างภาพตายบ่อยที่สุดคือ "ยืนยันผลไม่ได้แล้วส่องหน้าแชตไม่เจอภาพ"
 * เดิมโยน Halt ข้ามหัวผู้คุมกระบวนการไปตรง ๆ จึงเป็นสาเหตุตรง ๆ ที่เปิดโหมด CEO ไว้แล้วมันไม่เคยตื่น
 */
test('an unconfirmed image turn wakes the CEO before halting the book', () => {
  const rescue = src.slice(
    src.indexOf("const rescued = await this.grabRenderedImage"),
    src.indexOf("let url = res.images?.[0]", src.indexOf('async images(')),
  );
  const branch = rescue.indexOf('} else if (e instanceof Halt) {');
  const halt = rescue.slice(branch, rescue.indexOf('} else {', branch));
  assert.match(halt, /askSupervisor/);
  assert.match(halt, /sw\.reloadChat/);
  // ท่าเดียวที่ปลอดภัยคือล้างหน้าเว็บแล้วเริ่มรูปนี้ใหม่ — ห้ามเปิดทาง retry ในหน้าเดิม
  assert.equal(/action === 'retry'/.test(halt), false);
  // ผู้คุมสั่งหยุด หรือไม่มีผู้คุม = หยุดตามเจตนาเดิม
  assert.match(halt, /throw e;/);
});
