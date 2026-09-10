/**
 * โฟลเดอร์ของเล่ม — ทุกอย่างของหนังสือเล่มหนึ่งอยู่ที่เดียว และภาพถูกเก็บทันทีที่ได้มา
 *
 * จำลองระบบไฟล์ในหน่วยความจำด้วย API ชุดเดียวกับ File System Access
 * จึงทดสอบพฤติกรรมจริงได้โดยไม่ต้องมีเบราว์เซอร์และไม่แตะดิสก์
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function dirHandle(name = 'root') {
  const kids = new Map();
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(n, { create } = {}) {
      if (!kids.has(n)) {
        if (!create) throw new Error('NotFoundError');
        kids.set(n, dirHandle(n));
      }
      return kids.get(n);
    },
    async getFileHandle(n, { create } = {}) {
      if (!kids.has(n)) {
        if (!create) throw new Error('NotFoundError');
        kids.set(n, { kind: 'file', name: n, blob: null,
          async createWritable() { const self = this; return { async write(b) { self.blob = b; }, async close() {} }; },
          async getFile() { return Object.assign(this.blob, { lastModified: 1 }); } });
      }
      return kids.get(n);
    },
    async removeEntry(n) { kids.delete(n); },
    entries() { return kids.entries()[Symbol.iterator] ? kids.entries() : kids.entries(); },
    _kids: kids,
  };
}

const root = dirHandle();
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
// ไม่มี IndexedDB ใน Node — ให้ที่เก็บอ่านไม่ได้ไปเลย จะได้ทดสอบทางที่ไม่มีสำเนาไปพร้อมกัน
globalThis.indexedDB ??= { open() { throw new Error('no indexeddb in node'); } };
const W = await import('./workspace.js');
W.setDirectoryHandle(root);

const book = { id: '9f3ab21c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', outline: { title: 'เมืองที่ไม่เคยหลับ' } };
const png = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });

test('โฟลเดอร์ตั้งชื่อตามหนังสือ อ่านออกด้วยตา', async () => {
  const dir = await W.bookDir(book, { create: true });
  assert.ok(dir, 'ต้องสร้างโฟลเดอร์ได้');
  assert.match(dir.name, /^เมืองที่ไม่เคยหลับ-9f3ab21c$/);
  assert.equal(await W.bookDirPath(book), '_EbookAuto/books/เมืองที่ไม่เคยหลับ-9f3ab21c');
});

test('เปลี่ยนชื่อหนังสือแล้วยังเจอโฟลเดอร์เดิม ไม่ทิ้งภาพเป็นกำพร้า', async () => {
  await W.saveBookImage(book, 'cover-front.png', png());
  const renamed = { ...book, outline: { title: 'ชื่อใหม่ที่เพิ่งเปลี่ยน' } };
  const dir = await W.bookDir(renamed, { create: true });
  assert.equal(dir.name, 'เมืองที่ไม่เคยหลับ-9f3ab21c', 'ต้องเป็นโฟลเดอร์เดิม ไม่ใช่โฟลเดอร์ใหม่');
  const files = await W.listBookImages(renamed);
  assert.deepEqual(files.map((f) => f.name), ['cover-front.png']);
});

test('ภาพถูกเก็บพร้อมชื่อช่องของมัน และคืนที่อยู่ไฟล์กลับมา', async () => {
  const path = await W.saveBookImage(book, 'fig-1.1-1.png', png());
  assert.equal(path, '_EbookAuto/books/เมืองที่ไม่เคยหลับ-9f3ab21c/images/fig-1.1-1.png');
  const names = (await W.listBookImages(book)).map((f) => f.name).sort();
  assert.deepEqual(names, ['cover-front.png', 'fig-1.1-1.png']);
});

test('ชื่อที่ระบบไฟล์รับไม่ได้ถูกล้าง แต่ตัวอักษรไทยต้องอยู่ครบ', () => {
  assert.equal(W.safeFolderName('คู่มือ: ทำ/ไม่ทำ?'), 'คู่มือ ทำ ไม่ทำ');
  assert.equal(W.safeFolderName('ชื่อจบด้วยจุด...'), 'ชื่อจบด้วยจุด');
  assert.equal(W.safeFolderName(''), 'ยังไม่มีชื่อ');
  assert.equal(W.safeFolderName('   '), 'ยังไม่มีชื่อ');
});

test('ยังไม่ได้เลือกโฟลเดอร์ = ไม่พัง แค่ไม่มีสำเนา', async () => {
  W.setDirectoryHandle(null);
  assert.equal(await W.saveBookImage(book, 'cover-back.png', png()), '');
  assert.deepEqual(await W.listBookImages(book), []);
  W.setDirectoryHandle(root);
});

/**
 * ภาพที่มีอยู่แล้วต้องถูกเก็บกลับเข้าระบบก่อนสั่งวาดใหม่
 * ไม่งั้นเปิดเล่มเดิมในโปรไฟล์อื่นหรือหลังล้างข้อมูลเว็บ จะจ่ายค่าสร้างภาพซ้ำทั้งเล่ม
 */
