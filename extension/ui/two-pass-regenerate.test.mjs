import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as P from '../core/prompts.js';
import * as B from '../core/bible.js';
import { extractSection } from '../core/extract.js';
import { countUnits } from '../core/thai.js';
import { parseContentDraft, recoverContentDraft, contentInputRequests } from '../core/content-readiness.js';

const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('async function writeSectionWithAi(');
const method = source.slice(start, source.indexOf('\nasync function renderHistory', start));
const section = { id: '1.1', title: 'เทียบทางเลือก', problem: 'เลือกวิธีไหน',
  claim: 'เลือกตามทรัพยากร', beats: ['เทียบสองวิธี'], quota: 1800 };
const chapter = { n: 1, title: 'เลือกวิธี', sections: [section] };
const raw = 'สาระดิบที่อธิบายทางเลือกพร้อมเงื่อนไข '.repeat(15).trim();
const final = 'เลือกวิธีแรกเมื่อมีเครื่องมือพร้อม ถ้ายังไม่มีให้ใช้วิธีที่สองและเผื่อเวลาเพิ่ม '.repeat(8).trim();
function answer(body, meta) {
  return `<<<SEC 1.1 BEGIN>>>\n${body}\n<<<SEC 1.1 END>>>\n<<<META 1.1 BEGIN>>>\n${JSON.stringify(meta)}\n<<<META 1.1 END>>>`;
}
function fixture(replies, contentMode = 'prose') {
  const book = { id: 'b', contentMode, genre: 'textbook', language: 'th', audience: 'มือใหม่',
    bible: B.emptyBible(), outline: { title: 'วิธีทำงาน', thesis: 'เลือกทางได้', chapters: [chapter] } };
  const rec = { id: '1.1', md: 'ต้นฉบับเดิม', chars: 13, status: 'generated' };
  const calls = []; const saved = [];
  const scope = { book, sections: [rec], B, extractSection, countUnits,
    parseContentDraft, recoverContentDraft, contentInputRequests,
    sectionPrompt: P.sectionPrompt, contentDraftPrompt: P.contentDraftPrompt,
    contentDraftKey: P.contentDraftKey, composeBatchPrompt: P.composeBatchPrompt,
    isItemBook: () => false, focusChat: async () => {},
    makeTransport: () => ({}), transportKind: () => 'mock', transportOpts: () => ({}),
    syncSharedProject: async () => {}, addEvent() {}, answerEvidence: () => '',
    db: { saveSection: async (_, value) => saved.push(structuredClone(value)), saveBook: async () => {} },
    sendTurn: async (_, prompt, opts, config) => {
      calls.push({ prompt, ...opts });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return config.parse({ text: reply || '' });
    },
  };
  vm.runInNewContext(method + '\nglobalThis.run = writeSectionWithAi;', scope);
  return { scope, calls, saved, rec, run: () => scope.run('1.1') };
}

test('regenerate uses both stages, preserves old manuscript in history, saves raw separately', async () => {
  const f = fixture([answer(raw, { missing_information: [] }), answer(final, { summary: 'เนื้อหาใหม่' })]);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].prompt, /รอบ 1:/);
  assert.match(f.calls[1].prompt, /รอบ 2:/);
  assert.ok(f.calls[1].prompt.includes(raw));
  assert.ok(f.calls[1].prompt.includes('นิยามศัพท์ก่อนใช้'));
  assert.equal(f.saved[0].md, 'ต้นฉบับเดิม');
  assert.equal(f.rec.md, final);
  assert.equal(f.rec.contentDraft.md, raw);
  assert.equal(f.rec.history[0].md, 'ต้นฉบับเดิม');
});

test('failed composition leaves original intact and next attempt reuses the raw material', async () => {
  const replies = [answer(raw, { missing_information: [] }), new Error('หยุดกลางทาง')];
  const f = fixture(replies);
  assert.equal((await f.run()).ok, false);
  assert.equal(f.rec.md, 'ต้นฉบับเดิม');
  replies.push(answer(final, { summary: 'เสร็จ' }));
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].prompt, /รอบ 2:/);
});

test('missing information blocks regeneration without overwriting original or repeating turns', async () => {
  const gap = answer('ข้อมูลไม่ครบ', { missing_information: ['หลักฐานผลลัพธ์'] });
  const f = fixture([gap, gap]);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /หลักฐานผลลัพธ์/);
  assert.equal(f.rec.md, 'ต้นฉบับเดิม');
  assert.equal((await f.run()).ok, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.scope.book.job.status, 'waiting_content_input');
  assert.equal(result.inputNeeded, true);
});

test('fiction regenerates once and locked/approved manuscripts are protected', async () => {
  const fiction = fixture([answer(final, { summary: 'ฉาก' })], 'fiction');
  assert.equal((await fiction.run()).ok, true);
  assert.equal(fiction.calls.length, 1);
  assert.doesNotMatch(fiction.calls[0].prompt, /รอบ 1:|รอบ 2:/);
  for (const fields of [{ locked: true }, { status: 'approved' }]) {
    const f = fixture([]); Object.assign(f.rec, fields);
    assert.equal((await f.run()).ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test('history excludes content-only turns and estimate tells users about the extra stage', () => {
  assert.match(source, /filter\(turn => !String\(turn.label \|\| ''\).startsWith\('สาระดิบ'\)\)/);
  const estimate = source.slice(source.indexOf('function updateEstimate()'), source.indexOf('function updateEstimate()') + 3200);
  assert.match(estimate, /contentMode: val\('contentMode', 'prose'\)/);
  assert.match(estimate, /สร้างสาระ \$\{e.content\} \+ เรียบเรียง/);
});

test('regeneration accepts long source inputs and long raw material without a local length cap', async () => {
  const source = 'ข้อมูลอ้างอิงที่ต้องส่งให้ครบ '.repeat(1500);
  const largeRaw = raw.repeat(100);
  const f = fixture([answer(largeRaw, { missing_information: [] }), answer(final, { summary: 'เสร็จ' })]);
  f.scope.book.backMatter = ['references'];
  f.scope.book.referenceSources = [{ title: 'หลักฐาน', abstract: source }];
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.ok(call.prompt.length > 11500);
    assert.ok(call.prompt.includes(source));
  }
  assert.ok(f.calls[1].prompt.includes(largeRaw));
  assert.equal(f.rec.md, final);
});
