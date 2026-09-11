/**
 * "ไหนว่ากดแบบ auto จะไม่ต้องมาทำขั้นตอนนี้"
 *
 * ธง fullAutoRunning เป็นค่าของหน้า Studio ซึ่งถูกปลดทุกครั้งที่งานสะดุด
 * เล่มที่สั่งอัตโนมัติไว้แล้วสะดุดสักครั้งระหว่างทาง (ซึ่งเกิดเป็นปกติ)
 * จึงมานอนรอคนที่ประตูตรวจต้นฉบับเงียบ ๆ ทั้งที่ผู้ใช้เดินออกไปจากจอแล้ว
 *
 * runMachine() ติดธงกลับให้ตอนเริ่มรอบอยู่แล้ว แต่ประตูอยู่กลางรอบ ธงจึงหลุดได้อีกหลังจากนั้น
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
const gate = studio.slice(studio.indexOf('async function openEditor()'), studio.indexOf('const cmpId ='));

test('ประตูตรวจต้นฉบับถามเจตนาของเล่มซ้ำ ไม่ใช่เชื่อธงของหน้าอย่างเดียว', () => {
  const restore = gate.indexOf("if (!fullAutoRunning && unattended && book?.automation?.mode === 'full')");
  const pass = gate.indexOf('if (autoPilot()) {');
  assert.ok(restore > 0, 'ต้องมีการติดธงกลับที่ประตู');
  assert.ok(restore < pass, 'ต้องติดธงกลับก่อนถามว่าจะผ่านประตูไหม');
});

/**
 * กติกาเดิมต้องอยู่ครบ: ใครสั่งหยุดไปแล้วต้องหยุดจริง
 * ธง unattended ปลดได้ด้วยคนกดหยุด หรือผู้คุมสั่งเลิกกดต่อให้เองเท่านั้น
 */
test('เล่มที่ถูกสั่งหยุด ยังต้องหยุดจริง', () => {
  assert.match(gate, /!fullAutoRunning && unattended && book\?\.automation\?\.mode === 'full'/);
  assert.ok(!/book\?\.automation\?\.mode === 'full'\s*\)\s*\{\s*fullAutoRunning = true;\s*\}\s*$/.test(gate.trim()),
    'ห้ามติดธงกลับโดยไม่ดู unattended');
});

/**
 * ถ้ายังต้องรอคนจริง ๆ ต้องบอกให้ได้ว่าทำไม
 * ไม่งั้นผู้ใช้กลับมาเจอหน้าจอที่ดูเหมือนงานพัง แล้วไม่มีอะไรอธิบายสักบรรทัด
 */
test('ประตูที่รอคน ต้องบอกเหตุผลที่รอ แยกตามสาเหตุจริง', () => {
  assert.match(gate, /'ประตูนี้รอคุณอยู่'/);
  // สั่งอัตโนมัติไว้ แต่ธงหลุด
  assert.match(gate, /ธงอัตโนมัติหลุดระหว่างทาง/);
  // สั่งอัตโนมัติไว้ แต่มีคนหรือผู้คุมสั่งหยุด
  assert.match(gate, /มีการสั่งหยุดระหว่างทาง/);
  // ไม่ได้สั่งอัตโนมัติมาตั้งแต่ต้น
  assert.match(gate, /เล่มนี้สร้างแบบมีคนดูแล/);
});

/**
 * ประตูภาพเป็นบานถัดไป และหลุดด้วยเหตุเดียวกันเป๊ะ
 * ผู้ใช้กดอัตโนมัติครั้งเดียว แต่ถูกถามสองบานเพราะธงหลุดระหว่างทาง
 */
const imgGate = studio.slice(studio.indexOf('async function openImagePhaseGate'), studio.indexOf('async function startPhase2()'));

test('ประตูภาพถามเจตนาของเล่มซ้ำ ก่อนตัดสินว่าจะรอคนไหม', () => {
  const restore = imgGate.indexOf("if (!fullAutoRunning && unattended && book?.automation?.mode === 'full')");
  const decide = imgGate.indexOf('if (autoPilot() && plannedImageJobs(book)');
  assert.ok(restore > 0, 'ต้องมีการติดธงกลับที่ประตูภาพ');
  assert.ok(restore < decide, 'ต้องติดธงกลับก่อนตัดสินใจ');
});

test('ประตูภาพที่รอคน ต้องบอกเหตุผลที่รอเหมือนกัน', () => {
  assert.match(imgGate, /'ประตูภาพรอคุณอยู่'/);
  assert.match(imgGate, /ธงอัตโนมัติหลุดระหว่างทาง/);
  assert.match(imgGate, /เล่มนี้สร้างแบบมีคนดูแล/);
});

/**
 * ข้อยกเว้นที่ต้องอยู่ต่อ: ภาพที่ตั้งให้คนอัปโหลดเอง
 * ประตูนั้นรอไฟล์จากมือคน ไม่มีท่าไหนที่เครื่องกดแล้วเดินต่อได้
 */
test('ภาพที่รอไฟล์จากมือคน ยังต้องหยุดรอจริง', () => {
  assert.match(imgGate, /j\.manual && !assetNames\.includes\(j\.name\)/);
  assert.match(imgGate, /อัตโนมัติหยุดที่ประตูภาพ/);
});
