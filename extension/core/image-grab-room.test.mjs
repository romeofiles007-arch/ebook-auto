/**
 * ภาพวาดเสร็จอยู่บนจอ แต่ถูกปฏิเสธว่า "image_turn_not_available" แล้ววนสั่งวาดใหม่
 *
 * ต้นเหตุ: หลักฐานของเทิร์นภาพถูกจดตอนส่ง ซึ่งเกิดก่อนที่ ChatGPT จะเขียน URL ทับ
 * จาก chatgpt.com/ เป็น chatgpt.com/c/<id> การเทียบ URL ตรงตัวจึงพลาดทุกครั้ง
 * ที่เป็นภาพแรกของห้องใหม่ — และตั้งแต่แยกห้องตามกลุ่มงาน (ปก/ลาย/ภาพประกอบ)
 * ก็มีห้องใหม่ถึงสามห้องต่อเล่ม แทนที่จะมีห้องเดียว
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const src = await readFile(new URL('../adapter/chatgpt.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('  const conversationId = (href)'), src.indexOf('  // จำเฉพาะเทิร์นภาพที่ดึง bytes สำเร็จแล้ว'));

function at(href) {
  const scope = { location: new URL(href), URL };
  scope.location = { origin: new URL(href).origin, href };
  vm.createContext(scope);
  vm.runInContext(block.replace(/^ {2}/gm, ''), scope);
  return scope.sameConversation;
}

test('ห้องใหม่ที่เพิ่งได้ชื่อ ยังเป็นห้องเดิม', () => {
  const same = at('https://chatgpt.com/c/abc123');
  assert.equal(same('https://chatgpt.com/'), true);
  assert.equal(same('https://chatgpt.com/?model=gpt-5'), true);
  assert.equal(same('https://chatgpt.com/c/abc123'), true);
});

test('ย้ายไปห้องที่มีชื่อคนละชื่อ ต้องไม่ยอมรับ', () => {
  const same = at('https://chatgpt.com/c/def456');
  assert.equal(same('https://chatgpt.com/c/abc123'), false);
});

test('คนละเว็บ ต้องไม่ยอมรับ', () => {
  const same = at('https://chatgpt.com/c/abc123');
  assert.equal(same('https://example.com/c/abc123'), false);
  assert.equal(same(''), false);
});

test('ตัวคว้าภาพยังยึด anchor เป็นหลักฐานจริง ไม่ได้ปล่อยผ่านทั้งหมด', () => {
  const grab = src.slice(src.indexOf("if (msg?.type === 'gpt.grabImage')"), src.indexOf("if (msg?.type === 'gpt.run')"));
  assert.match(grab, /!sameConversation\(source\.url\)/);
  assert.match(grab, /!source\.anchor\.isConnected/);
});
