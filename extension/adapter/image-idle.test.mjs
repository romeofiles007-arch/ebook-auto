/**
 * "รอให้ ChatGPT ตอบเทิร์นก่อนหน้าจบ" วนไม่จบระหว่างสร้างภาพ
 *
 * งานภาพเปิดห้องแชตใหม่ทุกครั้งอยู่แล้ว และ "ห้องใหม่" คือท่าที่ปลดสถานะค้างได้จริง
 * แต่โค้ดเดิมรอให้หน้าเว็บหายค้างก่อนถึงจะยอมเปิดห้องใหม่ — กลับหัวกับสิ่งที่กำลังจะทำ
 * เท่ากับนั่งดูอาการที่เรามีวิธีแก้อยู่ในมือ นานได้ถึงสี่นาทีต่อหนึ่งภาพ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const run = src.slice(src.indexOf('if (opts.newThread) {'), src.indexOf('const userMessagesBefore = snapshotUserMessages();'));

test('งานภาพรอสั้น ๆ แล้วเปิดห้องใหม่เลย ไม่รอจนหมดเวลา', () => {
  assert.match(src, /const IMAGE_IDLE_GRACE_MS = 30000;/);
  assert.match(run, /opts\.wantImages \? IMAGE_IDLE_GRACE_MS : \(opts\.imageTimeoutMs \?\? 240000\)/);
});

test('รอไม่ทันแล้วยังเดินหน้าเปิดห้องใหม่ — ไม่ใช่ยอมแพ้', () => {
  assert.match(run, /if \(!idle && !opts\.wantImages\) \{/);
  assert.match(run, /error: 'previous_turn_running'/);
  // ต้องรายงานให้เห็นว่าทำไมถึงเปิดทั้งที่ยังไม่ว่าง
  assert.match(run, /เปิดห้องใหม่เลย เพราะห้องใหม่คือทางออกจากสถานะค้าง/);
});

test('งานข้อความยังรอเต็มเวลาเหมือนเดิม — ที่นั่นการรอคือการรักษาคำตอบไว้', () => {
  // ทางข้อความยังต้องคืน previous_turn_running เมื่อรอไม่ไหว
  assert.match(run, /!opts\.wantImages/);
  assert.ok(!/const idleBudget = IMAGE_IDLE_GRACE_MS;/.test(run), 'ห้ามใช้เวลาสั้นกับงานข้อความ');
});

test('ห้องใหม่ของงานภาพยังต้องเป็นห้องว่างจริง', () => {
  assert.match(run, /newThread\(\{ mustBeEmpty: !!opts\.wantImages \}\)/);
});
