/**
 * ส่วนต้นเล่ม — ผู้ใช้เปิดหน้าอ่านแล้วเจอบทที่ 1 ทันที ไม่มีปกใน ไม่มีคำนำ ไม่มีสารบัญ
 *
 * ทั้งที่ของพวกนี้อยู่ในเล่มที่พิมพ์ออกมา และผู้ใช้เป็นคนติ๊กสั่งให้มีเอง
 * สาเหตุคือมันถูกเขียนไว้ในตัวเรียงพิมพ์ Typst ที่เดียว หน้าอ่านกับ EPUB จึงไม่รู้จักมันเลย
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { frontMatterPages, forewordText, copyrightLines, tocEntries } from './book-parts.js';

const book = (extra = {}) => ({
  author: 'คลาวด์ สุมาลี',
  language: 'th',
  frontMatter: ['title', 'copyright', 'toc', 'foreword'],
  outline: {
    title: 'ร้านที่ถูกเลือก',
    subtitle: 'เมื่อ AI เลือกซื้อแทนคน',
    chapters: [
      { n: 1, title: 'ยอดขายหายไป 27%', sections: [{ id: '1.1', title: 'เช้าวันจันทร์' }, { id: '1.2', title: 'ตัวเลขที่ไม่ขยับ' }] },
      { n: 2, title: 'ของที่เครื่องมองเห็น', sections: [{ id: '2.1', title: 'สิ่งที่ต้องเขียน' }] },
    ],
  },
  ...extra,
});

test('เล่มที่ติ๊กครบต้องได้ ปกใน ลิขสิทธิ์ คำนำ สารบัญ ตามลำดับของเล่มจริง', () => {
  assert.deepEqual(frontMatterPages(book()).map((p) => p.key), ['title', 'copyright', 'foreword', 'toc']);
});

/** ช่องที่ผู้ใช้ไม่ได้ติ๊ก ต้องไม่โผล่ทั้งในไฟล์ PDF และบนหน้าอ่าน */
test('ช่องที่ไม่ได้ติ๊กต้องไม่มี แต่หน้าปกในมีเสมอเพราะเล่มทุกเล่มมี', () => {
  assert.deepEqual(frontMatterPages(book({ frontMatter: [] })).map((p) => p.key), ['title']);
  assert.deepEqual(frontMatterPages(book({ frontMatter: ['toc'] })).map((p) => p.key), ['title', 'toc']);
});

test('คำนำที่เขียนไว้จริงต้องมาก่อนตัวสำรองเสมอ', () => {
  assert.equal(forewordText(book({ outline: { ...book().outline, foreword: 'คำนำที่เขียนเอง' } })), 'คำนำที่เขียนเอง');
  assert.match(forewordText(book()), /หนังสือเล่มนี้จัดทำขึ้นเพื่อช่วยให้ผู้อ่านเข้าใจ ร้านที่ถูกเลือก/);
});

/** ตัวสำรองเป็นประโยคของหนังสือสารคดี เอาไปใส่ในนิยายแล้วผิดที่ผิดทาง */
test('นิยายที่ไม่มีคำนำจริง ต้องไม่ได้คำนำสำรอง', () => {
  assert.equal(forewordText(book({ contentMode: 'fiction' })), '');
  assert.ok(!frontMatterPages(book({ contentMode: 'fiction' })).some((p) => p.key === 'foreword'));
});

test('หน้าลิขสิทธิ์ต้องมีชื่อเรื่อง ผู้เขียน ปีพิมพ์เป็น พ.ศ. และข้อความสงวนสิทธิ์', () => {
  const lines = copyrightLines(book());
  assert.equal(lines[0], 'ร้านที่ถูกเลือก');
  assert.equal(lines[1], 'คลาวด์ สุมาลี');
  assert.match(lines[2], new RegExp(`พิมพ์ครั้งแรก ${new Date().getFullYear() + 543}`));
  assert.equal(lines[3], 'สงวนลิขสิทธิ์ตามพระราชบัญญัติ');
});

test('สารบัญของสารคดีลงถึงชื่อตอน ส่วนนิยายหยุดที่ชื่อบท', () => {
  const prose = tocEntries(book());
  assert.deepEqual(prose.map((e) => e.depth), [1, 2, 2, 1, 2]);
  assert.equal(prose[0].text, 'บทที่ 1 · ยอดขายหายไป 27%');
  assert.equal(prose[1].text, 'เช้าวันจันทร์');

  const fiction = tocEntries(book({ contentMode: 'fiction' }));
  assert.deepEqual(fiction.map((e) => e.depth), [1, 1]);
  assert.equal(fiction[0].text, 'บทที่ 1 · ยอดขายหายไป 27%');
});

test('เล่มแบบรายชิ้นใช้ธีมเป็นรายการสารบัญ', () => {
  const items = tocEntries({ outline: { themes: [{ n: 1, title: 'ธีมแรก' }, { n: 2, title: 'ธีมสอง' }] } });
  assert.deepEqual(items.map((e) => e.text), ['ธีมแรก', 'ธีมสอง']);
  assert.deepEqual(items.map((e) => e.theme), [1, 2]);
});

/** รายการสารบัญต้องกดแล้วไปถึงบทนั้นจริง จึงต้องชี้ด้วยเลขบท ไม่ใช่เทียบชื่อซึ่งซ้ำกันได้ */
test('รายการสารบัญต้องพาเลขบทและรหัสตอนไปด้วย', () => {
  const [ch1, s11] = tocEntries(book());
  assert.equal(ch1.chapter, 1);
  assert.equal(s11.section, '1.1');
});

test('หน้าอ่านกับ EPUB ต้องประกอบเล่มจากรายการเดียวกัน ไม่ใช่ต่างคนต่างทำ', async () => {
  const reader = await readFile(new URL('../reader/reader.js', import.meta.url), 'utf8');
  const exporter = await readFile(new URL('./export.js', import.meta.url), 'utf8');
  assert.match(reader, /import \{ frontMatterPages \} from '\.\.\/core\/book-parts\.js'/);
  assert.match(exporter, /import \{ frontMatterPages \} from '\.\/book-parts\.js'/);
  assert.match(reader, /for \(const part of frontMatterPages\(book\)\) pages\.push\(/);
  assert.match(exporter, /for \(const part of frontMatterPages\(book\)\) \{/);
});

test('หน้าสารบัญใน EPUB ต้องลิงก์ไปไฟล์บทจริง', async () => {
  const exporter = await readFile(new URL('./export.js', import.meta.url), 'utf8');
  assert.match(exporter, /const href = chapterFile\.get\(String\(e\.chapter \?\? e\.theme\)\)/);
  assert.match(exporter, /`<a href="\$\{href\}">\$\{esc\(e\.text\)\}<\/a>`/);
  // ปกกับปกในไม่ต้องไปโผล่ในสารบัญของ EPUB ซ้ำอีกรอบ
  assert.match(exporter, /inToc: false/);
});
