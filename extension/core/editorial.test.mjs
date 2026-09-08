import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from './prompts.js';
import * as X from './extract.js';
import * as B from './bible.js';

const sections = [
  { id: '1.1', title: 'เลือกเหตุการณ์', problem: 'เรื่องที่เล่ายังไม่มีจุดเปลี่ยน', claim: 'เลือกเหตุการณ์ที่ความคาดหมายเปลี่ยน', verdict: 'ชี้จุดเปลี่ยนในเรื่องได้', beats: ['ระบุความคาดหมาย', 'หาสิ่งที่เกิดต่างออกไป'], takeaways: ['เลือกวัตถุดิบได้'], not_here: 'การตัดคำอยู่ตอน 1.2', quota: 1800, maxChars: 2200 },
  { id: '1.2', title: 'ตัดคำ', problem: 'คนฟังหลงก่อนถึงจุดขำ', claim: 'เก็บคำที่ทำให้เข้าใจจุดเปลี่ยน', verdict: 'ตัดส่วนเกินโดยยังเข้าใจเรื่อง', beats: ['เทียบประโยคสองฉบับ', 'อธิบายผลของคำที่ตัด'], takeaways: ['แก้ประโยคได้'], not_here: 'การเลือกเหตุการณ์อยู่ตอน 1.1', quota: 1800, maxChars: 2200 },
];
const chapter = { n: 1, title: 'วัตถุดิบและการแก้', objective: 'เลือกและแก้เรื่องสั้นหนึ่งเรื่อง', adds: 'วิธีตรวจต้นฉบับ', sections };
const outline = { title: 'พูดให้ขำขึ้น', thesis: 'ฝึกเลือกและแก้เรื่องเล่าจากสิ่งรอบตัว', chapters: [chapter] };
const book = { topic: outline.title, audience: 'คนที่ต้องพูดในที่ทำงาน', tone: 'ตรงไปตรงมา', language: 'th', contentMode: 'prose', targetPages: 60, outline };
const args = { book, outline, bible: B.emptyBible(), chapter, sections, withContext: true, prevSummaries: ['อธิบายขอบเขตหนังสือแล้ว'], prevTail: 'จึงเริ่มจากเรื่องที่สังเกตได้ก่อน', nextSection: { title: 'ทดลองเล่า' } };

test('batch assignment preserves distinct questions, boundaries and continuity', () => {
  const prompt = P.batchPrompt(args);
  for (const section of sections) {
    assert.ok(prompt.includes(section.problem));
    assert.ok(prompt.includes(section.not_here));
    assert.ok(prompt.includes(`<<<META ${section.id} BEGIN>>>`));
  }
  assert.ok(prompt.includes(args.prevTail));
  assert.ok(prompt.includes('ทดลองเล่า'));
  assert.doesNotMatch(prompt, /ทุกตอนต้องเดินเป็น|ห้ามมีคำกันความแม้แต่คำเดียว|ห้ามกำกับว่า "สมมติ"/);
});

test('per-section response round-trips through the real extractor and bible', () => {
  const response = sections.map((s, i) => `<<<SEC ${s.id} BEGIN>>>\n${('เนื้อหาที่อธิบายประเด็นนี้อย่างครบถ้วน ').repeat(12)}\n<<<SEC ${s.id} END>>>\n<<<META ${s.id} BEGIN>>>\n${JSON.stringify({ summary: s.claim, examples: ['example-' + i], new_terms: [], promises: [], paid: [] })}\n<<<META ${s.id} END>>>`).join('\n');
  const bible = B.emptyBible();
  for (const s of sections) {
    const ex = X.extractSection(response, s.id);
    assert.equal(ex.status, 'ok');
    B.absorb(bible, s.id, ex.meta);
  }
  assert.equal(bible.sectionSummaries['1.1'], sections[0].claim);
  assert.equal(bible.sectionSummaries['1.2'], sections[1].claim);
  assert.notEqual(bible.sectionSummaries['1.1'], bible.sectionSummaries['1.2']);
});

test('single section uses the same contract as batch writing', () => {
  const one = P.sectionPrompt({ ...args, section: sections[0] });
  assert.ok(one.includes('หลักการเขียนร่วมของทุกแผนก'));
  assert.ok(one.includes('<<<META 1.1 BEGIN>>>'));
  assert.ok(!one.includes('<<<SEC 1.2 BEGIN>>>'));
});

test('legacy automatic author persona cannot introduce fabricated career or memories', () => {
  const voice = P.authorVoiceBlock({ authorVoiceCard: { who: 'นักพูดที่ทำงานมา 20 ปี', was_wrong_about: 'เคยทำบริษัทล้ม', why_this_book: 'ช่วยอธิบายให้ชัด' } });
  assert.ok(!voice.includes('20 ปี'));
  assert.ok(!voice.includes('บริษัทล้ม'));
  assert.match(voice, /ห้ามอ้างเป็นประวัติ/);
});

test('review and repair allow cuts while preserving evidence and image markers', () => {
  const rec = { ...sections[0], md: 'ตัวอย่างข้อความ', chars: 2000 };
  const review = P.consistencyPrompt(chapter, [rec], args.bible, book);
  assert.match(review, /อ้างข้อความจริงใน quote/);
  assert.match(review, /ไม่ต้องเติมเนื้อหาแทน/);
  const repair = P.repairPrompt({ book, section: rec, currentText: rec.md, issues: [{ label: 'ซ้ำ', text: 'เกริ่นซ้ำ', fix: 'ตัดเกริ่น' }] });
  assert.ok(repair.includes(rec.not_here));
  assert.ok(repair.includes('fig:'));
  assert.ok(repair.includes('<<<META 1.1 BEGIN>>>'));
  assert.doesNotMatch(repair, /ไม่ใช่ปล่อยให้ตอนสั้นลง|บวกลบไม่เกิน 10 เปอร์เซ็นต์/);
});

test('page fitting can report a completed section instead of inventing filler', () => {
  const rewrite = P.rewritePrompt({ book, section: { ...sections[0], chars: 1000 }, currentText: 'ต้นฉบับ', targetChars: 2000 });
  assert.match(rewrite, /META.short_reason/);
  assert.match(rewrite, /ห้ามแต่งเคสจริง/);
  assert.ok(rewrite.includes(sections[0].not_here));
});

test('continuation carries the original assignment for stateless transports', () => {
  const continuation = P.continueBatchPrompt(['1.2'], '', book, P.batchPrompt(args));
  assert.ok(continuation.includes(sections[1].problem));
  assert.ok(continuation.includes(outline.thesis));
});

test('fiction keeps scene goals and canon rather than nonfiction advice', () => {
  const fiction = P.batchPrompt({ ...args, book: { ...book, contentMode: 'fiction' }, sections: [{ ...sections[0], scene_goal: 'ตามหาจดหมาย', conflict: 'ประตูล็อก', turn: 'พบกุญแจ' }] });
  assert.match(fiction, /ตามหาจดหมาย/);
  assert.match(fiction, /Story Bible/);
  assert.doesNotMatch(fiction, /หลักการเขียนร่วมของทุกแผนก/);
});
