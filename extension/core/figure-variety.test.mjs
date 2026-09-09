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
