/**
 * เราฆ่างานวาดภาพของตัวเองที่กำลังเดินอยู่ — บั๊กที่แพงที่สุดในระบบนี้
 *
 * หลักฐานบนจอ: เทิร์นแรก "Worked for 2m 5s" แล้วได้ภาพ
 * เทิร์นถัดมาทุกเทิร์นเป็น "Stopped thinking" — ไม่มีภาพสักใบ แล้ววนสั่งวาดใหม่
 *
 * สองสาเหตุที่ทำงานร่วมกัน:
 *   1) สัญญาณชีพอ่านแค่คำตอบกับจำนวนรูป ระหว่างที่โมเดล "คิด" ยังไม่มีทั้งสองอย่าง
 *      ค่าจึงค้างนิ่งตลอดสองนาทีที่มันกำลังวาดจริง ๆ แล้วถูกตัดสินว่าหน้าเว็บค้าง
 *   2) ตัวปลดค้างถอยไปกดปุ่มหยุดเมื่อไม่เจอวงกลม ซึ่งกลับหัวกับเจตนา —
 *      ปุ่มหยุดที่มองเห็นคือหลักฐานว่ามีงานเดินอยู่ ไม่ใช่หลักฐานว่าค้าง
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

test('สัญญาณชีพต้องเห็นตอนที่โมเดลกำลังคิด ไม่ใช่เห็นแค่ตอนมีคำตอบแล้ว', () => {
  const fn = src.slice(src.indexOf('async function waitForBusyToClear('), src.indexOf('/** หน้าเว็บที่นิ่งสนิทนานเท่านี้'));
  assert.match(fn, /S\.turnContainer/);
  assert.match(fn, /box\?\.textContent/);
  // ยังต้องดูคำตอบกับรูปเหมือนเดิม แค่เพิ่มตัวที่จับ "กำลังคิด" ได้
  assert.match(fn, /lastAssistantTurn\(\)\?\.innerText/);
  assert.match(fn, /\$\$\('img'\)\.length/);
});

test('สัญญาณชีพต้องไม่บังคับคำนวณ layout ใหม่ทุกวินาที', () => {
  const fn = src.slice(src.indexOf('const sig = () => {'), src.indexOf('const t0 = Date.now();'));
  assert.ok(!/box\?\.innerText/.test(fn), 'กล่องสนทนาทั้งก้อนต้องใช้ textContent');
});

test('ตัวปลดค้างห้ามกดปุ่มหยุด — ปุ่มหยุดแปลว่ากำลังทำงานอยู่', () => {
  const fn = src.slice(src.indexOf('function releaseStuckComposer('), src.indexOf('function composerSpinner('));
  assert.match(fn, /if \(stopButtonVisible\(\)\) return false;/);
  assert.ok(!/visibleStopButton\(\)/.test(fn), 'ต้องไม่มีทางถอยไปกดปุ่มหยุดอีก');
  // แตะได้แค่วงกลมในกรอบช่องพิมพ์เท่านั้น
  assert.match(fn, /composerSpinner\(box\)\?\.closest\?\.\('button:not\(\[disabled\]\)'\)/);
});

test('ห้ามกดหยุดทับคำสั่งวาดภาพที่ยังไม่ได้ภาพกลับมา', () => {
  const idle = src.slice(src.indexOf('async function waitUntilIdle('), src.indexOf('async function clearComposer('));
  // เก็บภาพแล้ว = ปลอดภัย เพราะไม่มีอะไรให้เสีย
  assert.match(idle, /if \(capturedImageIsLast\)/);
  assert.match(src, /const CAPTURED_IMAGE_STUCK_SILENCE_MS = \d+;/);
  // ยังไม่ได้ภาพ = ห้ามแตะ ต้องถอยออกมาก่อนถึงบรรทัดที่กดหยุด
  assert.match(idle, /const pendingImage = /);
  // ตัวกันต้องอยู่ก่อนบรรทัดที่กดหยุด ไม่ใช่หลัง
  assert.ok(idle.indexOf('if (pendingImage)') < idle.lastIndexOf('visibleStopButton()?.click()'));
});
