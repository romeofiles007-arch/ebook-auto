import { supportedCodepoints } from './ttf-cmap.mjs';
import { writeFile } from 'node:fs/promises';
const dir = '../fonts/';
const files = ['Sarabun-Regular.ttf','Sarabun-Bold.ttf','Sarabun-Italic.ttf','Sarabun-BoldItalic.ttf','IBMPlexSansThai-Regular.ttf','IBMPlexSansThai-SemiBold.ttf'];

// เอาเฉพาะตัวที่ "ทุกฟอนต์ในเล่ม" วาดได้ ไม่ใช่ตัวที่ฟอนต์ใดฟอนต์หนึ่งมี
// เพราะข้อความหนึ่งบรรทัดอาจถูกจัดด้วยฟอนต์ตัวหนาหรือตัวเอียงก็ได้
let common = null;
for (const f of files) {
  const s = await supportedCodepoints(dir + f);
  common = common ? new Set([...common].filter((c) => s.has(c))) : s;
}
const cps = [...common].sort((a, b) => a - b);
const ranges = [];
for (const c of cps) {
  const last = ranges[ranges.length - 1];
  if (last && c === last[1] + 1) last[1] = c;
  else ranges.push([c, c]);
}
const fmt = (n) => '0x' + n.toString(16).toUpperCase();
const body = ranges.map(([a, b]) => (a === b ? `[${fmt(a)}]` : `[${fmt(a)},${fmt(b)}]`)).join(', ');
console.log('ตัวอักษรที่ทุกฟอนต์วาดได้:', cps.length, '· ช่วง:', ranges.length);
await writeFile('../core/font-coverage.js', `/**
 * ตัวอักษรที่ฟอนต์ในเล่มวาดได้จริง — สร้างจากตาราง cmap ของไฟล์ฟอนต์โดยตรง
 *
 * ไม่ได้เขียนด้วยมือ และห้ามเขียนด้วยมือ ถ้าเปลี่ยนชุดฟอนต์เมื่อไรให้สร้างไฟล์นี้ใหม่
 * (สคริปต์อยู่ใน tools/gen-font-coverage.mjs)
 *
 * นับเฉพาะตัวที่ทุกฟอนต์ในชุดวาดได้ ไม่ใช่ตัวที่ฟอนต์ใดฟอนต์หนึ่งมี
 * เพราะข้อความบรรทัดเดียวกันอาจถูกจัดด้วยตัวหนาหรือตัวเอียงก็ได้
 *
 * ฟอนต์: ${files.join(', ')}
 * รวม ${cps.length} ตัวอักษร ใน ${ranges.length} ช่วง
 */

const RANGES = [${body}];

/** ฟอนต์ในเล่มวาดตัวอักษรนี้ได้ไหม — ถ้าไม่ได้ ตอนพิมพ์จะกลายเป็นกล่องสี่เหลี่ยม */
export function isDrawable(codePoint) {
  let lo = 0;
  let hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = RANGES[mid];
    if (codePoint < r[0]) hi = mid - 1;
    else if (codePoint > (r[1] ?? r[0])) lo = mid + 1;
    else return true;
  }
  return false;
}
`);
console.log('เขียน core/font-coverage.js แล้ว');
