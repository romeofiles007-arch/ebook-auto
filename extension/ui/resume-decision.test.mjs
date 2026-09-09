import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('const AUTO_CONTINUE_TOTAL_MAX =');
const block = source.slice(start, source.indexOf('\n}', source.indexOf('async function askResumeDecision')) + 2);

/**
 * ครบเพดานที่จุดเดิมแล้ว ใครเป็นคนตัดสินว่าจะกดต่ออีกหรือหยุด
 * ไม่มีผู้คุม = หยุด เพราะไม่มีใครรับผิดชอบการตัดสินใจนั้น
 * มีผู้คุม = ให้มันเลือก แต่ยังมีเพดานรวมทั้งเล่มกันการวนทั้งคืนไว้อีกชั้น
 */
function fixture({ supervisor = null, total = 0 } = {}) {
  const events = [];
  const scope = {
    makeSupervisor: () => supervisor,
    book: { job: { step: 'write', status: 'paused' } },
    recentLogLines: () => [],
    addEvent: (kind, title, detail) => events.push(`${title} :: ${detail || ''}`),
    status: () => {},
    resumeGo: () => events.push('RESUME'),
    // ท่ากดปุ่มบนหน้า Studio ที่ผู้คุมเลือกได้เมื่อถูกเรียกจากหน้านี้
    ALL_SUPERVISOR_ACTIONS: { retry: '', new_thread: '', stop: '', press_continue: '', press_images: '', open_chat: '' },
    hasPendingTurn: () => false,
    plannedImageJobs: () => [],
    assetNames: [],
    phase2Running: false,
    startPhase2: async () => events.push('PHASE2'),
    focusChat: async () => events.push('FOCUS'),
    unattended: true,
    ceoModeOn: () => !!supervisor,
    autoContinues: 3,
    lastActivityAt: 0,
    AUTO_CONTINUE_MAX: 3,
  };
  vm.createContext(scope);
  vm.runInContext(`${block}\nautoContinueTotal = ${total};\nglobalThis.ask = askResumeDecision;`, scope);
  return { ask: scope.ask, events, scope };
}

test('ไม่มีผู้คุม = หยุด และบอกว่าเพราะโหมด CEO ปิดอยู่', async () => {
  const f = fixture({ supervisor: null });
  await f.ask();
  assert.match(f.events.join('\n'), /โหมด CEO ปิดอยู่/);
  assert.equal(f.events.includes('RESUME'), false);
});

test('ผู้คุมสั่งให้ทำต่อ = กดต่อให้จริง และนับยอดรวมไว้', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'retry', reason: 'ห้องแชตน่าจะกลับมาปกติแล้ว' }) });
  await f.ask();
  assert.ok(f.events.includes('RESUME'));
  assert.match(f.events.join('\n'), /ผู้คุมกระบวนการ: สั่งให้ทำต่อ/);
});

test('ผู้คุมสั่งหยุด = หยุดจริง ไม่กดต่อ', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'stop', reason: 'อาการเดิมซ้ำสามครั้ง' }) });
  await f.ask();
  assert.equal(f.events.includes('RESUME'), false);
  assert.match(f.events.join('\n'), /อาการเดิมซ้ำสามครั้ง/);
});

test('เกินเพดานรวมทั้งเล่ม = หยุด แม้ผู้คุมจะยังสั่งต่อได้', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'retry' }), total: 12 });
  await f.ask();
  assert.equal(f.events.includes('RESUME'), false);
  assert.match(f.events.join('\n'), /เกินเพดานที่ตั้งไว้/);
});

test('ถามผู้คุมแล้วพัง = หยุดไว้ก่อน ไม่ลุยต่อแบบเดา', async () => {
  const f = fixture({ supervisor: async () => { throw new Error('เน็ตหลุด'); } });
  await f.ask();
  assert.equal(f.events.includes('RESUME'), false);
  assert.match(f.events.join('\n'), /เน็ตหลุด/);
});

