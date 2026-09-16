/**
 * ปกที่วาดเสร็จแล้ว ต้องถูกแนบไปเป็นตัวอ้างอิงของภาพที่เหลือในเล่ม
 *
 * ท่าที่ผู้ใช้ทำมือแล้วได้ผลคือแนบปกไปกับคำสั่งทุกใบ ภาพทั้งเล่มจึงมาจากโลกเดียวกัน
 * เดิมระบบแนบรูปได้ชนิดเดียวคือรูปผู้เขียน และแนบให้เฉพาะปกกับภาพประกอบ
 * ลายพื้นหลังจึงไม่มีทางได้รูปแนบเลยไม่ว่าตั้งค่าอย่างไร
 *
 * ความเสี่ยงของการแนบปกคือได้ภาพที่เป็นปกซ้ำ ซึ่งเคยเกิดมาแล้วตอนที่ปกอยู่ในห้องแชตเดียวกัน
 * คำกำกับหน้าที่ของรูปจึงเป็นส่วนหนึ่งของการแก้ ไม่ใช่ของแถม
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsAuthorRef } from './imageRef.js';

test('ลายพื้นหลังไม่เคยเข้าเงื่อนไขรูปผู้เขียน ไม่ว่าตั้งค่าอย่างไร', () => {
  const book = { authorRefTargets: ['cover-front', 'cover-back', 'figures'] };
  assert.equal(wantsAuthorRef(book, { kind: 'pattern', name: 'pattern.png' }), false);
  assert.equal(wantsAuthorRef(book, { kind: 'interior', name: 'fig-1.png' }), true);
  assert.equal(wantsAuthorRef(book, { kind: 'cover', name: 'cover-front.png' }), true);
});

/**
 * กฎการตัดสินใจอยู่ในลูปสร้างภาพ เทสต์นี้จึงยึดกฎเดียวกันไว้เป็นสัญญา
 * ถ้ามีคนแก้กฎในลูป ต้องมาแก้ตรงนี้ด้วย และจะได้เห็นว่ากำลังเปลี่ยนอะไร
 */
const wantsCoverRef = (hasAuthorRef, kind, name) => !hasAuthorRef && name !== 'cover-front.png' && (kind === 'pattern' || kind === 'interior' || kind === 'cover');

test('ปกถูกแนบให้ลายพื้นหลังและภาพประกอบ แต่ไม่แนบให้ตัวปกเอง', () => {
  assert.equal(wantsCoverRef(false, 'pattern', 'pattern.png'), true);
  assert.equal(wantsCoverRef(false, 'interior', 'fig-1.png'), true);
  assert.equal(wantsCoverRef(false, 'cover', 'cover-back.png'), true, 'ปกหลังอ้างอิงปกหน้าได้');
  assert.equal(wantsCoverRef(false, 'cover', 'cover-front.png'), false, 'ปกหน้าอ้างอิงตัวเองไม่ได้');
});

/**
 * สองรูปในข้อความเดียวทำให้โมเดลสับสนว่าหน้าไหนคือหน้าที่ต้องรักษา
 * ซึ่งเป็นความเสียหายที่ผู้ใช้เห็นก็ต่อเมื่อเปิดเล่มที่ส่งออกแล้ว
 */
test('รูปผู้เขียนมาก่อนเสมอ ไม่แนบสองรูปพร้อมกัน', () => {
  assert.equal(wantsCoverRef(true, 'interior', 'fig-1.png'), false);
  assert.equal(wantsCoverRef(true, 'pattern', 'pattern.png'), false);
});
