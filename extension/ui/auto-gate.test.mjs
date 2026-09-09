import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * เล่มที่สั่งให้เดินจนจบ ต้องไม่ไปนอนรอคนที่ประตูตรวจต้นฉบับ
 *
 * ธง fullAutoRunning ถูกปลดทุกครั้งที่งานสะดุด ซึ่งถูกตามเจตนาเดิม (กันประตูผ่านเองซ้ำ)
 * แต่ไม่มีใครติดกลับให้เมื่องานเดินต่อได้แล้ว ประตูที่เคยผ่านเองจึงกลายเป็นจุดที่งานหยุดค้าง
 */
const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('  if (!fullAutoRunning && unattended && book?.automation?.mode === \'full\') {');
const block = source.slice(start, source.indexOf('\n  }', start) + 4);

function rearm({ fullAutoRunning = false, unattended = false, mode = 'full' } = {}) {
  const events = [];
  const scope = {
    fullAutoRunning,
    unattended,
    book: mode ? { automation: { mode } } : {},
    addEvent: (kind, title) => events.push(title),
  };
  vm.createContext(scope);
  vm.runInContext(block, scope);
  return { on: scope.fullAutoRunning, events };
}

test('เล่มที่สั่งอัตโนมัติไว้ ติดธงกลับเองเมื่อเครื่องเริ่มเดินอีกครั้ง', () => {
  const r = rearm({ unattended: true, mode: 'full' });
  assert.equal(r.on, true);
  assert.match(r.events.join(), /เดินต่อตามที่สั่งไว้/);
});

test('เล่มที่ผู้ใช้คุมเอง ไม่ถูกเปลี่ยนเป็นอัตโนมัติ', () => {
  assert.equal(rearm({ unattended: true, mode: 'guided' }).on, false);
});

test('สั่งหยุดไปแล้ว = หยุดจริง ธงไม่ถูกติดกลับ', () => {
  // unattended ถูกปลดเมื่อคนกดหยุดหรือผู้คุมสั่งหยุดเท่านั้น
  assert.equal(rearm({ unattended: false, mode: 'full' }).on, false);
});

test('ธงที่ติดอยู่แล้วไม่ถูกประกาศซ้ำ', () => {
  const r = rearm({ fullAutoRunning: true, unattended: true, mode: 'full' });
  assert.equal(r.on, true);
  assert.equal(r.events.length, 0);
});

test('ติดธงตอนเครื่องเริ่มเดิน ไม่ใช่ตอนเปิดประตูภาพ', () => {
  const run = source.slice(source.indexOf('async function runMachine'), source.indexOf('  machineBusy = true;'));
  assert.match(run, /fullAutoRunning = true/);
  // ประตูภาพมีเหตุผลของตัวเองที่ต้องรอคนเมื่อชนลิมิต ห้ามให้ตรงนั้นเริ่มเอง
  const gate = source.slice(source.indexOf('function openImagePhaseGate'), source.indexOf('function openImagePhaseGate') + 3000);
  assert.match(gate, /unattended && book\.job\?\.status !== 'rate_limited'/);
});

test('กล่องยืนยันไม่ค้างรอคนที่ไม่ได้นั่งอยู่', () => {
  const ask = source.slice(source.indexOf('function ask(message'), source.indexOf('function ask(message') + 400);
  assert.match(ask, /if \(auto && \(autoPilot\(\) \|\| unattended\)\)/);
});
