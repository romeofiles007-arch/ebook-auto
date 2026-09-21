/**
 * หน้าอ่าน — สิ่งที่พังแล้วผู้ใช้เห็นทันทีคือ "โค้ดกำกับโผล่กลางหน้าหนังสือ"
 *
 * เครื่องหมายภาพกับกล่องถูกแทรกลงต้นฉบับตั้งแต่ตอนวางแผน (machine.js)
 * ฝั่ง Typst กับ .docx รู้จักมันแล้ว หน้าอ่านก็ต้องรู้จักด้วย
 * ไม่งั้นผู้ใช้จะเห็น ![](fig:...) กับ ::: ปนอยู่ในเนื้อเล่มเหมือนที่เคยเกิดกับไฟล์เวิร์ด
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mdToHtml, isItemsBook, compareItemId, FIG_RE } from '../core/md-html.js';

const js = await readFile(new URL('./reader.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./reader.css', import.meta.url), 'utf8');
const html = await readFile(new URL('./reader.html', import.meta.url), 'utf8');
const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');

test('เครื่องหมายภาพต้องกลายเป็นที่ว่างของภาพ ไม่ใช่ข้อความดิบ', () => {
  const out = mdToHtml('![รูปที่ 3: แผนภาพกระแสเงิน](fig:fig-1.2-1.png 70% 42mm)');
  assert.match(out, /<figure data-fig="fig-1\.2-1\.png"/);
  assert.match(out, /data-w="70"/);
  // เลข "รูปที่ N" เป็นของฝั่ง PDF ใต้ภาพในหน้าอ่านเหลือแต่คำบรรยายจริง
  assert.match(out, /<figcaption>แผนภาพกระแสเงิน<\/figcaption>/);
  assert.ok(!out.includes('fig:'), 'ห้ามมีเครื่องหมายดิบหลงเหลือ');
  // ต้องจองความสูงไว้ก่อน ไม่งั้นตัวหนังสือกระโดดตอนภาพโหลดเสร็จ
  assert.match(out, /min-height:159px/);
});

test('รูปแบบเครื่องหมายภาพต้องตรงกับที่ Typst อ่าน', async () => {
  const template = await readFile(new URL('../typeset/template.js', import.meta.url), 'utf8');
  assert.ok(template.includes(FIG_RE.source), 'ถ้าสองฝั่งอ่านคนละแบบ ภาพจะหายไปฝั่งใดฝั่งหนึ่งโดยไม่มีใครรู้');
});

test('กล่องสรุปต้องเป็นกล่อง ไม่ใช่ย่อหน้าที่มี ::: ติดมา', () => {
  const out = mdToHtml(':::box สามข้อที่ต้องจำ\n- ข้อหนึ่ง\n- ข้อสอง\n:::');
  assert.match(out, /<div class="box"><b>สามข้อที่ต้องจำ<\/b>/);
  assert.match(out, /<li>ข้อหนึ่ง<\/li><li>ข้อสอง<\/li>/);
  assert.ok(!out.includes(':::'), 'ห้ามมีเครื่องหมายกล่องหลงเหลือ');
});

test('ข้อความของผู้ใช้ต้องถูก escape ก่อนเสมอ', () => {
  assert.match(mdToHtml('ราคา < 100 & ของแถม'), /ราคา &lt; 100 &amp; ของแถม/);
  assert.ok(!mdToHtml('<script>x</script>').includes('<script>'));
});

test('หัวข้อ รายการ และตัวหนา ยังทำงานตามปกติ', () => {
  assert.match(mdToHtml('## หัวข้อย่อย'), /<h2>หัวข้อย่อย<\/h2>/);
  assert.match(mdToHtml('- หนึ่ง\n- สอง'), /<ul><li>หนึ่ง<\/li><li>สอง<\/li><\/ul>/);
  assert.match(mdToHtml('1. หนึ่ง\n2. สอง'), /<ol><li>หนึ่ง<\/li><li>สอง<\/li><\/ol>/);
  assert.match(mdToHtml('คำ**เน้น**นี้'), /<strong>เน้น<\/strong>/);
});

test('เล่มแบบรายชิ้นต้องเรียงตามเลขจริง ไม่ใช่เรียงตามตัวอักษร', () => {
  assert.equal(isItemsBook({ contentMode: 'items' }), true);
  assert.equal(isItemsBook({ outline: { themes: [{ n: 1 }] } }), true);
  assert.equal(isItemsBook({ outline: { chapters: [{ n: 1 }] } }), false);
  assert.deepEqual(['1.10', '1.2', '2.1'].sort(compareItemId), ['1.2', '1.10', '2.1']);
});

/**
 * หน้านี้อ่านอย่างเดียว — เป็นสัญญาหลักของทั้งฟีเจอร์
 * ถ้าวันหนึ่งมีใครเผลอใส่การเขียนลงไป มันจะไปชนกับงานที่ Studio เดินอยู่อีกแท็บ
 */
