import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * ปก / ลายพื้นหลัง / ภาพประกอบ เป็นคนละโจทย์กันจริง ๆ
 *
 * อยู่ห้องแชตเดียวกันหมดทำให้ห้องสะสมบริบทของงานก่อนหน้า แล้วเครื่องมือเข้าโหมด
 * "แก้ภาพเดิม" แทนการวาดใหม่ตามโจทย์ใหม่ ลายพื้นหลังจึงออกมาหน้าตาเหมือนปก
 * ขอบกลุ่มเป็นจุดเปิดห้องใหม่ที่ปลอดภัย เพราะภาพของกลุ่มก่อนถูกบันทึกไปแล้วทุกใบ
 */
const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const start = src.indexOf("        const group = j.kind === 'cover'");
const block = src.slice(start, src.indexOf('\n        }', start) + 10);

function run(jobs, { useApi = false } = {}) {
  const opened = [];
  const scope = {
    useApi,
    j: null,
    log: () => {},
    // เลียนแบบ this.job ที่คงค่าข้ามรอบของลูป
    job: { imageThreadStarted: false, imageThreadGroup: null },
  };
  vm.createContext(scope);
  const code = block
    .replace(/this\.job/g, 'job')
    .replace(/this\.log/g, 'log');
  for (const kind of jobs) {
    scope.j = { kind };
    // หุ้มเป็นบล็อกทุกรอบ ไม่งั้น const ของรอบก่อนชนกับรอบถัดไปใน context เดียวกัน
    vm.runInContext('{\n' + code + '\nglobalThis.newThread = newThread;\n}', scope);
    opened.push(scope.newThread);
  }
  return { opened, group: scope.job.imageThreadGroup };
}

test('เปิดห้องใหม่ที่ขอบกลุ่ม ไม่ใช่ทุกรูป', () => {
  // ปกหน้า, ปกหลัง, ลายพื้นหลัง, ภาพประกอบสองรูป
  const r = run(['cover', 'cover', 'pattern', undefined, undefined]);
  assert.deepEqual(r.opened, [true, false, true, true, false]);
  assert.equal(r.group, 'figure');
});

test('ภาพประกอบทุกรูปอยู่ห้องเดียวกัน ไม่เปิดใหม่รายรูป', () => {
  const r = run([undefined, undefined, undefined, undefined]);
  assert.deepEqual(r.opened, [true, false, false, false]);
});

test('โหมด API ไม่มีห้องแชตให้เปิด', () => {
  const r = run(['cover', 'pattern', undefined], { useApi: true });
  assert.deepEqual(r.opened, [false, false, false]);
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
