/**
 * ตรวจ "สัญญา" ระหว่างหน้าเว็บกับโค้ด ก่อน commit ทุกครั้ง
 *
 * studio.js ผูกกับ studio.html ด้วยชื่อล้วน ๆ — id, data-attribute และคลาสไม่กี่ตัว
 * ถ้าชื่อใดหายไประหว่างจัดหน้าใหม่ เบราว์เซอร์จะไม่ฟ้องอะไรเลย ปุ่มนั้นจะเงียบไปเฉย ๆ
 * และกว่าจะรู้ก็ตอนผู้ใช้กดแล้วไม่มีอะไรเกิดขึ้น ซึ่งอาจเป็นเดือนถัดไป
 *
 * สคริปต์นี้เปลี่ยนความผิดพลาดแบบเงียบให้เป็นความผิดพลาดที่ส่งเสียง
 *
 *   node ui/check-ui-contract.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(here, 'studio.html'), 'utf8');
const js = await readFile(join(here, 'studio.js'), 'utf8');
const css = await readFile(join(here, 'studio.css'), 'utf8');

/**
 * id ที่มีอยู่จริง — ทั้งใน studio.html และใน markup ที่ studio.js สร้างเองด้วย template literal
 *
 * ถ้านับเฉพาะไฟล์ html จะได้ false positive ทันที เพราะการ์ดหลายใบถูกสร้างจาก JS
 * แล้วค้นหาในรอบเดียวกัน เช่นปุ่ม #inspireAgain ในกล่องผลลัพธ์ตกแต่งสารบัญ
 */
const idPattern = /\bid="([A-Za-z0-9_-]+)"/g;
const htmlIds = new Set([...html.matchAll(idPattern)].map((m) => m[1]));
const jsMadeIds = new Set([...js.matchAll(idPattern)].map((m) => m[1]));
const allIds = new Set([...htmlIds, ...jsMadeIds]);

/** id ที่โค้ดเรียกใช้ — ถ้าไม่มีอยู่จริง จะได้ null แล้วพังตอนรันไทม์ */
const usedIds = new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
for (const m of js.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) usedIds.add(m[1]);

/** data-attribute ที่โค้ดใช้หาปุ่ม เขียนได้ทั้งแบบมีค่าและแบบ boolean */
const usedAttrs = new Set(
  [...js.matchAll(/querySelector(?:All)?\('\[(data-[a-z0-9-]+)[\]=]/g)].map((m) => m[1]),
);
const hasAttr = (attr) => {
  const boundary = new RegExp(attr + '(?=[\\s>=\\]"\'`])');
  return boundary.test(html) || boundary.test(js);
};

/**
 * คลาสที่เป็นกลไก ไม่ใช่เครื่องสำอาง — หายไปจาก CSS แล้วระบบพัง ไม่ใช่แค่ดูแปลก
 * hidden คือกลไกสลับหน้าจอทั้งระบบ ถูกใช้กว่า 80 ครั้งใน studio.js
 */
const mechanicalClasses = ['hidden'];

const missingIds = [...usedIds].filter((id) => !allIds.has(id)).sort();
const missingAttrs = [...usedAttrs].filter((a) => !hasAttr(a)).sort();
const missingCss = mechanicalClasses.filter((c) => !new RegExp('\\.' + c + '\\b').test(css));

const problems = [];
if (missingIds.length) problems.push(`id ที่โค้ดเรียกแต่ไม่มีอยู่จริง (${missingIds.length}): ${missingIds.join(', ')}`);
if (missingAttrs.length) problems.push(`data-attribute ที่หาไม่เจอ (${missingAttrs.length}): ${missingAttrs.join(', ')}`);
if (missingCss.length) problems.push(`คลาสที่เป็นกลไกแต่ไม่มีใน CSS: ${missingCss.join(', ')}`);

const unusedIds = [...htmlIds].filter((id) => !usedIds.has(id)).sort();
const jsOnlyIds = [...jsMadeIds].filter((id) => usedIds.has(id) && !htmlIds.has(id));

console.log(`id ใน studio.html      ${htmlIds.size}`);
console.log(`id ที่ JS สร้างเอง       ${jsOnlyIds.length}`);
console.log(`id ที่โค้ดเรียกใช้       ${usedIds.size}   ← ทั้งหมดนี้ห้ามหายระหว่างจัดหน้าใหม่`);
console.log(`data-attribute         ${usedAttrs.size}`);
if (unusedIds.length) console.log(`id ที่ไม่มีใครเรียก       ${unusedIds.length}   (ปกติ — เป็นเป้าของ <label for>)`);

if (problems.length) {
  console.error('\n❌ สัญญาระหว่างหน้าเว็บกับโค้ดขาด\n');
  for (const p of problems) console.error('   ' + p);
  console.error('\nแก้ให้ครบก่อน commit — ของพวกนี้พังแบบเงียบ ไม่มี error ให้เห็น');
  process.exit(1);
}

console.log('\n✅ ครบทุกชื่อที่โค้ดต้องใช้');
