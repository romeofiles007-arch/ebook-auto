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
  const gate = source.slice(source.indexOf('function openImagePhaseGate'), source.indexOf('function openImagePhaseGate') + 5000);
  assert.match(gate, /unattended && book\.job\?\.status !== 'rate_limited'/);
  // ทางออก "รอคุณอัปโหลดภาพเอง" ต้องปลดธงทั้งสองใบ ไม่งั้นปุ่มอัตโนมัติตายค้างและนาฬิกากดต่อวนเปล่า
  const manual = gate.slice(0, gate.indexOf('} else if'));
  assert.match(manual, /stopAutoPilot\(\);/);
  assert.match(manual, /unattended = false;/);
});

test('กล่องยืนยันไม่ค้างรอคนที่ไม่ได้นั่งอยู่', () => {
  const ask = source.slice(source.indexOf('function ask(message'), source.indexOf('function ask(message') + 400);
  assert.match(ask, /if \(auto && \(autoPilot\(\) \|\| unattended\)\)/);
});

/**
 * ประตูภาพเคยเห็นรอยพลาดของรอบก่อนแล้วหยุดทันทีโดยไม่เริ่มอะไรเลย
 * รอยพลาดถูกเก็บไว้กับเล่ม ทุกครั้งที่กลับมาถึงประตูนี้จึงเจอเงื่อนไขเดิมแล้วหยุดซ้ำ
 * เล่มที่สะดุดหนึ่งรูปจึงไม่มีวันเดินจบเองอีกเลย
 */
const gateBlock = source.slice(
  source.indexOf("    const stuck = book.imagePhase?.failures?.length"),
  source.indexOf('    return await startPhase2();') + 32,
);

async function gate(imagePhase) {
  const calls = [];
  const book = { id: 'b', imagePhase, job: {} };
  const scope = {
    book,
    AUTO_PHASE2_ROUNDS: 2,
    Number,
    Date,
    Infinity,
    // ประตูนี้นับ "ภาพที่ยังขาด" เพื่อดูว่ารอบที่แล้วได้อะไรกลับมาบ้าง
    assetNames: [],
    plannedImageJobs: () => (imagePhase?.remaining || []).map((name) => ({ name, manual: false })),
    db: { saveBook: async () => calls.push('save') },
    stopAutoPilot: () => calls.push('stop'),
    status() {},
    runState: (s, why) => calls.push(`runState:${s}:${why}`),
    addEvent: (kind, title) => calls.push(title),
    startPhase2: async () => calls.push('startPhase2'),
  };
  vm.createContext(scope);
  await vm.runInContext(`(async () => {\n${gateBlock}\n})()`, scope);
  return { calls, rounds: book.imagePhase?.autoRounds };
}

test('ภาพเคยพลาด = ลองใหม่ให้ ไม่ใช่เลิกทั้งเล่มตั้งแต่ยังไม่ได้ลอง', async () => {
  const r = await gate({ failures: [{ name: 'cover' }], status: 'partial' });
  assert.ok(r.calls.includes('startPhase2'));
  assert.equal(r.calls.includes('stop'), false);
  assert.equal(r.rounds, 1);
  assert.match(r.calls.join(), /ลองภาพที่ยังไม่ผ่านอีกครั้ง 1\/2/);
});

test('ลองจนครบเพดานแล้วยังเหมือนเดิม = เรียกคนมาดู', async () => {
  // "เหมือนเดิม" ต้องหมายถึงจำนวนภาพที่ขาดไม่ลดลงด้วย ไม่ใช่แค่ยังมีรอยพลาดค้างอยู่
  const r = await gate({
    failures: [{ name: 'cover' }], status: 'partial', autoRounds: 2,
    remaining: ['cover-front.png', 'cover-back.png'], autoRoundsLeft: 2,
  });
  assert.ok(r.calls.includes('stop'));
  assert.equal(r.calls.includes('startPhase2'), false);
  assert.match(r.calls.join(), /สร้างภาพบางรูปไม่สำเร็จหลังลองอัตโนมัติแล้ว 2 รอบ/);
});

/**
 * รอบที่สร้างภาพได้เพิ่มแม้แต่ใบเดียวคือรอบที่คุ้ม ต้องไม่นับเป็นรอบที่เสียเปล่า
 * ไม่งั้นเล่มที่ค่อย ๆ เก็บภาพทีละใบจะหมดสิทธิ์อัตโนมัติทั้งที่กำลังคืบหน้าอยู่
 */
test('ได้ภาพเพิ่มจากรอบก่อน = ล้างตัวนับ แล้วไปต่อ', async () => {
  const r = await gate({
    failures: [{ name: 'cover' }], status: 'partial', autoRounds: 2,
    remaining: ['cover-back.png'], autoRoundsLeft: 4,
  });
  assert.ok(r.calls.includes('startPhase2'));
  assert.equal(r.calls.includes('stop'), false);
});

test('รอบที่ผ่านหมดรีเซ็ตตัวนับ ไม่สะสมข้ามรอบ', async () => {
  const r = await gate({ status: 'complete', autoRounds: 2 });
  assert.ok(r.calls.includes('startPhase2'));
  assert.equal(r.rounds, 0);
});

test('ตอนจบยึดเจตนาของเล่ม ไม่ใช่ธงที่หลุดไปแล้ว', () => {
  assert.match(source, /const wasFullAuto = fullAutoRunning \|\| \(unattended && book\?\.automation\?\.mode === 'full'\)/);
});
