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
/**
 * อ่านผลตรวจไม่ได้ ต้องไม่หยุดหนังสือทั้งเล่ม แต่ก็ต้องไม่นับว่าบทนั้นผ่าน
 *
 * เดิมโยน Halt ซึ่งทิ้งงานที่เขียนเสร็จแล้วไว้กลางทางเพื่อรอแผนกที่ไม่ได้ผลิตอะไรลงในเล่ม
 * (เห็นจริง: ค้างที่บทที่ 2 อยู่ 1,727 วินาที เพราะคำตอบกลับมาเป็นค่าว่าง 0 ตัวอักษรสองรอบติด)
 * ตอนนี้คืนธงว่า "ข้าม" กลับไป ผู้เรียกจดลง coverage แล้วด่านก่อนส่งออกปัดกลับเอง
 */
test('skip_step never counts unread chapter as passed',async()=>{
  const f=fixture({action:'skip_step'});
  const r=await f.run();
  assert.equal(r.skipped,true,'ต้องบอกว่าข้าม ไม่ใช่คืนผลตรวจที่ดูเหมือนผ่าน');
  assert.ok(r.reason,'ต้องบอกเหตุผลที่ข้าม');
  assert.equal(r.coverage,undefined,'ห้ามมี coverage ที่อ่านได้ว่าตรวจแล้ว');
});

test('บทที่ข้ามการตรวจ ต้องถูกปัดกลับที่ด่านก่อนส่งออก',()=>{
  const book={targetPages:24,typography:{marginsMm:{inner:20}},trim:{widthMm:148,heightMm:210},outline:{chapters:[]},
    review:{2:{coverage:{sections:3,reviewed:0,missed:['2.1','2.2','2.3'],skipped:true,reason:'คำตอบว่างเปล่า'}}}};
  const check=preflight({book,sections:[],pages:24}).checks.find(x=>x.id==='review_coverage');
  assert.equal(check.level,'fail');
  assert.match(check.detail,/2/);
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

/**
 * แผนกตรวจล้มได้ทุกทาง แต่ต้องไม่ลากหนังสือทั้งเล่มล้มตามสักทาง
 *
 * ทางที่แพงที่สุดคือเทิร์นค้างที่ขั้นพิมพ์ Prompt จนหมดเวลาสิบนาที แล้วโยน Halt ทะลุขึ้นไป
 * เห็นจริงในบันทึก: "Turn 26 · timeout · ส่งถึงรับผลจริง 600.0 วินาที" ตามด้วย "หยุดไว้ก่อน"
 * ทั้งที่บรรทัดถัดมาบอกเองว่า "งานถูกบันทึกไว้ครบ"
 */
test('เทิร์นตรวจที่ค้างจนหมดเวลา ต้องข้ามบทนั้น ไม่ใช่หยุดทั้งเล่ม', async () => {
  const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const fn = machine.slice(machine.indexOf('  async consistency() {'), machine.indexOf('  /** แบ่งตอนเป็นชุดตามงบตัวอักษร'));

  assert.match(fn, /r = await this\.reviewChapterFully\(ch, recs\);/);
  assert.match(fn, /\} catch \(e\) \{/);
  assert.match(fn, /r = \{ skipped: true, reason: `ตรวจบทนี้ไม่สำเร็จ/);
  // ผู้ใช้กดหยุด กับโควตาหมด ยังต้องหยุดจริง เพราะเป็นเรื่องของทั้งระบบ
  assert.match(fn, /if \(e instanceof RateLimited \|\| this\.stopRequested\) throw e;/);
  // และต้องจดว่าบทนี้ยังไม่ได้ตรวจ ไม่ใช่ข้ามเงียบ ๆ
  assert.match(fn, /skipped: true, reason: r\.reason/);
});

test('งบตัวอักษรของก้อนตรวจ เผื่อที่ให้หัวคำสั่งแล้ว', async () => {
  const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const n = Number(machine.match(/static CONSISTENCY_BATCH_CHARS = (\d+)/)[1]);
  const { consistencyPrompt } = await import('./prompts.js');
  const ch = { n: 1, title: 'ก', sections: [{ id: '1.1', title: 'ข' }] };
  const head = consistencyPrompt(ch, [{ id: '1.1', title: 'ข', md: '' }], {}, { language: 'th' }, '').length;
  // ทั้งฉบับต้องอยู่ใต้คำสั่งที่ยาวที่สุดที่พิมพ์ผ่านจริงทุกเล่ม (styleTokenPrompt ~12,657)
  assert.ok(n + head < 12600, `เนื้อหา ${n} + หัวคำสั่ง ${head} = ${n + head} ตัวอักษร ซึ่งเกินเส้นที่พิสูจน์แล้ว`);
});
