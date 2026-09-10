/**
 * ชั้นหนังสือ — ปกคือสิ่งที่คนจำเล่มได้ ไม่ใช่ชื่อไฟล์หรือวันที่
 *
 * รายการแบบบรรทัดต่อบรรทัดบังคับให้ไล่อ่านทีละแถวเพื่อหาเล่มที่ต้องการ
 * ส่วนชั้นที่วางปกจริงให้สายตาเจอได้ในครั้งเดียว
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const js = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./studio.css', import.meta.url), 'utf8');
const html = await readFile(new URL('./studio.html', import.meta.url), 'utf8');

test('ชั้นวางปกจริงของเล่ม ไม่ใช่รูปสำรองทั่วไป', () => {
  assert.match(js, /db\.loadAsset\(id, 'cover-front\.png'\)/);
  assert.match(js, /URL\.createObjectURL\(a\.blob\)/);
  // สัดส่วนต้องเท่ากับหน้ากระดาษจริง ปกบนชั้นจึงเป็นรูปเดียวกับที่จะพิมพ์
  assert.match(css, /\.shelfBook \.cover\{[^}]*aspect-ratio:148\/210/);
});

test('เล่มที่ยังไม่มีไฟล์ปก ต้องแสดง "หน้าปกใน" ซึ่งเป็นของที่เล่มนั้นมีอยู่จริง', () => {
  assert.match(js, /const titlePageArt = \(r\) =>/);
  assert.match(js, /<div class="titlepage">/);
  // ต้องมีทั้งชื่อเรื่องและชื่อผู้เขียน เหมือนหน้าปกในจริง
  assert.match(js, /r\.author \? `<div class="a">\$\{esc\(r\.author\)\}<\/div>` : ''/);
  assert.match(css, /\.titlepage\{/);
  // ต้องเป็นกระดาษจริง ไม่ใช่แผ่นไล่สีที่เราแต่งขึ้นเอง
  assert.match(css, /\.titlepage\{[^}]*background:#f7f4ec/);
  // ชื่อผู้เขียนต้องถูกส่งมาจากทั้งสองแหล่งข้อมูล
  assert.equal((js.match(/author: (b\?\.author|shared\.author) \|\| ''/g) || []).length, 2);
});

/**
 * ป้ายสถานะที่ลอยทับปกไปบังชื่อหนังสือ ซึ่งเป็นสิ่งที่ต้องอ่านออกก่อนอย่างอื่น
 * ชั้นหนังสือมีไว้ให้เห็นปก ไม่ใช่ให้เห็นป้ายของเรา
 */