test('ห้ามเขียนอะไรลงฐานข้อมูลของเล่ม', () => {
  for (const write of ['db.saveBook', 'db.saveSection', 'db.saveAsset', 'db.deleteAsset', 'db.deleteBook', 'db.put(']) {
    assert.ok(!js.includes(write), `หน้าอ่านต้องไม่เรียก ${write}`);
  }
  assert.match(js, /db\.loadBook\(id\)/);
  assert.match(js, /db\.loadSections\(id\)/);
});

test('ต้องล้าง ZWSP ก่อนแสดง ไม่งั้นคัดลอกออกไปแล้วข้อความเพี้ยน', () => {
  assert.match(js, /import \{ stripZwsp \} from '\.\.\/core\/thai\.js'/);
  assert.match(js, /stripZwsp\(stripEchoedHeading\(/);
});

test('ObjectURL ของภาพต้องถูกคืนทุกครั้งที่เปลี่ยนหน้า', () => {
  assert.match(js, /function releaseUrls\(\)/);
  assert.match(js, /async function show\(at, \{ col = 0 \} = \{\}\) \{\s*releaseUrls\(\);/);
  assert.match(js, /window\.addEventListener\('pagehide', releaseUrls\)/);
});

test('ภาพต้องโหลดเฉพาะบทที่กำลังอ่าน ไม่ใช่ทั้งเล่ม', () => {
  assert.match(js, /root\.querySelectorAll\('figure\[data-fig\]'\)/);
  assert.ok(!js.includes('db.loadAssets('), 'ห้ามดึงไฟล์ทั้งเล่มมากองไว้');
});

test('เล่มที่ยังเขียนไม่จบต้องอ่านได้ และบอกตรง ๆ ว่าขาดอะไร', () => {
  assert.match(js, /ยังเขียนไม่จบ/);
  assert.match(js, /บทนี้ยังไม่ได้เขียน/);
});

test('เล่มที่ยังไม่ได้ดึงเข้าเครื่องต้องบอกทางออก ไม่ใช่หน้าว่าง', () => {
  assert.match(js, /ยังไม่มีเล่มนี้ในเครื่อง/);
  assert.match(js, /Shared Workspace/);
});

test('ปกบนหน้าอ่านต้องเป็นปกจริงของเล่ม สัดส่วนเดียวกับหน้ากระดาษ', () => {
  assert.match(js, /db\.loadAsset\(state\.book\.id, 'cover-front\.png'\)/);
  assert.match(css, /\.cover\{[^}]*aspect-ratio:148\/210/);
});

test('ตัวหนังสือไทยต้องใช้ฟอนต์ของเล่ม ไม่ใช่ฟอนต์ระบบ', () => {
  assert.match(css, /@font-face\{font-family:"Sarabun";src:url\("\.\.\/fonts\/Sarabun-Regular\.ttf"\)/);
});

/**
 * แท็บที่เปิดใหม่ไม่มีประวัติ ปุ่ม Back ของเบราว์เซอร์จึงพาไปไหนไม่ได้
 * ถ้าไม่มีทางกลับในหน้า ผู้ใช้จะติดอยู่กับหน้าอ่านจนต้องปิดแท็บเอง
 */
test('ต้องมีทางกลับไปชั้นหนังสือ และต้องกลับไปที่แท็บเดิมถ้ายังเปิดอยู่', () => {
  assert.match(html, /id="back"/);
  assert.match(js, /\$\('back'\)\.onclick = backToShelf/);
  assert.match(js, /chrome\.tabs\.query\(\{ url: studio \}\)/);
  assert.match(js, /chrome\.tabs\.update\(open\.id, \{ active: true \}\)/);
  // เปิด Studio ใหม่เฉพาะตอนที่ไม่มีแท็บเดิมเหลืออยู่จริง ๆ
  assert.match(js, /else await chrome\.tabs\.create\(\{ url: studio \}\)/);
  assert.match(js, /chrome\.tabs\.remove\(me\.id\)/);
});

/**
 * คลิกปกบนชั้นหนังสือพามาหน้าอ่าน ซึ่งถูกแล้วสำหรับคนที่จะอ่าน
 * แต่คนที่เปิดมาเพื่อจะแก้ต้องมีทางเดินต่อจากตรงนี้ ไม่ใช่ติดอยู่จนต้องย้อนไปหาการ์ดแล้วกดให้ถูกจุด
 */
test('ต้องแก้ไขเล่มนี้ต่อได้จากหน้าอ่าน', () => {
  assert.match(html, /id="editBtn"/);
  assert.match(js, /\$\('editBtn'\)\.onclick = editInStudio/);
  assert.match(js, /command: 'openProject', bookId: state\.book\.id/);
  // ส่งไม่ถึงต้องบอกทางออก ไม่ใช่ปิดแท็บตัวเองทิ้งแล้วเงียบ
  assert.match(js, /if \(!sent\?\.ok\) \{/);
  assert.match(js, /เปิดใน Studio ไม่สำเร็จ/);
});

test('Studio กับ service worker ต้องรับคำสั่งเปิดเล่มนี้จริง', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /if \(msg\.command === 'openProject' && msg\.bookId\)/);
  // หน้า Studio ที่เปิดค้างอยู่อ่าน pendingUiCommand ไม่ได้อีก จึงต้องกระจายก่อนแล้วค่อยฝาก
  assert.match(sw, /const live = await chrome\.runtime\.sendMessage\(\{ \.\.\.msg, _relayed: true \}\)/);
  assert.match(sw, /if \(!live\?\.ok\) await S\.set\('pendingUiCommand', msg\)/);
  assert.match(studio, /m\.command === 'openProject' && m\.bookId/);
  assert.match(studio, /openSavedProject\(m\.bookId\)\.catch\(fail\)/);
});

test('จอแคบ เลือกบทแล้วสารบัญต้องปิดเอง', () => {
  assert.match(js, /function closeTocOnNarrow\(\)/);
  assert.match(js, /matchMedia\('\(max-width:900px\)'\)\.matches/);
  assert.match(js, /closeTocOnNarrow\(\);\s*\n\s*show\(Number\(el\.dataset\.at\)\)/);
});

/**
 * บันทึกแล้วต้องรู้ว่าไฟล์ไปอยู่ไหน — คำว่า "สำเร็จ" เฉย ๆ ไม่ช่วยให้หาไฟล์เจอ
 * และต้องเป็น PDF ท่อเดียวกับ Studio ไม่ใช่ภาพพิมพ์จากหน้าจอซึ่งได้คนละเล่ม
 */
test('บันทึก PDF ด้วยท่อเดียวกับ Studio แล้วบอกตำแหน่งที่เก็บ', () => {
  assert.match(html, /id="savePdf"/);
  assert.match(html, /id="saveEpub"/);
  assert.match(js, /X\.exportBookPdf\(book, sections\)/);
  assert.match(js, /X\.exportEpub\(book, sections\)/);
  assert.match(js, /W\.restoreDirectoryHandle\(\)/);
  assert.match(js, /X\.setExportDirectoryHandle\(dir\)/);
  // ต้องบอกทั้งสองกรณี: โฟลเดอร์ที่เลือกไว้ กับโฟลเดอร์ดาวน์โหลด
  assert.match(js, /โฟลเดอร์ที่เลือกไว้ใน Studio/);
  assert.match(js, /โฟลเดอร์ดาวน์โหลดของเบราว์เซอร์/);
  // โหลดตอนกดเท่านั้น คนที่เข้ามาอ่านเฉย ๆ ไม่ต้องจ่ายค่าโหลด wasm ของ Typst
  assert.ok(!/^import .*export\.js/m.test(js), 'ห้าม import ท่อส่งออกตั้งแต่เปิดหน้า');
  assert.match(js, /await Promise\.all\(\[import\('\.\.\/core\/export\.js'\), import\('\.\.\/core\/workspace\.js'\)\]\)/);
  // ล้มแล้วต้องบอกสาเหตุ ไม่ใช่เงียบ แล้วปุ่มต้องกลับมากดได้
  assert.match(js, /บันทึกไม่สำเร็จ/);
  assert.match(js, /finally \{\s*btn\.disabled = false/);
});

/**
 * โหมดแบ่งหน้า — อ่านแบบพลิกทีละหน้าเหมือนเครื่องอ่าน e-book
 * ทำด้วย CSS multicolumn ล้วน เพราะ CSP ของส่วนขยายห้ามโหลดไลบรารีอ่าน EPUB จากข้างนอก
 */
test('โหมดแบ่งหน้าต้องนับหน้าใหม่ทุกครั้งที่ขนาดเปลี่ยน', () => {
  assert.match(html, /id="modeBtn"/);
  assert.match(html, /<div id="viewport" class="viewport">/);
  assert.match(js, /function layoutPaged\(\)/);
  assert.match(js, /p\.style\.columnWidth = `\$\{w\}px`/);
  assert.match(js, /state\.cols = Math\.max\(1, Math\.round\(p\.scrollWidth \/ \(w \+ COL_GAP\)\)\)/);
  // ปรับขนาดตัวอักษร เปลี่ยนบท ย่อขยายหน้าต่าง และภาพโหลดเสร็จ — ต้องนับใหม่ทั้งสี่กรณี
  assert.match(js, /\$\('modeBtn'\)\.textContent = prefs\.paged \? 'เลื่อนยาว' : 'แบ่งหน้า';\s*\n\s*layoutPaged\(\)/);
  assert.match(js, /setTimeout\(layoutPaged, 150\)/);
  assert.match(js, /ภาพเพิ่งมาถึง ความสูงจริงเปลี่ยน จำนวนหน้าจึงต้องนับใหม่/);
  assert.match(css, /\.viewport\.paged\{[^}]*overflow:hidden/);
  // หัวข้อ ภาพ และกล่อง ห้ามถูกผ่าครึ่งคาหน้า
  assert.match(css, /break-inside:avoid/);
});

test('ปุ่มเลื่อนต้องไล่หน้าให้หมดบทก่อนข้ามบท และถอยกลับต้องไปหน้าสุดท้ายของบทก่อน', () => {
  assert.match(js, /function step\(dir\)/);
  assert.match(js, /show\(state\.at \+ dir, \{ col: dir < 0 \? 'last' : 0 \}\)/);
  assert.match(js, /\$\('prev'\)\.onclick = \(\) => step\(-1\)/);
  assert.match(js, /\$\('next'\)\.onclick = \(\) => step\(1\)/);
});

/**
 * "1 / 7" อ่านได้เป็น "เล่มนี้มี 7 หน้า" ทั้งที่เป็นจำนวนหัวข้อในสารบัญ
 * เล่มจริงเกือบร้อยหน้า ตัวเลขที่ไม่บอกว่านับอะไรจึงทำให้เข้าใจผิดว่าเนื้อหาหาย
 */
test('ตัวเลขตำแหน่งต้องบอกว่านับอะไรอยู่', () => {
  assert.match(js, /const where = `หัวข้อ \$\{state\.at \+ 1\} \/ \$\{state\.pages\.length\}`/);
  assert.match(js, /หน้า \$\{state\.col \+ 1\}\/\$\{state\.cols\} ในหัวข้อนี้/);
});

/**
 * พลิกหน้า — สำเนาของหน้าเดิมหมุนออกรอบสันหนังสือ ส่วนของจริงเปลี่ยนไปหน้าใหม่อยู่ข้างใต้
 * ทำด้วย Web Animations API ของเบราว์เซอร์ ไม่ได้พึ่งไลบรารีข้างนอกซึ่ง CSP ห้ามอยู่แล้ว
 */
test('พลิกหน้าต้องถ่ายสำเนาหน้าเดิมก่อนเปลี่ยนของจริง', () => {
  assert.match(js, /const copy = p\.cloneNode\(true\)/);
  assert.match(js, /clip\.className = `flipClip \$\{dir > 0 \? 'fwd' : 'back'\}`/);
  assert.match(js, /rotateY\(\$\{dir > 0 \? -118 : 118\}deg\)/);
  assert.match(js, /await apply\(\);/);
  // ต้องเก็บกวาดเสมอ แม้ระหว่างทางจะพัง ไม่งั้นสำเนาค้างทับจอถาวร
  assert.match(js, /finally \{\s*clip\.remove\(\);\s*state\.flipping = false;/);
  assert.match(css, /\.flipClip\{position:absolute/);
  assert.match(css, /\.viewport\.paged\{[^}]*perspective:2000px/);
});

test('คนที่ปิดภาพเคลื่อนไหวไว้ในเครื่องต้องได้หน้าใหม่ทันที ไม่ใช่ภาพหมุนช้า ๆ', () => {
  assert.match(js, /const reduceMotion = \(\) => window\.matchMedia\('\(prefers-reduced-motion:reduce\)'\)\.matches/);
  assert.match(js, /if \(!prefs\.paged \|\| reduceMotion\(\) \|\| typeof p\.animate !== 'function'\) return apply\(\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.flipClip\{display:none\}\}/);
});

test('ภาพในหน้าที่กำลังหมุนต้องไม่กลายเป็นรูปเสียกลางทาง', () => {
  assert.match(js, /if \(!state\.flipping\) return urls\.forEach\(\(u\) => URL\.revokeObjectURL\(u\)\)/);
  assert.match(js, /setTimeout\(\(\) => urls\.forEach\(\(u\) => URL\.revokeObjectURL\(u\)\), FLIP_MS \+ 120\)/);
});

test('ปุ่มบนหน้าต้องมีครบตามที่สคริปต์ไปผูก', () => {
  for (const id of ['toc', 'page', 'viewport', 'prev', 'next', 'pos', 'barTitle', 'barSub', 'tocToggle', 'sizeUp', 'sizeDown', 'themeBtn', 'modeBtn', 'back', 'editBtn', 'savePdf', 'saveEpub', 'saveNote']) {
    assert.ok(html.includes(`id="${id}"`), `reader.html ต้องมี #${id}`);
  }
  assert.match(html, /<script type="module" src="reader\.js"><\/script>/);
});

/**
 * ทางเข้าจาก Studio — ต้องเปิดแท็บใหม่ ไม่ใช่ทับหน้าที่งานกำลังเดินอยู่
 * และต้องไม่ไปแตะคลิกการ์ดบนชั้นหนังสือ ซึ่งเป็นทางเข้างานของเล่มที่ยังทำไม่เสร็จ
 */
test('Studio ส่งคนมาอ่านได้ โดยไม่แย่งคลิกเดิมของชั้นหนังสือ', () => {
  assert.match(studio, /<button data-detail-read>อ่าน<\/button>/);
  assert.match(studio, /chrome\.runtime\.getURL\(`reader\/reader\.html\?book=\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(studio, /chrome\.tabs\.create\(/);
  // คลิกการ์ดต้องยังเปิดแผงรายละเอียดเหมือนเดิม
  assert.match(studio, /el\.onclick = \(\) => openProjectDetail\(el\.dataset\.book, rows\)/);
});
