/**
 * "new chat เร็วเกิน ภาพยังไม่เสร็จเลย" — ห้องที่ยังหมุนอยู่ถูกทิ้งพร้อมภาพในห้อง
 *
 * รอบใหม่ทุกรอบเริ่มด้วยการเปิดห้องแชตใหม่ ซึ่งถูกต้องในแง่ของการกันงานแก้ภาพเดิม
 * แต่จังหวะที่เปิดคือจังหวะที่โมเดลสายคิดก่อนตอบยังวาดไม่เสร็จ
 * เห็นกับตา: รายการแชตมีห้อง "วาดภาพ..." เรียงกันหลายห้อง ห้องหนึ่งยังหมุนค้างอยู่
 * แล้วไม่มีภาพจากห้องเหล่านั้นถูกเก็บเลยสักใบ ทั้งที่จ่ายโควตาไปครบทุกรอบ
 *
 * ด่านนี้จึงต้องยืนรอในห้องเดิมแล้วไล่คว้าเป็นระยะ ก่อนจะยอมให้รอบถัดไปทิ้งห้อง
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');

test('รอในห้องเดิมหนึ่งนาที และไล่คว้าเป็นระยะ ไม่ใช่คว้าครั้งเดียวแล้วรอเฉย ๆ', () => {
  assert.match(machine, /const LATE_IMAGE_GRACE_MS = 60000;/);
  assert.match(machine, /const LATE_IMAGE_GAP_MS = 5000;/);
  const grab = machine.slice(machine.indexOf('async grabRenderedImage('), machine.indexOf('async turn(prompt'));
  assert.match(grab, /await sleep\(gapMs\);/, 'ต้องหน่วงระหว่างรอบคว้า ไม่งั้นวนจนหมดโควตารอบในเสี้ยววินาที');
});

test('ยังไม่ได้ภาพ = คว้าซ้ำก่อน แล้วค่อยขึ้นรอบใหม่ (ซึ่งเปิดห้องใหม่)', () => {
  const lateGate = machine.indexOf('if (!url && !res.imageDataUrl && !useApi && !this.stopRequested) {');
  const giveUp = machine.indexOf("if (!url && !res.imageDataUrl) {\n          /**");
  assert.ok(lateGate > 0, 'ต้องมีด่านคว้าซ้ำก่อนยอมแพ้');
  assert.ok(giveUp > lateGate, 'ด่านคว้าซ้ำต้องมาก่อนการสรุปว่ารอบนี้ไม่ได้ภาพ');

  const gate = machine.slice(lateGate, giveUp);
  assert.match(gate, /tries: Math\.max\(1, Math\.round\(LATE_IMAGE_GRACE_MS \/ LATE_IMAGE_GAP_MS\)\)/);
  assert.match(gate, /gapMs: LATE_IMAGE_GAP_MS/);
  assert.match(gate, /res\.imageDataUrl = late\.dataUrl;/, 'คว้าได้แล้วต้องใช้เลย ไม่ใช่คว้ามาแล้วทิ้ง');
});

/**
 * เทิร์นที่ล้มแบบ "ยืนยันผลไม่ได้" ก็เดินไปเปิดห้องใหม่เหมือนกัน
 * ทางนั้นต้องได้เวลารอเท่ากัน ไม่งั้นแก้ได้ทางเดียวแล้วอีกทางยังทิ้งภาพเหมือนเดิม
 */
test('ทางที่เทิร์นล้มกลางคัน ได้เวลารอเท่ากันก่อนทิ้งห้อง', () => {
  const rescue = machine.slice(machine.indexOf('const rescued = await this.grabRenderedImage'));
  assert.match(rescue.slice(0, 300), /LATE_IMAGE_GRACE_MS \/ LATE_IMAGE_GAP_MS/);
  assert.match(rescue.slice(0, 300), /gapMs: LATE_IMAGE_GAP_MS/);
});

/**
 * "ยังเป็นอยู่เลย ทำไมถึงรีบจัง" — ห้องชื่อเดียวกันโผล่ซ้อนกันสองห้อง
 *
 * คว้าภาพได้แล้วไม่ได้แปลว่าห้องนั้นทำงานเสร็จ หน้าเว็บยังปิดท้ายเทิร์นอยู่
 * (ตั้งชื่อห้อง · เขียน URL · คืนช่องพิมพ์) แล้วเราเด้งไปเปิดห้องใหม่ทับพอดี
 */
test('เก็บภาพได้แล้วต้องพักก่อนเปิดห้องใหม่ของรูปถัดไป', () => {
  assert.match(machine, /const POST_IMAGE_SETTLE_MS = 30000;/);
  const settle = machine.indexOf('if (!useApi && index + 1 < jobs.length && !this.stopRequested) {');
  assert.ok(settle > 0, 'ต้องมีจังหวะพักหลังเก็บภาพสำเร็จ');
  const block = machine.slice(settle, settle + 900);
  assert.match(block, /await sleep\(POST_IMAGE_SETTLE_MS\);/);
  // ต้องอยู่หลังบันทึกไฟล์สำเร็จ ไม่ใช่หน่วงทุกเส้นทางจนงานอืดไปทั้งกระดาน
  const saveOk = machine.lastIndexOf('saved = true;', settle);
  assert.ok(saveOk > 0 && saveOk < settle, 'จังหวะพักต้องอยู่ในเส้นทางที่เก็บภาพสำเร็จแล้วเท่านั้น');
});

test('รูปสุดท้ายไม่ต้องพัก เพราะไม่มีห้องใหม่ตามมา', () => {
  const settle = machine.indexOf('if (!useApi && index + 1 < jobs.length && !this.stopRequested) {');
  assert.ok(settle > 0);
  // โหมด API ไม่มีห้องแชตให้ปิด และผู้ใช้กดหยุดแล้วต้องหยุดจริง ไม่ใช่ค้างอีกครึ่งนาที
  assert.match(machine.slice(settle, settle + 120), /!useApi && index \+ 1 < jobs\.length && !this\.stopRequested/);
});
