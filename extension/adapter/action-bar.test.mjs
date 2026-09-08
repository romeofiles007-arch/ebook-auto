import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const adapterSource = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

/**
 * แถบปุ่มใต้คำตอบคือสัญญาณ "คำตอบนี้จบแล้ว" — ถ้าตีปุ่ม Copy ของหัวบล็อกโค้ดเป็นแถบปุ่ม
 * เทิร์นจะถูกปิดตั้งแต่ JSON พ่นได้ไม่กี่ตัวอักษร แล้วคำตอบถูกอ่านกลับมาแบบตัดกลางคัน
 * (อาการที่เห็น: ไม่พบรายการชื่อในคำตอบ [ยาว 31 ตัวอักษร · ตัดกลางคัน])
 */

/** DOM จำลองเท่าที่ actionBarFor/inCodeBlock ใช้จริง: ไต่ parent, matches, querySelector */
function el(tag, { attrs = {}, children = [] } = {}) {
  const node = {
    tag,
    attrs,
    children,
    parentElement: null,
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
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    closest(sel) {
      for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n;
      return null;
    },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

/** โครงจริงของหน้า: main > article > [กล่องคำตอบ (มีบล็อกโค้ด + ปุ่ม Copy ของบล็อก), แถบปุ่มใต้คำตอบ] */
function page({ turnBarShown = true, headerDepth = 1 } = {}) {
  const codeCopy = el('button', { attrs: { 'aria-label': 'Copy code' } });
  const pre = el('pre', { children: [el('code')] });
  // headerDepth = จำนวนชั้นที่ ChatGPT ห่อหัวบล็อกโค้ดไว้ ซึ่งลึกขึ้นเรื่อย ๆ ทุกครั้งที่ปรับหน้า
  let header = codeCopy;
  for (let i = 0; i < headerDepth; i++) header = el('div', { children: [header] });
  const codeBlock = el('div', { children: [header, pre] });
  const turn = el('div', {
    attrs: { 'data-message-author-role': 'assistant' },
    children: [el('div', { children: [codeBlock] })],
  });
  const turnCopy = el('button', { attrs: { 'data-testid': 'copy-turn-action-button', 'aria-label': 'Copy' } });
  const bar = el('div', { children: [turnCopy] });
  const article = el('article', { children: turnBarShown ? [turn, bar] : [turn] });
  const main = el('main', { children: [article] });
  return { main, turn, turnCopy, codeCopy };
}

async function fixture(main) {
  const context = {
    document: { querySelector: (sel) => (sel === 'main' ? main : null), querySelectorAll: () => [], body: main },
    window: {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 },
    chrome: {
      storage: { local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener() {} } },
    },
  };
  // Expose private functions only in this test VM; production has no test hook.
  vm.runInNewContext(
    adapterSource.replace(/\}\)\(\);\s*$/, 'globalThis.fixture = { actionBarFor, inCodeBlock }; })();'),
    context,
  );
  await Promise.resolve();
  return context.fixture;
}

test('ปุ่ม Copy ของบล็อกโค้ดไม่ใช่แถบปุ่มใต้คำตอบ', async () => {
  const dom = page({ turnBarShown: false });
  const { actionBarFor, inCodeBlock } = await fixture(dom.main);
  assert.equal(inCodeBlock(dom.codeCopy), true);
  assert.equal(actionBarFor(dom.turn), null, 'คำตอบยังพ่นไม่จบ ต้องยังไม่เจอแถบปุ่ม');
});

test('แถบปุ่มจริงของคำตอบยังหาเจอ แม้คำตอบจะมีบล็อกโค้ดอยู่ข้างใน', async () => {
  const dom = page({ turnBarShown: true });
  const { actionBarFor, inCodeBlock } = await fixture(dom.main);
  assert.equal(inCodeBlock(dom.turnCopy), false, 'ปุ่มของแถบปุ่มจริงห้ามถูกตีเป็นปุ่มบล็อกโค้ด');
  assert.equal(actionBarFor(dom.turn), dom.turnCopy);
});

test('หัวบล็อกโค้ดที่ห่อลึกกว่าเดิมก็ยังไม่ถูกตีเป็นแถบปุ่ม', async () => {
  const dom = page({ turnBarShown: false, headerDepth: 6 });
  const { actionBarFor, inCodeBlock } = await fixture(dom.main);
  assert.equal(inCodeBlock(dom.codeCopy), true);
  assert.equal(actionBarFor(dom.turn), null);
});
