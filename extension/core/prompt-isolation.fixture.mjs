/**
 * ตัวสร้าง prompt ตัวอย่างของโหมดสารคดีและโหมดรายชิ้น — ใช้เทียบว่าการแก้โหมดนิยายไม่ไปเปลี่ยนสองโหมดนี้
 *
 * ถ้าตั้งใจแก้ prompt ของสารคดี/รายชิ้นจริง ให้สร้างไฟล์เทียบใหม่:
 *   node core/prompt-isolation.fixture.mjs --write
 */
import * as P from './prompts.js';
import * as I from './items.js';
import * as B from './bible.js';
import { itemReviewPrompt } from './item-quality.js';
import { writeFile, readFile } from 'node:fs/promises';

const typography = { bodyFont: 'Sarabun', sizePt: 15, lineHeight: 1.7, marginsMm: { inner: 18, outer: 14, top: 16, bottom: 18 } };
const proseOutline = {
  title: 'หนังสือทดสอบ', subtitle: 'รอง', thesis: 'แกนของเล่ม', voice_card: 'เป็นกันเอง',
  chapters: [
    { n: 1, title: 'บทแรก', objective: 'ปูพื้น', adds: 'ข้อมูลใหม่', sections: [
      { id: '1.1', title: 'ตอนหนึ่ง', quota: 2000, takeaways: ['ข้อหนึ่ง'], claim: 'ข้ออ้าง' },
      { id: '1.2', title: 'ตอนสอง', quota: 2200, takeaways: ['ข้อสอง'] },
    ] },
    { n: 2, title: 'บทสอง', objective: 'ต่อยอด', sections: [{ id: '2.1', title: 'ตอนสาม', quota: 1800 }] },
  ],
};
const proseBible = () => {
  const b = B.emptyBible();
  B.absorb(b, '1.1', { summary: 'สรุป', new_terms: [{ term: 'ศัพท์', def: 'นิยาม' }], examples: ['ตัวอย่าง'], promises: ['สัญญา'] });
  return b;
};

export function buildSamples() {
  const out = {};
  for (const genre of ['how-to', 'self', 'business']) {
    const book = {
      id: 'p', contentMode: 'prose', genre, genreBrief: `แนว ${genre}`, topic: 'หัวข้อ', audience: 'ผู้อ่าน', tone: 'เป็นกันเอง',
      language: 'th', targetPages: 120, sectionLength: 'auto', authorVoice: 'auto', frontMatter: ['title', 'toc'], backMatter: [],
      trim: { preset: 'a5', widthMm: 148, heightMm: 210 }, typography, outline: proseOutline, illustrationLevel: 'light',
      authorVoiceCard: { who: 'ผู้เรียบเรียง', why_this_book: 'ช่วยผู้อ่าน', avoid_words: ['คำ'] },
    };
    const bible = proseBible();
    const ch = proseOutline.chapters[0];
    const sec = { ...ch.sections[0], chars: 1500, md: 'เนื้อหาเดิม' };
    out[`prose/${genre}/outline`] = P.outlinePrompt(book);
    out[`prose/${genre}/batch`] = P.batchPrompt({ book, outline: proseOutline, bible, chapter: ch, sections: ch.sections, prevSummaries: ['ก่อนหน้า'], prevTail: 'ท้ายตอน', nextSection: proseOutline.chapters[1].sections[0], withContext: true });
    out[`prose/${genre}/section`] = P.sectionPrompt({ book: { ...book, bible }, outline: proseOutline, chapter: ch, section: ch.sections[1], prevSummaries: [], nextSection: null });
    out[`prose/${genre}/continue`] = P.continueBatchPrompt(['1.2'], 'ข้อความเดิม', book, 'งานต้นทาง');
    out[`prose/${genre}/rewrite`] = P.rewritePrompt({ book, section: sec, currentText: sec.md, targetChars: 2400, instruction: 'ขยาย' });
    out[`prose/${genre}/repair`] = P.repairPrompt({ book: { ...book, bible }, section: sec, currentText: sec.md, issues: [{ label: 'ซ้ำ' }] });
    out[`prose/${genre}/consistency`] = P.consistencyPrompt(ch, [sec], bible, book, 'ส่วน 1/1');
    out[`prose/${genre}/voice`] = P.authorVoicePrompt(book, proseOutline);
    out[`prose/${genre}/figures`] = P.figurePlanPrompt({ ...book, bible }, proseOutline, proseOutline.chapters, 'line');
    out[`prose/${genre}/directions`] = P.outlineDirectionsPrompt({ title: 'ชื่อ', audience: 'ผู้อ่าน', tone: 'โทน', contentMode: 'prose', genreBrief: 'แนว', targetPages: 120 });
    out[`prose/${genre}/titles`] = P.titleIdeasPrompt({ topic: 'หัวข้อ', audience: 'ผู้อ่าน', tone: 'โทน', contentMode: 'prose', today: '2026-09-13' });
    out[`prose/${genre}/trends`] = P.trendIdeasPrompt({ seed: 'เมล็ด', audience: 'ผู้อ่าน', tone: 'โทน', contentMode: 'prose', today: '2026-09-13' });
    out[`prose/${genre}/polish`] = P.outlinePolishPrompt({ title: 'ชื่อ', userOutline: [{ n: 1, title: 'บท' }], audience: 'ผู้อ่าน', tone: 'โทน', contentMode: 'prose', genreBrief: 'แนว' });
    out[`prose/${genre}/bible`] = JSON.stringify(bible);
  }

  for (const itemKind of Object.keys(I.ITEM_KINDS)) {
    const book = { id: 'i', contentMode: 'items', itemKind, topic: 'หัวข้อ', audience: 'ผู้อ่าน', tone: 'โทน', language: 'th', targetPages: 60, itemsPerPage: 1, themeCount: 3, frontMatter: ['title'], backMatter: [], trim: { widthMm: 148, heightMm: 210 }, authorVoice: 'auto', authorVoiceCard: { who: 'x', why_this_book: 'y', avoid_words: [] } };
    const outline = { title: 'รวม', themes: [{ n: 1, title: 'หมวด', angle: 'มุม', count: 20 }] };
    out[`items/${itemKind}/theme`] = I.themePrompt(book, I.planItems(book));
    out[`items/${itemKind}/batch`] = I.itemBatchPrompt({ book, outline, theme: outline.themes[0], count: 3, startIndex: 1, avoid: ['ใช้แล้ว'] });
    out[`items/${itemKind}/review`] = itemReviewPrompt(book, [{ id: '1.1', text: 'ข้อความ', attribution: '' }], ['1.2: อื่น']);
    out[`items/${itemKind}/directions`] = P.outlineDirectionsPrompt({ title: 'ชื่อ', audience: 'ผู้อ่าน', tone: 'โทน', contentMode: 'items', targetPages: 60 });
    out[`items/${itemKind}/polish`] = P.outlinePolishPrompt({ title: 'ชื่อ', userOutline: [{ n: 1, title: 'หมวด' }], audience: 'ผู้อ่าน', tone: 'โทน', contentMode: 'items' });
  }
  return out;
}

export const FIXTURE = new URL('./prompt-isolation.snapshot.json', import.meta.url);

if (process.argv.includes('--write')) {
  await writeFile(FIXTURE, JSON.stringify(buildSamples(), null, 1) + '\n', 'utf8');
  console.log('wrote', FIXTURE.pathname);
}
export const readFixture = async () => JSON.parse(await readFile(FIXTURE, 'utf8'));
