import test from 'node:test';
import assert from 'node:assert/strict';
import { overallPercent, createProgressTracker, formatEta, stepNumber, STEP_COUNT, STEP_WEIGHTS } from './overall-progress.js';

test('weights add up to 100 and steps map to increasing ranges', () => {
  assert.equal(STEP_WEIGHTS.reduce((n, [, w]) => n + w, 0), 100);
  assert.equal(overallPercent('health', 0), 0);
  assert.equal(overallPercent('write', 0), 7);
  assert.equal(overallPercent('write', 0.5), 29);
  assert.equal(overallPercent('write', 1), overallPercent('figures', 0));
  assert.equal(overallPercent('done'), 100);
  assert.equal(overallPercent('unknown'), 0);
});

test('progress moves inside a step, not only between steps', () => {
  const t = createProgressTracker(() => 0);
  const a = t.update('fit', 0).percent;
  const b = t.update('fit', 0.5).percent;
  assert.ok(b > a, 'the bar used to stay frozen for the whole fit step');
});

test('in-step counters that restart never pull the bar backwards', () => {
  const t = createProgressTracker(() => 0);
  t.update('fit', 0.8);
  assert.equal(t.update('fit', 0.1).percent, overallPercent('fit', 0.8));
});

test('going back to an earlier step (new book) resets the bar', () => {
  const t = createProgressTracker(() => 0);
  t.update('images', 0.5);
  assert.equal(t.update('health', 0).percent, 0);
});

test('ETA hides until there is enough evidence, then uses the real pace', () => {
  let now = 0;
  const t = createProgressTracker(() => now);
  t.update('write', 0);                   // 7%
  now = 30_000;
  assert.equal(t.update('write', 0.2).etaMs, null, 'too early to guess');
  now = 10 * 60_000;
  const { percent, etaMs } = t.update('write', 0.5); // 29% after 10 min → 22% per 10 min
  assert.equal(percent, 29);
  assert.ok(Math.abs(etaMs - (10 * 60_000 / 22) * 71) < 1);
});

test('step numbers count only real steps and ETA text reads naturally', () => {
  assert.equal(STEP_COUNT, 9);
  assert.equal(stepNumber('health'), 1);
  assert.equal(stepNumber('fit'), 7);
  assert.equal(stepNumber('gate_images'), null);
  assert.equal(formatEta(20_000), 'ไม่ถึง 1 นาที');
  assert.equal(formatEta(14 * 60_000), '14 นาที');
  assert.equal(formatEta(95 * 60_000), '1 ชม. 35 นาที');
  assert.equal(formatEta(null), '');
});
