import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * ป้ายชั่วคราวระหว่าง ChatGPT คิด/ค้นเว็บ ต้องไม่ถูกนับเป็นคำตอบ
 *
 * เคสจริงที่ทำให้ขั้น "ค้นกระแส" ล้ม: หน้าเว็บโชว์ป้าย "Searching websites 4" ค้างไว้
 * ตัวรอคำตอบเห็นข้อความนิ่งเลยปิดเทิร์น แล้วส่งข้อความยาว 21 ตัวอักษรนั้นไปแปลงเป็น JSON
 */
const source = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const literal = source.match(/const PLACEHOLDER =\s*(\/\^.*\/i);/)?.[1];
assert.ok(literal, 'หา regex PLACEHOLDER ใน adapter ไม่เจอ');
// eslint-disable-next-line no-eval
const PLACEHOLDER = eval(literal);
const isPlaceholder = (t) => PLACEHOLDER.test(t.trim());

test('ป้ายระหว่างคิดและค้นเว็บนับเป็นของชั่วคราว', () => {
  for (const label of [
    'Thinking',
    'Thinking…',
    'Thought for 12s',
    'Searching the web',
    'Searching websites',
    'Searching websites 4',
    'Searched 5 sites',
    'Searching 4 websites',
    'Browsing the web',
    'Reading sources',
    'Finding sources',
    'กำลังค้นหาข้อมูล',
    'กำลังคิด',
  ]) {
    assert.equal(isPlaceholder(label), true, label);
  }
});

test('คำตอบจริงไม่ถูกนับเป็นป้ายชั่วคราว', () => {
  for (const answer of [
    '{"trends":[{"trend":"ราคาทองคำ"}]}',
    'Reading this book is a long and rewarding habit',
    'Searching websites 4 — และนี่คือผลลัพธ์ที่ได้',
    'นี่คือคำตอบจริงที่ยาวพอสมควร',
  ]) {
    assert.equal(isPlaceholder(answer), false, answer);
  }
});
