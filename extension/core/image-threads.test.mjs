import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * ห้องแชตใหม่ทุกครั้งที่จะสร้างภาพ — ทุกใบ และทุกรอบที่ลองใหม่ด้วย
 *
 * ห้องที่มีภาพอยู่แล้วทำให้เครื่องมือสร้างภาพอ่านคำสั่งถัดไปเป็น "แก้ภาพเดิม" ไม่ใช่ "วาดใหม่"
 * ทางที่ลองมาแล้วและไม่ได้ผล: ห้องเดียวทั้ง Phase 2 · ห้องใหม่ต่อกลุ่ม ·
 * คั่นด้วยเทิร์นข้อความ · ห้องใหม่เมื่อเก็บภาพสำเร็จแล้ว (ยังพลาดรอบที่ลองใหม่ในใบเดิม)
 */
const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const start = src.indexOf("        const group = j.kind === 'cover'");
const block = src.slice(start, src.indexOf('\n        }', start) + 10);

function run(jobs, { useApi = false, attempts = 1 } = {}) {
  const opened = [];
  const scope = {
    useApi,
    j: null,
    attempt: 1,
    log: () => {},
    job: { imageThreadStarted: false, imageThreadGroup: null },
  };
  vm.createContext(scope);
  const code = block.replace(/this\.job/g, 'job').replace(/this\.log/g, 'log');
  for (const kind of jobs) {
    for (let a = 1; a <= attempts; a++) {
      scope.j = { kind, what: 'ภาพ' };
      scope.attempt = a;
      vm.runInContext('{\n' + code + '\nglobalThis.newThread = newThread;\n}', scope);
      opened.push(scope.newThread);
    }
  }
  return { opened, group: scope.job.imageThreadGroup };
}

test('ทุกภาพเปิดห้องใหม่ ทั้งข้ามกลุ่มและในกลุ่มเดียวกัน', () => {
  const r = run(['cover', 'cover', 'pattern', undefined, undefined]);
  assert.deepEqual(r.opened, [true, true, true, true, true]);
  assert.equal(r.group, 'figure');
});

/**
 * รอบที่ลองใหม่ในใบเดิมคือรอบที่ห้องมีภาพของรอบก่อนค้างอยู่พอดี
 * ถ้ารอบนี้ไม่เปิดห้องใหม่ ภาพที่สองจะเป็นภาพแรกที่ถูกแก้ ไม่ใช่ภาพใหม่
 */
test('รอบที่ลองใหม่ในใบเดิมก็ต้องเปิดห้องใหม่', () => {
  const r = run(['cover'], { attempts: 2 });
  assert.deepEqual(r.opened, [true, true]);
});

test('โหมด API ไม่มีห้องแชตให้เปิด', () => {
  const r = run(['cover', 'pattern', undefined], { useApi: true });
  assert.deepEqual(r.opened, [false, false, false]);
});

test('ตัวนับ/ตัวคั่นของทางที่เลิกใช้แล้ว ต้องไม่เหลือค้างในโค้ด', () => {
  for (const gone of ['imagesInRoom', 'roomHasImage', 'SPACER_PROMPT', 'spacerTurn', 'useImageLine']) {
    assert.ok(!src.includes(gone), `ยังเหลือ ${gone} อยู่`);
  }
});

test('ยังบอกได้ว่ากำลังทำกลุ่มไหน เผื่อไล่อ่านบันทึกย้อนหลัง', () => {
  assert.match(block, /const group = j\.kind === 'cover' \? 'cover' : j\.kind === 'pattern' \? 'pattern' : 'figure';/);
  assert.match(block, /this\.job\.imageThreadGroup = group;/);
});

test('ลายพื้นหลังไปถึงเอกสารรายชิ้นด้วย พร้อมไฟล์จริง', async () => {
  const compiler = await readFile(new URL('../typeset/compiler.js', import.meta.url), 'utf8');
  const items = compiler.slice(compiler.indexOf('const isrc = buildItemsDocument'), compiler.indexOf('const src = buildDocument'));
  assert.match(items, /assetNames: usable\.map\(\(a\) => a\.name\)/);
  assert.match(items, /const ifiles = await packAssets\(usable\)/);
  assert.match(items, /pageCount\(isrc, ifiles\)/);
});

test('พื้นหลังถูกวางไว้หลังข้อความของหน้าเนื้อหา', async () => {
  const template = await readFile(new URL('../typeset/template.js', import.meta.url), 'utf8');
  // background ของ #set page คือชั้นที่อยู่ใต้เนื้อหาเสมอ และต้องอยู่ทั้งเอกสารร้อยแก้วและรายชิ้น
  assert.equal((template.match(/numbering: none,\$\{pageBackground\(opts\)\}/g) || []).length, 2);
  assert.match(template, /background: image\("\/img\/page-pattern\.png"/);
});



test('ไฟล์ถูกเก็บก่อนตัวนับใด ๆ จะขยับ — เปิดห้องใหม่จึงไม่มีอะไรให้เสีย', () => {
  const from = src.indexOf('const stored = await db.loadAsset(this.book.id, j.name);');
  const save = src.slice(from, src.indexOf('lastSavedAt: Date.now()', from));
  assert.ok(save.indexOf('validatePhase2Asset(stored, j)') < save.indexOf('W.saveBookImage'));
});
