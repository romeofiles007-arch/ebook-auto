/**
 * ฝ่ายธุรการ — บันทึกกลางของอาการและท่าที่เดินไปแล้ว
 * เส้นแบ่งที่ต้องคุมให้ได้: มันมองอย่างเดียว ไม่ตัดสินใจ ไม่มีเพดานของตัวเอง
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { noteTrouble, troubleSummary, troubleEntries, troubleBrief, startTrouble, SYMPTOMS, MOVES } from './dispatch.js';

test('ตอบสามคำถามที่ระบบตอบไม่ได้มาตลอด: ติดอะไร · ซ้ำกี่ครั้ง · ลองอะไรไปแล้ว', () => {
  startTrouble('เล่มหนึ่ง');
  noteTrouble({ step: 'consistency', symptom: 'prompt_not_sent', move: 'retry' });
  noteTrouble({ step: 'consistency', symptom: 'prompt_not_sent', move: 'new_thread' });
  noteTrouble({ step: 'consistency', symptom: 'prompt_not_sent', move: 'reload_tab' });
  const s = troubleSummary();
  assert.equal(s.repeats, 3, 'อาการเดียวกันที่ขั้นเดียวกันต้องนับเป็นซ้ำที่เดิม');
  assert.deepEqual(s.moves, ['retry', 'new_thread', 'reload_tab']);
  assert.match(s.line, /ส่งคำสั่งไม่ออกจากเครื่องเรา ที่ขั้น consistency/);
  assert.match(s.line, /ซ้ำที่เดิม 3 ครั้ง/);
  assert.match(s.line, /โหลดแท็บ ChatGPT ใหม่/);
});

test('ขยับไปติดที่ใหม่ = ไม่ใช่ซ้ำที่เดิม', () => {
  startTrouble('เล่มสอง');
  noteTrouble({ step: 'write', symptom: 'citation_only', move: 'harden_prompt' });
  noteTrouble({ step: 'write', symptom: 'citation_only', move: 'harden_prompt' });
  noteTrouble({ step: 'images', symptom: 'image_duplicate', move: 'retry' });
  assert.equal(troubleSummary().repeats, 1);
});

test('เริ่มเล่มใหม่ = ล้างกระดาน แต่เรียกซ้ำด้วยเล่มเดิมต้องไม่ล้างงานที่กำลังจด', () => {
  startTrouble('เล่มสาม');
  noteTrouble({ step: 'write', symptom: 'quiet_stall', move: 'press_continue' });
  startTrouble('เล่มสาม');
  assert.equal(troubleEntries().length, 1, 'เล่มเดิมต้องไม่ถูกล้าง');
  startTrouble('เล่มสี่');
  assert.equal(troubleEntries().length, 0);
  assert.equal(troubleSummary().total, 0);
  assert.equal(troubleSummary().line, '');
});

test('ย่อให้ผู้คุมอ่านได้สั้น ๆ', () => {
  startTrouble('เล่มห้า');
  noteTrouble({ step: 'images', symptom: 'image_not_grabbed', move: 'reload_tab' });
  assert.deepEqual(troubleBrief(), ['วาดเสร็จแล้วแต่คว้าภาพไม่ได้ (images) → โหลดแท็บ ChatGPT ใหม่']);
});

test('ของแปลกที่ส่งเข้ามาต้องไม่ทำให้พัง เพราะเรียกจากทางเดินหลัก', () => {
  startTrouble('เล่มหก');
  assert.doesNotThrow(() => noteTrouble());
  assert.doesNotThrow(() => noteTrouble({ symptom: 'ไม่รู้จัก', move: 'ไม่รู้จัก' }));
  assert.ok(troubleSummary().total >= 2);
});

test('บันทึกไม่โตไม่รู้จบ', () => {
  startTrouble('เล่มเจ็ด');
  for (let i = 0; i < 200; i++) noteTrouble({ step: 'write', symptom: 'quiet_stall' });
  assert.ok(troubleEntries().length <= 60);
});

test('เส้นแบ่ง: ฝ่ายธุรการต้องไม่ตัดสินใจและไม่มีผลข้างเคียง', async () => {
  const src = await readFile(new URL('./dispatch.js', import.meta.url), 'utf8');
  // ห้ามสั่งใคร ห้ามยิงข้อความ ห้ามแตะฐานข้อมูล ห้ามตั้งนาฬิกาของตัวเอง
  for (const forbidden of ['chrome.', 'sendMessage', 'import ', 'setTimeout', 'setInterval', 'db.']) {
    assert.ok(!src.includes(forbidden), `ฝ่ายธุรการต้องไม่มี ${forbidden}`);
  }
  // คำศัพท์ต้องปิดตาย ไม่ใช่ข้อความอิสระ
  assert.ok(Object.keys(SYMPTOMS).length >= 8);
  assert.ok(Object.keys(MOVES).length >= 8);
});

/**
 * ต่อสายเข้ากับตัวกู้ทั้งห้าที่ — ถ้าที่ไหนไม่จด ที่นั่นจะกลายเป็นจุดบอดเหมือนเดิม
 */
test('ตัวกู้ทุกที่จดเข้าบันทึกกลาง และยังตัดสินใจเองเหมือนเดิม', async () => {
  const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');

  for (const [src, name, want] of [
    [machine, 'machine', ['citation_only', 'composer_busy', 'prompt_not_sent', 'image_duplicate']],
    [studio, 'studio', ['citation_only', 'composer_busy', 'prompt_not_sent', 'quiet_stall']],
  ]) {
    for (const symptom of want) {
      assert.ok(src.includes(`symptom: '${symptom}'`), `${name} ไม่ได้จดอาการ ${symptom}`);
    }
  }
  // เพดานเดิมต้องยังอยู่ครบ — ฝ่ายธุรการไม่ได้มาแทนที่การตัดสินใจของใคร
  for (const budget of ['MAX_FREE_RETRIES', 'MAX_IMAGE_ATTEMPTS', 'OUTLINE_ATTEMPTS']) {
    assert.ok(machine.includes(budget), `เพดาน ${budget} หายไป`);
  }
  assert.ok(studio.includes('AUTO_CONTINUE_MAX'), 'เพดานกดทำต่อหายไป');
});

test('หน้าจอมีที่พูด และล้างกระดานตอนเริ่มรอบใหม่', async () => {
  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../ui/studio.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="deskNote"'));
  assert.match(studio, /function renderDeskNote\(\)/);
  assert.match(studio, /startTrouble\(book\?\.id \|\| ''\)/);
});