test('ขั้นสร้างภาพหยิบของในโฟลเดอร์กลับมาก่อนเสมอ', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const images = src.slice(src.indexOf('  async images() {'), src.indexOf('function applyCoverRevision'));
  assert.match(images, /await this\.hydrateImagesFromFolder\(jobs\)/);
  const hydrate = src.slice(src.indexOf('  async hydrateImagesFromFolder('), src.indexOf('  async images() {'));
  // ต้องข้ามช่องที่มีของดีอยู่แล้ว และตรวจไฟล์จากโฟลเดอร์ด้วยด่านเดียวกับภาพที่คว้ามาเอง
  assert.match(hydrate, /validatePhase2Asset\(existing, j\)\)\.ok\) continue/);
  assert.match(hydrate, /ingestImageDataUrl\(/);
});

test('ทุกทางที่ได้ภาพมา เก็บลงโฟลเดอร์ทันที', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  // ทางเครื่อง: หลังไฟล์ที่บันทึกแล้วผ่านตรวจ
  assert.match(src, /W\.saveBookImage\(this\.book, j\.name, candidate\.blob\)/);
  // ทางมือทุกทางรวมกันที่ ingestImageDataUrl ที่เดียว
  const ingest = src.slice(src.indexOf('export async function ingestImageDataUrl('), src.indexOf('/** Prompt ของช่องภาพหนึ่ง ๆ'));
  assert.match(ingest, /W\.saveBookImage\(book, name, candidate\.blob\)/);
});

test('สำเนาโครงการอยู่ในโฟลเดอร์ของเล่มด้วย ไม่ใช่แค่ที่ projects', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./workspace.js', import.meta.url), 'utf8');
  const sync = src.slice(src.indexOf('export async function syncProject('), src.indexOf('/** Read lightweight metadata'));
  assert.match(sync, /bookDir\(payload\.book, \{ create: true \}\)/);
  assert.match(sync, /'book\.json'/);
  assert.match(sync, /'meta\.json'/);
});

/**
 * ภาพที่จ่ายโควตาไปแล้วต้องไม่หายไปเฉย ๆ แม้จะไม่ผ่านตรวจ
 *
 * อาการที่เห็น: ChatGPT วาดปกเดิมซ้ำสามสี่รอบ โดยผู้ใช้ไม่รู้ว่าภาพที่วาดมาแล้วหายไปไหน
 * และผิดตรงไหน — เพราะไฟล์ถูกลบทิ้งทั้งใบก่อนใครจะได้เห็น
 */
test('ไฟล์ดิบถูกเก็บก่อนตรวจเสมอ และบอกที่อยู่ไว้ในเหตุผลที่ไม่ผ่าน', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const dl = src.slice(src.indexOf("if (!rawBlob?.size) throw new Error"), src.indexOf('made++;'));
  // เก็บก่อน แล้วค่อยตรวจ ลำดับนี้สำคัญ
  assert.ok(dl.indexOf("folder: 'generated'") < dl.indexOf('validateGeneratedSource'), 'ต้องเก็บไฟล์ก่อนตรวจ');
  assert.match(dl, /const rawPath = await W\.saveBookImage\(/);
  // ทั้งสองด่านต้องบอกว่าไฟล์ที่วาดมาอยู่ไหน
  const says = [...dl.matchAll(/ไฟล์ที่วาดมาถูกเก็บไว้ที่ \$\{rawPath\}/g)];
  assert.equal(says.length, 2);
});

test('เหตุผลที่ต้องวาดใหม่ถูกส่งเข้าฝ่ายธุรการ จะได้เห็นว่าซ้ำเหตุเดิมไหม', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  assert.match(src, /symptom: 'image_not_grabbed', move: 'retry', detail: `\$\{j\.what\}: \$\{lastError\}`/);
});

test('เลือกโฟลเดอร์ปลายทางได้ และค่าตั้งต้นยังเป็น images เหมือนเดิม', async () => {
  const png = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
  const b = { id: 'aa11bb22-cc33-dd44-ee55-ff6677889900', outline: { title: 'เล่มทดสอบ' } };
  assert.match(await W.saveBookImage(b, 'x.png', png), /\/images\/x\.png$/);
  assert.match(await W.saveBookImage(b, 'y.png', png, { folder: 'generated' }), /\/generated\/y\.png$/);
  // ของที่เก็บไว้คนละโฟลเดอร์ต้องไม่ปนกับภาพที่ผ่านตรวจแล้ว
  assert.deepEqual((await W.listBookImages(b)).map((f) => f.name), ['x.png']);
});
