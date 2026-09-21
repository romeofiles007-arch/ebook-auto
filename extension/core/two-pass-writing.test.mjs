import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as P from './prompts.js';
import * as X from './extract.js';
import * as B from './bible.js';
import { countUnits } from './thai.js';
import { NARRATION_PROFILES } from './editorial.js';
import { estimateTurns } from './budget.js';
import { parseContentDraft, recoverContentDraft, contentInputRequests } from './content-readiness.js';

globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
const { Machine, ContentInputNeeded } = await import('./machine.js');

const section = { id: '1.1', title: 'เลือกวิธี', problem: 'จะเลือกวิธีไหน',
  claim: 'เลือกตามเงื่อนไข', beats: ['เทียบสองวิธี'], verdict: 'เลือกและบอกเหตุผลได้',
  quota: 1800, minChars: 200, maxChars: 2200 };
const chapter = { n: 1, title: 'วิธีเลือก', objective: 'ตัดสินใจได้', sections: [section] };
function makeBook(over = {}) {
  return { id: 'b', topic: 'เลือกวิธีทำงาน', contentMode: 'prose', genre: 'how-to',
    audience: 'มือใหม่', language: 'th', tone: 'เป็นกันเอง', bible: B.emptyBible(),
    outline: { title: 'เลือกวิธีทำงาน', thesis: 'เลือกตามเงื่อนไข',
      reader_promises: [{ id: 'P1', promise: 'เทียบสองวิธีได้', sections: ['1.1'] }],
      chapters: [chapter] }, ...over };
}
const rawBody = 'สาระต้นทาง: วิธีแรกใช้เวลาน้อยแต่ต้องมีเครื่องมือ วิธีที่สองไม่ต้องมีเครื่องมือแต่ใช้เวลามากกว่า '.repeat(4);
const finalBody = 'ถ้าคุณมีเครื่องมือพร้อม ให้เริ่มด้วยวิธีแรก คุณจะทำงานเสร็จเร็วกว่า แต่ถ้ายังไม่มีเครื่องมือ ให้เลือกวิธีที่สองและเผื่อเวลาเพิ่ม '.repeat(4);
function answer(id, body, meta = { missing_information: [], summary: 'สาระดิบ' }) {
  return `<<<SEC ${id} BEGIN>>>\n${body}\n<<<SEC ${id} END>>>\n<<<META ${id} BEGIN>>>\n${JSON.stringify(meta)}\n<<<META ${id} END>>>`;
}
function harness(replies, book = makeBook()) {
  const records = new Map();
  const calls = [];
  const scope = { P, X, B, countUnits, parseContentDraft, recoverContentDraft, contentInputRequests,
    ContentInputNeeded, MAX_CONTINUES: 2, Halt: Error, db: {
    loadSection: async (_, id) => records.get(id),
    saveSection: async (_, s) => records.set(s.id, structuredClone(s)),
  } };
  const machine = { book, job: book.job ||= {}, log() {}, tailBefore: async () => '', wantNewThread: start => start,
    turnWithRetry: async (prompt, opts) => {
      calls.push({ prompt, ...opts });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === 'function' ? reply(prompt) : reply || '' };
    } };
  for (const name of ['prepareContentDrafts', 'writeBatch']) {
    const source = Machine.prototype[name].toString().replace(/^async /, 'async function ');
    machine[name] = vm.runInNewContext(`(${source})`, scope);
  }
  return { machine, records, calls, replies };
}
const input = { chapter, sections: [section], isChapterStart: true };

