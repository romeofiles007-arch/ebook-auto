import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { enforceAuthorRefPrompt, promptWantsAuthorRef, wantsAuthorRef } from './imageRef.js';

test('rewritten cover prompt still requests the author photograph', () => {
  assert.equal(promptWantsAuthorRef('Human subject: use the person from the attached author reference photograph'), true);
  assert.equal(wantsAuthorRef({ authorRefTargets: ['cover-front'] }, { name: 'cover-front.png' }), true);
  assert.equal(promptWantsAuthorRef('Draw an abstract landscape'), false);
});

test('selected author reference removes conflicting no-person instructions', () => {
  const prompt = enforceAuthorRefPrompt(`SUBJECT: a calendar on a desk.
NO HUMAN FIGURE. Ignore any attached author reference photo for this image.
Keep the scene minimal.`);
  assert.doesNotMatch(prompt, /NO HUMAN FIGURE|Ignore any attached author reference/i);
  assert.match(prompt, /MUST contain at least one clearly visible human figure/i);
  assert.match(prompt, /recognisably the same individual/i);
  assert.match(prompt, /SUBJECT: a calendar on a desk/);
  assert.match(prompt, /Keep the scene minimal/);
  assert.equal(enforceAuthorRefPrompt(prompt), prompt);
});

test('all selected targets require the author while page patterns do not', () => {
  const book = { authorRefTargets: ['cover-front', 'cover-back', 'figures'] };
  for (const job of [
    { name: 'cover-front.png', kind: 'cover' },
    { name: 'cover-back.png', kind: 'cover' },
    { name: 'fig-2.1.png', kind: 'interior' },
  ]) assert.equal(wantsAuthorRef(book, job), true);
  assert.equal(wantsAuthorRef(book, { name: 'page-pattern.png', kind: 'pattern' }), false);
});

test('final planned prompts for front, back and interior all enforce author likeness', async () => {
  globalThis.chrome ||= { runtime: { onMessage: { addListener() {} } } };
  const { plannedImageJobs } = await import('./machine.js');
  const jobs = plannedImageJobs({
    coverMode: 'auto',
    coverPrompts: {
      front: 'Front cover. NO HUMAN FIGURE.',
      back: 'Back cover. Ignore the attached author photograph.',
    },
    figureMode: 'auto',
    figures: [{ kind: 'image', name: 'fig-1.png', section: '1.1', prompt: 'Diagram only. NO PEOPLE.' }],
    authorRefTargets: ['cover-front', 'cover-back', 'figures'],
  }).filter((job) => job.kind !== 'pattern');
  assert.deepEqual(jobs.map((job) => job.name), ['cover-front.png', 'cover-back.png', 'fig-1.png']);
  for (const job of jobs) {
    assert.equal(job.needsAuthorRef, true);
    assert.doesNotMatch(job.prompt, /NO HUMAN FIGURE|NO PEOPLE|Ignore the attached author/i);
    assert.match(job.prompt, /MUST contain at least one clearly visible human figure/i);
  }
});

test('failed or partial attachment returns before the prompt can be sent', async () => {
  const source = await readFile(new URL('../adapter/chatgpt.js', import.meta.url), 'utf8');
  const start = source.indexOf('        attachment = await attachFiles(opts.attachments);');
  const end = source.indexOf('        report(', start);
  for (const result of [{ attached: 0, errors: [] }, { attached: 1, errors: ['upload failed'] }]) {
    const run = vm.runInNewContext(`(async () => { let attachment; ${source.slice(start, end)} throw Error('must not send'); })`, {
      opts: { attachments: [{}] }, turnId: 'test', attachFiles: async () => result,
    });
    assert.equal((await run()).meta.error, 'attachment_failed');
  }
});
