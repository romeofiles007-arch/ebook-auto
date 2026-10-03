/**
 * หน้า ChatGPT โครงใหม่ (ต.ค. 2026) — อาการ "ค้างที่รอหน้า ChatGPT พร้อม" แล้วลองใหม่วนไป
 *
 * #prompt-textarea · [data-message-author-role] · <article> · conversation-turn-N หายไปพร้อมกัน
 * โครงใหม่ครอบคำสั่งของเรากับคำตอบไว้ในกล่องเทิร์นเดียวกัน และแถบปุ่มเป็นพี่น้องของคำตอบ
 *
 *   div[data-turn-key]
 *     div[data-content-search-turn-key="fallback-turn-4"]
 *       div[…:user]        ← มีปุ่ม Copy message ของตัวเอง โผล่ตั้งแต่วินาทีที่ส่ง
 *       div[…:assistant]   ← มี h4 "ChatGPT said:" ที่มองไม่เห็นอยู่ข้างใน
 *       button[Copy]       ← แถบปุ่มจริง โผล่เมื่อคำตอบจบ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const adapterSource = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

/** DOM จำลองเท่าที่ตัวที่ทดสอบใช้จริง: ไต่ parent, matches แบบ [attr] / [attr="v"] / [attr^="v"], querySelector */
function el(tag, { attrs = {}, children = [], innerText = '' } = {}) {
  const node = {
    tag, attrs, children, innerText, parentElement: null,
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    matches(sel) {
      return sel.split(',').some((one) => {
        const s = one.trim();
        if (s === this.tag) return true;
        const m = s.match(/^\[([^\]^~|$*=]+)(?:\^?=")?([^"\]]*)"?\]$/);
        if (!m) return false;
        const [, name, want] = m;
        if (!(name in this.attrs)) return false;
        return !want || (s.includes('^=') ? String(this.attrs[name]).startsWith(want) : this.attrs[name] === want);
      });
    },
    querySelectorAll(sel) {
      const out = [];
      for (const c of this.children) {
        if (c.matches(sel)) out.push(c);
        out.push(...c.querySelectorAll(sel));
      }
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    closest(sel) {
      for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n;
      return null;
    },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

// ตัวจำลองอ่าน selector ซับซ้อนไม่ได้ จึงตั้ง selector ง่าย ๆ ผ่านช่องทางเดียวกับหน้าตั้งค่าของ Studio
const TEST_SELECTORS = {
  assistantTurn: '[data-chatgpt-search-assistant]',
  userTurn: '[data-chatgpt-search-user]',
  copyButton: '[data-copy]',
};

async function fixture(main, saved = TEST_SELECTORS) {
  const context = {
    document: { querySelector: (sel) => (sel === 'main' ? main : null), querySelectorAll: () => [], body: main },
    window: {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 },
    chrome: {
      storage: { local: { get: async () => ({ selectors: saved }) } },
      runtime: { onMessage: { addListener() {} } },
    },
  };
  vm.runInNewContext(
    adapterSource.replace(
      /\}\)\(\);\s*$/,
      'globalThis.fixture = { actionBarFor, turnText, turnIndexOf, userMessageKey, userReceiptText, selectors: () => S }; })();',
    ),
    context,
  );
  await Promise.resolve();
  return context.fixture;
}

function page({ done = false, turnKey = 'fallback-turn-4' } = {}) {
  const userCopy = el('button', { attrs: { 'data-copy': '', 'aria-label': 'Copy message' } });
  const bubble = el('div', { attrs: { 'data-user-message-bubble': 'true' }, innerText: 'คำสั่งของเรา\n…\nShow more' });
  const user = el('div', {
    attrs: { 'data-chatgpt-search-user': '', 'data-chatgpt-search-message-ids': 'user-msg-1' },
    children: [bubble, userCopy],
    innerText: 'Pasted text.txt\nคำสั่งของเรา\n…\nShow more',
  });
  const codeCopy = el('button', { attrs: { 'data-copy': '', 'aria-label': 'Copy code' } });
  const heading = el('h4', { attrs: { 'data-conversation-role': 'assistant' }, innerText: 'ChatGPT said:' });
  const answer = el('div', {
    attrs: { 'data-chatgpt-search-assistant': '' },
    children: [heading, el('div', { children: [codeCopy] })],
    innerText: 'ChatGPT said:\n\n{"titles":["ก"]}',
  });
  const barCopy = el('button', { attrs: { 'data-copy': '', 'aria-label': 'Copy' } });
  const inner = el('div', {
    attrs: { 'data-content-search-turn-key': turnKey },
    children: done ? [user, answer, barCopy] : [user, answer],
  });
  const shell = el('div', { attrs: { 'data-turn-key': 'user-msg-1' }, children: [inner] });
  const main = el('main', { children: [shell] });
  return { main, user, answer, heading, barCopy, userCopy, codeCopy };
}

