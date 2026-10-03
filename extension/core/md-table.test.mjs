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
  assert.match(out, /<table style="border-collapse:collapse;width:100%;border-bottom:2px solid #333">/);
  // เส้นของหัวคอลัมน์ติดไปกับแท็ก ส่วนช่องข้อมูลไม่มีเส้นตั้ง
  assert.match(out, /<th style="[^"]*border-top:2px solid #333;border-bottom:1px solid #333"/);
  assert.doesNotMatch(out, /<td style="[^"]*border/);
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

/** เคสจริงจากเล่มไข้เลือดออก หน้า 3 — ตารางบันทึกอาการที่ไม่มีแถวคั่นและไม่มีขีดเปิดปิด */
test('ตารางที่ไม่มีแถวคั่นเลย แต่ทุกแถวมีจำนวนช่องเท่ากัน ต้องอ่านเป็นตาราง', () => {
  const md = [
    'เวลา | ไข้ | อาการเด่น | สิ่งที่ดื่มหรือกิน | ปัสสาวะ | ยาและเวลาที่ได้รับ',
    '',
    'ตัวอย่างสมมติ: 08:00 | 38.7°C | ปวดหัว เพลีย | น้ำ 1 แก้ว | ปัสสาวะช่วงเช้า 1 ครั้ง | ยาที่ได้รับ: [ชื่อยา] 08:15',
    '14:00 | 39.0°C | เพลียมากขึ้น | ดื่มได้น้อยลง | ปัสสาวะแล้วช่วงเที่ยง | ยาที่ได้รับ: [ชื่อยา] 14:20',
    '20:00 | 38.5°C | ยังเพลีย มีคลื่นไส้ | จิบน้ำได้เป็นช่วง ๆ | ยังไม่ได้ปัสสาวะตั้งแต่ช่วงเที่ยง | ยาที่ได้รับ: [ชื่อยา] 20:10',
    '',
    'หลังกรอกแต่ละครั้ง ให้เติมอีกหนึ่งบรรทัด',
  ].join('\n');
  const t = readTable(lines(md), 0);
  assert.ok(t, 'ต้องอ่านเป็นตาราง');
  assert.equal(t.rows.length, 4);
  assert.equal(t.rows[0].length, 6);
  assert.equal(t.rows[2][1], '39.0°C');
  assert.equal(t.next, 5, 'ย่อหน้าถัดไปต้องไม่ถูกกลืนเข้าตาราง');
  assert.match(mdToHtml(md), /<table[\s\S]*39\.0°C[\s\S]*<\/table>/);
});

test('ข้อความที่มี | แต่ไม่ครบเกณฑ์ ต้องยังเป็นข้อความธรรมดา', () => {
  // สองช่อง — ประโยคทั่วไปใช้ | คั่นได้
  assert.equal(readTable(lines('เช้า | เย็น\nร้อน | หนาว\nสูง | ต่ำ'), 0), null);
  // สามช่องแต่มีแค่สองแถว — หลักฐานไม่พอ
  assert.equal(readTable(lines('ก | ข | ค\nง | จ | ฉ\nข้อความต่อ'), 0), null);
  // จำนวนช่องไม่เท่ากัน
  assert.equal(readTable(lines('ก | ข | ค\nง | จ\nช | ซ | ฌ | ญ'), 0), null);
});

/** เคสจริงหน้า 3 ฉบับที่ส่งออกจริง — ชื่อคอลัมน์อยู่ในประโยค แล้วมีป้าย "ตัวอย่างสมมติ:" คั่นก่อนแถวข้อมูล */
const LOG_TABLE = [
  'ให้ทำตาราง 6 ช่องไว้หนึ่งหน้า: วันและเวลา | อุณหภูมิ | อาการเด่น | สิ่งที่ดื่มหรือกิน | ปัสสาวะ | ยาและเวลาที่ได้รับ',
  '',
  'ตัวอย่างสมมติ:',
  '',
  '08:00 | 38.7°C | ปวดหัว เพลีย | น้ำ 1 แก้ว กินข้าวได้นิดหน่อย | ปัสสาวะช่วงเช้า 1 ครั้ง | ยาที่ได้รับ: [ชื่อยา] 08:15',
  '14:00 | 39.0°C | เพลียมากขึ้น | ดื่มได้น้อยลง | ปัสสาวะแล้วช่วงเที่ยง | ยาที่ได้รับ: [ชื่อยา] 14:20',
  '20:00 | 38.5°C | ยังเพลีย มีคลื่นไส้ | จิบน้ำได้เป็นช่วง ๆ | ยังไม่ได้ปัสสาวะตั้งแต่ช่วงเที่ยง | ยาที่ได้รับ: [ชื่อยา] 20:10',
  '',
  'หลังกรอกแต่ละครั้ง ให้เติมอีกหนึ่งบรรทัด',
].join('\n');

