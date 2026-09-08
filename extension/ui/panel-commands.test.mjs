import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

/**
 * ปุ่มหยุด/ทำต่อบนแผงข้างสั่งงานที่เดินอยู่ในหน้า Studio ที่เปิดค้างไว้
 * สองอย่างที่ห้ามพลาด: ห้ามเปิดแท็บใหม่ให้ (หน้าใหม่ไม่มีงานเดินอยู่ คำสั่งจะหายเงียบ)
 * และถ้าไม่มีใครรับ ต้องตอบว่าไม่สำเร็จ ไม่ใช่ปล่อยให้แผงขึ้นว่าสั่งแล้ว
 */
function worker({ studioReply = null } = {}) {
  let listener;
  const calls = [];
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onInstalled: event,
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: async (msg) => {
        calls.push({ relay: msg });
        if (!studioReply) throw new Error('Could not establish connection');
        return studioReply;
      },
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onActivated: event, onUpdated: event, onRemoved: event,
      query: async () => { calls.push({ query: true }); return []; },
      create: async (opts) => { calls.push({ create: opts }); return { id: 7, windowId: 1 }; },
      update: async (id, opts) => { calls.push({ update: opts }); return { id, windowId: 1 }; },
    },
    windows: { update: async () => {} },
    alarms: { create() {}, onAlarm: event },
  };
  vm.runInNewContext(workerSource, { chrome });
  return {
    calls,
    send: (msg) => new Promise((resolve) => listener(msg, {}, resolve)),
  };
}

test('หยุด/ทำต่อ ถูกส่งต่อให้หน้า Studio ที่เปิดอยู่ โดยไม่เปิดแท็บใหม่', async () => {
  for (const command of ['stopJob', 'resumeJob']) {
    const w = worker({ studioReply: { ok: true } });
    assert.deepEqual(await w.send({ type: 'ui.command', command }), { ok: true });
    assert.equal(w.calls.some((c) => c.create), false, 'ห้ามเปิดแท็บ Studio ใหม่');
    assert.equal(w.calls.find((c) => c.relay)?.relay.command, command);
  }
});

test('ไม่มีหน้า Studio รับคำสั่ง ต้องตอบว่าไม่สำเร็จ', async () => {
  const w = worker({ studioReply: null });
  const res = await w.send({ type: 'ui.command', command: 'stopJob' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Studio/);
});
