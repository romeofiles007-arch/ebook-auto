/**
 * "เห็นคำตอบใหม่แล้ว · ยาว 0 ตัวอักษร · หยุดพ่นแล้ว · ยังไม่เจอแถบปุ่ม" — 299 วินาที
 *
 * ของจริงจากหน้าจอ: ขั้นปรับจำนวนหน้าค้างอยู่ห้านาทีเต็มในสถานะที่ตัดสินได้ตั้งแต่วินาทีแรก
 * กล่องคำตอบโผล่มาแล้ว ปุ่มหยุดหายไปแล้ว (= ChatGPT พ่นจบ) แต่ไม่มีตัวอักษรสักตัว
 *
 * เดิมไม่มีด่านไหนจับกรณีนี้เลยสักด่าน:
 *   · ด่านกันค้างฝั่งปุ่มหยุดเขียนไว้ว่า `len > 0` จึงข้ามคำตอบว่างไปทั้งดุ้น
 *   · เกณฑ์ "ข้อความหยุดยาว" อยู่ใต้บรรทัด `if (len === 0) return` ที่ไม่มีกำหนดเวลา
 * ทางออกเดียวจึงเป็นเพดานห้านาทีของนาฬิกาหัวใจ ซึ่งกลายเป็น timeout แล้วถูกตีตราเป็น
 * outcome_unknown — รหัสเดียวในระบบที่ห้ามกู้ทุกทาง ทั้งเล่มตายตรงนั้น CEO ก็ไม่ถูกเรียก
 *
 * คำตอบว่างที่พ่นจบแล้วไม่ใช่ "ผลที่ยืนยันไม่ได้" มันคือผลที่ยืนยันแล้วว่าว่าง — ต้องเป็น empty
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const adapterSource = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

/** ปุ่มหยุดที่ "มองเห็นอยู่" ตามเกณฑ์ของ visibleStopButton */
const stopButton = {
  disabled: false,
  offsetParent: {},
  getAttribute: (name) => (name === 'data-testid' ? 'stop-button' : ''),
  getBoundingClientRect: () => ({ width: 32, height: 32 }),
};

/**
 * DOM จำลองเท่าที่ waitForAnswer ใช้จริง — คืนผลตาม selector ที่มันถามเท่านั้น
 * ทุกอย่างที่ไม่รู้จักคืนค่าว่าง เพื่อให้เทสต์ล้มทันทีถ้าโค้ดไปพึ่งของที่ไม่ได้จำลองไว้
 */
function fixture({ streaming, text, trailingEmptyBox = false }) {
  const state = { streaming, text };
  const box = (read) => ({
    get innerText() { return read(); },
    querySelector: () => null,
    querySelectorAll: () => [],
    matches: () => false,
    closest: () => null,
    parentElement: null,
    // ทุกใบในเทสต์นี้อยู่หลังคำสั่งของเราเสมอ (anchor = null อยู่แล้ว)
    compareDocumentPosition: () => 4,
  });
  const turn = box(() => state.text);
  // โครงกล่องคำตอบใบถัดไปที่หน้าเว็บวางต่อท้ายไว้ — ว่างตลอดกาล
  const trailing = box(() => '');
  const main = { querySelector: () => null, querySelectorAll: () => [] };
  const pick = (sel) => {
    if (sel === 'main') return [main];
    if (sel.includes('data-message-author-role="assistant"'))
      return trailingEmptyBox ? [turn, trailing] : [turn];
    if (sel.includes('stop-button')) return state.streaming ? [stopButton] : [];
    return [];
  };
  const document = {
    body: main,
    querySelector: (sel) => pick(sel)[0] || null,
    querySelectorAll: (sel) => pick(sel),
  };

  let now = 1_000_000;
  const timers = [];
  const context = {
    document,
    window: {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 },
    getComputedStyle: () => ({ position: 'static' }),
    MutationObserver: class { observe() {} disconnect() {} },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0), every: 0 }); return timers.length; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    chrome: {
      storage: { local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} },
    },
  };
  // Expose the private function only inside this test VM; production keeps no test hook.
  vm.runInNewContext(
    adapterSource.replace(/\}\)\(\);\s*$/, 'globalThis.hook = { waitForAnswer }; })();'),
    context,
  );

  /** เดินนาฬิกาไปข้างหน้าทีละวินาที แล้วปล่อยตัวจับเวลาที่ถึงกำหนด */
  const advance = async (ms) => {
    for (let step = 0; step < ms; step += 1000) {
      now += 1000;
      for (const t of timers) {
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every;
        else t.dead = true;
        t.fn();
      }
      await Promise.resolve();
    }
  };

  return { context, state, advance };
}

const wait = (f) =>
  f.context.hook.waitForAnswer('t1', null, { timeoutMs: 300000, startMs: 120000 });

test('พ่นจบแล้วแต่ว่างเปล่า = empty ภายในไม่กี่วินาที ไม่ใช่ timeout ตอนห้านาที', async () => {
  const f = fixture({ streaming: true, text: '' });
  const p = wait(f);
  await f.advance(3000); // กำลังพ่นอยู่ ยังไม่ตัดสินอะไรทั้งนั้น
  f.state.streaming = false; // ปุ่มหยุดหายไป = พ่นจบแล้ว และยังว่างอยู่
  await f.advance(5000);
  assert.equal(await p, 'empty');
});

