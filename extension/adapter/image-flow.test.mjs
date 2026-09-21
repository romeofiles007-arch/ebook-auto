import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

function worker({ mismatch = false, staleDisabledStop = false, realDraft = null, failEnter = false, session = {} } = {}) {
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
      sendCommand: (target, method, params, done) => {
        calls.push({ target, method, params });
        if (failEnter && params.key === 'Enter') chrome.runtime.lastError = { message: 'input connection lost' };
        done({});
        delete chrome.runtime.lastError;
      },
    },
    scripting: { executeScript: async (request) => {
      const verify = typeof request.args?.[1] !== 'boolean';
      calls.push({ verify, target: request.target });
      if (realDraft) {
        const thumbs = realDraft.thumbs || [];
        const form = { querySelectorAll: () => thumbs, querySelector: () => realDraft.uploading ? {} : null };
        const box = { innerText: realDraft.text, closest: () => form,
          focus() { if (!realDraft.focusFails) page.document.activeElement = box; } };
        const page = { document: { activeElement: null, querySelector: () => box, querySelectorAll: () => [] } };
        // The focus from the first injection persists into the final verification.
        if (verify && !realDraft.focusFails) page.document.activeElement = box;
        return [{ result: vm.runInNewContext(`(${request.func.toString()})(...args)`, { ...page, args: request.args }) }];
      }
      if (staleDisabledStop && !verify) {
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

test('image send focuses the existing prompt and only dispatches Enter, after checking attachments', async () => {
  const w = worker({ realDraft: { text: 'image prompt', thumbs: [{ complete: true, naturalWidth: 600 }] } });
  const result = await w.send({ type: 'sw.forceSend', text: 'image prompt', enterOnly: true, expectedAttachments: 1 });
  assert.equal(result.ok, true);
  const input = w.calls.filter(c => c.method);
  assert.deepEqual(input.map(c => c.params.key), ['Enter', 'Enter', 'Enter']);
  assert.ok(w.calls.findIndex(c => c.verify) < w.calls.findIndex(c => c.method));
});

for (const [reason, draft] of Object.entries({
  'wrong prompt': { text: 'old prompt' },
  'missing attachment': { text: 'image prompt' },
  'extra attachment': { text: 'image prompt', thumbs: [{ complete: true, naturalWidth: 600 }, { complete: true, naturalWidth: 600 }] },
  'image still loading': { text: 'image prompt', thumbs: [{ complete: false, naturalWidth: 0 }] },
  'upload in progress': { text: 'image prompt', thumbs: [{ complete: true, naturalWidth: 600 }], uploading: true },
  'focus failed': { text: 'image prompt', focusFails: true },
})) test(`image Enter is blocked for ${reason}`, async () => {
  const w = worker({ realDraft: draft });
  const result = await w.send({ type: 'sw.forceSend', text: 'image prompt', enterOnly: true, expectedAttachments: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.enterAttempted, false);
  assert.equal(w.calls.some(c => c.method), false);
  assert.ok(w.calls.some(c => c.detach));
});

test('failed Enter reports an uncertain send rather than claiming no input occurred', async () => {
  const w = worker({ failEnter: true });
  const result = await w.send({ type: 'sw.forceSend', text: 'image prompt', enterOnly: true });
  assert.equal(result.ok, false);
  assert.equal(result.enterAttempted, true);
});

async function sendBlock({ image = true, native = { ok: false, enterAttempted: false }, receipt = null, disconnected = false } = {}) {
  const start = adapterSource.indexOf("report(turnId, 'sending', 'กำลังกดส่ง");
  const end = adapterSource.indexOf("report(turnId,'submitted'", start);
  const calls = [];
  const context = {
    opts: { wantImages: image, attachments: [{}] }, prompt: 'image prompt', turnId: 't1',
    userMessagesBefore: {}, composerBox: {}, completedImageTurn: null,
    report() {}, setTimeout() {}, Date,
    chrome: { runtime: { sendMessage: async msg => { calls.push(msg); if (disconnected) throw new Error('worker disconnected'); return native; } } },
    waitForDom: async fn => fn(), findUserReceipt: () => receipt,
    nothingWasSent: () => true, composerMatches: () => true, stopButtonVisible: () => false,
    clickSend: async () => { calls.push('DOM click'); return {}; },
  };
  const result = await vm.runInNewContext(`(async () => { ${adapterSource.slice(start, end)} return { status: 'submitted' }; })()`, context);
  return { calls, result };
}

test('image jobs never switch to the DOM send button when native Enter is rejected', async () => {
  const { calls, result } = await sendBlock();
  assert.equal(calls[0].enterOnly, true);
  assert.equal(calls[0].expectedAttachments, 1);
  assert.equal(calls.includes('DOM click'), false);
  assert.equal(result.meta.error, 'send_action_not_accepted');
});

test('text jobs retain their DOM fallback when native input was not attempted', async () => {
  const { calls, result } = await sendBlock({ image: false });
  assert.equal(calls[0].enterOnly, false);
  assert.equal(calls.includes('DOM click'), true);
  assert.equal(result.status, 'submitted');
});

test('uncertain native send never falls through to a second send, even with a full draft', async () => {
  const { calls, result } = await sendBlock({ native: { ok: false, enterAttempted: true } });
  assert.equal(calls.includes('DOM click'), false);
  assert.equal(result.meta.error, 'outcome_unknown');
});

test('an uncertain Enter can still complete when its matching user receipt exists', async () => {
  const { calls, result } = await sendBlock({ native: { ok: false, enterAttempted: true }, receipt: {} });
  assert.equal(calls.includes('DOM click'), false);
  assert.equal(result.status, 'submitted');
});

test('a disconnected image sender stops without assuming the full draft is safe to resend', async () => {
  const { calls, result } = await sendBlock({ disconnected: true });
  assert.equal(calls.includes('DOM click'), false);
  assert.equal(result.meta.error, 'outcome_unknown');
});

async function imageSubmission({ ready = true } = {}) {
  const start = adapterSource.indexOf('      let attachment = null;');
  const end = adapterSource.indexOf("report(turnId,'submitted'", start);
  const calls = [];
  const box = { innerText: '' };
  const context = {
    opts: { wantImages: true, attachments: [{ dataUrl: 'data:image/png;base64,ref' }] },
    prompt: 'image prompt', turnId: 't1', userMessagesBefore: {}, completedImageTurn: null,
    S: { composer: '#prompt-textarea' }, $: () => box,
    report() {}, setTimeout() {}, Date, napMs: async () => {}, waitComposerStable: async () => {},
    attachFiles: async () => { calls.push('attach complete'); return { attached: 1, errors: [] }; },
    imageDraftAttachmentsReady: () => { calls.push('check attachment'); return ready; },
    injectText: async text => { calls.push('type prompt'); box.innerText = text; return box; },
    chrome: { runtime: { sendMessage: async msg => { calls.push(msg.enterOnly ? 'Enter only' : 'other send'); return { ok: true }; } } },
    waitForDom: async fn => fn(), findUserReceipt: () => ({}),
    nothingWasSent: () => false, composerMatches: () => true, stopButtonVisible: () => false,
    clickSend: async () => { throw new Error('image must not click DOM send'); },
  };
  const result = await vm.runInNewContext(`(async () => { ${adapterSource.slice(start, end)} return { status: 'submitted' }; })()`, context);
  return { calls, result };
}

test('image submission waits for attachment readiness, types the prompt, then presses Enter', async () => {
  const { calls, result } = await imageSubmission();
  assert.deepEqual(calls, ['attach complete', 'check attachment', 'type prompt', 'Enter only']);
  assert.equal(result.status, 'submitted');
});

test('attachment not ready stops the image flow before typing or Enter', async () => {
  const { calls, result } = await imageSubmission({ ready: false });
  assert.deepEqual(calls, ['attach complete', 'check attachment']);
  assert.equal(result.meta.error, 'attachment_failed');
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

/**
 * ภาพขึ้นจอแล้ว แต่บันทึกฟ้อง "เห็นคำตอบแล้ว · หยุดพ่นแล้ว · ภาพในคำตอบ 0 รูป · นิ่งมา 122/90"
 * ผู้ใช้ต้องกด "ภาพเสร็จแล้ว → ดึงมาเลย" เองทุกรูป
 *
 * ต้นเหตุ: ChatGPT วาดบทสนทนาใหม่ระหว่างสร้างภาพ ข้อความของเราที่จับไว้ตอนส่ง (anchor) หลุดออกจากหน้า
 * ตัวที่หลุดตอบตำแหน่งแบบสุ่ม ("อยู่ก่อน" ทุกโหนด) และสำเนาใหม่ของข้อความเราเองถูกนับเป็น
 * "ข้อความผู้ใช้ถัดไป" ภาพทุกใบที่อยู่หลังมันจึงถูกทิ้ง — ปุ่มดึงเองใช้ข้อความล่าสุดที่อยู่บนหน้าจริง จึงเจอ
 */
test('image scan follows a re-rendered user message instead of a detached anchor', async () => {
  const a = await adapterFixture();
  const live = a.node(2);
  live.isConnected = true;
  a.nodes.push(live);
  a.images.push(a.node(3, 'https://chatgpt.com/backend-api/estuary/content?id=file_generated'));
  const detached = { isConnected: false, compareDocumentPosition: () => 1 | 4 | 32 };
  assert.deepEqual(Array.from(a.scanImages(undefined, detached).images), [
    'https://chatgpt.com/backend-api/estuary/content?id=file_generated',
  ]);
});

/**
 * กล่อง "Something went wrong · Retry" โผล่ แต่ ChatGPT ยังขึ้น "Generating a more detailed image — hang tight"
 * ต้องไม่เลิกรอแล้วเปิดห้องใหม่ทันที (อาการ: "ภาพยังไม่มา new chat เฉยเลย")
 */
test('an error box does not abandon an image that ChatGPT is still generating', () => {
  const start = adapterSource.indexOf('async function pollForImage(');
  const loop = adapterSource.slice(start, adapterSource.indexOf("return { status: 'timeout'", start));
  assert.ok(loop.indexOf('const scan = scanImages(before, anchor);') < loop.indexOf('if (errorAfterAnchor())'),
    'images that already appeared are grabbed before any error decision');
  assert.ok(!/if \(errorAfterAnchor\(\)\) return \{ status: 'error'/.test(loop), 'no immediate give-up on the error box');
  assert.match(loop, /stillWorking = stopButtonVisible\(\) \|\| \(turn && IMAGE_IN_PROGRESS\.test/);
  assert.match(loop, /Date\.now\(\) - errorQuietSince >= ERROR_GRACE_MS/);
  const re = vm.runInNewContext(adapterSource.match(/const IMAGE_IN_PROGRESS = (\/.*\/i);/)[1]);
  assert.ok(re.test('Thinking\nGenerating a more detailed image — hang tight.'));
  assert.ok(!re.test('Something went wrong. Please try again.'));
  assert.match(adapterSource, /const ERROR_GRACE_MS = 30000;/);
});
