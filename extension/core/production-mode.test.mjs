import test from 'node:test';
import assert from 'node:assert/strict';
import { productionSettings, turnDelay } from './production-mode.js';
import { estimateTurns } from './budget.js';

globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
const { Machine, plannedImageJobs } = await import('./machine.js');
const outline = { chapters: [1, 2].map(n => ({ n, sections: Array.from({length: 7}, (_, i) => ({ id: `${n}.${i+1}`, quota: 1800 })) })) };
const plan = book => new Machine({ book, transport: {} }).planBatches(outline);

test('legacy section and batch books preserve their saved behavior without mutation', () => {
  for (const book of [{}, { writeMode: 'section' }, { writeMode: 'batch', maxCharsPerTurn: 4000, transport: { delayMs: [123, 456] } }]) {
    const before = structuredClone(book);
    assert.equal(plan(book).length, book.writeMode === 'batch' ? 8 : 14);
    assert.deepEqual(turnDelay(book), book.transport?.delayMs || [4000,9000]);
    assert.deepEqual(book, before);
  }
});

test('new presets retain every section in order and obey both limits within chapters', () => {
  for (const mode of ['fast', 'standard', 'detailed']) {
    const saved = JSON.parse(JSON.stringify(productionSettings(mode)));
    const batches = plan(saved);
    assert.deepEqual(batches.flatMap(b => b.sections.map(s => s.id)), outline.chapters.flatMap(c => c.sections.map(s => s.id)));
    for (const batch of batches) {
      assert.ok(batch.sections.length <= saved.maxSectionsPerTurn);
      assert.ok(batch.sections.reduce((n,s) => n+s.quota,0) <= saved.maxCharsPerTurn);
      assert.ok(batch.sections.every(s => s.id.startsWith(`${batch.chapter.n}.`)));
    }
    assert.equal(batches.length, {fast:6, standard:8, detailed:14}[mode]);
    assert.equal(batches.filter(b => b.first).length, 2);
  }
});

test('presets leave images, references, editorial checks and output settings untouched', () => {
  const book = { transport: { delayMs: [4000,9000] }, runConsistency: true, pageMode: 'strict', authorRefTargets: ['figures'], references: ['saved'], referenceStyle: 'ieee', coverMode: 'none', figures: [] };
  const before = structuredClone(book);
  for (const mode of ['fast', 'standard', 'detailed']) {
    const next = {...book, ...productionSettings(mode)};
    for (const key of Object.keys(book)) assert.deepEqual(next[key], book[key]);
    assert.deepEqual(turnDelay(next, true), book.transport.delayMs);
    assert.deepEqual(plannedImageJobs(next), plannedImageJobs(book));
  }
  assert.deepEqual(book, before);
  assert.deepEqual(productionSettings('custom'), {});
});

test('saved presets do not share mutable arrays and estimate respects batch limits', () => {
  const a=productionSettings('fast'); a.textDelayMs[0]=99;
  assert.equal(productionSettings('fast').textDelayMs[0],800);
  const common={targetPages:60, calibration:{charsPerPage:462}, runConsistency:true};
  const fast=estimateTurns({...common,...productionSettings('fast')});
  const standard=estimateTurns({...common,...productionSettings('standard')});
  assert.ok(fast.batches <= standard.batches);
});
