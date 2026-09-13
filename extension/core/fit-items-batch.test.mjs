/**
 * "ค้างที่ขั้นปรับจำนวนหน้า · กดต่อให้แล้ว 3 ครั้งแต่ยังกลับมาค้างที่เดิม"
 *
 * ขั้นปรับจำนวนหน้าของโหมดรายชิ้นเคยส่ง need ดิบ ๆ เข้าไปเป็นจำนวนชิ้นที่ขอในข้อความเดียว
 * need มาจากหน้าที่ยังขาด × ชิ้นต่อหน้า — ขาด 20 หน้าที่ 4 ชิ้นต่อหน้า = ขอ 80 ชิ้นรวดเดียว
 * ขั้นเขียนรู้เพดานนี้ดีและตัด min(itemsPerTurn, ที่เหลือ) ทุกชุด (กลอน 10 · คำคม 20)
 * แต่ขั้นนี้ไม่เคยตัดเลย และแม่แบบยังพิมพ์โครง <<<ITEM>>> ให้ครบทุกชิ้นที่ขอ prompt จึงพองตาม
 *
 * ที่ทำให้มันร้ายคือความแน่นอน: need คำนวณจากค่าเดิมทุกรอบ คำสั่งที่ส่งออกไปจึงเหมือนเดิมเป๊ะ
 * กดทำต่อกี่ครั้งก็ได้ผลเดิม — ไม่ใช่อาการสุ่มที่หายเองได้
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { itemsPerTurn } from './items.js';

const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const fitItems = src.slice(src.indexOf('async fitItems() {'), src.indexOf('async ensureAuthorVoice('));

test('ขอทีละชุดตามเพดานของชนิดงาน ไม่ใช่ขอทั้งก้อนที่ยังขาด', () => {
  assert.match(fitItems, /itemsPerTurn\(this\.book\.itemKind\)/, 'ต้องอ่านเพดานของชนิดงานมาใช้');
  assert.match(fitItems, /Math\.min\(per, need - added\)/, 'จำนวนที่ขอต่อชุดต้องถูกตัดด้วยเพดาน');
  assert.ok(!/count: need\b/.test(fitItems), 'ห้ามส่ง need ดิบ ๆ เป็นจำนวนชิ้นที่ขออีก');
});

test('ทุกชุดต้องบอกรหัสที่ขอไปตรง ๆ ไม่ให้เดาจากลำดับ', () => {
  assert.match(fitItems, /requestedIds: ids/);
  // รหัสของชุดถัดไปต้องมาจากรหัสที่ได้กลับมาจริง ไม่ใช่จากจำนวนที่ขอไป
  assert.match(fitItems, /have = Math\.max\(have, \.\.\.got\.map/);
});

test('ชุดที่ได้กลับมาไม่ครบ ต้องเก็บของที่ได้ไว้ ไม่ใช่ทิ้งทั้งรอบ', () => {
  const save = fitItems.indexOf('await this.saveItem(theme, it)');
  const stop = fitItems.indexOf('if (!got.length) break');
  assert.ok(save > 0 && stop > save, 'ต้องบันทึกชิ้นที่ได้ก่อนตัดสินใจเลิกขอต่อ');
  assert.ok(
    !/got\.length !== ids\.length[\s\S]{0,80}throw new Halt/.test(fitItems),
    'ได้ไม่ครบชุดต้องไม่หยุดทั้งเล่ม — รอบถัดไปวัดหน้าใหม่แล้วขอเพิ่มต่อได้',
  );
  // ไม่ได้เลยสักชิ้นยังต้องหยุดเหมือนเดิม เพราะขอต่อไปก็ได้ผลเดิม
  assert.match(fitItems, /if \(!added\) throw new Halt/);
});

test('มีเพดานจำนวนชุดต่อรอบ จะได้ไม่ยิงทั้งคืนเมื่อได้กลับมาครั้งละนิด', () => {
  assert.match(fitItems, /const maxBatches = Math\.ceil\(need \/ per\) \+ 1;/);
  assert.match(fitItems, /batch < maxBatches && added < need/);
});

/**
 * เพดานที่ใช้ต้องเป็นตัวเดียวกับที่ขั้นเขียนใช้ ไม่ใช่เลขที่ตั้งขึ้นใหม่ตรงนี้
 * ไม่งั้นสองขั้นจะเถียงกันเองว่าอะไรคือ "มากเกินไป"
 */
test('เพดานเป็นตัวเดียวกับขั้นเขียน และเล็กกว่าจำนวนที่เคยขอรวดเดียวมาก', () => {
  assert.equal(itemsPerTurn('poem'), 10);
  assert.equal(itemsPerTurn('quote'), 20);
  const write = src.slice(src.indexOf('async writeItems() {'), src.indexOf('async fitItems() {'));
  assert.ok(write.length > 0);
  assert.match(write, /I\.itemsPerTurn\(this\.book\.itemKind\)/, 'ขั้นเขียนต้องยังใช้เพดานตัวเดิม');
});

/**
 * ด่านกันโหมดอื่นโดนลูกหลง — ขั้นนี้เป็นของโหมดรายชิ้นล้วน ๆ
 * โหมดเรื่องยาวกับโหมดนิยายต้องไม่เดินผ่านบรรทัดพวกนี้เลยสักบรรทัด
 */
test('โหมดอื่นไม่ได้เดินผ่านขั้นนี้', () => {
  const fit = src.slice(src.indexOf('async fit() {'), src.indexOf('async finishFit('));
  assert.ok(fit.length > 0, 'ต้องหาขั้นปรับจำนวนหน้าของโหมดเรื่องยาวเจอ');
  assert.match(fit, /if \(this\.book\.contentMode === 'items'\) return this\.fitItems\(\);/);
  // ทางเดินของโหมดเรื่องยาวยังเป็นการวัดหน้าแล้วแก้ทีละตอนเหมือนเดิม ไม่มีการขอชิ้นเพิ่ม
  assert.ok(!/itemBatchPrompt/.test(fit), 'ขั้นปรับจำนวนหน้าของโหมดเรื่องยาวต้องไม่ไปยุ่งกับรายชิ้น');
});
