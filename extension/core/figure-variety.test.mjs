import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interiorFigurePrompt, figurePlanPrompt } from './prompts.js';

/**
 * ภาพในเล่มไปทางเดียวกันหมด เพราะทุกรูปได้คำสั่งชุดเดียวกันเป๊ะ
 * ต่างกันแค่ประโยค Subject ที่บอกว่าวาดอะไร ที่เหลือเหมือนกันทุกบรรทัด
 * โมเดลที่ได้คำสั่งเหมือนกันจึงคืนภาพที่จัดวางเหมือนกัน ต่างแค่ของที่อยู่ในภาพ
 */
const cover = {
  style: 'documentary photograph, real workshop',
  texture: 'ผิวไม้จริง',
  lighting: 'แสงหน้าต่างตอนเช้า',
  palette: [{ hex: '#2B3A42' }, { hex: '#C96A2B' }, { hex: '#F3EDE4' }],
};
const make = (i) =>
  interiorFigurePrompt('photoColor', `ภาพที่ ${i}`, 120, 80, '3:2', { color: true, cover, figureIndex: i });

test('รูปที่อยู่ติดกันได้มุมกล้องคนละแบบ', () => {
  const shots = [0, 1, 2, 3].map((i) => make(i).match(/HOW THIS ONE IS FRAMED[^.]*\./)[0]);
  assert.equal(new Set(shots).size, 4);
});

test('เล่มยาวก็ยังไม่วนกลับมาซ้ำเร็ว ๆ — จังหวะเปลี่ยนเมื่อมุมกล้องวนครบรอบ', () => {
  const first = make(0);
  const wrapped = make(8); // ครบรอบมุมกล้องแปดแบบ
  const shotOf = (p) => p.match(/HOW THIS ONE IS FRAMED[^.]*\./)[0];
  const momentOf = (p) => p.match(/Moment shown: [^.]*\./)[0];
  assert.equal(shotOf(first), shotOf(wrapped));
  assert.notEqual(momentOf(first), momentOf(wrapped));
});

test('ทุกรูปถูกสั่งตรง ๆ ว่าห้ามใช้มุมและระยะซ้ำกับรูปอื่น', () => {
  const p = make(2);
  assert.match(p, /Do not reuse the vantage point, camera distance or arrangement of any other figure/);
  assert.match(p, /reads as one picture repeated/);
});

test('อยู่โลกเดียวกับปกได้ แต่ต้องไม่ใช่การวาดปกซ้ำ', () => {
  const p = make(1);
  assert.match(p, /SAME BOOK AS THE COVER/);
  assert.match(p, /DIFFERENT moment inside that world/);
  assert.match(p, /do not redraw the cover either/);
});

test('ไม่รู้ลำดับรูปก็ยังใช้จำนวนรูปก่อนหน้าแทนได้', () => {
  const p = interiorFigurePrompt('line', 'ภาพหนึ่ง', 120, 80, '3:2', {
    color: false,
    otherSubjects: ['ก', 'ข', 'ค'],
  });
  assert.match(p, /HOW THIS ONE IS FRAMED/);
  // ลำดับ 3 = มุมที่สี่ในรายการ
  assert.match(p, /high angle looking straight down/);
});

test('ขั้นวางแผนภาพถูกสั่งให้กระจายฉาก ไม่ใช่วนอยู่กับโต๊ะทำงาน', () => {
  const p = figurePlanPrompt(
    { contentMode: 'prose', topic: 'งานไม้', language: 'th', figureDensity: 'normal' },
    { chapters: [{ n: 1, title: 'บทที่ 1', sections: [] }] },
    [],
    'photoColor',
  );
  assert.match(p, /ภาพทุกรูปในเล่มต้องต่างกันที่ "สิ่งที่ตาเห็น"/);
  assert.match(p, /คนนั่งหน้าแล็ปท็อป/);
  assert.match(p, /ถ้าสรุปสองรูปด้วยประโยคเดียวกันได้/);
});

