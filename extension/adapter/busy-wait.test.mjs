import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const adapterSource = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

/**
 * ก่อนส่ง Prompt ระบบต้องรอให้เทิร์นก่อนหน้าจบ — แต่ต้องแยก "กำลังตอบอยู่จริง"
 * ออกจาก "หน้าเว็บค้างสถานะ" ให้ได้ ไม่งั้นจะได้อาการใดอาการหนึ่งใน 2 อย่าง:
 * รอเงียบ 3 นาทีต่อรอบจนงานอัตโนมัติล้ม หรือกดปุ่มหยุดใส่งานที่กำลังทำอยู่ดี ๆ
 */
async function fixture({ text = () => 0, images = () => 0 } = {}) {
  const context = {
    document: {
      // ป้อนสัญญาณผ่าน DOM จำลอง เพื่อให้โค้ดจริงอ่านค่าด้วยเส้นทางเดียวกับตอนทำงานจริง
      querySelectorAll: (sel) =>
        sel === 'img'
          ? Array.from({ length: images() }, () => ({}))
          : String(sel).includes('assistant') || String(sel).includes('data-turn')
            ? [{ innerText: 'x'.repeat(text()) }]
            : [],
      querySelector: () => null,
      documentElement: {},
    },
    window: {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 },
    setTimeout,
    clearTimeout,
    Date,
    chrome: {
      storage: { local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) },
    },
  };
  context.document.body = context.document;
  // Expose private functions only in this test VM; production has no test hook.
  vm.runInNewContext(
    adapterSource.replace(/\}\)\(\);\s*$/, 'globalThis.fixture = { waitForBusyToClear }; })();'),
    context,
  );
  await Promise.resolve();
  return context.fixture;
}

test('หน้าเว็บที่ไม่ขยับเลยตั้งแต่เริ่มรอ ถูกตัดสินว่าค้าง', async () => {
  const { waitForBusyToClear } = await fixture();
  const how = await waitForBusyToClear(() => true, { timeoutMs: 5000, staleMs: 120 });
  assert.equal(how, 'stale');
});

test('คำตอบที่ยังโตอยู่ ห้ามถูกตัดสินว่าค้าง', async () => {
  let n = 0;
  const { waitForBusyToClear } = await fixture({ text: () => (n += 40) });
  const how = await waitForBusyToClear(() => true, { timeoutMs: 2500, staleMs: 120 });
  assert.equal(how, 'timeout', 'เนื้อหาโตขึ้นเรื่อย ๆ ต้องรอจนหมดเวลา ไม่ใช่ไปกดหยุด');
});

test('ปุ่มหยุดหายไประหว่างรอ = จบปกติ', async () => {
  let busy = true;
  setTimeout(() => (busy = false), 300);
  const { waitForBusyToClear } = await fixture();
  const how = await waitForBusyToClear(() => busy, { timeoutMs: 5000, staleMs: 4000 });
  assert.equal(how, 'done');
});

/**
 * เกณฑ์ "ต้องไม่ขยับเลยแม้แต่ครั้งเดียว" พังในทางปฏิบัติ เพราะหน้าเว็บที่ค้าง
 * ยังกะพริบได้หนึ่งครั้งจากการ re-render แล้วธงติดค้างว่ากำลังทำงานตลอดกาล
 * ตัวรอจึงกินเวลาเต็มเพดานทุกครั้ง (เห็นจริง: รอ 239 วินาทีแล้วล้มด้วย previous_turn_running)
 */
test('ขยับครั้งเดียวตอนต้น แล้วเงียบยาว ต้องยังนับว่าค้าง', async () => {
  let n = 0;
  // ขยับหนึ่งครั้งในวินาทีแรก จากนั้นนิ่งสนิท
  const { waitForBusyToClear } = await fixture({ text: () => (n++ < 2 ? n * 10 : 20) });
  const how = await waitForBusyToClear(() => true, { timeoutMs: 6000, staleMs: 1500 });
  assert.equal(how, 'stale');
});

