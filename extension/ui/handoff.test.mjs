import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = source.indexOf('const HANDOFF_MS =');
const block = source.slice(start, source.indexOf('\n});', source.indexOf('const transportOpts =')) + 4);

/**
 * ด่านสุดท้ายของการส่ง Prompt คือค้างไว้ในช่องแล้วรอคนกด Enter
 * โหมดอัตโนมัติไม่มีใครนั่งเฝ้า การรอสามนาทีจึงเป็นการนอนรอสิ่งที่ไม่มีวันมา
 * แล้วค่อยล้มเทิร์นทีหลังอยู่ดี — เสียเวลาฟรีสามนาทีต่อการล้มหนึ่งครั้ง
 */
function optsWith(auto) {
  const scope = {
    handleGptMessage: () => {},
    apiKeyValue: '',
    textApiModel: () => 'model',
    autoPilot: () => auto,
  };
  vm.runInNewContext(`${block}\nglobalThis.out = transportOpts();`, scope);
  return scope.out;
}

test('โหมดอัตโนมัติรอคนกด Enter สั้น ๆ แล้วไปลองใหม่เอง', () => {
  assert.equal(optsWith(true).handoffMs, 20000);
});

test('เวลาคนนั่งทำเอง ยังรอให้เต็มสามนาทีเหมือนเดิม', () => {
  assert.equal(optsWith(false).handoffMs, 180000);
});

test('ผู้เรียกยังทับค่าเองได้ ไม่ถูกล็อกตายจากโหมด', () => {
  const scope = {
    handleGptMessage: () => {},
    apiKeyValue: '',
    textApiModel: () => 'model',
    autoPilot: () => true,
  };
  vm.runInNewContext(`${block}\nglobalThis.out = transportOpts({ handoffMs: 5000 });`, scope);
  assert.equal(scope.out.handoffMs, 5000);
});
