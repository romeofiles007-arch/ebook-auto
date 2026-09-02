/**
 * IndexedDB — แหล่งความจริงเดียวของระบบ
 * หลักการ: ทุกเทิร์นต้องถูกเขียนลงที่นี่ก่อนยิงเทิร์นถัดไปเสมอ
 * ถ้าทำได้ตามนี้ ทุกความพังจะกลายเป็นแค่ "ลองเทิร์นนั้นใหม่"
 */

const DB_NAME = 'ebook-auto';
const DB_VERSION = 1;

const STORES = {
  books: { keyPath: 'id' },
  sections: { keyPath: 'key' }, // key = `${bookId}:${sectionId}`
  turns: { keyPath: 'key' }, // key = `${bookId}:${n}`
  assets: { keyPath: 'key' }, // key = `${bookId}:${name}`
  settings: { keyPath: 'k' },
};

let _db = null;

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const os = db.createObjectStore(name, opts);
          if (name === 'sections' || name === 'turns' || name === 'assets') {
            os.createIndex('bookId', 'bookId', { unique: false });
          }
        }
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

const wrap = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

export const put = async (store, value) => wrap((await tx(store, 'readwrite')).put(value));
export const get = async (store, key) => wrap((await tx(store)).get(key));
export const del = async (store, key) => wrap((await tx(store, 'readwrite')).delete(key));
export const all = async (store) => wrap((await tx(store)).getAll());

export async function byBook(store, bookId) {
  const os = await tx(store);
  return wrap(os.index('bookId').getAll(bookId));
}

// ---------- helper เฉพาะโดเมน ----------

export const saveBook = (book) => put('books', { ...book, updatedAt: Date.now() });
export const loadBook = (id) => get('books', id);
export const listBooks = () => all('books');

export async function saveSection(bookId, sec) {
  return put('sections', { ...sec, key: `${bookId}:${sec.id}`, bookId, updatedAt: Date.now() });
}
export const loadSections = (bookId) => byBook('sections', bookId);
export const loadSection = (bookId, sid) => get('sections', `${bookId}:${sid}`);

export async function saveTurn(bookId, n, rec) {
  return put('turns', { ...rec, key: `${bookId}:${n}`, bookId, n, at: Date.now() });
}
export const loadTurns = (bookId) => byBook('turns', bookId);

export async function saveAsset(bookId, name, blob, meta = {}) {
  return put('assets', { key: `${bookId}:${name}`, bookId, name, blob, meta, at: Date.now() });
}
export const loadAsset = (bookId, name) => get('assets', `${bookId}:${name}`);
export const loadAssets = (bookId) => byBook('assets', bookId);
export const deleteAsset = (bookId, name) => del('assets', `${bookId}:${name}`);

export async function setting(k, v) {
  if (v === undefined) return (await get('settings', k))?.v;
  return put('settings', { k, v });
}

export async function deleteBook(bookId) {
  for (const store of ['sections', 'turns', 'assets']) {
    const rows = await byBook(store, bookId);
    for (const r of rows) await del(store, r.key);
  }
  await del('books', bookId);
}

/** ส่งออกทั้งโปรเจกต์เป็น JSON เดียว — กันงานหายเมื่อเบราว์เซอร์ล้างข้อมูล */
export async function exportProject(bookId) {
  const book = await loadBook(bookId);
  const sections = await loadSections(bookId);
  const turns = await loadTurns(bookId);
  const assets = await loadAssets(bookId);
  const encoded = [];
  for (const a of assets) {
    encoded.push({ name: a.name, meta: a.meta, dataUrl: await blobToDataUrl(a.blob) });
  }
  return { version: 1, exportedAt: new Date().toISOString(), book, sections, turns, assets: encoded };
}

export async function importProject(payload) {
  const { book, sections = [], turns = [], assets = [] } = payload;
  // Import from a shared workspace should preserve the source revision time.
  // Otherwise merely opening a project in another Chrome profile would make
  // that stale cache look newer than the physical shared copy.
  if (book?.updatedAt) await put('books', { ...book });
  else await saveBook(book);
  for (const s of sections) await saveSection(book.id, s);
  for (const t of turns) await saveTurn(book.id, t.n, t);
  for (const a of assets) await saveAsset(book.id, a.name, await dataUrlToBlob(a.dataUrl), a.meta);
  return book.id;
}

export function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}
