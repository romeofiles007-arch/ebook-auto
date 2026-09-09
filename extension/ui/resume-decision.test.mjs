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
    unattended: true,
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
  assert.match(f.events.join('\n'), /ผู้คุมกระบวนการสั่งให้ทำต่อ/);
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
