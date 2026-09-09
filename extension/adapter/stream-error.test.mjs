import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * กล่องแดง "Error in message stream" คือคำตอบว่าเทิร์นนี้จบแล้วและล้มแล้ว
 *
 * ถ้าไม่จับ เทิร์นจะรอจนหมดเพดานแล้วจบเป็น outcome_unknown ซึ่งเป็นรหัสที่สั่งหยุดทั้งเล่ม
 * โดยไม่ผ่านผู้คุมกระบวนการ — CEO จึงไม่มีวันถูกปลุกในเคสนี้เลย
 */
const source = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('const STREAM_ERROR');
const end = source.indexOf('\n  }', source.indexOf('function streamErrorAfter')) + 4;
const block = source.slice(start, end);

const FOLLOWING = 4;

function box(text, { after = true, visible = true, sel = '[role="alert"]' } = {}) {
  return {
    sel,
    innerText: text,
    offsetParent: visible ? {} : null,
    after,
  };
}

function run(boxes, { anchored = true } = {}) {
  const anchor = anchored
    ? { compareDocumentPosition: (el) => (el.after ? FOLLOWING : 0) }
    : null;
  const scope = {
    // ตัวจริงส่ง selector รวมของกล่องพังเข้ามาก้อนเดียว ที่นี่จึงคืนทุกกล่องที่ตั้งไว้ในเคส
    // แล้วให้ตัวกรองในฟังก์ชัน (มองเห็น · อยู่หลัง anchor · สั้น · ตรงวลี) เป็นตัวตัดสินเอง
    $$: () => boxes,
    getComputedStyle: () => ({ position: 'static' }),
    Node: { DOCUMENT_POSITION_FOLLOWING: FOLLOWING },
  };
  vm.createContext(scope);
  vm.runInContext(`${block}\nglobalThis.find = streamErrorAfter;`, scope);
  return scope.find(anchor);
}

test('กล่องแดงหลังข้อความที่เราเพิ่งส่ง ถือว่าเทิร์นนี้ล้ม', () => {
  const hit = box('Error in message stream');
  assert.equal(run([hit]), hit);
});

test('Something went wrong ก็นับ เพราะเป็นกล่องพังของ ChatGPT เหมือนกัน', () => {
  const hit = box('Something went wrong.', { sel: '[class*="error" i]' });
  assert.equal(run([hit]), hit);
});

test('แผลเก่าที่อยู่ก่อนข้อความของเรา ไม่ฆ่าเทิร์นใหม่', () => {
  assert.equal(run([box('Error in message stream', { after: false })]), null);
});

test('เนื้อหายาวที่บังเอิญมีคำว่า error ไม่ถูกนับเป็นกล่องพัง', () => {
  const prose = box(`บทที่ 3 ว่าด้วย error ในระบบงาน ${'ก'.repeat(400)}`);
  assert.equal(run([prose]), null);
});

test('กล่องที่ซ่อนอยู่ไม่นับ', () => {
  assert.equal(run([box('Error in message stream', { visible: false })]), null);
});

test('ไม่มีกล่องพัง = ไม่มีอะไรเกิดขึ้น', () => {
  assert.equal(run([box('คำตอบปกติ')]), null);
});

test('ทั้งเทิร์นข้อความและเทิร์นภาพเรียกตัวจับนี้', () => {
  assert.match(source, /if \(streamErrorAfter\(anchor\)\) \{[\s\S]{0,200}return finish\('error'\)/);
  assert.match(source, /const errorAfterAnchor = \(\)[\s\S]{0,240}\|\| !!streamErrorAfter\(anchor\)/);
});
