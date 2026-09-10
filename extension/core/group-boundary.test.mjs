/**
 * "สร้างเสร็จแล้วหยุดไปเลย" ตรงรอยต่อกลุ่มงานภาพ
 *
 * ปก → ลายพื้นหลัง → ภาพประกอบ แต่ละกลุ่มเปิดห้องแชตของตัวเอง (ตามที่ตั้งใจ)
 * แต่จังหวะขอห้องใหม่คือจังหวะที่ภาพกลุ่มก่อนเพิ่งวาดเสร็จ หน้าเว็บยังคืนช่องพิมพ์ไม่ทัน
 * แล้วตอบ previous_turn_running — ซึ่งถูกโยนขึ้นไปหยุดทั้ง Phase 2 ทันที
 * ทั้งที่ทุกที่ในหน้าเว็บคืนรหัสนี้ "ก่อน" แตะช่องพิมพ์ = คำสั่งยังไม่เคยถูกส่ง
 *
 * ของจริง: ปกหน้า ปกหลัง ลายพื้นหลัง เสร็จครบ แล้วจอดตายก่อนภาพประกอบใบแรก เหลือ 6 รูป
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const adapter = await readFile(new URL('../adapter/chatgpt.js', import.meta.url), 'utf8');

test('ทุกที่ที่คืนรหัสนี้ คืนก่อนแตะช่องพิมพ์ — จึงลองใหม่ได้เสมอ', () => {
  // ทุกจุดต้องเป็นการถอยออกมาเพราะเห็นปุ่มหยุด หรือเพราะมีเทิร์นอื่นครองอยู่
  const spots = [...adapter.matchAll(/previous_turn_running/g)];
  assert.ok(spots.length >= 5);
  for (const m of ['stopButtonVisible()', 'activeTurnId']) {
    assert.ok(adapter.includes(m), `ขาดตัวกันก่อนส่ง: ${m}`);
  }
});

test('สายภาพ: รอหน้าเว็บว่างแล้วลองใหม่ ไม่ใช่หยุดทั้ง Phase 2', () => {
  const loop = machine.slice(machine.indexOf('let busyWaits = 0;'), machine.indexOf('let url = res.images?.[0];'));
  assert.match(loop, /e\.code === 'previous_turn_running' && busyWaits < MAX_BUSY_WAITS/);
  assert.match(loop, /await sleep\(BUSY_WAIT_MS\)/);
  assert.match(loop, /attempt--/);
  // ต้องไม่นับเป็นครั้งที่ลอง เพราะยังไม่เคยได้สั่งวาดจริง
  const idx = loop.indexOf("e.code === 'previous_turn_running'");
  assert.ok(idx < loop.indexOf("e.code !== 'outcome_unknown') throw e"), 'ต้องดักก่อนบรรทัดที่โยนทิ้ง');
});

test('สายข้อความก็รอเหมือนกัน', () => {
  const turn = machine.slice(machine.indexOf('async turnWithRetry('), machine.indexOf('/** บันทึกล่าสุดของงานนี้'));
  assert.match(turn, /e\.code === 'previous_turn_running' && busyWaits < MAX_BUSY_WAITS/);
  const idx = turn.indexOf("e.code === 'previous_turn_running'");
  assert.ok(idx < turn.indexOf("e.code !== 'not_sent' || i >= MAX_RETRIES) throw e"), 'ต้องดักก่อนบรรทัดที่โยนทิ้ง');
});

test('การรอมีที่สิ้นสุด ไม่ใช่รอทั้งคืน', () => {
  assert.match(machine, /const MAX_BUSY_WAITS = 4;/);
  assert.match(machine, /const BUSY_WAIT_MS = 20000;/);
});

/**
 * เดิมข้อนี้ยืนยันว่า "ห้องใหม่ที่ขอบกลุ่ม" ซึ่งพิสูจน์แล้วว่าไม่พอ —
 * ภายในกลุ่มเดียวกันยังต่อจากภาพเดิมอยู่ ตอนนี้เปิดห้องใหม่ทุกครั้งที่จะสร้างภาพ
 */
test('ทุกครั้งที่จะสร้างภาพ ต้องอยู่ในห้องใหม่', () => {
  const b = machine.slice(machine.indexOf("const group = j.kind === 'cover'"), machine.indexOf('this.book.imagePhase = {', machine.indexOf("const group = j.kind === 'cover'")));
  assert.match(b, /const newThread = !useApi;/);
  // ยังบอกได้ว่ากำลังทำกลุ่มไหน เผื่อไล่อ่านบันทึกย้อนหลัง
  assert.match(b, /this\.job\.imageThreadGroup = group;/);
});
