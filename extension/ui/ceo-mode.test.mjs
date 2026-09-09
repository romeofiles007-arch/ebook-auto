import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('function ceoModeOn() {');
const block = source.slice(start, source.indexOf('\nfunction makeSupervisor()', start));

/**
 * โหมด CEO ใช้เงินของผู้ใช้ จึงต้องเป็นการติ๊กเอง ไม่ใช่เปิดให้เองเพราะบังเอิญมีคีย์อยู่
 * และสถานะที่แสดงต้องตรงความจริงเสมอ — ติ๊กไว้แต่ไม่มีคีย์ = ยังไม่มีผู้คุม
 */
function fixture({ checked = false, key = '' } = {}) {
  const nodes = { ceoMode: { checked }, ceoModeHint: { textContent: '' } };
  const scope = { apiKeyValue: key, $: (id) => nodes[id] };
  vm.runInNewContext(`${block}\nglobalThis.on = ceoModeOn; globalThis.sync = syncCeoMode;`, scope);
  return { on: scope.on, sync: scope.sync, hint: () => nodes.ceoModeHint.textContent };
}

test('ไม่ติ๊ก = ไม่มีผู้คุม แม้จะมีคีย์อยู่ก็ตาม', () => {
  const f = fixture({ checked: false, key: 'sk-test' });
  assert.equal(f.on(), false);
  f.sync();
  assert.match(f.hint(), /ปิดอยู่/);
});

test('ติ๊กแล้วมีคีย์ = ใช้งานได้จริง', () => {
  const f = fixture({ checked: true, key: 'sk-test' });
  assert.equal(f.on(), true);
  f.sync();
  assert.match(f.hint(), /เปิดอยู่/);
  assert.match(f.hint(), /ไม่เขียนเนื้อหาสักตัว/);
});

test('ติ๊กแต่ไม่มีคีย์ = ต้องบอกตรง ๆ ว่ายังไม่มีผู้คุม ไม่ใช่ปล่อยให้เข้าใจว่าเปิดแล้ว', () => {
  const f = fixture({ checked: true, key: '' });
  assert.equal(f.on(), false);
  f.sync();
  assert.match(f.hint(), /ยังไม่ได้ใส่ API key/);
});
