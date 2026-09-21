/**
 * EPUB — ไฟล์ที่ส่งให้คนอื่นเปิดอ่าน จึงต้องเป็น "เล่มเดียวกับที่พิมพ์" ไม่ใช่แค่ต้นฉบับ
 *
 * ของเดิมมีแต่ตัวหนังสือ: ภาพในเล่มกับปกไม่เคยถูกแพ็กเข้าไฟล์เลย
 * และตัวแปลง markdown ของ EPUB ไม่รู้จักเครื่องหมาย ![](fig:...) กับ :::box
 * ผลคือโค้ดกำกับถูกพิมพ์ดิบ ๆ กลางหน้าหนังสือ เหมือนที่เคยเกิดกับไฟล์ .docx มาก่อน
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mdToHtml } from './md-html.js';

const src = await readFile(new URL('./export.js', import.meta.url), 'utf8');

test('EPUB ต้องใช้ตัวแปลงตัวเดียวกับหน้าอ่าน ไม่ใช่ตัวแปลงของตัวเอง', () => {
  assert.match(src, /import \{ mdToHtml \} from '\.\/md-html\.js'/);
  // ตัวแปลงเก่าที่ไม่รู้จักเครื่องหมายภาพต้องไม่เหลือค้างไว้ให้ใครเผลอเรียก
  assert.ok(!/^function mdToHtml\(/m.test(src), 'ตัวแปลงซ้ำในไฟล์นี้ต้องถูกถอดออก');
  assert.ok(!/^function inlineHtml\(/m.test(src), 'ตัวแปลง inline ซ้ำต้องถูกถอดออก');
});

test('ภาพในเล่มกับปกต้องถูกแพ็กเข้าไฟล์ .epub จริง', () => {
  assert.match(src, /files\.set\(`OEBPS\/img\/\$\{a\.name\}`, new Uint8Array\(await a\.blob\.arrayBuffer\(\)\)\)/);
  assert.match(src, /a\.name\?\.startsWith\('fig-'\) \|\| a\.name === 'cover-front\.png'/);
  // manifest ต้องประกาศไฟล์ภาพทุกไฟล์ ไม่งั้นโปรแกรมอ่านจะไม่ยอมแสดง
  assert.match(src, /<item id="img\$\{i\}" href="img\/\$\{a\.name\}" media-type="\$\{epubMedia\(a\.name\)\}"/);
  assert.match(src, /properties="cover-image"/);
});

test('ปกต้องเป็นหน้าแรกของเล่ม และต้องไม่ไปโผล่ซ้ำในสารบัญ', () => {
  assert.match(src, /chapters\.unshift\(\{\s*\n\s*file: 'cover\.xhtml'/);
  assert.match(src, /inToc: false/);
  assert.match(src, /\.filter\(\(c\) => c\.inToc !== false\)/);
});

/**
 * XHTML เข้มกว่า HTML: แท็กเดี่ยวที่ไม่ปิดตัวเองทำให้โปรแกรมอ่านบางตัวไม่ยอมเปิดไฟล์เลย
 * ไม่ใช่แค่แสดงเพี้ยน แต่คือเปิดไม่ได้ทั้งเล่ม
 */
test('EPUB ต้องได้ XHTML ที่แท็กเดี่ยวปิดตัวเอง', () => {
  const out = mdToHtml('บรรทัดแรก\nบรรทัดสอง', { xhtml: true });
  assert.match(out, /<br\/>/);
  assert.ok(!/<br>/.test(out));
  // หน้าอ่านบนจอเป็น HTML ปกติ ไม่ต้องปิดตัวเอง
  assert.match(mdToHtml('บรรทัดแรก\nบรรทัดสอง'), /<br>/);
});

test('ฝั่ง EPUB วาดภาพเป็นไฟล์จริง ส่วนหน้าอ่านจองที่ว่างไว้ก่อน', () => {
  const md = '![รูปที่ 2: ผังเงินเข้าออก](fig:fig-1.1-1.png 60% 40mm)';
  const epub = mdToHtml(md, {
    xhtml: true,
    figure: ({ name, caption, widthPct }) => `<figure><img src="img/${name}" alt="${caption}" style="width:${widthPct}%"/></figure>`,
  });
  assert.match(epub, /<img src="img\/fig-1\.1-1\.png" alt="ผังเงินเข้าออก" style="width:60%"\/>/);
  assert.ok(!epub.includes('data-fig'), 'ฝั่ง EPUB ต้องไม่ได้ที่ว่างแบบหน้าอ่าน');
  assert.match(mdToHtml(md), /<figure data-fig="fig-1\.1-1\.png"/);
});

test('ภาพที่ยังไม่มีไฟล์ต้องไม่กลายเป็นกรอบว่างหรือเครื่องหมายดิบ', () => {
  assert.match(src, /if \(!have\.has\(name\)\) return caption \? `<p class="figmiss">\[ภาพ: \$\{esc\(caption\)\}\]<\/p>` : ''/);
});

test('หัวข้อที่ต้นฉบับพิมพ์ซ้ำมาเองต้องถูกตัด ไม่ใช่โผล่สองครั้งติดกัน', () => {
  assert.match(src, /const text = md\(stripEchoedHeading\(rec\?\.md \|\| '', s\)\)/);
  assert.match(src, /import \{ stripEchoedHeading \} from '\.\/extract\.js'/);
});
