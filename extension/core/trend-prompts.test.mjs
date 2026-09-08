import test from 'node:test';
import assert from 'node:assert/strict';
import { trendIdeasPrompt, titleIdeasPrompt } from './prompts.js';

/**
 * โหมดดูกระแสถูกลดเหลือคำถามเดียว: ขอ 10 หัวข้อ แล้วเอาไปตั้งชื่อ
 * ห้ามให้กติกาหนัก ๆ (บังคับ URL จริง ห้ามตอบถ้าค้นเว็บไม่ได้) กลับเข้ามาอีก
 * เพราะนั่นคือสิ่งที่ทำให้ขั้นนี้ช้าและล้มบ่อยจนใช้งานจริงไม่ได้
 */
test('ขั้นดูกระแสขอ 10 หัวข้อ ไม่ขอลิงก์ และไม่มีด่านให้ล้ม', () => {
  const p = trendIdeasPrompt({ seed: 'การเงิน', today: '2026-09-08' });
  assert.match(p, /เสนอ 10 หัวข้อ/);
  assert.match(p, /"topics"/);
  assert.match(p, /ไม่ต้องแนบลิงก์/);
  assert.match(p, /การเงิน/);
  // ค้นเว็บได้ก็ดี ไม่ได้ก็ตอบจากที่รู้ — ห้ามมีทางออกที่ทำให้ทั้งขั้นล้ม
  assert.doesNotMatch(p, /"verified":false/);
  assert.doesNotMatch(p, /ห้ามเดา slug/);
  assert.doesNotMatch(p, /"sources"/);
});

test('หัวข้อที่เลือกถูกส่งต่อไปให้ตัวตั้งชื่อ', () => {
  const p = titleIdeasPrompt({
    topic: '',
    trendSeed: { trend: 'ราคาทองคำผันผวน', why_now: 'ขึ้นแรงสัปดาห์นี้' },
    today: '2026-09-08',
  });
  assert.match(p, /ราคาทองคำผันผวน/);
  assert.match(p, /ขึ้นแรงสัปดาห์นี้/);
  // trendSeed ไม่มีแหล่งข้อมูลแล้ว prompt ต้องไม่ทิ้งช่องว่างที่เขียนว่า "แหล่งตั้งต้น: -"
  assert.doesNotMatch(p, /แหล่งตั้งต้น/);
});