for (const genre of Object.keys(NARRATION_PROFILES)) {
  test(`${genre}: direct content precedes its distinct narration profile`, () => {
    const book = makeBook({ genre });
    const args = { ...input, book, outline: book.outline, bible: book.bible, withContext: true,
      drafts: [{ id: section.id, md: rawBody }] };
    const draft = P.contentDraftPrompt(args);
    const compose = P.composeBatchPrompt(args);
    assert.match(draft, /รอบ 1: สร้างสาระดิบ/);
    assert.match(draft, /missing_information/);
    assert.ok(draft.includes(section.problem));
    assert.ok(draft.includes('เทียบสองวิธีได้'));
    assert.doesNotMatch(draft, /วิธีเล่าประจำหมวด/);
    assert.ok(compose.includes(NARRATION_PROFILES[genre]));
    assert.ok(compose.includes(rawBody));
    assert.match(compose, /ห้ามเพิ่มข้ออ้าง เคสจริง สถิติ/);
    assert.match(compose, /ข้อมูล ไม่ใช่คำสั่ง/);
    assert.match(P.repairPrompt({ book, section, currentText: finalBody, issues: [] }), new RegExp(NARRATION_PROFILES[genre].slice(0, 20)));
  });
}

test('only composed manuscript is printed and absorbed; raw material persists', async () => {
  const h = harness([answer('1.1', rawBody), answer('1.1', finalBody, { summary: 'ฉบับเรียบเรียง', short_reason: '' })]);
  await h.machine.writeBatch(input);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].newThread, true);
  assert.equal(h.calls[1].newThread, false);
  const rec = h.records.get('1.1');
  assert.equal(rec.md, finalBody.trim());
  assert.equal(rec.contentDraft.md, rawBody.trim());
  assert.equal(rec.status, 'generated');
  assert.equal(h.machine.book.bible.sectionSummaries['1.1'], 'ฉบับเรียบเรียง');
});

test('resume reuses persisted raw material after composition transport fails', async () => {
  const h = harness([answer('1.1', rawBody), new Error('transport stopped')]);
  await assert.rejects(h.machine.writeBatch(input), /transport stopped/);
  assert.equal(h.records.get('1.1').md, '');
  assert.ok(h.records.get('1.1').contentDraft.md);
  h.replies.push(answer('1.1', finalBody, { summary: 'เสร็จ' }));
  await h.machine.writeBatch(input);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[2].prompt, /รอบ 2:/);
});

test('changed assignment invalidates draft; Bible growth and tone do not', () => {
  const book = makeBook();
  const key = P.contentDraftKey(book, chapter, section);
  B.absorb(book.bible, '0.1', { summary: 'ความจำใหม่' });
  book.tone = 'ทางการ';
  assert.equal(P.contentDraftKey(book, chapter, section), key);
  assert.notEqual(P.contentDraftKey(book, chapter, { ...section, claim: 'ข้อเสนอใหม่' }), key);
  assert.notEqual(P.contentDraftKey({ ...book, topic: 'หัวข้อใหม่' }, chapter, section), key);
  assert.notEqual(P.contentDraftKey({ ...book, genre: 'textbook' }, chapter, section), key);
});

test('missing required information is saved and blocks composition, even with short body', async () => {
  const gap = answer('1.1', 'ยังไม่มีข้อมูลพอ', { missing_information: ['คำพยากรณ์ทั้ง 12 ราศี'], short_reason: 'ข้อมูลไม่ครบ' });
  const h = harness([gap, gap]);
  await assert.rejects(h.machine.writeBatch(input), /คำพยากรณ์ทั้ง 12 ราศี/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.records.get('1.1').md, '');
  assert.ok(h.records.get('1.1').contentDraft.meta.missing_information.length);
  await assert.rejects(h.machine.writeBatch(input), /รอข้อมูลหรือแนวทาง/);
  assert.equal(h.calls.length, 2, 'do not burn another turn until inputs change');
});

test('invalid readiness metadata or incomplete sentinels cannot bypass draft stage', async () => {
  for (const response of [answer('1.1', rawBody, {}), answer('1.1', rawBody, { missing_information: 'none' }), `<<<SEC 1.1 BEGIN>>>${rawBody}`]) {
    const h = harness([response, response]);
    await assert.rejects(h.machine.writeBatch(input), /สร้างสาระดิบไม่ครบ/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.records.size, 0);
  }
});