test('ไม่มีอะไรลอยทับปก — สถานะอยู่ใต้ปก', () => {
  assert.ok(!js.includes('<div class="flag">'), 'ป้ายที่ทับปกต้องถูกถอดออก');
  assert.ok(!css.includes('.shelfBook .chip'), 'สไตล์ของป้ายที่ทับปกต้องไม่เหลือค้าง');
  assert.match(js, /<i class="dot \$\{st\.cls\}"><\/i>\$\{esc\(st\.text\)\}/);
  assert.match(css, /\.shelfBook \.dot\{/);
  // สีต้องยังบอกสถานะได้เหมือนเดิม
  assert.match(css, /\.shelfBook \.dot\.done\{/);
  assert.match(css, /\.shelfBook \.dot\.busy\{/);
});

test('ปุ่มลบอยู่บนการ์ด และคลิกแล้วต้องไม่กลายเป็นคลิกเปิดเล่ม', () => {
  assert.match(js, /<button class="del" data-drop=/);
  assert.match(js, /ev\.stopPropagation\(\)/);
  assert.match(js, /deleteSavedProject\(el\.dataset\.drop\)/);
  // ปุ่มซ้อนในปุ่มไม่ได้ — การ์ดต้องเป็นกล่อง แล้วมีปุ่มเลือกกับปุ่มลบแยกกัน
  assert.match(js, /<div class="shelfBook\$\{/);
  assert.match(js, /<button class="pick" data-book=/);
  assert.match(css, /\.shelfBook \.del\{/);
  // จอสัมผัสไม่มี hover ปุ่มต้องโผล่ให้เห็น
  assert.match(css, /@media \(hover:none\)\{\.shelfBook \.del\{opacity:1\}\}/);
});

test('ObjectURL ต้องถูกคืนก่อนวาดใหม่ ไม่งั้นหน่วยความจำรั่วทุกครั้งที่รีเฟรช', () => {
  assert.match(js, /function releaseShelfUrls\(\)/);
  assert.match(js, /URL\.revokeObjectURL\(u\)/);
  const render = js.slice(js.indexOf('async function renderShelf('), js.indexOf('/** รายละเอียดของเล่มที่คลิก'));
  assert.ok(render.indexOf('releaseShelfUrls()') < render.indexOf('coverUrlFor'), 'ต้องคืนก่อนสร้างชุดใหม่');
});

test('คลิกเล่ม = เปิดรายละเอียด พร้อมปุ่มที่ทำอะไรกับเล่มนั้นได้จริง', () => {
  assert.match(html, /id="projectDetail"/);
  const d = js.slice(js.indexOf('async function openProjectDetail('), js.indexOf('/**\n * แก้ชื่อโครงการที่บันทึกไว้'));
  assert.match(d, /openSavedProject\(id\)/);   // เปิดและแก้ไข
  assert.match(d, /renameSavedProject\(id\)/);
  assert.match(d, /deleteSavedProject\(id\)/);
  assert.match(d, /data-detail-close/);         // ปิดแล้วกลับไปเห็นชั้นเต็ม
});

test('เล่มที่กำลังเปิดอยู่ต้องเห็นได้บนชั้น', () => {
  // ธงอยู่ที่กล่องครอบ ไม่ใช่ที่ปุ่ม เพราะขอบเรืองวาดรอบปกของทั้งการ์ด
  assert.match(js, /el\.closest\('\.shelfBook'\)\?\.classList\.toggle\('sel', el\.dataset\.book === id\)/);
  assert.match(css, /\.shelfBook\.sel \.cover\{/);
});

test('เล่มที่ถูกลบไปแล้ว ต้องไม่ค้างเป็นรายละเอียดที่เปิดอยู่', () => {
  assert.match(js, /if \(shelfSelected && rows\.some\(\(r\) => r\.id === shelfSelected\)\) openProjectDetail/);
  assert.match(js, /else \$\('projectDetail'\)\.classList\.add\('hidden'\)/);
});

test('รายการแบบเดิมถูกถอดออก ไม่เหลือโค้ดสองชุดที่ทำงานเดียวกัน', () => {
  assert.ok(!js.includes('projectItem'), 'ยังเหลือตัวเรนเดอร์รายการเดิม');
  assert.ok(!js.includes('data-open-project'), 'ยังเหลือปุ่มของรายการเดิม');
});

/**
 * ชั้นหนังสือคือของประดับ ส่วนการทำเล่มคืองานจริง — ของประดับห้ามล้มงานจริง
 *
 * loadProjectHistory ถูก await อยู่กลางเส้นทางการผลิตหลายจุด (จบ Phase 1 · จบเล่ม ·
 * หลังสร้างภาพ) ถ้าอ่านรายการหรือวาดปกพลาด ความผิดพลาดจะไหลขึ้นไปหยุดงานที่กำลังเดินอยู่
 */
test('อ่านชั้นหนังสือพลาด ต้องไม่ทำให้งานที่กำลังเดินอยู่หยุด', () => {
  const wrap = js.slice(js.indexOf('async function loadProjectHistory() {'), js.indexOf('async function renderProjectHistory() {'));
  assert.match(wrap, /try \{\s*\n\s*return await renderProjectHistory\(\);\s*\n\s*\} catch/);
  assert.match(wrap, /อ่านชั้นหนังสือไม่สำเร็จ/);
  // ต้องไม่โยนต่อ
  assert.ok(!/throw/.test(wrap), 'ห้ามโยนความผิดพลาดขึ้นไป');
});

test('ทุกที่ที่เรียกยังเรียกชื่อเดิม ไม่ต้องไล่แก้ทีละจุด', () => {
  assert.ok((js.split('await loadProjectHistory()').length - 1) >= 6);
});
