/**
 * รูปผู้เขียนพอกในช่องพิมพ์ทีละใบทุกรอบ — เห็นกับตา: แนบไปสองใบในเทิร์นเดียว
 *
 * ChatGPT ที่ได้รูปเดียวกันซ้อนกันหลายใบตีความว่าเป็นงานเทียบภาพหรืองานแก้ภาพ
 * ไม่ใช่งานวาดใหม่ตามคำสั่ง แล้วก็หยุดคิดกลางคัน ("Stopped thinking") ไม่ได้ภาพสักใบ
 *
 * ต้นตอ: ตัวนับไฟล์แนบมองทั้งหน้า แต่ภาพที่ ChatGPT วาดเสร็จก็เป็น blob: เหมือนกัน
 * ตัวล้างจึงไปไล่หาปุ่มลบของภาพในบทสนทนา ซึ่งไม่มี แล้ว break ออกโดยไม่ล้างอะไรเลย
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

test('นับไฟล์แนบเฉพาะในกรอบช่องพิมพ์ ไม่ใช่ทั้งหน้า', () => {
  const fn = src.slice(src.indexOf('const attachmentThumbs = () => {'), src.indexOf('const countAttachmentThumbs'));
  assert.match(fn, /\$\(S\.composer\)\?\.closest\('form'\)/);
  assert.match(fn, /form \? \$\$\('img\[src\^="blob:"\]', form\) : \[\]/);
  // ห้ามกลับไปกวาดทั้งเอกสารอีก
  assert.ok(!/\$\$\('img\[src\^="blob:"\]'\)\s*;/.test(src), 'ยังมีที่ที่กวาดทั้งหน้าอยู่');
});

test('หาปุ่มลบไม่เจอด้วยป้ายกำกับ ต้องมีทางสำรอง ไม่ใช่ยอมแพ้ทันที', () => {
  const fn = src.slice(src.indexOf('async function clearAttachments()'), src.indexOf('return { cleared: started - left, left };'));
  assert.match(fn, /S\.attachmentRemove/);
  assert.match(fn, /querySelectorAll\?\.\('button'\)/);
  // ปุ่มที่ครอบภาพย่อไว้เองไม่ใช่ปุ่มลบ (มันคือปุ่มเปิดดูภาพ)
  assert.match(fn, /!b\.contains\(thumb\)/);
});

test('ยังมีเพดานกันลูปไม่รู้จบ', () => {
  const fn = src.slice(src.indexOf('async function clearAttachments()'), src.indexOf('return { cleared: started - left, left };'));
  assert.match(fn, /round < started \+ 3/);
  assert.match(fn, /if \(now >= left\) break;/);
});
