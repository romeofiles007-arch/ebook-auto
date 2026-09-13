/**
 * โหลดส่วนขยายซ้ำแล้วแท็บ ChatGPT ไม่ฟื้นเอง — ต้องให้คนไปกดรีเฟรชทุกครั้ง
 *
 * ตัว service worker ทำถูกอยู่แล้ว: ensureAdapter ping ก่อน ไม่ตอบก็ฉีด adapter ใหม่เข้าไป
 * แต่ adapter ตัวเก่าที่ถูกตัดขาดไปแล้วทิ้งธง window.__ebookAutoAdapter ค้างไว้บนหน้าเว็บ
 * ตัวใหม่ที่ถูกฉีดเข้ามาจึงเจอธงนั้นแล้ว return ทิ้งตั้งแต่บรรทัดแรก ไม่ติดตั้ง listener เลย
 * ping รอบถัดไปก็ยังไม่ผ่าน ensureAdapter วนจนครบยี่สิบวินาทีแล้วคืน false
 *
 * ผลที่ผู้ใช้เห็น: กดโหลดซ้ำส่วนขยายแล้วงานยังไม่เดิน ต้องไปกด Ctrl+R ที่แท็บ ChatGPT เองทุกครั้ง
 * ทั้งที่ระบบนี้ทั้งระบบตั้งใจให้ทำงานต่อได้โดยไม่ต้องมีคนมากด
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');

/**
 * รัน adapter บนหน้าเว็บจำลอง แล้วบอกว่ามันติดตั้ง listener หรือถอยออกไปเฉย ๆ
 * runtimeId = undefined คือสภาพของสคริปต์ที่ถูกตัดขาดหลังโหลดส่วนขยายซ้ำ
 */
function inject(win, runtimeId) {
  let installed = 0;
  const context = {
    window: win,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      body: {},
      addEventListener() {},
    },
    getComputedStyle: () => ({ position: 'static' }),
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 },
    chrome: {
      get runtime() {
        if (runtimeId === undefined) return { onMessage: { addListener: () => { installed++; } } };
        return { id: runtimeId, onMessage: { addListener: () => { installed++; } } };
      },
      storage: { local: { get: async () => ({}) } },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(src, context);
  return installed;
}

test('ส่วนขยายถูกโหลดซ้ำ: ตัวเก่าตายแล้ว ตัวใหม่ต้องติดตั้งได้เอง', () => {
  const page = {};
  assert.equal(inject(page, 'ext-1'), 1, 'ครั้งแรกต้องติดตั้ง');
  assert.equal(page.__ebookAutoAdapter, true);

  // ส่วนขยายถูกโหลดซ้ำ — ตัวเก่ายังทิ้งธงไว้บนหน้าเว็บ แต่คุยกับส่วนขยายไม่ได้แล้ว
  page.__ebookAutoAdapterAlive = () => false;
  assert.equal(inject(page, 'ext-2'), 1, 'ตัวใหม่ต้องติดตั้ง ไม่ใช่ถอยเพราะธงค้าง');
});

test('ตัวเก่ายังมีชีวิตอยู่ ห้ามติดตั้งซ้อนเด็ดขาด', () => {
  const page = {};
  assert.equal(inject(page, 'ext-1'), 1);
  // ธงและตัวพิสูจน์ชีวิตถูกวางไว้โดยตัวแรกเอง ตัวที่สองต้องถอย
  assert.equal(typeof page.__ebookAutoAdapterAlive, 'function');
  assert.equal(inject(page, 'ext-1'), 0, 'listener ซ้อนกันคือต้นเหตุของงานซ้อน');
});

/**
 * บิลด์เก่าที่ยังอยู่ในแท็บไม่มีตัวพิสูจน์ชีวิตให้เรียก
 * ตัวใหม่ต้องอ่านกรณีนั้นว่า "พิสูจน์ไม่ได้ = ไม่นับว่ามีชีวิต" แล้วติดตั้งแทน
 * ไม่งั้นการอัปเกรดครั้งนี้เองก็ยังต้องให้คนไปกดรีเฟรชอยู่ดี
 */
test('ธงค้างจากบิลด์เก่าที่ไม่มีตัวพิสูจน์ชีวิต ต้องไม่กันตัวใหม่', () => {
  const page = { __ebookAutoAdapter: true };
  assert.equal(inject(page, 'ext-2'), 1);
});

test('ตัวพิสูจน์ชีวิตอ่านจากการเชื่อมต่อจริง ไม่ใช่จากธงบนหน้าเว็บ', () => {
  const guard = src.slice(0, src.indexOf('const DEFAULT_SELECTORS'));
  assert.match(guard, /chrome\.runtime\?\.id/);
  assert.match(guard, /window\.__ebookAutoAdapterAlive\?\.\(\)/);
  assert.ok(
    !/if \(window\.__ebookAutoAdapter\) return;/.test(guard),
    'ห้ามกลับไปใช้ธงเปล่า ๆ ที่ติดแล้วติดเลย',
  );
});
