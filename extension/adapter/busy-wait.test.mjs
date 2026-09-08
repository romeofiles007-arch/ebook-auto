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
