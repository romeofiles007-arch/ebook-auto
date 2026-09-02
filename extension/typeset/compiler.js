/**
 * ชั้นเรียงพิมพ์ — Typst ทั้งตัวรันเป็น WASM ในแท็บ ไม่มีเซิร์ฟเวอร์
 *
 * นี่คือสิ่งที่ทำให้ลูปนับหน้าเป็นไปได้จริง: วัดจำนวนหน้าจากเอกสารจริงแล้ววนแก้
 * ไม่ใช่การเดาจากจำนวนอักษร ซึ่งเป็นจุดที่ทำให้ระบบนี้ต่างจากโปรเจกต์อื่น
 *
 * ความเร็วที่วัดได้จริงในเบราว์เซอร์ (ไม่ใช่ตัวเลขที่คาดไว้):
 *   40 หน้า ≈ 0.9 วินาที · 200 หน้า ≈ 3.6 วินาที · 300 หน้า ≈ 5.3 วินาที
 * เร็วพอสำหรับลูปนับหน้า (ใช้ 2-6 ครั้งต่อเล่ม) แต่ไม่พอสำหรับพรีวิวสดทุกครั้งที่พิมพ์
 * โหมดแก้ไขจึงใช้ปุ่มนับหน้าใหม่ ไม่ใช่คอมไพล์อัตโนมัติทุก 400 มิลลิวินาที
 *
 * ทำไมต้องผ่าน iframe:
 *   typst.ts มีบรรทัด new Function('m','return import(m)') อยู่ในเส้นทางโหลดฟอนต์
 *   CSP ของหน้า extension ปกติห้าม new Function (wasm-unsafe-eval อนุญาตแค่ WebAssembly)
 *   หน้าที่ประกาศไว้ใน manifest.sandbox จะได้ CSP ที่ผ่อนคลายกว่า จึงรันได้
 *   ไฟล์นี้ทำหน้าที่เป็นตัวแทน คุยกับห้องนั้นผ่าน postMessage
 *
 * อีกสองอย่างที่ต้องรู้
 *   - คอมไพเลอร์ในเบราว์เซอร์ไม่เห็นฟอนต์ของระบบ ต้องป้อนไฟล์ฟอนต์เข้าไปเอง
 *   - ไฟล์ wasm ราว 28 MB โหลดครั้งแรกใช้เวลาสักหน่อย จากนั้นค้างในหน่วยความจำ
 */

import { buildDocument, buildItemsDocument, buildCalibrationDoc } from './template.js';

const url = (p) => chrome.runtime.getURL(p);

export const BUNDLED_FONTS = [
  'fonts/Sarabun-Regular.ttf',
  'fonts/Sarabun-Bold.ttf',
  'fonts/Sarabun-Italic.ttf',
  'fonts/Sarabun-BoldItalic.ttf',
  'fonts/IBMPlexSansThai-Regular.ttf',
  'fonts/IBMPlexSansThai-SemiBold.ttf',
];

export const FONT_FAMILIES = ['Sarabun', 'IBM Plex Sans Thai'];

let ready = null;
let frame = null;
let seq = 0;
const pending = new Map();

function onMessage(e) {
  const m = e.data;
  if (!m) return;
  if (m.ready) return; // สัญญาณว่าห้องพร้อมรับคำสั่ง จัดการใน init()
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
}

function call(op, payload = {}, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    frame.contentWindow.postMessage({ id, op, ...payload }, '*', transfer);
  });
}

async function bytes(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`โหลดไฟล์ไม่ได้: ${path}`);
  return res.arrayBuffer();
}

export function init() {
  if (ready) return ready;

  ready = (async () => {
    window.addEventListener('message', onMessage);

    frame = document.createElement('iframe');
    frame.src = url('typeset/sandbox.html');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    const opened = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ห้องเรียงพิมพ์ไม่ตอบสนอง')), 20000);
      const onReady = (e) => {
        if (e.source !== frame.contentWindow || !e.data?.ready) return;
        clearTimeout(t);
        window.removeEventListener('message', onReady);
        resolve();
      };
      window.addEventListener('message', onReady);
    });
    document.body.appendChild(frame);
    await opened;

    // หน้าแม่เป็นฝ่ายอ่านไฟล์ทั้งหมด เพราะในห้องแยกอ่านไฟล์ของส่วนขยายไม่ได้
    const [librarySource, compilerWasm, rendererWasm] = await Promise.all([
      fetch(url('vendor/typst/typst.mjs')).then((r) => r.text()),
      bytes('vendor/typst/compiler.wasm'),
      bytes('vendor/typst/renderer.wasm').catch(() => null),
    ]);
    const fonts = await Promise.all(
      BUNDLED_FONTS.map(async (f) => ({ name: url(f), bytes: await bytes(f) })),
    );

    const transfer = [compilerWasm, ...fonts.map((f) => f.bytes)];
    if (rendererWasm) transfer.push(rendererWasm);

    await call('init', { librarySource, compilerWasm, rendererWasm, fonts }, transfer);
    return true;
  })();

  return ready;
}

