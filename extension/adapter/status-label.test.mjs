/**
 * "ได้รับคำตอบจาก ChatGPT แล้ว (19 ตัวอักษร · 0 ภาพ): Refining Thai verse"
 *
 * ของจริงจาก log: Turn 55 · ok · ส่งถึงรับผลจริง 65 วินาที — แล้วขั้นบนฟ้อง
 * "แก้ชิ้น 1.4 ไม่สำเร็จ เก็บต้นฉบับเดิมไว้" แล้วหยุดทั้งงาน
 *
 * "Refining Thai verse" คือป้ายบอกสถานะที่ ChatGPT ขึ้นระหว่างทำงาน ไม่ใช่คำตอบ
 * ตัวจับป้ายเดิมเป็นรายการคำที่เขียนไว้ตายตัว (thinking · searching · analyzing ...)
 * ซึ่งแม่นแต่ตามไม่ทัน ทุกครั้งที่หน้าเว็บคิดคำใหม่บนป้าย เราจะกลืนป้ายนั้นมาเป็นคำตอบ
 * แล้วเสียไปหนึ่งเทิร์นเต็ม ๆ พร้อมหยุดงานทั้งเล่ม — เคยเจอมาแล้วกับ "Searching websites 4"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const PLACEHOLDER = new RegExp(
  src.slice(src.indexOf('const PLACEHOLDER =')).match(/\/\^\(\?:[\s\S]*?\/i;/)[0].slice(1, -3),
  'i',
);

test('ป้ายที่เคยหลุดมาแล้วทั้งสองใบ ต้องถูกจับได้', () => {
  assert.ok(PLACEHOLDER.test('Refining Thai verse'), 'ใบที่เพิ่งทำให้งานหยุด');
  assert.ok(PLACEHOLDER.test('Searching websites 4'), 'ใบที่เคยทำให้งานหยุดมาก่อน');
});

test('ป้ายหน้าตาใหม่ที่ยังไม่เคยเจอ ก็ต้องถูกจับได้โดยไม่ต้องมาเติมคำทีหลัง', () => {
  for (const label of [
    'Polishing the draft',
    'Generating image',
    'Composing Thai poem',
    'Refining verse',
    'Thinking',
    'Thought for 12s',
  ]) {
    assert.ok(PLACEHOLDER.test(label), `ต้องจับ "${label}" ได้`);
  }
});

/**
 * ด่านที่สำคัญกว่า: ห้ามกลืนคำตอบจริงไปเป็นป้าย
 * คำตอบของระบบนี้เป็นภาษาไทยหรือบล็อกโค้ดเสมอ ป้ายไม่มีทั้งสองอย่าง
 */
test('คำตอบจริงต้องไม่ถูกตีเป็นป้ายเด็ดขาด', () => {
  for (const real of [
    'ความรักไม่ได้หายไปไหน มันแค่เปลี่ยนที่อยู่',
    '{"titles":["หนึ่ง","สอง"]}',
    '<<<ITEM 1.4>>>\nลมหนาวพัดผ่าน\n<<<END 1.4>>>',
    'Nothing lasts, and that is the point of it.',
    'Working with the material you already have changes everything about the result.',
  ]) {
    assert.ok(!PLACEHOLDER.test(real), `ห้ามตี "${real.slice(0, 40)}" เป็นป้าย`);
  }
});

/**
 * จับป้ายได้อย่างเดียวไม่พอ ต้องไม่รอเก้อด้วย
 * ปุ่มหยุดยังอยู่ = คิดอยู่จริง รอต่อ · ปุ่มหยุดหายแล้วยังเหลือแต่ป้าย = คำตอบไม่มีวันมา
 */
test('ป้ายตอนที่พ่นจบแล้ว ต้องไปทางเดียวกับคำตอบว่าง ไม่ใช่รอจนหมดเพดาน', () => {
  const wait = src.slice(src.indexOf('function waitForAnswer('), src.indexOf('function readAnswer('));
  assert.match(wait, /const placeholderOnly = isThinkingOnly\(turn\) && !turn\.querySelector\('img'\)/);
  assert.match(wait, /if \(placeholderOnly && stopButtonVisible\(\)\) return;/);
  assert.match(wait, /if \(!hasImg && \(len === 0 \|\| placeholderOnly\)\)/);
  assert.ok(
    !/if \(isThinkingOnly\(turn\) && !turn\.querySelector\('img'\)\) return;/.test(wait),
    'ห้ามกลับไป return ทิ้งทั้งสองกรณีเหมือนเดิม',
  );
});

test('ตอนถอยไปหากล่องที่มีของ ต้องไม่ไปเกาะกล่องที่เป็นป้าย', () => {
  const wait = src.slice(src.indexOf('function waitForAnswer('), src.indexOf('function readAnswer('));
  assert.match(wait, /turnHasContent\(filled\) && !isThinkingOnly\(filled\)/);
});
