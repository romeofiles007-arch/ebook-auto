import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

function worker({ mismatch = false, staleDisabledStop = false, session = {} } = {}) {
  let listener;
  const calls = [];
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onInstalled: event,
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
    storage: { session: {
      get: async (key) => key in session ? { [key]: session[key] } : {},
      set: async (value) => Object.assign(session, value),
    } },
    tabs: {
      onActivated: event, onUpdated: event, onRemoved: event,
      get: async (id) => ({ id, url: 'https://chatgpt.com/c/test' }),
      query: async () => { throw new Error('must not choose the active tab'); },
      sendMessage: async (id, msg) => {
        calls.push({ id, msg });
        return msg.type === 'gpt.ping' ? { ok: true } : { ok: true, dataUrl: 'data:image/png;base64,test' };
      },
    },
    debugger: {
      attach: (target, version, done) => { calls.push({ target, attach: true }); done(); },
      detach: (target, done) => { calls.push({ target, detach: true }); done(); },
      sendCommand: (target, method, params, done) => { calls.push({ target, method, params }); done({}); },
    },
    scripting: { executeScript: async (request) => {
      const verify = request.args?.length === 1;
      calls.push({ verify, target: request.target });
      if (staleDisabledStop && request.args?.length === 2) {
        const box = {
          innerText: request.args[0],
          focus() { page.document.activeElement = box; },
        };
        const stop = {
          disabled: true,
          getAttribute: () => '',
          getBoundingClientRect: () => ({ width: 40, height: 40 }),
        };
        const page = { document: {
          activeElement: null,
          querySelector: (selector) => selector === '#prompt-textarea' ? box : null,
          querySelectorAll: (selector) => selector === '[data-testid="stop-button"]' ? [stop] : [],
        } };
        const result = vm.runInNewContext(
          `(${request.func.toString()})(${JSON.stringify(request.args[0])}, true)`,
          page,
        );
        return [{ result }];
      }
      return [{ result: verify ? !mismatch : true }];
    } },
    alarms: { create() {}, onAlarm: event },
  };
  vm.runInNewContext(workerSource, { chrome, setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {} });
  return {
    calls,
    send: (msg, sender = { tab: { id: 7, url: 'https://chatgpt.com/c/test' } }) =>
      new Promise((resolve) => listener(msg, sender, resolve)),
  };
}

test('recovery replaces the editor selection before sending, on the requesting tab', async () => {
  const w = worker();
  assert.equal((await w.send({ type: 'sw.forceSend', text: 'one prompt' })).ok, true);
  const input = w.calls.filter((c) => c.method);
  assert.equal(input[0].params.key, 'a');
  assert.equal(input[0].params.modifiers, 2);
  assert.equal(input[2].method, 'Input.insertText');
  assert.equal(input[2].params.text, 'one prompt');
  assert.ok(input.every((c) => c.target.tabId === 7));
  assert.ok(input.some((c) => c.params.key === 'Enter'));
  assert.ok(w.calls.findIndex((c) => c.verify) < w.calls.findIndex((c) => c.params?.key === 'Enter'));
});

test('duplicate or mismatched text is never submitted and debugger is detached', async () => {
  const w = worker({ mismatch: true });
  const result = await w.send({ type: 'sw.forceSend', text: 'one prompt' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'composer_text_mismatch');
  assert.equal(w.calls.some((c) => c.params?.key === 'Enter'), false);
  assert.ok(w.calls.some((c) => c.detach));
});

test('browser Enter ignores a disabled stale Stop spinner after an image completed', async () => {
  const w = worker({ staleDisabledStop: true });
  const result = await w.send({ type: 'sw.forceSend', text: 'next image prompt', requireDraft: true });
  assert.equal(result.ok, true);
  assert.ok(w.calls.some((c) => c.params?.key === 'Enter'));
});

test('automatic image recovery uses the original tab and turn', async () => {
  const w = worker({ session: { imageTurnTabs: { t1: 7 }, chatTabId: 99 } });
  assert.equal((await w.send({ type: 'sw.grabImage', turnId: 't1' })).ok, true);
  const grab = w.calls.find((c) => c.msg?.type === 'gpt.grabImage');
  assert.equal(grab.id, 7);
  assert.equal(grab.msg.turnId, 't1');
});

test('unknown image turn fails closed instead of taking the latest image', async () => {
  const w = worker();
  const result = await w.send({ type: 'sw.grabImage', turnId: 'not-sent' });
  assert.equal(result.error, 'image_turn_not_available');
  assert.equal(w.calls.length, 0);
});

async function adapterFixture() {
  const nodes = [];
  const images = [];
  const document = {
    querySelector: () => null,
    querySelectorAll: (sel) => sel === 'img' ? images : sel === '[data-message-author-role="user"]' ? nodes : [],
  };
  document.body = document;
  const context = {
    document, window: {}, Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 },
    chrome: {
      storage: { local: { get: async () => ({ selectors: { assistantTurn: '[data-message-author-role="assistant"]' } }) } },
      runtime: { onMessage: { addListener() {} } },
    },
  };
  // Expose private functions only in this test VM; production has no test hook.
  vm.runInNewContext(adapterSource.replace(/\}\)\(\);\s*$/, 'globalThis.fixture = { scanImages, imageTurns, selectors: () => S }; })();'), context);
  await Promise.resolve();
  function node(order, src, user = false) {
    return {
      order, naturalWidth: 1536, naturalHeight: 1024, complete: true,
      src, currentSrc: src,
      compareDocumentPosition(other) { return other.order > order ? 4 : 2; },
      contains(other) { return other === this; },
      closest() { return user ? {} : null; },
      getAttribute(name) { return name === 'src' ? src : ''; },
    };
  }
  return { ...context.fixture, document, nodes, images, node };
}

