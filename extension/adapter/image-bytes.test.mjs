/**
 * "ดึงเองก็ไม่ค่อยได้" — ทางเอาไฟล์ภาพออกมามีทางเดียวมาตลอด พลาดแล้วคือทิ้งภาพทั้งใบ
 *
 * ภาพถูกวาดเสร็จแล้ว จ่ายโควตาไปแล้ว แล้วเราทิ้งเพราะ fetch ไม่ผ่าน — แพงที่สุดในระบบ
 * ตอนนี้มีสามทางที่ใช้กลไกคนละอย่าง จึงไม่พลาดพร้อมกัน
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const adapter = await readFile(new URL('./chatgpt.js', import.meta.url), 'utf8');
const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('สามทาง: fetch ในหน้า → วาดลงผ้าใบ → ให้ service worker ดึง', () => {
  const cap = adapter.slice(adapter.indexOf('async function captureImageData('), adapter.indexOf('async function pollForImage'));
  assert.match(cap, /await fetch\(src/);
  assert.match(cap, /captureFromElement\(el\)/);
  assert.match(cap, /captureViaWorker\(src\)/);
  // ลำดับสำคัญ: ผ้าใบก่อน เพราะไม่ต้องยุ่งกับเครือข่ายเลย
  assert.ok(cap.indexOf('captureFromElement(el)') < cap.indexOf('captureViaWorker(src)'));
});

test('ทางผ้าใบอ่านจากพิกเซลที่วาดไว้แล้ว ไม่พึ่ง URL', () => {
  const fn = adapter.slice(adapter.indexOf('async function captureFromElement('), adapter.indexOf('async function captureViaWorker('));
  assert.match(fn, /drawImage\(img, 0, 0\)/);
  assert.match(fn, /cv\.toBlob\(/);
  assert.match(fn, /naturalWidth/);
});

test('ตัวสแกนเก็บ element ไว้ให้ทางผ้าใบใช้', () => {
  assert.match(adapter, /el: i,/);
  assert.match(adapter, /const nodeBySrc = new Map\(\)/);
  assert.match(adapter, /return \{ images: \[\.\.\.new Set\(cand\.map\(\(x\) => x\.src\)\)\], seen, nodeBySrc \}/);
  // ทุกที่ที่คว้าภาพต้องส่ง element ไปด้วย ไม่งั้นทางผ้าใบไม่มีวันได้ทำงาน
  assert.equal([...adapter.matchAll(/captureImageData\(scan\.images, scan\.nodeBySrc\)/g)].length, 2);
});

test('service worker ดึงด้วยสิทธิ์ของส่วนขยาย และมีสิทธิ์ที่เก็บไฟล์จริง', () => {
  assert.match(sw, /case 'sw\.fetchImage'/);
  assert.match(sw, /credentials: 'include'/);
  assert.ok(manifest.host_permissions.some((h) => h.includes('oaiusercontent.com')));
});

test('ตอนประกอบเล่ม ต้องหยิบไฟล์ที่ save ไว้กลับมาก่อนเสมอ', () => {
  assert.match(studio, /async function hydrateImagesFromFolder\(\)/);
  const fin = studio.slice(studio.indexOf('async function finish() {'), studio.indexOf('const pages = book.finalPages'));
  assert.match(fin, /await hydrateImagesFromFolder\(\)/);
  // ต้องเกิดก่อนการประกอบไฟล์ ไม่ใช่หลัง
  assert.ok(fin.indexOf('await hydrateImagesFromFolder()') < fin.indexOf('exportInterior'));
});
