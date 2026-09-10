/**
 * "กด Enter แล้วแต่จับข้อความไม่ได้" ถูกตัดสินว่าตอบไม่ได้มาตลอด — ทั้งที่หน้าเว็บบอกคำตอบอยู่
 *
 * ของจริง: Phase 2 ผ่านไป 2 จาก 10 รูป แล้วหยุดกลางคันด้วยข้อความ
 * "เบราว์เซอร์กด Enter แล้ว แต่ยังจับข้อความที่ส่งไม่ได้ — ไม่กดซ้ำเพื่อป้องกันงานซ้อน"
 * รหัสนั้นคือ outcome_unknown ซึ่งกันตัวกู้ทุกตัวออกไปแล้วหยุดทั้งงาน
 *
 * แต่ ChatGPT ล้างช่องพิมพ์ทันทีที่รับข้อความ ถ้า Prompt ยังอยู่ในช่องครบและไม่มีปุ่มหยุด
 * แปลว่า Enter ไม่ติด ไม่มีอะไรออกไป — ตอบได้ชัดเจน ไม่ใช่เรื่องที่ต้องเดา
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const adapter = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const machine = await readFile(new URL('../core/machine.js', import.meta.url), 'utf8');

test('หลักฐานคือช่องพิมพ์ที่ยังเต็ม บวกกับยังไม่มีการตอบ', () => {
  assert.match(adapter, /const nothingWasSent = \(prompt\) => composerMatches\(prompt\) && !stopButtonVisible\(\);/);
});

test('ทั้งทางหลักและทางสำรองต้องเช็คหลักฐานก่อนยอมแพ้', () => {
  const start = adapter.indexOf("report(turnId, 'sending'");
  const send = adapter.slice(start, adapter.indexOf('const submittedAt = Date.now();', start));
  const guarded = [...send.matchAll(/if \(!fresh && nothingWasSent\(prompt\)\)/g)];
  assert.equal(guarded.length, 2, 'ต้องเช็คทั้งสองทาง');
  // ต้องคืนรหัสที่ระบบกู้เองได้ ไม่ใช่รหัสที่กันทุกคนออก
  assert.match(send, /error:'send_action_not_accepted'/);
  // และยังต้องมี outcome_unknown ไว้สำหรับกรณีที่ตอบไม่ได้จริง ๆ
  assert.match(send, /error:'outcome_unknown'/);
});

test('send_action_not_accepted เป็นรหัสที่ไม่เสียโควตา จึงลองใหม่ได้', () => {
  const noCost = machine.slice(machine.indexOf('const NO_COST_ERRORS'), machine.indexOf('const MAX_FREE_RETRIES'));
  assert.match(noCost, /'send_action_not_accepted'/);
});

test('สายภาพได้บันไดกู้เท่ากับสายข้อความ — ส่งไม่ออกซ้ำแล้วโหลดแท็บใหม่', () => {
  const loop = machine.slice(machine.indexOf('let imgUnstuck = false;'), machine.indexOf('let url = res.images?.[0];'));
  assert.match(loop, /if \(freeRetries >= 2 && !imgUnstuck\)/);
  assert.match(loop, /await this\.reloadChatTab\(\)/);
  // หน้าใหม่แล้วต้องเปิดห้องของรอบนี้เอง ไม่งั้นยิงลงห้องที่ไม่มีอยู่แล้ว
  assert.match(loop, /this\.job\.imageThreadStarted = false;/);
  // ครั้งเดียวต่อรูป
  assert.match(loop, /imgUnstuck = true;/);
});
