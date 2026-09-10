/**
 * "กด Enter แล้วแต่จับข้อความที่ส่งไม่ได้" กลาง Phase 2 — รากของอาการอยู่ตรงนี้
 *
 * คำสั่งภาพทุกใบในเล่มขึ้นต้นเหมือนกันเป๊ะ 120 ตัวแรก
 *   "วาดภาพต่อไปนี้ให้หน่อย ตอบกลับมาเป็นภาพอย่างเดียว …"
 * ตัวหาใบเสร็จเดิมจึงนับทุกใบเป็น "ข้อความเดียวกัน" แล้วตัดสินด้วยการเทียบจำนวน
 * พอบทสนทนายาวขึ้นและ ChatGPT ถอดข้อความเก่าที่พ้นจอออกจาก DOM จำนวนที่นับได้
 * เท่าเดิมหรือลดลง ทั้งที่เพิ่งส่งไปจริง → หยุดทั้งงานกลางคัน ยิ่งลึกยิ่งเจอ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('  function userMessageKey(node)'), src.indexOf('  async function clickSend('));

/** จำลองข้อความผู้ใช้ในหน้า ChatGPT พร้อมลำดับเทิร์นแบบที่หน้าเว็บใช้จริง */
const msg = (text, turn, id = '') => ({
  innerText: text, textContent: text,
  getAttribute: (a) => (a === 'data-message-id' ? id : null),
  closest: (sel) => (sel.startsWith('[data-testid^="conversation-turn"]')
    ? { getAttribute: () => `conversation-turn-${turn}` } : null),
});

function pageWith(nodes) {
  const scope = {
    $$: () => nodes,
    Number, String,
    normalizeMessage: (t) => String(t || '').replace(/\s+/g, ' ').trim(),
  };
  vm.createContext(scope);
  vm.runInContext(block.replace(/^ {2}/gm, ''), scope);
  return scope;
}

const HEAD = 'วาดภาพต่อไปนี้ให้หน่อย ตอบกลับมาเป็นภาพอย่างเดียว ';
const imagePrompt = (n) => HEAD + 'Interior book illustration. clean black line art on white, uniform stroke weight, no shading, generous margins. '.repeat(2) + `ภาพที่ ${n}`;

test('คำสั่งภาพขึ้นต้นเหมือนกันจริง — ตัวนับจึงแยกกันไม่ออก', () => {
  assert.equal(imagePrompt(1).slice(0, 120), imagePrompt(9).slice(0, 120));
});

test('หน้าเว็บถอดข้อความเก่าออก แต่ยังต้องเจอใบเสร็จของข้อความที่เพิ่งส่ง', () => {
  // ก่อนส่ง: เห็นคำสั่งภาพ 3 ใบ (เทิร์น 10, 12, 14)
  const before = pageWith([msg(imagePrompt(1), 10), msg(imagePrompt(2), 12), msg(imagePrompt(3), 14)]);
  const snap = before.snapshotUserMessages();
  assert.equal(snap.maxTurn, 14);

  // หลังส่ง: ข้อความเก่าสองใบถูกถอดออกจาก DOM เหลือ 2 ใบ — น้อยกว่าเดิมด้วยซ้ำ
  const after = pageWith([msg(imagePrompt(3), 14), msg(imagePrompt(4), 16)]);
  const got = after.findUserReceipt(imagePrompt(4), snap);
  assert.ok(got, 'ต้องเจอใบเสร็จ แม้จำนวนข้อความจะลดลง');
  assert.equal(got.innerText, imagePrompt(4));
});

test('ยังไม่ได้ส่งจริง ต้องไม่หลอกตัวเองว่าเจอ', () => {
  const before = pageWith([msg(imagePrompt(1), 10), msg(imagePrompt(2), 12)]);
  const snap = before.snapshotUserMessages();
  // หน้าเว็บเหมือนเดิมทุกอย่าง ไม่มีข้อความใหม่
  const after = pageWith([msg(imagePrompt(1), 10), msg(imagePrompt(2), 12)]);
  assert.equal(after.findUserReceipt(imagePrompt(3), snap), null);
});

test('ข้อความเก่าถูกถอดออกโดยที่เราไม่ได้ส่งอะไร ก็ต้องไม่นับว่าส่งแล้ว', () => {
  const before = pageWith([msg(imagePrompt(1), 10), msg(imagePrompt(2), 12), msg(imagePrompt(3), 14)]);
  const snap = before.snapshotUserMessages();
  const after = pageWith([msg(imagePrompt(3), 14)]); // เหลือใบเดียว ลำดับไม่ได้เพิ่ม
  assert.equal(after.findUserReceipt(imagePrompt(4), snap), null);
});

test('ห้องใหม่เอี่ยม ข้อความแรกของห้องต้องเจอ', () => {
  const before = pageWith([]);
  const snap = before.snapshotUserMessages();
  const after = pageWith([msg(imagePrompt(1), 2)]);
  assert.ok(after.findUserReceipt(imagePrompt(1), snap));
});

test('ทางเดิมที่ใช้ได้อยู่แล้วต้องยังใช้ได้ — ข้อความที่มี id ของตัวเอง', () => {
  const before = pageWith([msg(imagePrompt(1), 10, 'm1')]);
  const snap = before.snapshotUserMessages();
  const after = pageWith([msg(imagePrompt(1), 10, 'm1'), msg(imagePrompt(2), 12, 'm2')]);
  const got = after.findUserReceipt(imagePrompt(2), snap);
  assert.equal(got.innerText, imagePrompt(2));
});
