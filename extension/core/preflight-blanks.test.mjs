/**
 * ช่องที่โมเดลเว้นไว้ให้เติมเอง — เห็นในเล่มจริง: "ยาที่ได้รับ: [ชื่อยา] 08:15" ครบทุกแถวของตารางตัวอย่าง
 * ไม่มีด่านไหนจับได้ เพราะมันไม่ใช่ตอนว่างและไม่ใช่ตัวอักษรที่พิมพ์ไม่ออก
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from './preflight.js';
import { EVIDENCE_RULES } from './editorial.js';

const run = (md) =>
  preflight({
    book: { targetPages: 24, typography: { marginsMm: { inner: 20 } }, trim: { widthMm: 148, heightMm: 210 }, outline: { chapters: [] } },
    sections: [{ id: '1.1', title: 'ก', md, status: 'done' }],
    pages: 24,
  }).checks.find((r) => r.id === 'blanks');

test('ช่องว่างในวงเล็บเหลี่ยมถูกรายงานก่อนส่งออก พร้อมบอกว่าอยู่ตอนไหน', () => {
  const r = run('08:00 | 38.7°C | ยาที่ได้รับ: [ชื่อยา] 08:15\n14:00 | 39.0°C | ยาที่ได้รับ: [ชื่อยา] 14:20');
  assert.equal(r.level, 'warn');
  assert.match(r.label, /2 จุด/);
  assert.match(r.detail, /\[ชื่อยา\]/);
  assert.match(r.detail, /1\.1/);
});

test('วงเล็บเหลี่ยมที่ตั้งใจ — ลิงก์ ภาพ เลขอ้างอิง — ไม่ถูกนับ', () => {
  const r = run('ดู[แหล่งอ้างอิง](https://example.org) ตามงานวิจัย [1] และ [12]\n\n![ผังอาการ](fig:fig-1)');
  assert.equal(r.level, 'ok');
});

test('คำสั่งเขียนบอกตรง ๆ ว่าตัวอย่างต้องใส่ค่าจริง', () => {
  assert.match(EVIDENCE_RULES, /ห้ามเว้นเป็น \[ชื่อยา\]/);
});