test('ชื่อคอลัมน์ที่อยู่ในประโยคนำ ต้องกลายเป็นหัวตาราง และข้อความที่ปนมาต้องไม่หาย', () => {
  const t = readTable(lines(LOG_TABLE), 0);
  assert.ok(t);
  assert.deepEqual(t.rows[0], ['วันและเวลา', 'อุณหภูมิ', 'อาการเด่น', 'สิ่งที่ดื่มหรือกิน', 'ปัสสาวะ', 'ยาและเวลาที่ได้รับ']);
  assert.equal(t.rows.length, 4);
  assert.equal(t.header, true);
  assert.deepEqual(t.lead, ['ให้ทำตาราง 6 ช่องไว้หนึ่งหน้า:', 'ตัวอย่างสมมติ:']);
  // เวลา "08:00" มีโคลอนแต่ไม่ใช่คำนำ ต้องไม่ถูกผ่า
  assert.equal(t.rows[1][0], '08:00');
  const html = mdToHtml(LOG_TABLE);
  assert.match(html, /<p>ให้ทำตาราง 6 ช่องไว้หนึ่งหน้า:<\/p><p>ตัวอย่างสมมติ:<\/p><table>/);
  assert.match(html, /<th[^>]*>วันและเวลา<\/th>/);
});

test('ตารางที่ไม่มีแถวชื่อคอลัมน์ ต้องไม่เอาแถวข้อมูลแถวแรกไปทำเป็นหัว', () => {
  const md = LOG_TABLE.split('\n').slice(4).join('\n');
  const t = readTable(lines(md), 0);
  assert.equal(t.header, false);
  const html = mdToHtml(md);
  assert.doesNotMatch(html, /<th/);
  assert.match(html, /<table class="nohead">/);
});

test('คอลัมน์สั้นใน PDF ต้องกว้างพอดีเนื้อหา ไม่ถูกบีบจนตัวหนังสือทับกัน', async () => {
  const { mdToTypst } = await import('../typeset/template.js');
  const typ = mdToTypst(LOG_TABLE);
  assert.match(typ, /columns: \(auto, auto, \d+fr, \d+fr, \d+fr, \d+fr\)/);
  assert.match(typ, /ให้ทำตาราง 6 ช่องไว้หนึ่งหน้า:/);
  assert.match(typ, /table\.header\(\n\s+\[#text\(weight: 600\)\[วันและเวลา\]\]/);
  // ไม่มีหัว = ไม่มี table.header และไม่มีเส้นใต้หัว
  const bare = mdToTypst(LOG_TABLE.split('\n').slice(4).join('\n'));
  assert.doesNotMatch(bare, /table\.header/);
  assert.equal((bare.match(/table\.hline/g) || []).length, 2);
});

/** เล่มจริงหน้า 4 — โมเดลครอบหมายเหตุถึงฝ่ายศิลป์ด้วยวงเล็บเหลี่ยม ตัวกวาดเดิมจึงมองไม่เห็น */
test('หมายเหตุ [ภาพประกอบ: …] ต้องไม่ถูกพิมพ์ลงเล่ม ทั้ง PDF และหน้าอ่าน', async () => {
  const { stripDesignNotes } = await import('./extract.js');
  const { mdToTypst } = await import('../typeset/template.js');
  const md = 'เมื่อไปพบแพทย์ จะบอกได้ว่าไข้เปลี่ยนไปเวลาใดบ้าง\n\n[ภาพประกอบ: ตารางตัวอย่างที่กรอก 3 เวลา 08:00, 14:00 และ 20:00 วางคู่กับตารางเปล่า 6 ช่องสำหรับนำไปใช้]\n\n### ไข้สูงไม่ได้แปลว่าไข้เลือดออกเสมอไป\n\nดู[แหล่งอ้างอิง](https://example.org) และภาพ\n\n![ผังอาการ](fig:fig-1)';
  for (const out of [stripDesignNotes(md), mdToHtml(md), mdToTypst(md)]) {
    assert.doesNotMatch(out, /ตารางตัวอย่างที่กรอก/);
    assert.match(out, /ไข้สูงไม่ได้แปลว่า/);
  }
  // ภาพจริงและลิงก์ใช้วงเล็บเหลี่ยมเหมือนกัน ต้องไม่ถูกกวาดไปด้วย
  assert.match(stripDesignNotes(md), /!\[ผังอาการ\]\(fig:fig-1\)/);
  assert.match(stripDesignNotes(md), /\[แหล่งอ้างอิง\]\(https:\/\/example\.org\)/);
});