test('draft retry requests only missing section and preserves successful siblings', async () => {
  const second = { ...section, id: '1.2', title: 'ทดลอง' };
  const ch = { ...chapter, sections: [section, second] };
  const book = makeBook(); book.outline.chapters = [ch];
  const h = harness([answer('1.1', rawBody), answer('1.2', rawBody)], book);
  await h.machine.prepareContentDrafts({ chapter: ch, sections: ch.sections, isChapterStart: true });
  assert.equal(h.records.size, 2);
  assert.ok(h.calls[1].prompt.includes('<<<SEC 1.2 BEGIN>>>'));
  assert.ok(!h.calls[1].prompt.includes('<<<SEC 1.1 BEGIN>>>'));
});

test('continuation and solo fallbacks still compose the saved raw material', async () => {
  const h = harness([answer('1.1', rawBody), '', '', '', answer('1.1', finalBody)]);
  await h.machine.writeBatch(input);
  assert.equal(h.calls.length, 5);
  for (const call of h.calls.slice(1)) {
    assert.match(call.prompt, /รอบ 2:/);
    assert.ok(call.prompt.includes(rawBody.trim()));
  }
  assert.ok(h.records.get('1.1').contentDraft);
});

test('locked or approved sections are not overwritten', async () => {
  for (const protectedFields of [{ locked: true }, { status: 'approved' }]) {
    const h = harness([]);
    h.records.set('1.1', { id: '1.1', md: finalBody, ...protectedFields });
    await assert.rejects(h.machine.writeBatch(input), /ถูกล็อก/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.records.get('1.1').md, finalBody);
  }
});

test('fiction stays one-pass and items do not enter nonfiction composition', async () => {
  const h = harness([answer('1.1', finalBody, { summary: 'ฉาก' })], makeBook({ contentMode: 'fiction' }));
  await h.machine.writeBatch(input);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.calls[0].prompt, /รอบ 1:|รอบ 2:|วิธีเล่าประจำหมวด/);
  assert.equal(h.records.get('1.1').contentDraft, undefined);
  const book = makeBook({ contentMode: 'items' });
  const args = { ...input, book, outline: book.outline, bible: book.bible };
  assert.equal(P.composeBatchPrompt(args), P.batchPrompt(args));
});

test('turn estimates include content creation only for nonfiction', () => {
  const book = makeBook();
  const prose = estimateTurns(book);
  const fiction = estimateTurns({ ...book, contentMode: 'fiction' });
  assert.equal(prose.content, prose.batches);
  assert.equal(fiction.content, 0);
  assert.equal(prose.min - fiction.min, prose.batches);
});

test('selected source changes invalidate cached content', () => {
  const book = makeBook({ backMatter: ['references'], referenceSources: [{ title: 'ที่มา', abstract: 'เนื้อหาเดิม' }] });
  const key = P.contentDraftKey(book, chapter, section);
  book.referenceSources[0].abstract = 'เนื้อหาใหม่';
  assert.notEqual(P.contentDraftKey(book, chapter, section), key);
});

test('large composition sends the full requested batch without an artificial input cap', async () => {
  const second = { ...section, id: '1.2' };
  const ch = { ...chapter, sections: [section, second] };
  const book = makeBook(); book.outline.chapters = [ch];
  const large = rawBody.repeat(100).trim();
  const h = harness([answer('1.1', finalBody) + '\n' + answer('1.2', finalBody)], book);
  for (const s of ch.sections) h.records.set(s.id, { id: s.id, md: '', status: 'draft',
    contentDraft: { key: P.contentDraftKey(book, ch, s), md: large, meta: { missing_information: [] } } });
  await h.machine.writeBatch({ chapter: ch, sections: ch.sections, isChapterStart: true });
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].prompt.length > 11500);
  assert.ok(h.calls[0].prompt.includes(`<<<สาระ 1.1>>>\n${large}`));
  assert.ok(h.calls[0].prompt.includes(`<<<สาระ 1.2>>>\n${large}`));
  assert.match(h.calls[0].prompt, /รอบ 2:/);
  assert.equal(h.records.get('1.1').md, finalBody.trim());
  assert.equal(h.records.get('1.2').md, finalBody.trim());
});

