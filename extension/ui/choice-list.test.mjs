import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * ขอสิบ ได้หนึ่ง แล้วบอกว่าสำเร็จ — คือรายการที่เลือกไม่ได้จริง
 *
 * ตัวกู้ JSON ที่ถูกตัดกลางคันทำให้คำตอบที่ขาดตั้งแต่รายการที่สองยังผ่านได้
 * เกณฑ์เดิม "มีอย่างน้อยหนึ่ง" จึงปล่อยให้หน้าจอขึ้นตัวเลือกเดียวโดยไม่มีใครรู้ว่ามันขาด
 */
const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('const MIN_TITLE_CHOICES');
const end = source.indexOf('\n}', source.indexOf('function parseTrendAnswer')) + 2;
const block = source.slice(start, end);

function parsers(payload) {
  const scope = {
    parseJson: () => payload,
    answerEvidence: () => '(หลักฐานคำตอบ)',
  };
  vm.createContext(scope);
  vm.runInContext(`${block}\nglobalThis.titles = parseTitleAnswer;\nglobalThis.topics = parseTrendAnswer;`, scope);
  return scope;
}

const topicRows = (n) => ({ topics: Array.from({ length: n }, (_, i) => ({ topic: `หัวข้อ ${i + 1}`, why: 'เพราะ' })) });
const titleRows = (n) => ({ titles: Array.from({ length: n }, (_, i) => ({ title: `ชื่อ ${i + 1}` })) });

test('หัวข้อมาชุดเดียวจากที่ขอสิบ = ยังไม่ผ่าน ต้องลองใหม่', () => {
  const out = parsers(topicRows(1)).topics({ text: '{}' });
  assert.equal(out.data, undefined);
  assert.match(out.error, /ได้หัวข้อมา 1 รายการ/);
  assert.match(out.error, /ถูกตัดกลางคัน/);
});

test('แต่ของที่ได้มาแล้วต้องไม่ถูกทิ้ง — ส่งกลับไปเป็น partial', () => {
  const out = parsers(topicRows(2)).topics({ text: '{}' });
  assert.equal(out.partial.length, 2);
  assert.equal(out.partial[0].trend, 'หัวข้อ 1');
});

test('ครบตามขั้นต่ำ = ผ่านตามปกติ', () => {
  const out = parsers(topicRows(10)).topics({ text: '{}' });
  assert.equal(out.error, undefined);
  assert.equal(out.data.length, 10);
});

test('ไม่มีรายการเลย = ยังเป็นความล้มเหลวแบบเดิม ไม่มี partial ให้ใช้', () => {
  const out = parsers({ topics: [] }).topics({ text: 'ข้อความที่ไม่ใช่ JSON' });
  assert.match(out.error, /ไม่พบรายการหัวข้อ/);
  assert.equal(out.partial, undefined);
});

test('ชื่อหนังสือใช้เกณฑ์เดียวกัน', () => {
  const p = parsers(titleRows(2));
  const short = p.titles({ text: '{}' });
  assert.match(short.error, /ได้ชื่อหนังสือมา 2 รายการ/);
  assert.equal(short.partial.length, 2);

  const full = parsers(titleRows(8)).titles({ text: '{}' });
  assert.equal(full.error, undefined);
  assert.equal(full.data.length, 8);
});

test('sendTurn เก็บชุดที่ยาวที่สุดไว้ แล้วคืนให้เมื่อลองจนครบ', () => {
  const send = source.slice(source.indexOf('async function sendTurn'), source.indexOf('async function superviseFailure'));
  assert.match(send, /out\.partial\.length > \(bestPartial\?\.length \|\| 0\)/);
  // ทั้งทางที่ไม่มีผู้คุม และทางที่ผู้คุมกู้แล้วยังไม่ครบ ต้องได้ของที่มีขึ้นจอ
  assert.match(send, /if \(!decided\) return bestPartial \?/);
  assert.match(send, /return \{ \.\.\.decided, data: rescued, error: null, short:/);
});

test('หน้าจอบอกตรง ๆ ว่าได้ไม่ครบ ไม่ใช่ทำเหมือนปกติ', () => {
  const render = source.slice(source.indexOf('function renderTopicChoices'), source.indexOf('async function generateTrendIdeas'));
  assert.match(render, /function renderTopicChoices\(short = ''\)/);
  assert.match(render, /กด “สุ่มใหม่” เพื่อขอชุดเต็มอีกครั้ง/);
  assert.match(source, /renderTopicChoices\(res\.short\)/);
});
