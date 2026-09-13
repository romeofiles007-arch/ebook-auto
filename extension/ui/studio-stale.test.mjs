/**
 * แก้โค้ดแล้ว โหลดซ้ำส่วนขยายแล้ว แต่ยังเห็นข้อความผิดพลาดที่ถูกลบออกไปจากซอร์สแล้ว
 *
 * ของจริง: log ขึ้นว่า "แก้ชิ้น 1.10 ไม่สำเร็จ เก็บต้นฉบับเดิมไว้" ทั้งที่ประโยคนั้น
 * ไม่มีอยู่ในซอร์สอีกแล้ว — เพราะสมองของระบบอยู่ในหน้า Studio ไม่ใช่ใน service worker
 * core/machine.js ถูก import เข้าไปในหน้านั้นตั้งแต่ตอนเปิด การกดโหลดซ้ำที่หน้าส่วนขยาย
 * เปลี่ยนแต่ไฟล์บนดิสก์ ไม่ได้แตะโมดูลที่โหลดไปแล้วในหน้าที่ยังเปิดอยู่
 *
 * เป็นอาการที่หลอกที่สุด เพราะทุกอย่างดูเหมือนทำถูกหมดแล้วแต่ผลลัพธ์ไม่ขยับ
 * และมันกินเวลาไปหลายรอบกว่าจะรู้ว่าที่รันอยู่ไม่ใช่โค้ดที่เพิ่งแก้
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const url = 'chrome-extension://test/ui/studio.html';

/** ติดตั้ง/โหลดซ้ำส่วนขยาย แล้วบอกว่ามีการสั่งอะไรกับแท็บบ้าง */
async function reinstall({ existing = true } = {}) {
  const calls = [];
  const event = { addListener() {} };
  let onInstalled;
  const tab = { id: 7, windowId: 1, url, status: 'complete', discarded: false };
  const chrome = {
    runtime: {
      getURL: () => url,
      onInstalled: { addListener(fn) { onInstalled = fn; } },
      onMessage: { addListener() {} },
      getContexts: async () => [{ tabId: 7 }],
    },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), remove: async () => {} },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: {
      onActivated: event, onUpdated: event, onRemoved: event,
      query: async () => (existing ? [tab] : []),
      create: async (opts) => { calls.push({ create: opts }); return tab; },
      update: async (id, opts) => { calls.push({ update: opts }); return { ...tab, ...opts }; },
      reload: async (id, opts) => { calls.push({ reload: id, opts }); },
    },
    windows: { update: async () => {} },
    alarms: { create() {}, onAlarm: event },
  };
  vm.runInNewContext(source, { chrome });
  onInstalled({ reason: 'update' });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return JSON.parse(JSON.stringify(calls));
}

test('โหลดซ้ำส่วนขยาย = หน้า Studio ที่ค้างอยู่ต้องถูกโหลดใหม่ให้เอง', async () => {
  assert.deepEqual(await reinstall(), [{ reload: 7, opts: { bypassCache: true } }]);
});

/**
 * ยังไม่เคยเปิด Studio = ไม่มีอะไรค้างให้ต้องรีเฟรช
 * ห้ามถือโอกาสเด้งหน้าขึ้นมาเอง เพราะการติดตั้งส่วนขยายไม่ใช่คำสั่งให้เริ่มทำหนังสือ
 */
test('ไม่มีแท็บ Studio อยู่ ต้องไม่เปิดหน้าใหม่ขึ้นมาเอง', async () => {
  assert.deepEqual(await reinstall({ existing: false }), []);
});

test('ยังตั้งค่าให้ปุ่มไอคอนเปิดแถบข้างเหมือนเดิม', () => {
  const block = source.slice(source.indexOf('chrome.runtime.onInstalled.addListener'), source.indexOf('// ---------- หา/เปิดแท็บ'));
  assert.match(block, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.match(block, /chrome\.tabs\.reload\(tab\.id, \{ bypassCache: true \}\)/);
});
