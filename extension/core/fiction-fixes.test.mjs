/**
 * แก้โหมดนิยายชุดที่ 1 — และต้องไม่แตะโหมดสารคดี/รายชิ้นแม้แต่ตัวอักษรเดียว
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as P from './prompts.js';
import * as B from './bible.js';
import * as X from './extract.js';
import { buildSamples, readFixture } from './prompt-isolation.fixture.mjs';
globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
const { Machine } = await import('./machine.js');

test('prose and item-mode prompts are byte-for-byte unchanged', async () => {
  const before = await readFixture();
  const now = buildSamples();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) assert.equal(now[key], before[key], `changed: ${key}`);
});

const outline = {
  title: 'เงาใต้ลมหนาว', thesis: 'แกน', voice_card: 'กระชับ มืด',
  cast: [{ name: 'มีรา', role: 'ตัวเอก', want: 'หาพี่ชาย', appearance: 'ผมสั้น แผลเป็นที่คิ้วซ้าย' }],
  chapters: [
    { n: 2, title: 'เมืองน้ำแข็ง', objective: 'เข้าเมือง', sections: [{ id: '2.1', title: 'ประตูเมือง', quota: 3000 }] },
    { n: 3, title: 'ประตูน้ำแข็ง', objective: 'มีรารู้ความลับ', adds: 'พี่ชายยังมีชีวิต', sections: [
      { id: '3.2', title: 'ห้องใต้ดิน', quota: 3000, pov_character: 'มีรา', location: 'ห้องใต้ดิน', scene_goal: 'หากุญแจ', conflict: 'ยามลาดตระเวน', turn: 'เจอจดหมาย', beats: ['ย่องลง', 'ซ่อน', 'เจอจดหมาย'], takeaways: ['มีราบาดเจ็บที่แขน'] },
    ] },
  ],
};
const fictionBook = (over = {}) => ({
  contentMode: 'fiction', fictionGenre: 'comingofage', genreBrief: 'นิยายเติบโต', fictionPov: 'third-limited',
  fictionEnding: 'bittersweet', fictionRomance: 'none', tone: 'มืด', language: 'th', outline,
  bible: { ...B.emptyBible(), characters: structuredClone(outline.cast) }, ...over,
});

test('fiction repair knows its chapter and scene plan, and answers in the fiction story-bible format', () => {
  const book = fictionBook();
  const p = P.repairPrompt({ book, section: { id: '3.2', title: 'ห้องใต้ดิน', md: 'x' }, currentText: 'เนื้อฉาก', issues: [{ label: 'pov' }] });
  assert.ok(!p.includes('undefined'), 'no "บทที่ undefined" any more');
  assert.match(p, /บทที่ 3: ประตูน้ำแข็ง/);
  assert.match(p, /เป้าหมายฉาก: หากุญแจ/);
  assert.match(p, /beats: 1\) ย่องลง/);
  assert.match(p, /continuity ที่ห้ามหาย: มีราบาดเจ็บที่แขน/);
  assert.match(p, /character_updates/);
  assert.ok(!p.includes('new_terms'), 'no non-fiction glossary META');
  // ตัวแกะคำตอบเดิมยังอ่านคำตอบรูปแบบนี้ได้ พร้อม META ของ Story Bible
  const answer = '```markdown\n<<<SEC 3.2 BEGIN>>>\n' + 'มีราย่องลงบันได '.repeat(40) + '\n<<<SEC 3.2 END>>>\n<<<META 3.2 BEGIN>>>\n{"summary":"สรุป","character_updates":[{"name":"มีรา","injury":"แขน"}]}\n<<<META 3.2 END>>>\n```';
  const ex = X.extractSection(answer, '3.2');
  assert.equal(ex.status, 'ok');
  assert.equal(ex.meta?.character_updates?.[0]?.name, 'มีรา');
});

test('each new scene sees the exact ending of the previous scene', () => {
  const book = fictionBook();
  const ch = outline.chapters[1];
  const p = P.batchPrompt({ book, outline, bible: book.bible, chapter: ch, sections: ch.sections, prevSummaries: [], prevTail: 'ประตูปิดลงดังปัง', nextSection: { title: 'ถัดไป' } });
  assert.match(p, /ท้ายฉากก่อนหน้าคำต่อคำ[\s\S]*ประตูปิดลงดังปัง/);
  const first = P.batchPrompt({ book, outline, bible: book.bible, chapter: ch, sections: ch.sections, prevSummaries: [], prevTail: '', nextSection: { title: 'ถัดไป' } });
  assert.ok(!first.includes('ท้ายฉากก่อนหน้าคำต่อคำ'), 'the first scene of the book has nothing to continue');
});

test('chosen ending, romance level and POV reach the writing prompts in words, not raw keys', () => {
  const book = fictionBook();
  const ch = outline.chapters[1];
  const mid = P.batchPrompt({ book, outline, bible: book.bible, chapter: ch, sections: ch.sections, prevSummaries: [], nextSection: { title: 'x' } });
  assert.match(mid, /ตอนจบที่ผู้ใช้เลือก: จบหวานขม/);
  assert.match(mid, /เส้นเรื่องความรัก: ไม่มีเส้นเรื่องความรักเป็นแกน/);
  assert.ok(!/มุมมอง: third-limited/.test(mid));
  for (const sections of [ch.sections, [...ch.sections, { ...ch.sections[0], id: '3.3', title: 'พีค' }]]) {
    const last = P.batchPrompt({ book, outline, bible: book.bible, chapter: ch, sections, prevSummaries: [], nextSection: null });
    assert.match(last, /ฉากพีค[\s\S]*ตอนจบที่ผู้ใช้เลือก \(จบหวานขม/, 'the climax scene is told which ending to land');
  }
  for (const p of [
    P.titleIdeasPrompt({ topic: 't', contentMode: 'fiction', fictionGenre: 'comingofage' }),
    P.trendIdeasPrompt({ contentMode: 'fiction', fictionGenre: 'comingofage' }),
    P.outlineDirectionsPrompt({ title: 't', contentMode: 'fiction', fictionGenre: 'comingofage' }),
    P.outlinePolishPrompt({ title: 't', userOutline: [{ n: 1, title: 'a' }], contentMode: 'fiction', fictionGenre: 'comingofage' }),
    P.consistencyPrompt(ch, ch.sections, book.bible, book),
  ]) {
    assert.ok(!p.includes('comingofage'), 'genre key must be shown as a name');
    assert.match(p, /Coming of Age/);
  }
});

test('long novels keep the main cast profiles in the story bible', () => {
  const bible = { ...B.emptyBible(), characters: structuredClone(outline.cast) };
  for (let i = 0; i < 60; i++) B.absorb(bible, `s${i}`, { character_updates: [`อัปเดตที่ ${i}`] });
  const mira = bible.characters.find((c) => c?.name === 'มีรา');
  assert.ok(mira, 'the protagonist profile survives');
  assert.equal(mira.appearance, 'ผมสั้น แผลเป็นที่คิ้วซ้าย');
  assert.ok(bible.characters.includes('อัปเดตที่ 59'), 'latest notes are still kept');
  assert.ok(bible.characters.length <= 40);
});

test('fiction books no longer spend a message on the non-fiction author card; other modes still get it', async () => {
  const run = vm.runInNewContext(`(${Machine.prototype.ensureAuthorVoice.toString().replace('async ensureAuthorVoice()', 'async function()')})`, {
    P, X: { parseJson: JSON.parse }, RateLimited: class {}, Halt: class {},
  });
  for (const [contentMode, expected] of [['fiction', 0], ['prose', 1], ['items', 1]]) {
    let turns = 0;
    const m = { book: { contentMode, outline: {} }, log() {}, save: async () => {}, turnWithRetry: async () => { turns++; return { text: '{"who":"x"}' }; } };
    await run.call(m);
    assert.equal(turns, expected, contentMode);
  }
});
