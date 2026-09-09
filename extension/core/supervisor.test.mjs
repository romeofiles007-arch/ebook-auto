import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisorPrompt, parseSupervisorDecision, repairPrompt, SUPERVISOR_ACTIONS } from './supervisor.js';

/**
 * ผู้คุมกระบวนการต้องถูกล็อกไว้สองชั้น: เลือกได้เฉพาะท่าที่ระบบมีจริง
 * และห้ามแตะงานเขียน เพราะเนื้อหาทุกตัวอักษรต้องมาจากหน้าเว็บเท่านั้น
 */

test('คำสั่งบอกชัดว่าไม่ใช่คนเขียน และให้เลือกจากรายการที่มีเท่านั้น', () => {
  const p = supervisorPrompt({ step: 'consistency', status: 'paused', attempts: 2, lastError: 'อ่าน JSON ไม่ได้' });
  assert.match(p, /ห้ามเขียนหรือแก้เนื้อหาหนังสือ/);
  assert.match(p, /ห้ามคิดท่าใหม่/);
  for (const action of Object.keys(SUPERVISOR_ACTIONS)) assert.match(p, new RegExp(action));
});

test('สถานะที่ส่งไปต้องเล็ก และไม่มีเนื้อหาหนังสือติดไปด้วย', () => {
  const p = supervisorPrompt({
    step: 'write',
    status: 'paused',
    log: Array.from({ length: 60 }, (_, i) => `บรรทัดที่ ${i}`),
  });
  // ส่งบันทึกไปแค่ยี่สิบบรรทัดล่าสุด ทุก token มีราคา
  assert.equal(p.includes('บรรทัดที่ 39'), false);
  assert.match(p, /บรรทัดที่ 59/);
});

test('รับเฉพาะท่าที่อยู่ในรายการ ของนอกรายการถือว่าใช้ไม่ได้', () => {
  assert.deepEqual(parseSupervisorDecision('{"action":"new_thread","reason":"ห้องเดิมส่งไม่ออก"}'), {
    action: 'new_thread',
    reason: 'ห้องเดิมส่งไม่ออก',
  });
  // ท่าที่คิดขึ้นเอง ต้องไม่ผ่าน ไม่ใช่เอาไปตีความต่อ
  assert.equal(parseSupervisorDecision('{"action":"rewrite_chapter","reason":"เขียนใหม่ให้เลย"}'), null);
  assert.equal(parseSupervisorDecision('ลองใหม่ดูนะครับ'), null);
  assert.equal(parseSupervisorDecision(''), null);
});

test('คำตัดสินที่ห่ออยู่ในข้อความอื่นก็ยังอ่านได้', () => {
  const got = parseSupervisorDecision('สรุปแล้ว\n```json\n{"action":"stop","reason":"ซ้ำที่เดิมสามครั้ง"}\n```');
  assert.equal(got.action, 'stop');
});

test('คำสั่งซ่อมรูปแบบย้ำว่าห้ามแต่งข้อมูลเพิ่ม', () => {
  const p = repairPrompt('{"section_verdicts": [', ['section_verdicts']);
  assert.match(p, /ห้ามเพิ่มข้อมูลใหม่/);
  assert.match(p, /section_verdicts/);
});

/**
 * เส้นแบ่งที่สำคัญที่สุดของผู้คุม: ท่าที่ "ลองใหม่ได้" ใช้ได้เฉพาะตอนที่คำสั่งยังไม่เคยออกจากเครื่องเรา
 * ถ้าอาจส่งไปแล้ว (outcome_unknown) การลองซ้ำคือการสร้างงานซ้อนและเผาโควตา
 */
test('คำสั่งบอกกติกาการเลือกท่าให้ตรงกับความเสี่ยงจริง', () => {
  const p = supervisorPrompt({ step: 'write', status: 'error', lastError: 'ส่งไม่ออก' });
  assert.match(p, /repair_json[\s\S]*ไม่ต้องสั่งเว็บใหม่ให้เปลืองโควตา/);
  assert.match(p, /ห้องแชตเสีย[\s\S]*new_thread/);
  assert.match(p, /ลองมามากแล้วอาการเดิมซ้ำ[\s\S]*stop/);
  assert.match(p, /skip_step[\s\S]*ห้ามใช้กับขั้นที่ผลิตเนื้อหา/);
});