/** จำนวนหน้าจริงที่โรงพิมพ์ต้องพิมพ์ — อ่านจากเอกสาร ไม่ใช่จากการประมาณ */
export async function pageCount(mainContent, files = []) {
  await init();
  return call('pagecount', { src: mainContent, files });
}

export async function toPdf(mainContent, files = []) {
  await init();
  const { pdf } = await call('pdf', { src: mainContent, files });
  return new Blob([pdf], { type: 'application/pdf' });
}

/** SVG ใช้ตอนพรีวิว — คอมไพเลอร์ตัวเดียวกับที่ออก PDF ผลจึงตรงกันเสมอ */
export async function toSvg(mainContent, files = []) {
  await init();
  return call('svg', { src: mainContent, files });
}

/**
 * แปลงภาพที่เก็บใน IndexedDB ให้อยู่ในรูปที่ป้อนเข้าคอมไพเลอร์ได้
 * ชื่อไฟล์ในระบบไฟล์เสมือนคือ /img/<ชื่อภาพ> ตรงกับที่ template อ้างถึง
 */
export async function packAssets(assets = []) {
  const files = [];
  for (const a of assets) {
    if (!a?.blob) continue;
    files.push({ path: `/img/${a.name}`, bytes: await a.blob.arrayBuffer() });
  }
  return files;
}

// ---------- ระดับเล่ม ----------

export async function compileBook({ book, outline, sections, assets = [], withBleed = false }) {
  const usable = assets.filter((a) => a?.blob && a.name?.startsWith('fig-'));

  // โหมดรายชิ้นใช้เอกสารคนละแบบทั้งหมด ไม่ใช่แค่ปรับค่า
  if (book.contentMode === 'items' || (outline?.themes?.length && !outline?.chapters?.length)) {
    const items = sections
      .filter((s) => s.kind === 'item' && s.text)
      .sort((a, b) => cmpItemId(a.id, b.id));
    const isrc = buildItemsDocument({
      book,
      outline,
      items,
      opts: { withBleed, padPages: book.padPages || 0 },
    });
    const t1 = performance.now();
    const p = await pageCount(isrc);
    return { src: isrc, pages: p, files: [], items: items.length, ms: Math.round(performance.now() - t1) };
  }

  const src = buildDocument({
    book,
    outline,
    sections,
    opts: {
      withBleed,
      padPages: book.padPages || 0,
      assetNames: usable.map((a) => a.name),
    },
  });
  const files = await packAssets(usable);
  const t0 = performance.now();
  const pages = await pageCount(src, files);
  return { src, pages, files, ms: Math.round(performance.now() - t0) };
}

/**
 * Calibration — ทำครั้งเดียวต่อโปรไฟล์
 * เรียงพิมพ์ข้อความที่รู้จำนวนอักษรแน่นอน แล้วหารด้วยจำนวนหน้าที่ได้จริง
 * ต้องใช้ข้อความแนวเดียวกับหนังสือจริง ไม่ใช่ lorem ละติน เพราะความยาวคำมีผล
 */
export async function calibrate({ book, sampleText, sampleChars }) {
  const src = buildCalibrationDoc({ book, sampleText });
  const { physical } = await pageCount(src);
  if (!physical) throw new Error('calibration ได้ศูนย์หน้า');
  return { charsPerPage: Math.round(sampleChars / physical), pages: physical };
}

/** ตรวจว่าคอมไพเลอร์ใช้งานได้จริง เรียกตอนเปิดหน้า Studio */
export async function selfTest() {
  const t0 = performance.now();
  await init();
  const src = `#set text(font: "Sarabun", lang: "th")
ทดสอบการเรียงพิมพ์ภาษาไทย ตัดบรรทัดถูกต้องหรือไม่
#pagebreak()
หน้าที่สอง
#context [#metadata((physical: here().page(), numbered: counter(page).final().first())) <pagecount>]`;
  const { physical } = await pageCount(src);
  return { ok: physical === 2, pages: physical, ms: Math.round(performance.now() - t0) };
}

function cmpItemId(a, b) {
  const [a1, a2] = String(a).split('.').map(Number);
  const [b1, b2] = String(b).split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

export async function fontAvailable(family) {
  return FONT_FAMILIES.includes(family);
}