/**
 * ความหลากหลายที่แท้จริงมีอยู่ในเล่มอยู่แล้ว — แต่ละตอนเล่าคนละเรื่อง
 * คนวาดแค่ไม่เคยได้อ่านมัน ได้แต่ประโยค subject ที่ย่อมาอีกทีจนเหลือแต่หัวข้อกว้าง ๆ
 */
const { figureNearbyText } = await import('./prompts.js');

const md = `## หัวข้อที่ไม่ใช่สิ่งที่ตาเห็น

ย่อหน้าแรกเล่าถึงร้านกาแฟเล็กในซอยที่เปิดตีห้า เจ้าของยกลังนมขึ้นวางบนเคาน์เตอร์ไม้ที่มีรอยครูดจากการใช้งานมาสิบปี

![](fig:fig-1.1-1.png 80% 60mm)

ย่อหน้ากลางเล่าถึงสมุดจดออเดอร์ปกหนังที่เปียกฝนจนหมึกเลอะ วางอยู่ข้างเครื่องคิดเลขที่ปุ่มสึกจนมองไม่เห็นตัวเลข

:::box สรุป
- ของในกล่องสรุปไม่ใช่ฉากที่ต้องวาด
:::

ย่อหน้าท้ายเล่าถึงตอนปิดร้าน เก้าอี้ถูกคว่ำขึ้นบนโต๊ะ และไฟหน้าร้านดวงเดียวที่ยังเปิดค้างไว้จนถึงเช้า`;

test('ตัดเนื้อหาตามตำแหน่งที่ภาพจะไปอยู่ ไม่ใช่ตัดจากต้นตอนเสมอ', () => {
  assert.match(figureNearbyText(md, 'after_intro'), /ร้านกาแฟเล็กในซอย/);
  assert.match(figureNearbyText(md, 'before_conclusion'), /เก้าอี้ถูกคว่ำขึ้นบนโต๊ะ/);
  assert.equal(/ร้านกาแฟเล็กในซอย/.test(figureNearbyText(md, 'before_conclusion')), false);
});

test('หัวข้อ ภาพที่แทรกไว้ และกล่องสรุป ไม่ใช่สิ่งที่ต้องวาด', () => {
  const out = figureNearbyText(md, 'middle');
  assert.equal(/หัวข้อที่ไม่ใช่สิ่งที่ตาเห็น/.test(out), false);
  assert.equal(/fig-1\.1-1\.png/.test(out), false);
  assert.equal(/ของในกล่องสรุป/.test(out), false);
});

test('ตอนที่ยังไม่มีเนื้อหา ไม่ทำให้คำสั่งภาพพัง', () => {
  assert.equal(figureNearbyText('', 'middle'), '');
  const p = interiorFigurePrompt('photoColor', 'ภาพหนึ่ง', 120, 80, '3:2', { color: true, nearby: '' });
  assert.equal(/WHAT THIS PART OF THE BOOK ACTUALLY DESCRIBES/.test(p), false);
  assert.match(p, /HOW THIS ONE IS FRAMED/);
});

/**
 * เนื้อหาคุมว่า "มีอะไรอยู่ในภาพ" — ข้อนี้ห้ามอ่อนลงเด็ดขาด ภาพต้องตรงกับเล่มเสมอ
 */
test('เนื้อหาจริงถูกส่งเข้าคำสั่งวาด และคุมสิ่งที่อยู่ในภาพ', () => {
  const p = interiorFigurePrompt('photoColor', 'สมุดจดออเดอร์', 120, 80, '3:2', {
    color: true,
    nearby: figureNearbyText(md, 'middle'),
    figureIndex: 1,
  });
  assert.match(p, /WHAT THIS PART OF THE BOOK ACTUALLY DESCRIBES/);
  assert.match(p, /สมุดจดออเดอร์ปกหนังที่เปียกฝน/);
  assert.match(p, /Every place, object, action and detail in the picture must be something this passage names/);
  assert.match(p, /Never swap them for a generic stand-in scene/);
});

