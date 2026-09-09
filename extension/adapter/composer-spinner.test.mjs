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
  // นิ่งครบเกณฑ์หรือหมุนยาวจนครบสามนาที ล้วนเข้าเส้นทางปลดเองแล้วค่อยยอมแพ้เป็น composer_busy_stuck
  assert.match(send, /if \(how !== 'done'\) \{[\s\S]*composer_busy_stuck/);
});

/**
 * สิ่งที่คนทำเมื่อเจอวงกลมค้างคือกดที่ปุ่มนั้นหนึ่งครั้ง แล้วช่องพิมพ์ก็กลับมา
 * ระบบเราไม่เคยลองท่านั้นในเส้นทางนี้เลย ได้แต่รอครบเกณฑ์แล้วโยนความล้มขึ้นไป
 * ให้ชั้นบนไปตามผู้คุมกระบวนการมาสั่งโหลดหน้าใหม่ ซึ่งช้ากว่าและแพงกว่ามาก
 */
const releaseBlock = source.slice(
  source.indexOf('function releaseStuckComposer'),
  source.indexOf('\n  }', source.indexOf('function releaseStuckComposer')) + 4,
);

function release({ spinnerButton = null, stopButton = null } = {}) {
  const clicked = [];
  const spinner = spinnerButton
    ? { closest: (sel) => (sel.includes('not([disabled])') ? { click: () => clicked.push('spinner') } : null) }
    : null;
  const scope = {
    composerSpinner: () => spinner,
    visibleStopButton: () => (stopButton ? { click: () => clicked.push('stop') } : null),
  };
  vm.createContext(scope);
  vm.runInContext(`${releaseBlock}\nglobalThis.release = releaseStuckComposer;`, scope);
  return { ok: scope.release({}), clicked };
}

test('กดปลดวงกลมที่ค้างเองหนึ่งครั้ง แทนที่จะรอให้ใครมาสั่ง', () => {
  const r = release({ spinnerButton: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.clicked, ['spinner']);
});

test('ไม่มีวงกลมให้กด ก็ใช้ปุ่มหยุดที่เห็นอยู่แทน', () => {
  const r = release({ stopButton: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.clicked, ['stop']);
});

test('ไม่มีอะไรให้กดเลย = บอกตรง ๆ ว่าปลดไม่ได้ ไม่ใช่แกล้งว่าสำเร็จ', () => {
  const r = release({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.clicked, []);
});

test('ปลดเองก่อน แล้วค่อยยอมแพ้เป็น composer_busy_stuck', () => {
  const send = source.slice(source.indexOf('async function clickSend'), source.indexOf('// ---------- รู้ได้อย่างไรว่าตอบจบ'));
  assert.match(send, /if \(releaseStuckComposer\(\$\(S\.composer\)\)\) \{/);
  assert.match(send, /btn = await waitForDom\(usableButton, \{ timeoutMs: 8000 \}\)/);
  assert.match(send, /if \(!btn\) throw new Error\('composer_busy_stuck'\)/);
});
