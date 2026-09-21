/**
 * "ขอหัวข้อไม่สำเร็จ · ChatGPT ตอบกลับสถานะ empty · กดปุ่มเดิมอีกครั้งเพื่อลองใหม่"
 *
 * ของจริงจากหน้าจอ: กดกี่ครั้งก็ได้ข้อความเดิม เพราะบันไดกู้ทั้งสามขั้นยิงคำสั่งเดิมเป๊ะ ๆ
 * ห้องใหม่กับโหลดแท็บแก้อาการของ "หน้าเว็บ" แต่คำตอบว่างไม่ใช่อาการของหน้าเว็บ
 * มันคือการตัดสินใจของโมเดล (ไปค้นเว็บ หรือคิดเงียบแล้วจบโดยไม่พิมพ์อะไรออกมา)
 * คำสั่งเดิมพามันไปที่การตัดสินใจเดิมทุกรอบ — ต้องเปลี่ยนคำสั่ง ไม่ใช่เปลี่ยนจังหวะ
 *
 * เหตุผลเดียวกับที่โค้ดใช้อยู่แล้วกับกรณี "เหลือแต่หมุดอ้างอิง" แต่ด่านนั้นดักไม่ถึง
 * เพราะ citationGutted('') เป็นเท็จเมื่อคำตอบว่างสนิท
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const send = source.slice(source.indexOf('async function sendTurn('), source.indexOf('async function superviseFailure('));

test('คำตอบว่างต้องทำให้คำสั่งรอบถัดไปเปลี่ยน ไม่ใช่ยิงของเดิมซ้ำ', () => {
  assert.match(send, /if \(res\.status === 'empty' && askText === prompt\)/);
  assert.match(send, /askText = `\$\{prompt\}\\n\\n\$\{NO_CITATION_RULE\}/);
  assert.match(send, /ห้ามค้นเว็บ ห้ามเรียกเครื่องมือใด ๆ ห้ามตอบเป็นป้ายบอกสถานะ/);
});

test('เปลี่ยนคำสั่งได้ครั้งเดียว ไม่ใช่พอกทับทุกรอบจนคำสั่งบวม', () => {
  const guards = send.match(/askText === prompt/g) || [];
  assert.equal(guards.length, 2, 'ทั้งกรณีหมุดอ้างอิงและกรณีคำตอบว่าง ต้องมีด่านกันพอกทับคนละอัน');
});

test('เหตุผลที่โมเดลตอบว่างต้องถูกส่งต่อเข้าไปในคำสั่งรอบใหม่ด้วย', () => {
  // ถ้ารู้ว่าเห็นป้าย "Searching websites" ก็ต้องบอกมันตรง ๆ ว่ารอบที่แล้วมันทำอะไรลงไป
  assert.match(send, /res\.meta\?\.note \? ` \(\$\{res\.meta\.note\}\)` : ''/);
});

test('ต้องบันทึกไว้ว่าทำท่าไหนไป เพื่อให้ตามรอยได้ว่าท่าไหนได้ผลจริง', () => {
  assert.match(send, /symptom: 'empty_answer', move: 'harden_prompt'/);
  assert.match(send, /'ChatGPT ตอบกลับว่าง — สั่งใหม่แบบห้ามใช้เครื่องมือ'/);
});

/**
 * ข้อความบนหน้าจอต้องบอกได้ว่าเกิดอะไรขึ้น ไม่ใช่บอกแค่รหัสสถานะ
 * ตัวอ่านหน้าเว็บรู้อยู่แล้วว่าเห็นอะไร เหตุผลนั้นต้องเดินทางมาถึงตาผู้ใช้
 */
test('หน้าจอต้องบอกเหตุผลที่อ่านแล้วรู้ว่าต้องทำอะไรต่อ', () => {
  const msg = source.slice(source.indexOf('function turnErrorMessage('), source.indexOf('function retryNotice('));
  assert.match(msg, /const note = res\?\.meta\?\.note \? ` — \$\{String\(res\.meta\.note\)\.slice\(0, 160\)\}` : ''/);
  assert.match(msg, /return `ChatGPT ตอบกลับสถานะ \$\{res\?\.status \|\| 'error'\}\$\{why\}\$\{note\}`/);
});

test('empty ยังต้องอยู่ในรายการที่ลองใหม่ได้ ไม่ใช่ล้มทันที', () => {
  assert.match(source, /const RETRYABLE_TURN_STATUS = new Set\(\['error', 'empty', 'no_response'\]\)/);
});