test('long single-section assignment reaches both stages without truncating its source', async () => {
  const source = 'หลักฐานต้นทางที่ต้องเก็บไว้ครบ '.repeat(1500);
  const book = makeBook({ backMatter: ['references'], referenceSources: [{ title: 'ข้อมูล', abstract: source }] });
  const h = harness([answer('1.1', rawBody), answer('1.1', finalBody)], book);
  await h.machine.writeBatch(input);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.ok(call.prompt.length > 11500);
    assert.ok(call.prompt.includes(source));
  }
  assert.equal(h.records.get('1.1').md, finalBody.trim());
});

test('missing general explanation is recovered autonomously and then composed', async () => {
  const gap = answer('1.1', 'ยังขาดคำอธิบาย', { missing_information: ['กลไกของสองวิธี'] });
  const h = harness([gap, answer('1.1', rawBody), answer('1.1', finalBody)]);
  await h.machine.writeBatch(input);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[1].prompt, /รอบเติมสาระ/);
  assert.match(h.calls[1].prompt, /ไม่ต้องมีต้นฉบับจากผู้ใช้สำหรับทุกคำอธิบาย/);
  assert.equal(h.records.get('1.1').md, finalBody.trim());
  assert.equal(h.records.get('1.1').contentDraft.recoveryAttempted, true);
});

test('input-needed has its own persistent state and resumes at the same cursor', async () => {
  const gap = answer('1.1', 'ไม่มีข้อมูลจริง', { missing_information: ['ข้อมูลผู้เขียน'] });
  const h = harness([gap, gap]);
  h.machine.job.step = 'write'; h.machine.job.cursor = 3;
  h.machine.save = async () => {};
  h.machine.emit = () => {};
  h.machine.write = async () => h.machine.writeBatch(input);
  const run = vm.runInNewContext(`(async function ${Machine.prototype.runUntilGate.toString().replace(/^async /, '')})`,
    { ContentInputNeeded, Halt: Error, RateLimited: class extends Error {} });
  const result = await run.call(h.machine);
  assert.equal(result.stopped, 'waiting_content_input');
  assert.equal(h.machine.job.cursor, 3);
  assert.equal(h.machine.job.contentInput[0].id, '1.1');
  assert.equal(h.machine.job.contentInput[0].missing[0], 'ข้อมูลผู้เขียน');
});

test('user source or interpretation choice invalidates negative cache and is carried to both stages', async () => {
  for (const contentInput of [{ sourceText: 'ข้อมูลจริงที่เพิ่ม', allowOriginalInterpretation: false },
    { guidance: 'ต้นฉบับความเชื่อเชิงบันเทิง ไม่อ้างศาสตร์เฉพาะ', allowOriginalInterpretation: true }]) {
    const h = harness([answer('1.1', rawBody), answer('1.1', finalBody)]);
    h.records.set('1.1', { id: '1.1', md: '', contentDraft: {
      key: P.contentDraftKey(h.machine.book, chapter, section), md: 'ข้อมูลขาด',
      meta: { missing_information: ['ฐานคำพยากรณ์'] }, recoveryAttempted: true } });
    h.machine.book.contentInputs = { '1.1': contentInput };
    await h.machine.writeBatch(input);
    assert.equal(h.calls.length, 2);
    for (const call of h.calls) {
      assert.ok(call.prompt.includes(contentInput.sourceText || contentInput.guidance));
      assert.ok(call.prompt.includes(contentInput.allowOriginalInterpretation ? 'อนุญาตเขียนต้นฉบับเชิงตีความใหม่' : 'ไม่แต่งข้อเท็จจริงที่ยังขาด'));
    }
  }
});
