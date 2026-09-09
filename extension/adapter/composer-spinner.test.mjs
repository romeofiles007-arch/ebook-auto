import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * วงกลมหมุนที่ปุ่มส่งต้องถูกอ่านว่า "หน้าเว็บค้าง" ไม่ใช่ "กดส่งไม่ติด"
 *
 * รหัสสองตัวนี้พาไปคนละทาง: composer_busy_stuck ส่งต่อให้ CEO โหลดหน้าใหม่ได้ทันที
 * ส่วน send_action_not_accepted ไปนอนอยู่ในกองลองใหม่ฟรีสี่รอบ รอบละสี่วินาที
 * แล้วจบด้วยอาการเดิมโดยไม่มีใครแตะหน้าเว็บที่ค้างอยู่เลยสักครั้ง
 */
const source = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('const SPINNER_SELECTORS');
const end = source.indexOf('\n  }', source.indexOf('function composerSpinner')) + 4;
const block = source.slice(start, end);

function el(sel, { visible = true } = {}) {
  return {
    sel,
    offsetParent: visible ? {} : null,
    getBoundingClientRect: () => (visible ? { width: 32, height: 32 } : { width: 0, height: 0 }),
  };
}

function composerWith(children) {
  const form = { querySelectorAll: (sel) => children.filter((c) => c.sel === sel) };
  return { isConnected: true, closest: (what) => (what === 'form' ? form : null) };
}

function run(box) {
  const scope = {
    $$: (sel, root) => [...root.querySelectorAll(sel)],
    getComputedStyle: () => ({ position: 'static' }),
  };
  vm.createContext(scope);
  vm.runInContext(`${block}\nglobalThis.find = composerSpinner;`, scope);
  return scope.find(box);
}

test('ปุ่มส่งที่กลายเป็นวงกลมหมุนถูกจับได้ แม้ไม่เหลือ element ที่นับเป็นปุ่มส่ง', () => {
  const spinner = el('[class*="animate-spin" i]');
  assert.equal(run(composerWith([spinner])), spinner);
});

test('ปุ่มส่งที่ยังอยู่แต่ถูก disable ก็นับว่าหน้าเว็บยังไม่ว่าง', () => {
  const disabled = el('[data-testid="send-button"][disabled]');
  assert.equal(run(composerWith([disabled])), disabled);
});

test('วงกลมที่ซ่อนอยู่ใน DOM ไม่นับ — ไม่งั้นทุกเทิร์นจะรอเปล่า', () => {
  assert.equal(run(composerWith([el('[role="progressbar"]', { visible: false })])), null);
});

test('ช่องพิมพ์ว่างและไม่มีอะไรหมุน = ไม่ค้าง', () => {
  assert.equal(run(composerWith([])), null);
});

test('ช่องพิมพ์ที่หลุดจากหน้าไปแล้วไม่ถือว่าค้าง', () => {
  assert.equal(run({ isConnected: false, closest: () => null }), null);
});

test('clickSend รอวงกลมหมุน แล้วรายงานเป็น composer_busy_stuck ทั้ง stale และ timeout', () => {
  const send = source.slice(source.indexOf('async function clickSend'), source.indexOf('// ---------- รู้ได้อย่างไรว่าตอบจบ'));
  assert.match(send, /composerBusy = \(\) => sendCandidates[\s\S]*composerSpinner/);
  assert.match(send, /if \(!btn && composerBusy\(\)\)/);
  assert.match(send, /if \(how !== 'done'\) throw new Error\('composer_busy_stuck'\)/);
});
