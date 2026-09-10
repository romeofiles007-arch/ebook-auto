/**
 * ทุกเล่มที่ทำมาไม่มีลวดลายพื้นหลังเลย — วัดจากไฟล์ PDF จริงที่ส่งออก
 *
 *   ลายถูกฝังอยู่จริง 1748×2480 px (A5 ที่ 300dpi พอดี)
 *   ทึบแสงเต็มที่ (soft mask = 255 ทุกพิกเซล)
 *   อยู่ชั้นล่างสุด — ลำดับในหน้าคือ /x0 Do ก่อน แล้วค่อย BT วาดตัวหนังสือ
 *   แต่สีเข้มที่สุดในลายคือ 248 จาก 255 — ต่างจากขาว 2.7% ตาไม่เห็น
 *
 * เหตุคือคูณสองต่อ: ต้นฉบับจาก ChatGPT เข้มสุดราว 205 อยู่แล้ว แล้วเราคูณ 0.14 ทับอีก
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf("if (job.kind === 'pattern') {"), src.indexOf('if (job.grayscale) {'));

/** สูตรเดียวกับในโค้ด ใช้ตรวจว่าตัวเลขความเข้มมีความหมายจริง */
const gainFor = (floor) => Math.min(10, 255 / Math.max(8, 255 - floor));
const ink = (v, floor, alpha) => Math.max(0, Math.round(255 - (255 - v) * gainFor(floor) * alpha));

test('ต้นฉบับจาง ๆ ต้องยังเห็นได้ ไม่ใช่หายไปเป็นขาว', () => {
  // ตัวเลขจริงจาก PDF ของผู้ใช้: เข้มสุด 205 · ความเข้มที่ตั้งไว้ 14%
  const before = Math.round(255 + (205 - 255) * 0.14); // สูตรเดิม
  assert.equal(before, 248, 'สูตรเดิมให้ 248 — ต่างจากขาว 2.7%');
  const after = ink(205, 205, 0.14);
  assert.equal(after, 219, 'สูตรใหม่ให้ 219 — เห็นได้บนกระดาษ');
});

test('ตัวเลขความเข้มต้องเรียงตามลำดับจริง อ่อน < กลาง < เข้ม', () => {
  const soft = ink(205, 205, 0.08);
  const medium = ink(205, 205, 0.14);
  const strong = ink(205, 205, 0.2);
  assert.ok(strong < medium && medium < soft, `${soft} · ${medium} · ${strong}`);
  // และต้องไม่เข้มจนแย่งสายตากับตัวหนังสือ
  assert.ok(strong > 190, 'เข้มสุดยังต้องอ่อนกว่าตัวหนังสือมาก');
});

test('ภาพที่ขาวสนิทอยู่แล้ว ต้องไม่ถูกขยายจนกลายเป็นรอยด่าง', () => {
  assert.equal(gainFor(255), 10, 'เพดานการขยายคุมไว้ที่ 10 เท่า ไม่ใช่ 255/8');
  assert.ok(gainFor(255) <= 10, 'มีเพดานการขยาย');
  assert.equal(ink(255, 255, 0.14), 255, 'ขาวสนิทยังขาวสนิท');
});

test('ใช้เปอร์เซ็นไทล์ ไม่ใช่ค่าต่ำสุด — จุดดำหลงมาจุดเดียวต้องไม่ล้มการยืดทั้งภาพ', () => {
  assert.match(block, /const hist = new Uint32Array\(256\)/);
  assert.match(block, /seen >= total \* 0\.002/);
});

test('ลายยังทึบแสงเต็มที่ และยังเป็นขั้นตอนของลายอย่างเดียว', () => {
  assert.match(block, /d\.data\[i \+ 3\] = 255;/);
  assert.match(src, /if \(job\.kind === 'pattern'\) \{/);
  // ห้ามไปแตะภาพชนิดอื่น
  assert.ok(!block.includes('coverTextBaked'));
});

/**
 * ลายที่จางจนตาไม่เห็น = ไฟล์ที่ใช้ไม่ได้ ไม่ใช่ไฟล์ที่ผ่าน
 *
 * ด่านตรวจเคยดูแค่ "เปิดได้ไหม" กับ "ขนาดตรงช่องไหม" ลายที่ขาวสนิททั้งใบจึงผ่านฉลุย
 * แล้วไปโผล่ในเล่มจริงเป็นหน้ากระดาษเปล่า — และไม่มีใครรู้จนกว่าจะเปิด PDF ดู
 */
test('ด่านตรวจต้องปฏิเสธลายที่มองไม่เห็น', () => {
  const v = src.slice(src.indexOf('async function validatePhase2Asset('), src.indexOf('async function validateGeneratedSource('));
  assert.match(v, /if \(job\?\.kind === 'pattern'\)/);
  assert.match(v, /ink\.visible < 0\.001/);
  assert.match(v, /ลายจางจนมองไม่เห็น/);
  // ต้องบอกตัวเลขจริงออกมาด้วย จะได้รู้ว่าจางแค่ไหน ไม่ใช่แค่บอกว่าไม่ผ่าน
  assert.match(v, /\$\{ink\.darkest\} จาก 255/);
});

test('วัดหมึกจากพิกเซลจริง ไม่ใช่เดาจากขนาดไฟล์', () => {
  const f = src.slice(src.indexOf('async function patternInk('), src.indexOf('async function validatePhase2Asset('));
  assert.match(f, /0\.299 \* d\[i\]/);      // ระดับเทาตามการรับรู้ของตา
  assert.match(f, /if \(g < 245\) seen\+\+/); // เข้มพอที่ตาจะจับได้บนกระดาษ
  assert.match(f, /new OffscreenCanvas\(w, h\)/);
});

/**
 * ผลพลอยได้ที่สำคัญกว่า: เล่มเก่าที่มีลายจาง ๆ ค้างอยู่ จะถูกทิ้งแล้วสร้างใหม่ให้เอง
 * เพราะด่านนี้เป็นตัวเดียวกับที่ใช้ตรวจ "ไฟล์เดิมยังใช้ได้ไหม" ตอนเริ่มขั้นสร้างภาพ
 */
test('ไฟล์เดิมที่ไม่ผ่านด่าน ต้องถูกลบแล้วสร้างใหม่', () => {
  const loop = src.slice(src.indexOf('const checked = await validatePhase2Asset(existing, j);'), src.indexOf('let lastError = \'\';'));
  assert.match(loop, /await db\.deleteAsset\(this\.book\.id, j\.name\)/);
  assert.match(loop, /ไฟล์เดิมไม่ผ่านตรวจ/);
});
