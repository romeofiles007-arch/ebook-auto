import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const start = source.indexOf('  async askSupervisor(context) {');
const fn = source.slice(start, source.indexOf('\n  }', start) + 4);

/**
 * ผู้คุมกระบวนการต้องเป็นของเสริม ไม่ใช่ของที่ระบบพึ่งพา
 * ไม่มีคีย์ ไม่ได้ต่อ หรือถามแล้วพัง — ทุกกรณีต้องกลับไปเดินทางเดิมได้เสมอ
 */
function machineLike(supervisor) {
  const logs = [];
  const scope = { console };
  vm.runInNewContext(`globalThis.make = (supervisor, logs) => ({ supervisor, log:(lv,m)=>logs.push(lv+': '+m), ${fn.trim().replace(/^async function |^  async /, 'askSupervisor: async ').replace('askSupervisor(context) {', 'askSupervisor(context) {')} });`, scope);
  return { obj: scope.make(supervisor, logs), logs };
}

test('ไม่มีผู้คุม = คืน null เงียบ ๆ ให้ผู้เรียกทำตามทางเดิม', async () => {
  const { obj, logs } = machineLike(null);
  assert.equal(await obj.askSupervisor({ step: 'write' }), null);
  assert.deepEqual(logs, [], 'ไม่มีผู้คุมไม่ใช่ความผิดปกติ ต้องไม่รกบันทึก');
});

test('คำตัดสินที่ใช้ได้ถูกบันทึกพร้อมเหตุผล จะได้ตรวจย้อนได้ว่าตัดสินใจอะไรไป', async () => {
  const { obj, logs } = machineLike(async () => ({ action: 'new_thread', reason: 'ห้องเดิมส่งไม่ออก' }));
  const got = await obj.askSupervisor({ step: 'write' });
  assert.equal(got.action, 'new_thread');
  assert.match(logs.join('\n'), /new_thread — ห้องเดิมส่งไม่ออก/);
});

test('ถามผู้คุมแล้วพัง ต้องไม่ลามไปล้มงาน', async () => {
  const { obj, logs } = machineLike(async () => { throw new Error('เน็ตหลุด'); });
  assert.equal(await obj.askSupervisor({ step: 'write' }), null);
  assert.match(logs.join('\n'), /ถามผู้คุมกระบวนการไม่สำเร็จ/);
});

test('ผู้คุมตอบของว่าง = ถือว่าไม่ได้ตัดสิน', async () => {
  const { obj } = machineLike(async () => ({}));
  assert.equal(await obj.askSupervisor({ step: 'write' }), null);
});
