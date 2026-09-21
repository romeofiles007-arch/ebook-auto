/**
 * ตาราง — ตัวอ่านตัวเดียวที่ Typst หน้าอ่าน และ EPUB ใช้ร่วมกัน
 *
 * ก่อนหน้านี้มีตัวอ่านอยู่ฝั่ง Typst ฝ่ายเดียว หน้าอ่านกับ EPUB จึงพิมพ์ | ... | ออกมาดิบ ๆ
 * และตัวอ่านเดิมบังคับว่าแถวคั่น |---| ต้องอยู่บรรทัดถัดจากแถวหัวพอดี
 * ตารางที่โมเดลเว้นบรรทัดคั่นไว้จึงหลุดเป็นข้อความดิบทั้งในเล่ม PDF และบนหน้าอ่าน
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readTable, splitTableRow, isTableDivider, alignOf } from './md-table.js';
import { mdToHtml } from './md-html.js';

const lines = (s) => s.split('\n');

test('ตารางปกติต้องอ่านได้ครบทุกแถว', () => {
  const t = readTable(lines('| ชื่อ | ราคา |\n|---|---:|\n| A | 30 |\n| B | 39 |'), 0);
  assert.deepEqual(t.rows, [
    ['ชื่อ', 'ราคา'],
    ['A', '30'],
    ['B', '39'],
  ]);
  assert.deepEqual(t.align, ['left', 'right']);
  assert.equal(t.next, 4);
});

/** เคสจริงจากเล่มของผู้ใช้ — แถวหัวกับแถวคั่นถูกเว้นบรรทัดคั่นไว้ */
test('บรรทัดว่างระหว่างแถวต้องไม่ทำให้ตารางกลายเป็นข้อความดิบ', () => {
  const md = '| ต่อ 100 มล. | สินค้า A | สินค้า B |\n\n|---|---:|---:|\n| น้ำตาล | 4 กรัม | 3 กรัม |\n\n| โปรตีน | 5 กรัม | 4 กรัม |';
  const t = readTable(lines(md), 0);
  assert.ok(t, 'ต้องอ่านเป็นตาราง ไม่ใช่ null');
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows[2], ['โปรตีน', '5 กรัม', '4 กรัม']);
});

test('ข้อความธรรมดาที่มีขีดกลางต้องไม่ถูกเข้าใจผิดว่าเป็นตาราง', () => {
  assert.equal(readTable(lines('ราคา 30 บาท\nสินค้า A ถูกกว่า'), 0), null);
  assert.equal(readTable(lines('| ไม่มีแถวคั่น |\nข้อความต่อ'), 0), null);
});

test('ขีดยาวที่โมเดลชอบพิมพ์แทนขีดสั้นต้องยังนับเป็นแถวคั่น', () => {
  assert.equal(isTableDivider('|—|—|'), true);
  assert.equal(isTableDivider('|–––|:––:|'), true);
  assert.equal(isTableDivider('| ข้อความ | ปกติ |'), false);
});

test('ขีดคั่นที่ถูก escape ไว้ต้องอยู่ในช่องเดียวกัน ไม่ใช่ถูกผ่า', () => {
  assert.deepEqual(splitTableRow('| A \\| B | C |'), ['A | B', 'C']);
});

test('ตำแหน่งของ : บอกการจัดชิดของคอลัมน์', () => {
  assert.deepEqual(alignOf('|---|:---|---:|:---:|'), ['left', 'left', 'right', 'center']);
});

test('ตารางบนหน้าอ่านต้องเป็น <table> จริง ไม่ใช่ย่อหน้าที่มีขีดคั่น', () => {
  const out = mdToHtml('| ชื่อ | ราคา |\n|---|---:|\n| A | 30 |');
  assert.match(out, /<table>/);
  assert.match(out, /<th style="text-align:left">ชื่อ<\/th>/);
  assert.match(out, /<td style="text-align:right">30<\/td>/);
  assert.ok(!out.includes('|---|'), 'ห้ามมีแถวคั่นดิบหลงเหลือ');
});

test('ตารางใน EPUB ต้องพกเส้นไปเอง เพราะไฟล์นั้นไม่มีสไตล์ชีตของตัวเอง', () => {
  const out = mdToHtml('| ชื่อ | ราคา |\n|---|---:|\n| A | 30 |', { xhtml: true });
  assert.match(out, /<table style="border-collapse:collapse;width:100%">/);
  assert.match(out, /border:1px solid #ccc/);
});

test('ข้อความก่อนและหลังตารางต้องยังอยู่ครบ', () => {
  const out = mdToHtml('นำเรื่อง\n\n| ก | ข |\n|---|---|\n| 1 | 2 |\n\nปิดท้าย');
  assert.match(out, /<p>นำเรื่อง<\/p>/);
  assert.match(out, /<p>ปิดท้าย<\/p>/);
});

test('Typst ต้องใช้ตัวอ่านตัวเดียวกัน และจัดชิดตามที่ต้นฉบับสั่ง', async () => {
  const src = await readFile(new URL('../typeset/template.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ readTable \} from '\.\.\/core\/md-table\.js'/);
  assert.ok(!/function isTableDivider\(/.test(src), 'ตัวอ่านซ้ำฝั่ง Typst ต้องถูกถอดออก');
  assert.match(src, /const alignSpec = /);
  assert.match(src, /align: \(\$\{alignSpec\}\)/);
});
