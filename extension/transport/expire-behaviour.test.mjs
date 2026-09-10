/**
 * เทิร์นหายไปเฉย ๆ — ต้องถามหน้าเว็บว่าเกิดอะไรขึ้น ไม่ใช่เดาจากขั้นล่าสุดที่ได้ยิน
 *
 * ของจริงสองครั้งติด: บันทึกบอกว่าค้างที่ขั้น "พิมพ์ Prompt ลงช่อง" 590 วินาที
 * แล้วนาฬิกาใหญ่ตัดที่ 601 วินาที — แต่คำตอบเต็ม ๆ ของ ChatGPT อยู่บนจอเรียบร้อยแล้ว
 * แปลว่าขั้นล่าสุดที่ได้ยินไม่ได้บอกว่าส่งไปหรือยัง มันบอกแค่ว่าเราได้ยินอะไรครั้งสุดท้าย
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let listener = null;
let probeReply = null;
const probes = [];
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: async (m) => {
      if (m?.type === 'sw.recoverTurn') { probes.push(m); return probeReply; }
      return { ok: true };
    },
  },
};
const { ChatGptTabTransport, hasPendingTurn } = await import('./chatgpt-tab.js');

async function timedOut(phases, reply) {
  probeReply = reply;
  const tr = new ChatGptTabTransport({});
  const p = tr.send('คำสั่งของเรา', { outerTimeoutMs: 30 });
  for (const phase of phases) listener({ type: 'gpt.progress', turnId: tr.lastTurnId, phase });
  return await p;
}

test('ผลอยู่ที่แท็บแล้ว แค่ข้อความแจ้งผลหาย — ต้องเอากลับมาใช้ ไม่ใช่ทิ้งแล้วสั่งใหม่', async () => {
  const r = await timedOut(['typing'], { state: 'done', result: { status: 'ok', text: '{"verdict":"needs_fix"}', meta: {} } });
  assert.equal(r.status, 'ok');
  assert.equal(r.text, '{"verdict":"needs_fix"}');
  assert.equal(r.meta.recoveredAfterTimeout, true);
});

test('แท็บยืนยันว่าไม่มีข้อความของเราบนหน้า = ยังไม่เคยส่ง กู้ได้', async () => {
  const r = await timedOut(['typing'], { state: 'not_sent' });
  assert.equal(r.meta.error, 'prompt_not_sent');
  assert.match(r.meta.detail, /พิมพ์ Prompt ลงช่อง/);
});

test('ข้อความขึ้นไปแล้วแต่ไม่มีผล = ตอบไม่ได้ ห้ามส่งซ้ำ แม้ขั้นล่าสุดจะเป็น "พิมพ์"', async () => {
  const r = await timedOut(['typing'], { state: 'sent_unknown' });
  assert.equal(r.meta.error, 'outcome_unknown');
  assert.match(r.meta.detail, /ขึ้นไปบนหน้าแล้ว/);
});

test('แท็บบอกว่ายังทำอยู่ = ห้ามส่งซ้ำเด็ดขาด', async () => {
  assert.equal((await timedOut(['typing'], { state: 'running' })).meta.error, 'outcome_unknown');
});

test('ถามแท็บไม่ได้ = ตอบไม่ได้ ต้องระวังไว้ก่อน', async () => {
  assert.equal((await timedOut(['typing'], null)).meta.error, 'outcome_unknown');
  assert.equal((await timedOut(['typing'], { state: 'unreachable' })).meta.error, 'outcome_unknown');
});

test('ได้ผลตามปกติ นาฬิกาต้องไม่แตะ ไม่ต้องถามแท็บ และคิวต้องถูกปลด', async () => {
  probes.length = 0;
  const tr = new ChatGptTabTransport({});
  const p = tr.send('คำสั่งของเรา', {});
  assert.equal(hasPendingTurn(), true);
  listener({ type: 'gpt.result', turnId: tr.lastTurnId, status: 'ok', text: 'เนื้อหา' });
  const r = await p;
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'เนื้อหา');
  assert.equal(hasPendingTurn(), false);
  assert.equal(probes.length, 0, 'เทิร์นที่สำเร็จต้องไม่ไปรบกวนแท็บ');
});