/**
 * คำตัดสิน "หยุดรอคุณ" ต้องยึดจริง
 *
 * นาฬิกาเฝ้าดูอ่านเงื่อนไขเป็น `unattended || ceoModeOn()` การปลดธง unattended อย่างเดียว
 * จึงไม่มีผลเลยเมื่อเปิดโหมด CEO ไว้ อีกห้าวินาทีก็วนกลับมาถามซ้ำ เสียค่า API ทุกรอบ
 * โดยที่งานไม่ขยับ ต้องมีธงของตัวเองที่ล้างได้ด้วยมือคนเท่านั้น
 */
test('ผู้คุมสั่งหยุด = ปักธงหยุดไว้ ไม่ให้นาฬิกาปลุกซ้ำทุกห้าวินาที', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'stop', reason: 'อาการเดิมซ้ำ' }) });
  await f.ask();
  assert.equal(vm.runInContext('ceoStopped', f.scope), true);
});

test('ผู้คุมสั่งให้ทำต่อ = ไม่ปักธงหยุด', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'retry' }) });
  await f.ask();
  assert.equal(vm.runInContext('ceoStopped', f.scope), false);
});

test('เพดานกดต่อที่จุดเดิมสั้นลงเมื่อเปิดโหมด CEO — ไม่ต้องรอครบสามรอบกว่าจะถึงคิวมัน', () => {
  const f = fixture({ supervisor: async () => ({ action: 'retry' }) });
  assert.equal(vm.runInContext('autoContinueMax()', f.scope), 1);
  const off = fixture({ supervisor: null });
  assert.equal(vm.runInContext('autoContinueMax()', off.scope), 3);
});

test('นาฬิกาเคารพธงหยุดของผู้คุม', async () => {
  const src = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
  assert.match(src, /unattended: !ceoStopped && \(unattended \|\| ceoModeOn\(\)\)/);
  assert.match(src, /if \(autoContinues >= autoContinueMax\(\)\)/);
  // ล้างธงได้ด้วยการที่คนสั่งเริ่มหรือสั่งทำต่อเองเท่านั้น
  assert.equal((src.match(/^\s*ceoStopped = false;/gm) || []).length, 2);
});

/**
 * ท่าที่คนใช้กู้งานจริงคือการกดปุ่มบนหน้าจอ ไม่ใช่ท่าในเครื่องผลิต
 * ผู้คุมเคยสั่งได้แต่ท่าที่ใช้ได้ตอนเครื่องกำลังเดิน ซึ่งเป็นตอนที่ไม่ค่อยต้องการมันเท่าไร
 */
test('สั่งกดปุ่มขั้นสร้างภาพ = เดินขั้นภาพต่อ ไม่ใช่แค่ทำต่อเฉย ๆ', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'press_images', reason: 'ยังเหลือรูปที่สร้างเองได้' }) });
  vm.runInContext("book.job.step = 'images';", f.scope);
  await f.ask();
  assert.ok(f.events.includes('PHASE2'));
  assert.equal(f.events.includes('RESUME'), false);
});

test('สั่งเปิดหน้าต่าง ChatGPT = เปิดให้พร้อมก่อนแล้วค่อยสั่งเดินต่อ', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'open_chat', reason: 'หน้าเว็บยังไม่พร้อม' }) });
  await f.ask();
  assert.deepEqual(f.events.filter((e) => e === 'FOCUS' || e === 'RESUME'), ['FOCUS', 'RESUME']);
});

test('สั่งกดทำต่อ = เดินต่อจากขั้นที่บันทึกไว้', async () => {
  const f = fixture({ supervisor: async () => ({ action: 'press_continue', reason: 'ไม่มีอะไรเดินอยู่' }) });
  await f.ask();
  assert.ok(f.events.includes('RESUME'));
});

test('ผู้คุมได้เห็นรายการท่ากดปุ่มเฉพาะตอนถูกเรียกจากหน้า Studio', async () => {
  const src = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
  assert.match(src, /actions: ALL_SUPERVISOR_ACTIONS/);
  const machine = await readFile(new URL('../core/machine.js', import.meta.url), 'utf8');
  // เครื่องผลิตกดปุ่มของตัวเองไม่ได้ จึงต้องไม่ถูกเสนอท่าพวกนี้
  assert.equal(/press_images|press_continue|open_chat/.test(machine), false);
});
