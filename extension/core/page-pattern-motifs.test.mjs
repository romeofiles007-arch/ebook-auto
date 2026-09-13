/**
 * ลายพื้นหลังต้องมาจากเรื่องของเล่มนั้น ไม่ใช่ "simple geometric marks" เหมือนกันทุกเล่ม
 * แต่ต้องยังเป็นลายพื้นที่จาง ไม่มีตัวหนังสือ และไม่กลายเป็นภาพฉาก
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from './prompts.js';

const trim = { widthMm: 148, heightMm: 210 };
const books = {
  fiction: { contentMode: 'fiction', trim, outline: { title: 'เงาใต้ลมหนาว', thesis: 'ความลับของครอบครัว', world_rules: ['หิมะไม่เคยละลายในหุบเขา'] } },
  items: { contentMode: 'items', trim, outline: { title: 'ความรักและลมหนาว', themes: [{ n: 1, title: 'ก่อนลมหนาว', angle: 'ความพร้อม' }] } },
  prose: { contentMode: 'prose', trim, outline: { title: 'หมดไฟ แต่ยังไม่หมดทาง', thesis: 'ทำงานโดยไม่เผาตัวเอง', chapters: [{ n: 1, title: 'สัญญาณหมดไฟ' }] } },
};

for (const [mode, book] of Object.entries(books)) test(`${mode}: pattern motifs come from the book, rules stay strict`, () => {
  const p = P.pagePatternPrompt(null, book);
  assert.ok(p.includes(book.outline.title), 'title is the motif source');
  const part = mode === 'fiction' ? 'หิมะไม่เคยละลายในหุบเขา' : mode === 'items' ? 'ก่อนลมหนาว — ความพร้อม' : 'สัญญาณหมดไฟ';
  assert.ok(p.includes(part), 'parts of the book are listed');
  assert.ok(!/simple geometric marks drawn from the book concept/.test(p), 'no generic fallback motif');
  for (const rule of [/Extremely low contrast/, /At least 70% of the canvas stays empty/, /No scene, no landscape, no characters/, /No text, letters, Thai characters/, /never write any of these words into the image/])
    assert.match(p, rule);
  assert.ok(!p.includes('undefined'));
});

test('cover style still leads colour, texture and the signature motif', () => {
  const style = { style: 'soft watercolour', texture: 'cotton paper grain', background_element: 'falling snow', palette: [{ hex: '#DDE7F0' }] };
  const p = P.pagePatternPrompt(style, books.items);
  assert.match(p, /soft watercolour/);
  assert.match(p, /must be one of them: falling snow/);
  assert.match(p, /#DDE7F0/);
});

test('books without an outline still get a valid prompt', () => {
  const p = P.pagePatternPrompt(null, { topic: 'หัวข้อ', trim });
  assert.match(p, /Title: หัวข้อ/);
  assert.match(p, /148 × 210 mm/);
});
