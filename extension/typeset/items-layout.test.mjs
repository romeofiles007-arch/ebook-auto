/**
 * จัดหน้าโหมดรายชิ้นแบบหนังสือรวมบทกวีจริง
 *
 * เล่มจริงที่ส่งออกมา ("ความรักและลมหนาว" 209 หน้า): ตัวอักษร 20-26pt จัดกลางทีละบรรทัด
 * กลอนหักกลางวรรค ไหลไปทับเลขหน้า และมีหน้าสารบัญเปล่า ๆ เพราะเล่มหมวดเดียวไม่มีหัวข้อ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildItemsDocument, buildDocument } from './template.js';
import * as I from '../core/items.js';
globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
const { Machine } = await import('../core/machine.js');

const baseBook = (over = {}) => ({
  id: 'b', contentMode: 'items', itemKind: 'poem', itemsPerPage: 1, language: 'th',
  trim: { widthMm: 148, heightMm: 210 }, frontMatter: ['title', 'toc'],
  typography: { bodyFont: 'Sarabun', sizePt: 15, lineHeight: 1.7, marginsMm: { inner: 18, outer: 14, top: 16, bottom: 18 } },
  ...over,
});
const poem = 'ก่อนลมหนาวเปิดใจให้ใครมา\nลองดูตารางว่าเราพร้อมไหม\n\nความพร้อมรักไม่ใช่แค่ใจเต้น\nยังต้องเห็นเวลาว่าแบ่งไหว';
const items = (n, theme = 1) => Array.from({ length: n }, (_, i) => ({ id: `${theme}.${i + 1}`, kind: 'item', text: poem, md: poem }));

test('book-sized type: old poster sizes are capped, empty setting uses the literary size', () => {
  assert.equal(I.itemTypeSize(baseBook({ itemSizePt: null })), 12);
  assert.ok(I.itemTypeSize(baseBook({ itemSizePt: 26 })) <= 13.2, 'a saved 26pt must not come back');
  assert.equal(I.itemTypeSize(baseBook({ itemSizePt: 10.5 })), 10.5, 'smaller choices are respected');
  assert.ok(I.itemTypeSize(baseBook({ itemKind: 'quote' })) > I.itemTypeSize(baseBook({ itemKind: 'poem' })));
  assert.equal(I.suggestItemSize(baseBook({ itemSizePt: 26 })), 12);
});

test('poems are one left-aligned block centred on the page, verses are paragraphs with hanging indent', () => {
  const src = buildItemsDocument({ book: baseBook({ itemSizePt: 26 }), outline: { title: 'T', themes: [{ n: 1, title: 'A' }] }, items: items(2) });
  assert.match(src, /#item-piece\(left,/);
  assert.match(src, /hanging-indent: if al == left \{ 1\.6em \}/);
  assert.ok(!src.includes(' \\\n'), 'verses must not be joined with forced line breaks any more');
  assert.match(src, /#item-stanza/, 'blank line between stanzas is kept as space');
  assert.ok(!/size: 2[0-9]pt/.test(src), 'no poster-sized text anywhere');
  assert.match(src, /numbering\("1", \.\.n\)/, 'page numbers are small, not body sized');
});

test('short quotes stay centred and wrap in a comfortable measure', () => {
  const src = buildItemsDocument({ book: baseBook({ itemKind: 'quote' }), outline: { title: 'T', themes: [{ n: 1, title: 'A' }] }, items: items(1) });
  assert.match(src, /#item-piece\(center,/);
});

test('single-theme books drop the empty table of contents; multi-theme books keep it with real headings', () => {
  const one = buildItemsDocument({ book: baseBook(), outline: { title: 'T', themes: [{ n: 1, title: 'A' }] }, items: items(2) });
  assert.ok(!one.includes('#outline('));
  const two = buildItemsDocument({ book: baseBook(), outline: { title: 'T', themes: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }] }, items: [...items(2, 1), ...items(2, 2)] });
  assert.ok(two.includes('#outline('));
  assert.match(two, /หมวดที่ 2/);
  assert.equal((two.match(/#heading\(level: 1\)/g) || []).length, 2);
});

test('item figures: theme image is round on the divider, item image gets its own page above the text', () => {
  const book = baseBook({
    itemsPerPage: 2, figureMode: 'prompt',
    figures: [
      { kind: 'image', itemFigure: true, section: 'theme-2', name: 'fig-theme-2.png', prompt: 'window' },
      { kind: 'image', itemFigure: true, section: '1.2', name: 'fig-item-1.2.png', heightMm: 58, prompt: 'tea' },
    ],
  });
  const src = buildItemsDocument({ book, outline: { title: 'T', themes: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }] }, items: [...items(3, 1), ...items(2, 2)], opts: { assetNames: ['fig-theme-2.png'] } });
  assert.match(src, /#image\("\/img\/fig-theme-2\.png"/);
  assert.match(src, /radius: 25mm/, 'divider image is a circle');
  assert.match(src, /\\<Prompt : tea\\>/, 'missing file shows the escaped prompt, not a Typst label');
  const figPage = src.slice(src.indexOf('Prompt : tea'));
  assert.ok(figPage.indexOf('#item-piece') > 0, 'the text follows the image on the same page');
});

test('prose documents are untouched by the item layout', () => {
  const book = { ...baseBook(), contentMode: 'prose', typography: { ...baseBook().typography, headFont: 'Sarabun' } };
  const src = buildDocument({ book, outline: { title: 'T', chapters: [{ n: 1, title: 'C', sections: [{ id: '1.1', title: 'S' }] }] }, sections: [{ id: '1.1', md: 'เนื้อหา' }] });
  assert.ok(!src.includes('item-piece') && !src.includes('item-fit'));
});

test('item figure planner targets only real items/themes and never touches prose figures', async () => {
  const rows = items(30, 1).concat(items(30, 2));
  const book = baseBook({ itemIllus: 'light', figureColor: 'color', outline: { title: 'T', themes: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }] }, figures: [] });
  const run = vm.runInNewContext(`(${Machine.prototype.itemFigures.toString().replace('async itemFigures()', 'async function()')})`, {
    db: { loadSections: async () => rows }, I, P: await import('../core/prompts.js'), X: { parseJson: JSON.parse },
    cmpItem: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
    normalizeFigureAspect: (v) => ({ label: v === '1:1' ? '1:1' : '3:2', ratio: v === '1:1' ? 1 : 1.5 }),
  });
  let sent = '';
  const machine = { book, log() {}, save: async () => {}, turnWithRetry: async (p) => { sent = p; return { text: JSON.stringify({ figures: [
    { target: 'theme-1', subject: 'misty winter lake at dawn' },
    { target: '2.7', subject: 'steam rising from a cup by a window' },
    { target: '9.9', subject: 'invented id' },
    { target: '2.7', subject: 'duplicate' },
  ] }) }; } };
  await run.call(machine);
  assert.match(sent, /theme-2: B/);
  assert.equal(JSON.stringify(book.figures.map((f) => f.name)), JSON.stringify(['fig-theme-1.png', 'fig-item-2.7.png']));
  assert.ok(book.figures.every((f) => f.itemFigure && f.prompt));
  const again = book.figures.length;
  await run.call(machine);
  assert.equal(book.figures.length, again, 'resume must not plan twice');
});

test('no blank numbered pages before theme dividers, no prose-style fallback foreword', () => {
  const book = baseBook({ itemKind: 'quote', frontMatter: ['title', 'foreword', 'toc'] });
  const outline = { title: 'หมดไฟ แต่ยังไม่หมดทาง', themes: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }] };
  const src = buildItemsDocument({ book, outline, items: [...items(2, 1), ...items(2, 2)] });
  assert.ok(!src.includes('pagebreak(to: "odd"') || src.indexOf('pagebreak(to: "odd"') > src.indexOf('หมวดที่ 2'), 'dividers must not force odd pages');
  assert.ok(!src.includes('คำนำ'), 'no generated non-fiction foreword');
  const written = buildItemsDocument({ book, outline: { ...outline, foreword: 'REAL_FOREWORD_TEXT' }, items: items(2, 1) });
  assert.ok(written.includes('REAL_FOREWORD_TEXT'), 'a real foreword is still printed');
});

test('older item books never start planning interior images on their own', async () => {
  const run = vm.runInNewContext(`(${Machine.prototype.figures.toString().replace('async figures()', 'async function()')})`, {});
  for (const [over, expected] of [
    [{ illustrationLevel: 'light', figureMode: 'auto' }, 0], // images() may upgrade illustrationLevel by itself
    [{ illustrationLevel: 'rich' }, 0],
    [{ itemIllus: 'none', illustrationLevel: 'light' }, 0],
    [{ itemIllus: 'light' }, 1],
    [{ itemIllus: 'rich' }, 1],
  ]) {
    let planned = 0;
    const m = { book: baseBook(over), job: {}, itemFigures: async () => { planned++; } };
    await run.call(m);
    assert.equal(planned, expected, JSON.stringify(over));
    assert.equal(m.job.step, 'fit');
  }
});