test('old saved selector is migrated to support image-only assistant sections', async () => {
  const a = await adapterFixture();
  assert.match(a.selectors().assistantTurn, /data-turn="assistant"/);
});

test('image scan excludes author uploads, earlier replies and later turns', async () => {
  const a = await adapterFixture();
  const anchor = a.node(2);
  a.nodes.push(anchor, a.node(5));
  a.images.push(
    a.node(1, 'https://chatgpt.com/files/old.png'),
    a.node(3, 'https://chatgpt.com/files/author.jpg', true),
    a.node(4, 'https://chatgpt.com/files/wanted.png'),
    a.node(6, 'https://chatgpt.com/files/later.png'),
  );
  assert.deepEqual(Array.from(a.scanImages(undefined, anchor).images), ['https://chatgpt.com/files/wanted.png']);
});

test('image scan sees generated images rendered outside the first main portal', async () => {
  const a = await adapterFixture();
  const anchor = a.node(2);
  a.nodes.push(anchor);
  a.images.push(a.node(3, 'https://chatgpt.com/backend-api/files/generated.png'));
  const firstMain = { querySelectorAll: () => [], querySelector: () => null };
  a.document.querySelector = (sel) => sel === 'main' ? firstMain : null;
  assert.deepEqual(Array.from(a.scanImages(undefined, anchor).images), [
    'https://chatgpt.com/backend-api/files/generated.png',
  ]);
});

test('disabled composer is classified as recoverable without shortening image generation waits', () => {
  assert.match(adapterSource, /COMPOSER_STUCK_SILENCE_MS\s*=\s*30000/);
  assert.match(adapterSource, /staleMs:\s*COMPOSER_STUCK_SILENCE_MS/);
  assert.match(adapterSource, /STUCK_SILENCE_MS\s*=\s*120000/);
  assert.match(adapterSource, /timeoutMs:\s*opts\.imageTimeoutMs\s*\?\?\s*480000/);
  assert.match(adapterSource, /sendError === 'composer_busy_stuck'[\s\S]*error:sendError/);
});

test('a captured image gets a short stuck-spinner grace without shortening ordinary turns', () => {
  const start = adapterSource.indexOf('const STUCK_SILENCE_MS');
  const end = adapterSource.indexOf('async function waitUntilIdle', start);
  const values = vm.runInNewContext(`${adapterSource.slice(start, end)}; [idleSilenceMs(false), idleSilenceMs(true)]`);
  assert.deepEqual([...values], [120000, 8000]);
  assert.match(adapterSource, /if \(captured\.dataUrl\) completedImageTurn = \{ anchor/);
  assert.match(adapterSource, /if \(capturedImageIsLast\)[\s\S]*visibleStopButton\(\)\?\.click\(\)/);
});

test('browser-native Enter is attempted before the fragile DOM button', () => {
  const start = adapterSource.indexOf("report(turnId, 'sending', 'กำลังกดส่ง");
  const end = adapterSource.indexOf("report(turnId,'submitted'", start);
  const block = adapterSource.slice(start, end);
  assert.ok(block.indexOf("type:'sw.forceSend'") >= 0);
  assert.ok(block.indexOf("type:'sw.forceSend'") < block.indexOf('clickSend('));
  assert.match(block, /native\?\.ok[\s\S]*outcome_unknown[\s\S]*ไม่กดซ้ำ/);
});