/**
 * แต่เนื้อหาไม่ได้คุม "กล้องยืนตรงไหน" — เดิมเขียนไว้ว่า "the passage wins" ลอย ๆ
 * แล้วพังกับเล่มที่ทุกตอนบรรยายสถานการณ์เดียวกัน (เล่มสอนพูดหน้ากล้อง: ทุกตอนมีคนนั่งหน้ากล้อง)
 * โมเดลสรุปว่าเนื้อหากำหนดมุมแล้ว จึงทิ้งรายการมุมกล้องทุกใบ ภาพทั้งเล่มออกมาเป็นรูปเดียวกันซ้ำ ๆ
 *
 * ของสองอย่างนี้ไม่เคยขัดกันจริง ฉากเดียวกันถ่ายได้แปดมุมโดยไม่ผิดเนื้อหาสักตัว
 */
test('เนื้อหาคุมสิ่งที่อยู่ในภาพ ส่วนมุมกล้องคุมว่ากล้องยืนตรงไหน', () => {
  const p = interiorFigurePrompt('photoColor', 'สมุดจดออเดอร์', 120, 80, '3:2', {
    color: true,
    nearby: figureNearbyText(md, 'middle'),
    figureIndex: 1,
  });
  assert.match(p, /This passage decides WHAT is in the picture\. It does not decide where the camera stands/);
  assert.match(p, /this line decides where the camera stands and how close it is/);
  assert.match(p, /HOW THIS ONE IS FRAMED — this line is not a suggestion/);
  assert.ok(!/the passage wins/.test(p), 'คำที่ทำให้โมเดลทิ้งมุมกล้องทุกใบต้องไม่กลับมา');
});

/**
 * ประตูหลังที่ยังต้องมี — ถ้าเนื้อหาระบุมุมไว้เป็นคำพูดจริง ๆ เนื้อหาต้องชนะ
 * ไม่ใช่แค่บรรยายฉากแล้วถือว่าระบุมุมแล้ว
 */
test('เนื้อหายังชนะได้ ถ้าระบุมุมไว้เป็นคำพูด', () => {
  const p = interiorFigurePrompt('photoColor', 'สมุดจดออเดอร์', 120, 80, '3:2', {
    color: true,
    nearby: figureNearbyText(md, 'middle'),
    figureIndex: 1,
  });
  assert.match(p, /Override it only if the passage names a viewpoint in so many words/);
});

/**
 * เล่มที่ทุกตอนเป็นฉากเดียวกันคือเคสที่ทำให้เรื่องนี้แตก ต้องสั่งตรง ๆ ว่ายิ่งเหมือนยิ่งต้องเปลี่ยนมุม
 */
test('ฉากซ้ำแบบเดิมคือเหตุผลให้เปลี่ยนมุม ไม่ใช่ข้ออ้างให้ใช้มุมเดิม', () => {
  const p = interiorFigurePrompt('photoColor', 'คนนั่งหน้ากล้อง', 120, 80, '3:2', {
    color: true,
    nearby: figureNearbyText(md, 'middle'),
    figureIndex: 2,
  });
  assert.match(p, /same kind of scene as other figures — especially then/);
});

test('เครื่องผลิตส่งเนื้อหาบริเวณนั้นไปให้จริง', async () => {
  const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  assert.match(machine, /nearby: P\.figureNearbyText\(rec\.md, f\.placement\)/);
});

test('ขั้นวางแผนถูกสั่งให้หยิบของจากตอนนั้นจริง', () => {
  const p = figurePlanPrompt(
    { contentMode: 'prose', topic: 'ร้านกาแฟ', language: 'th' },
    { chapters: [{ n: 1, title: 'บทที่ 1', sections: [] }] },
    [],
    'photoColor',
  );
  assert.match(p, /subject ต้องหยิบของที่ "ตอนนั้นบรรยายไว้จริง" มาใช้/);
  assert.match(p, /ถ้าเอา subject ไปวางกับตอนอื่นแล้วยังใช้ได้พอดี/);
});
