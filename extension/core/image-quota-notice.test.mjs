import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * "โควตาสร้างภาพหมด" ต้องอ่านออกว่าเป็นการหยุด ไม่ใช่คำตอบที่บังเอิญไม่มีภาพ
 *
 * ประกาศนี้ต่างจากลิมิตอื่นสองอย่าง: มันมาเป็นคำตอบในกล่องสนทนา (ตัวจับลิมิตเดิมตัดทิ้ง
 * ทุกอย่างที่อยู่ในข้อความสนทนา เพราะเนื้อหาหนังสือเองก็พูดถึงคำว่า usage limit ได้)
 * และมันบอกเวลาเป็นตัวเลข "try again in 4 hours" ซึ่งไม่ตรงกับวลี "try again later" ที่มีอยู่
 *
 * ผลที่เกิดจริงคือสั่งวาดใหม่วนไป ทั้งที่อีกสี่ชั่วโมงข้างหน้าไม่มีทางได้ภาพสักใบ
 */
const src = await readFile(new URL('../adapter/chatgpt.js', import.meta.url), 'utf8');
const grab = (re) => {
  const m = src.match(re);
  assert.ok(m, `หาโค้ดที่ต้องใช้ไม่เจอ: ${re}`);
  return m[0];
};
const scope = vm.createContext({});
vm.runInContext(
  `${grab(/const IMAGE_QUOTA_PATTERNS = \[[\s\S]*?\n  \];/)}
${grab(/function imageQuotaNotice\(text\) \{[\s\S]*?\n  \}/)}
globalThis.out = imageQuotaNotice;`,
  scope,
);
const imageQuotaNotice = scope.out;

test('ข้อความที่หน้าจอขึ้นจริง ถูกอ่านว่าเป็นโควตาหมด', () => {
  const said = "You're out of image generation messages for now. Please try again in 4 hours.";
  assert.ok(imageQuotaNotice(said), 'ต้องจับได้ ไม่งั้นระบบจะสั่งวาดใหม่วนไปอีกสี่ชั่วโมง');
  assert.match(imageQuotaNotice(said), /4 hours/, 'ต้องส่งเวลาที่หน้าเว็บบอกไปถึงหน้าจอด้วย');
});

test('สำนวนอื่นของประกาศเดียวกันก็ต้องจับได้', () => {
  for (const said of [
    'You have reached your image generation limit for today.',
    'No more image generations available on your plan right now.',
    'คุณใช้โควตาสร้างภาพครบแล้ว กรุณาลองใหม่ภายหลัง',
  ]) {
    assert.ok(imageQuotaNotice(said), `ควรจับได้: ${said}`);
  }
});

/**
 * ห้ามหยุดงานเพราะคำตอบพูดถึงเรื่องโควตาเฉย ๆ
 *
 * นี่คือเหตุผลที่ตัวจับลิมิตเดิมไม่ยอมอ่านข้อความในกล่องสนทนาเลย — เนื้อหาหนังสือพูดถึง
 * เรื่องพวกนี้ได้ตามปกติ ตัวนี้จึงกันสองชั้น: ดูเฉพาะตอนเทิร์นวาดภาพไม่ได้ภาพกลับมา
 * และคำตอบต้องสั้นแบบประกาศ ไม่ใช่ความเรียงของจริง
 */
test('คำตอบยาวที่บังเอิญพูดถึงโควตา ไม่นับว่าเป็นประกาศ', () => {
  const chapter =
    'บทนี้ว่าด้วยการจัดสรรทรัพยากรที่มีจำกัด ' +
    'เมื่อคุณใช้โควตาภาพของทีมจนครบ สิ่งที่เกิดขึ้นไม่ใช่ความล้มเหลว แต่คือสัญญาณให้ทบทวน '.repeat(8);
  assert.ok(chapter.length > 400);
  assert.equal(imageQuotaNotice(chapter), '', 'ความเรียงยาวต้องไม่ถูกอ่านว่าเป็นประกาศของหน้าเว็บ');
});

test('คำตอบธรรมดาและคำตอบว่าง ไม่นับ', () => {
  for (const said of ['', '   ', 'นี่คือภาพที่วาดให้ครับ', 'Here is the illustration you asked for.']) {
    assert.equal(imageQuotaNotice(said), '');
  }
});

/**
 * จับได้แล้วต้องหยุดจริง ไม่ใช่แค่เขียน log
 *
 * เส้นทางคือ pollForImage → rate_limited → turn() โยน RateLimited → งานหยุดและรอคนสั่งทำต่อ
 */
test('ทางเดินของการหยุดต่อกันครบ ตั้งแต่หน้าเว็บถึงตัวงาน', async () => {
  assert.match(src, /const quota = imageQuotaNotice\(turn\.innerText\);[\s\S]{0,300}finish\('rate_limited'\)/);

  const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  assert.match(
    machine,
    /res\.status === 'rate_limited'\) throw new RateLimited\(res\.meta\?\.limit/,
    'เหตุผลที่หน้าเว็บบอกต้องถูกพกขึ้นไปด้วย ไม่ใช่หายระหว่างทาง',
  );
  assert.match(
    machine,
    /e instanceof RateLimited\) \{[\s\S]{0,400}job\.status = 'rate_limited'/,
    'ชนลิมิตต้องจบด้วยการหยุดและรอคนสั่งทำต่อ',
  );
});
