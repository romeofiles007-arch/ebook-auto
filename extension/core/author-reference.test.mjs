import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { promptWantsAuthorRef, wantsAuthorRef } from './imageRef.js';

test('rewritten cover prompt still requests the author photograph', () => {
  assert.equal(promptWantsAuthorRef('Human subject: use the person from the attached author reference photograph'), true);
  assert.equal(wantsAuthorRef({ authorRefTargets: ['cover-front'] }, { name: 'cover-front.png' }), true);
  assert.equal(promptWantsAuthorRef('Draw an abstract landscape'), false);
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
