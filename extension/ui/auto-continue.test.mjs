import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('const AUTO_CONTINUE_MAX =');
const block = source.slice(start, source.indexOf('\n}', source.indexOf('function shouldAutoContinue')) + 2);
const scope = {};
vm.runInNewContext(`${block}\nglobalThis.decide = shouldAutoContinue;\nglobalThis.QUIET = AUTO_CONTINUE_QUIET_MS;`, scope);
const { decide, QUIET } = scope;

/**
 * ตัวกดทำต่อให้เองมีไว้แก้สภาพเดียว: งานที่ถูกหยุดแล้วนอนรออยู่เฉย ๆ ทั้งที่ยังไม่จบ
 * ทุกเงื่อนไขในนี้คือกรณีที่ "กดต่อแล้วแย่ลง" ซึ่งต้องไม่ถูกแตะ
 */
const stalled = { unattended: true, busy: false, job: { step: 'write', status: 'paused' }, quietMs: QUIET };

test('งานที่นิ่งสนิทในโหมดไร้คนเฝ้า ถูกกดต่อให้', () => {
  assert.equal(decide(stalled), true);
});

test('ยังไม่นิ่งนานพอ ต้องไม่แตะ', () => {
  assert.equal(decide({ ...stalled, quietMs: QUIET - 1 }), false);
});

test('มีงานเดินอยู่ ห้ามกดซ้อน', () => {
  assert.equal(decide({ ...stalled, busy: true }), false);
});

test('ชนลิมิตข้อความ ห้ามกดต่อ เพราะไปชนซ้ำและเผาโควตาที่เหลือ', () => {
  assert.equal(decide({ ...stalled, job: { step: 'write', status: 'rate_limited' } }), false);
});

test('ผู้ใช้สั่งหยุดเอง (ปลดโหมดไร้คนเฝ้าแล้ว) ต้องหยุดจริง', () => {
  assert.equal(decide({ ...stalled, unattended: false }), false);
});

test('งานที่จบแล้วหรือไม่มีงานค้าง ไม่มีอะไรให้ทำต่อ', () => {
  assert.equal(decide({ ...stalled, job: { step: 'done', status: 'done' } }), false);
  assert.equal(decide({ ...stalled, job: null }), false);
});