test('ปุ่ม Copy message ของข้อความเราเอง ไม่ใช่สัญญาณว่าคำตอบจบแล้ว', async () => {
  const dom = page({ done: false });
  const { actionBarFor } = await fixture(dom.main);
  assert.equal(actionBarFor(dom.answer), null, 'ยังพ่นอยู่ ต้องยังไม่เจอแถบปุ่ม ทั้งที่มีปุ่ม Copy อยู่ในกล่องเทิร์นแล้วสองตัว');
});

test('แถบปุ่มที่เป็นพี่น้องของคำตอบ คือสัญญาณว่าคำตอบจบ', async () => {
  const dom = page({ done: true });
  const { actionBarFor } = await fixture(dom.main);
  assert.equal(actionBarFor(dom.answer), dom.barCopy);
});

test('หัว "ChatGPT said:" ที่มองไม่เห็น ไม่ติดมากับคำตอบ', async () => {
  const dom = page();
  const { turnText } = await fixture(dom.main);
  assert.equal(turnText(dom.answer), '{"titles":["ก"]}');
  assert.doesNotThrow(() => JSON.parse(turnText(dom.answer)));
  // กล่องที่มีแต่หัว = ยังไม่มีคำตอบ ต้องนับว่าว่าง
  const empty = el('div', { children: [el('h4', { attrs: { 'data-conversation-role': 'assistant' }, innerText: 'ChatGPT said:' })], innerText: 'ChatGPT said:' });
  assert.equal(turnText(empty), '');
  // โครงเก่าไม่มีหัวอยู่ข้างใน ต้องได้ข้อความเดิมทุกตัวอักษร
  assert.equal(turnText({ innerText: 'ChatGPT said: นี่คือเนื้อหาจริง' }), 'ChatGPT said: นี่คือเนื้อหาจริง');
});

test('ลำดับเทิร์นและรหัสข้อความอ่านได้จากโครงใหม่', async () => {
  const dom = page({ turnKey: 'fallback-turn-12' });
  const { turnIndexOf, userMessageKey, userReceiptText } = await fixture(dom.main);
  assert.equal(turnIndexOf(dom.user), 12);
  assert.equal(userMessageKey(dom.user), 'user-msg-1');
  // ใบเสร็จอ่านจากฟองข้อความ ไม่ใช่ทั้งกล่องที่มีแผ่นไฟล์แนบนำหน้า
  assert.ok(userReceiptText(dom.user).startsWith('คำสั่งของเรา'));

  // รหัสสุ่มที่บังเอิญลงท้ายด้วยเลข ห้ามถูกอ่านเป็นลำดับเทิร์น
  const odd = page({ turnKey: '0b931c47-3600-491e-9a7f-704f5d014123' });
  const f = await fixture(odd.main);
  assert.ok(Number.isNaN(f.turnIndexOf(odd.user)));
});

test('ค่าที่บันทึกไว้จากรุ่นก่อนไม่ทับค่าตั้งต้นที่รู้จักโครงใหม่', async () => {
  const dom = page();
  const { selectors } = await fixture(dom.main, {
    composer: '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"]',
    assistantTurn: '[data-message-author-role="assistant"]',
    modelBadge: '[data-testid="model-switcher-dropdown-button"]',
    stopButton: '[data-testid="my-own-stop"]',
  });
  const S = selectors();
  assert.match(S.composer, /ProseMirror/);
  assert.match(S.composer, /#prompt-textarea/, 'ของเก่ายังต้องอยู่ เผื่อบัญชีที่ยังได้หน้าเดิม');
  assert.match(S.assistantTurn, /data-turn-key/);
  assert.match(S.userTurn, /data-chatgpt-search-unit-key/);
  assert.match(S.modelBadge, /aria-label/);
  assert.equal(S.stopButton, '[data-testid="my-own-stop"]', 'ค่าที่ผู้ใช้ปรับเองในช่องอื่นต้องไม่ถูกแตะ');
});