/**
 * วงกลมที่ปุ่มส่งค้าง — ต้องปลดเองได้โดยไม่ต้องรอโหมด CEO
 *
 * มาถึงรหัส composer_busy_stuck ได้ก็ต่อเมื่อ adapter ตรวจครบทุกด่านและกดปลดไปแล้วหนึ่งครั้ง
 * เรารู้แน่ว่าหน้าเว็บค้างและคำสั่งยังไม่เคยถูกส่ง โหลดหน้าใหม่จึงปลอดภัยเสมอ
 * เดิมท่านี้สั่งได้เฉพาะทางผู้คุมกระบวนการ ปิด CEO ไว้ = ตรวจเจอแต่ไม่มีใครลงมือ
 */
test('ทั้งเครื่องผลิตและปุ่มบนหน้า Studio โหลดหน้าใหม่เองได้เมื่อปุ่มส่งค้าง', async () => {
  const { readFile } = await import('node:fs/promises');
  const machine = await readFile(new URL('../core/machine.js', import.meta.url), 'utf8');
  const turn = machine.slice(machine.indexOf('async turnWithRetry('), machine.indexOf('/** บันทึกล่าสุดของงานนี้'));
  assert.match(turn, /composer_busy_stuck/);
  assert.match(turn, /if \(!unstuck\)/);
  assert.match(turn, /sw\.reloadChat/);
  // ครั้งเดียวต่อเทิร์น แล้วต้องตกไปทางเดิม ไม่ใช่วนโหลดไม่จบ
  assert.match(turn, /i = MAX_RETRIES;\s*\n\s*break;/);

  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
  const send = studio.slice(studio.indexOf('async function sendTurn('), studio.indexOf('async function superviseFailure('));
  assert.match(send, /composer_busy_stuck' && !unstuck/);
  assert.match(send, /sw\.reloadChat/);
});

/**
 * บันไดกู้ต้องเป็นบันได ไม่ใช่การยิงซ้ำเงื่อนไขเดิม
 * ห้องเดิม → ห้องใหม่ (ล้างบทสนทนา) → โหลดแท็บใหม่ (ล้างสถานะหน้าเว็บ) — คนละอาการ คนละท่า
 */
test('ห้องใหม่แล้วยังไม่หาย ต้องขึ้นขั้นโหลดแท็บใหม่ ทั้งสองเส้นทาง', async () => {
  const { readFile } = await import('node:fs/promises');
  const machine = await readFile(new URL('../core/machine.js', import.meta.url), 'utf8');
  const turn = machine.slice(machine.indexOf('async turnWithRetry('), machine.indexOf('/** บันทึกล่าสุดของงานนี้'));
  assert.match(turn, /if \(freshRoom\) \{[\s\S]*?triedNewThread = true;/);
  assert.match(turn, /if \(triedNewThread && !unstuck\)/);

  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
  const send = studio.slice(studio.indexOf('async function sendTurn('), studio.indexOf('async function superviseFailure('));
  assert.match(send, /!opts\.newThread\) \{\s*\n\s*opts = \{ \.\.\.opts, newThread: true \};/);
  assert.match(send, /\} else if \(!unstuck\) \{/);
});

/**
 * โหลดแท็บได้เฉพาะตอนที่งานวิ่งผ่านหน้าเว็บจริง
 * เล่มที่เขียนด้วย API ไม่มีแท็บให้โหลด และ ensureChatTab จะ "สร้าง" แท็บให้ ซึ่งไม่มีใครขอ
 */
test('โหมด API ต้องไม่ถูกเปิดแท็บ ChatGPT ขึ้นมาเพราะบันไดกู้', async () => {
  const { readFile } = await import('node:fs/promises');
  const machine = await readFile(new URL('../core/machine.js', import.meta.url), 'utf8');
  const helper = machine.slice(machine.indexOf('async reloadChatTab()'), machine.indexOf('async turnWithRetry('));
  assert.match(helper, /this\.tr\?\.kind !== 'chatgpt_tab'/);
  assert.match(helper, /typeof chrome === 'undefined'/);

  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
  const send = studio.slice(studio.indexOf('async function sendTurn('), studio.indexOf('async function superviseFailure('));
  assert.match(send, /transport\.kind !== 'chatgpt_tab'/);
  assert.match(send, /composer_busy_stuck' && !unstuck && transport\.kind === 'chatgpt_tab'/);
});