test('ยังพ่นอยู่ ห้ามตัดสินว่าว่าง ต่อให้นิ่งนานแค่ไหน', async () => {
  const f = fixture({ streaming: true, text: '' });
  const p = wait(f);
  let settled = false;
  p.then(() => { settled = true; });
  await f.advance(120000);
  assert.equal(settled, false, 'ปุ่มหยุดยังอยู่ = ยังไม่จบ ห้ามทิ้งเทิร์น');
  f.state.text = 'คำตอบจริง';
  f.state.streaming = false;
  await f.advance(5000);
  assert.equal(await p, 'ok');
});

/**
 * ปุ่มหยุดโผล่ช้ากว่ากล่องคำตอบได้ และ selector ของมันพลาดได้เมื่อหน้าเว็บเปลี่ยนโครงสร้าง
 * ถ้าตัดที่สองวินาทีเท่ากันทุกกรณี เทิร์นปกติที่แค่เริ่มช้าจะถูกทิ้งทั้งที่คำตอบกำลังจะมา
 */
test('ไม่เคยเห็นปุ่มหยุดเลย ต้องให้เวลานานกว่านั้นมากก่อนตัดสิน', async () => {
  const f = fixture({ streaming: false, text: '' });
  const p = wait(f);
  let settled = false;
  p.then(() => { settled = true; });
  await f.advance(30000);
  assert.equal(settled, false, 'ยังไม่มีหลักฐานว่าเคยพ่น ต้องรอต่อ');
  await f.advance(35000);
  assert.equal(await p, 'empty');
});

/**
 * ต้นเหตุจริงของอาการที่เห็นซ้ำ ๆ ที่ขั้นปรับจำนวนหน้า
 *
 * selector ของเรานับ [data-turn="assistant"] ที่ยังไม่มีเนื้อในเป็นกล่องคำตอบด้วย
 * พอหน้าเว็บวางโครงใบถัดไปต่อท้าย เราจึงไปจ้องใบเปล่าแทนใบที่มีคำตอบจริง
 * เห็นเป็น "ยาว 0 ตัวอักษร · ยังไม่เจอแถบปุ่ม" ทั้งที่คำตอบเต็ม ๆ อยู่บนจอแล้ว
 */
test('มีกล่องเปล่าต่อท้าย ต้องอ่านใบที่มีคำตอบจริง ไม่ใช่ทิ้งทั้งเทิร์น', async () => {
  const f = fixture({ streaming: true, text: '', trailingEmptyBox: true });
  const p = wait(f);
  await f.advance(2000);
  f.state.text = 'คำตอบจริงที่พ่นจบแล้ว';
  f.state.streaming = false;
  await f.advance(5000);
  assert.equal(await p, 'ok', 'คำตอบมีอยู่จริง ต้องจบเป็น ok ไม่ใช่ empty');
});

/**
 * แต่ถ้าไม่มีใบไหนมีของเลย ก็ยังต้องเป็นคำตอบว่างตามเดิม ไม่ใช่รอเก้อ
 */
test('กล่องเปล่าทุกใบ = ว่างจริง ยังต้องจบเป็น empty', async () => {
  const f = fixture({ streaming: true, text: '', trailingEmptyBox: true });
  const p = wait(f);
  await f.advance(2000);
  f.state.streaming = false;
  await f.advance(5000);
  assert.equal(await p, 'empty');
});

/**
 * empty ต้องไม่ถูกตีตรา outcome_unknown ที่ชั้นรายงานผล
 * ไม่งั้นแก้ตรงตัวจับเวลาไปก็เท่านั้น ปลายทางยังห้ามกู้เหมือนเดิม
 */
test('ชั้นรายงานผลตีตรา outcome_unknown เฉพาะ timeout กับ no_response เท่านั้น', () => {
  const stamp = adapterSource.slice(
    adapterSource.indexOf("if (status !== 'ok') {"),
    adapterSource.indexOf('const { text, blocks } = readAnswer(anchor);'),
  );
  assert.match(stamp, /\['timeout','no_response'\]\.includes\(status\)/);
  // รหัสที่ห้ามกู้ต้องถูกตีตราใต้เงื่อนไขนั้นเงื่อนไขเดียว ไม่มีทางอื่นเข้าถึง
  assert.equal((stamp.match(/outcome_unknown/g) || []).length, 1);
  assert.ok(
    !/\['timeout','no_response','empty'\]|status === 'empty'[^\n]*outcome_unknown/.test(stamp),
    'empty ต้องไม่ถูกกวาดเข้าไปในรหัสที่ห้ามกู้',
  );
});

/**
 * "สถานะ empty" เฉย ๆ บอกผู้ใช้ไม่ได้ว่าต้องทำอะไรต่อ และบอกชั้นบนไม่ได้ว่าควรเปลี่ยนคำสั่งไหม
 * ตัวอ่านหน้าเว็บเห็นอยู่แล้วว่าบนจอมีอะไร เหตุผลนั้นต้องเดินทางไปกับผลลัพธ์ด้วย
 */
test('คำตอบว่างต้องบอกด้วยว่าว่างแบบไหน', () => {
  const stamp = adapterSource.slice(
    adapterSource.indexOf("if (status !== 'ok') {"),
    adapterSource.indexOf('const { text, blocks } = readAnswer(anchor);'),
  );
  assert.match(stamp, /status === 'empty' \? String\(readAnswer\(anchor\)\?\.text \|\| ''\)/);
  assert.match(stamp, /note: seen \? `หน้าเว็บมีแต่ "\$\{seen\}" ซึ่งไม่ใช่คำตอบ` : 'ช่องคำตอบว่างเปล่า ไม่มีข้อความเลย'/);
});
