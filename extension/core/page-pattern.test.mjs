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

/**
 * หน้าบรรณานุกรมต้องอ่านเป็นรายการอ้างอิง ไม่ใช่เนื้อหาอีกบทหนึ่ง
 *
 * หัวข้อเคยพิมพ์ชื่อรูปแบบอ้างอิงต่อท้ายว่า "บรรณานุกรม (IEEE)"
 * ซึ่งเป็นข้อมูลของคนทำเล่ม ไม่ใช่ของคนอ่าน — ค่า referenceStyle ยังใช้จัดรูปแบบตัวรายการตามเดิม
 */
test('หัวข้อบรรณานุกรมไม่บอกชื่อรูปแบบอ้างอิง และตัวอักษรเล็กลง', async () => {
  const template = await readFile(new URL('../typeset/template.js', import.meta.url), 'utf8');
  const back = template.slice(template.indexOf("if (has('references')) {"), template.indexOf("const bio = String(book.aboutAuthor"));
  assert.match(back, /const title = 'บรรณานุกรม';/);
  assert.ok(!/บรรณานุกรม \(\$\{REFERENCE_STYLES/.test(back), 'ต้องไม่มีวงเล็บบอกสไตล์แล้ว');
  // ย่อด้วยหน่วย em เพื่อให้เล็กลงตามขนาดตัวอักษรของเล่มนั้น ไม่ใช่ตัวเลขตายตัว
  assert.match(back, /#set text\(size: 0\.82em\)/);
  // ต้องครอบไว้ ไม่งั้นขนาดจะรั่วไปถึงหน้าเกี่ยวกับผู้เขียนที่ต่อท้ายกัน
  assert.match(back, /#block\(breakable: true\)\[/);

  const refs = await readFile(new URL('./references.js', import.meta.url), 'utf8');
  assert.match(refs, /sections\.push\(\{ title: 'บรรณานุกรม', lines \}\)/);
});

/**
 * ชื่อตอนโผล่สองบรรทัดติดกัน — ตัวหนึ่งจากตัวเรียงพิมพ์ อีกตัวจากในเนื้อหาเอง
 *
 * เห็นจริงบนหน้ากระดาษ:
 *   ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก
 *   1.3 ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก
 * ต่างกันแค่ขนาดกับเลขตอน ซึ่งอ่านแล้วเหมือนเล่มทำมาไม่เรียบร้อย
 */
test('หัวข้อที่ทวนชื่อตอนของตัวเองถูกตัดออกก่อนเรียงพิมพ์', async () => {
  const { stripEchoedHeading } = await import('./extract.js');
  const s = { id: '1.3', title: 'ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก' };

  // ทวนพร้อมเลขตอน (เส้นทางที่มาจาก DOCX) และทวนเปล่า ๆ
  assert.equal(stripEchoedHeading('### 1.3 ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก\n\nเนื้อหา', s), 'เนื้อหา');
  assert.equal(stripEchoedHeading('# ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก\nเนื้อหา', s), 'เนื้อหา');
  // บรรทัดตัวหนาล้วนก็ทำหน้าที่เป็นหัวข้อในสายตาผู้อ่านเหมือนกัน
  assert.equal(stripEchoedHeading('**ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก**\n\nเนื้อหา', s), 'เนื้อหา');

  // หัวข้อย่อยที่คนเขียนตั้งใจใส่ ห้ามแตะ
  const keep = '### หัวข้อย่อยที่ตั้งใจใส่\n\nเนื้อหา';
  assert.equal(stripEchoedHeading(keep, s), keep);
  assert.equal(stripEchoedHeading('เนื้อหาเริ่มเลย', s), 'เนื้อหาเริ่มเลย');
  // ตัดแค่หัวข้อแรกสุด หัวข้อกลางตอนที่บังเอิญชื่อซ้ำต้องอยู่ต่อ
  assert.match(stripEchoedHeading('# ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก\n\nก\n\n## ขั้นที่ 2 ทำฐานให้เท่ากันก่อนบอกว่าอันไหนถูก', s), /^ก\n/);
});

test('ทั้ง PDF และ DOCX ใช้ตัวตัดหัวข้อซ้ำตัวเดียวกัน', async () => {
  const template = await readFile(new URL('../typeset/template.js', import.meta.url), 'utf8');
  const docx = await readFile(new URL('./docx.js', import.meta.url), 'utf8');
  assert.match(template, /stripEchoedHeading\(rec\?\.md, s\)/);
  assert.match(docx, /stripEchoedHeading\(byId\.get\(s\.id\)\?\.md \|\| '', s\)/);
});

/**
 * การอ้างในเนื้อหาต้องสั้น — DOI กับ URL อยู่ในหน้าบรรณานุกรมแล้ว
 * เคยได้ของแบบนี้คากลางย่อหน้า: (Haws & Bearden, 2006, DOI: 10.1086/508435; …)
 */
test('บอกรูปแบบการอ้างในเนื้อหาตามสไตล์ที่เล่มนั้นเลือก และห้าม DOI', async () => {
  const { referenceContext } = await import('./references.js');
  const mk = (referenceStyle) =>
    referenceContext({ backMatter: ['references'], referenceStyle, referenceSources: [{ title: 'T', year: 2006, doi: '10.1086/508435' }] });

  assert.match(mk('apa'), /เขียนสั้นแบบนี้เท่านั้น \(Atkins & Gershell, 2002\)/);
  assert.match(mk('ieee'), /เขียนสั้นแบบนี้เท่านั้น \[1\]/);
  assert.match(mk('apa'), /ห้ามใส่ DOI, URL, ชื่อวารสาร, เลขหน้า/);
  // doi ยังต้องส่งไปให้โมเดลรู้ว่าแหล่งไหนคือแหล่งไหน แค่ห้ามพิมพ์ลงเนื้อหา
  assert.match(mk('apa'), /10\.1086\/508435/);
});
