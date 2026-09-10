/**
 * คำตอบที่เหลือแต่หมุดอ้างอิงของการค้นเว็บ — อาการที่ทำให้โหมดอัตโนมัติหยุดตั้งแต่ขั้นคิดชื่อ
 *
 * ของจริงที่บันทึกได้จากหน้าจอ: ChatGPT ตอบยาว 310 ตัวอักษร แต่ทุกตัวอักษรเป็นหมุด
 * :contentReference[oaicite:N]{index=N} ไม่มีชื่อหนังสือสักชื่อ ยิงซ้ำสามรอบได้ผลเดิมทั้งสามรอบ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { citationGutted, parseJson } from './extract.js';
import { titleIdeasPrompt, trendIdeasPrompt, NO_CITATION_RULE } from './prompts.js';

// คัดลอกจากบันทึกหน้าจอจริงตอนงานหยุด
const FROM_LOG =
  '{\n  "titles"::contentReference[oaicite:0]{index=0}:contentReference[oaicite:1]{index=1}' +
  ':contentReference[oaicite:2]{index=2}:contentReference[oaicite:3]{index=3}' +
  ':contentReference[oaicite:4]{index=4}:contentReference[oaicite:5]{index=5}' +
  ':contentReference[oaicite:6]{index=6}:contentReference[oaicite:7]{index=7}';

test('รู้จักคำตอบที่เหลือแต่หมุดอ้างอิง และไม่เข้าใจผิดว่าคำตอบดี ๆ เป็นแบบนั้น', () => {
  assert.equal(citationGutted(FROM_LOG), true);
  assert.equal(citationGutted('{"titles":[{"title":"เมืองที่ไม่เคยหลับ"}]}'), false);
  // มีหมุดติดมาบ้างแต่เนื้อหาจริงมาครบ = ใช้ได้ ไม่ใช่อาการนี้
  assert.equal(citationGutted('{"titles":[{"title":"เมืองที่ไม่เคยหลับ :contentReference[oaicite:0]{index=0}"}]}'), false);
  assert.equal(citationGutted(''), false);
  assert.equal(citationGutted('{"titles":['), false); // ตัดกลางคันเฉย ๆ คนละอาการ
});

test('หมุดล้วนอ่านเป็น JSON ไม่ได้จริง — จึงต้องแยกอาการให้ออกตั้งแต่ต้น', () => {
  const parsed = parseJson(FROM_LOG);
  assert.ok(!parsed?.titles?.length);
});

test('ขั้นที่ล่อให้ค้นเว็บที่สุดต้องพกกฎห้ามอ้างอิงไปด้วยทุกภาษาและทุกโหมด', () => {
  for (const contentMode of ['prose', 'fiction']) {
    const p = titleIdeasPrompt({ topic: 'การนอน', contentMode, today: '2026-09-10' });
    assert.ok(p.includes(NO_CITATION_RULE.trim().split('\n')[0]), `ขาดกฎห้ามอ้างอิงในโหมด ${contentMode}`);
    assert.ok(/contentReference/.test(p));
  }
  assert.ok(trendIdeasPrompt({ today: '2026-09-10' }).includes('oaicite'));
});

/**
 * ทางผ่านเดียวของทุกขั้นที่คุยกับหน้าเว็บ ต้องปิดอาการนี้ได้ครบทุกโหมด
 * ไม่ใช่ปิดเฉพาะปุ่มบนหน้า Studio — ขั้นเขียน สารบัญ ตรวจ ก็เจอเหมือนกัน
 */
test('turnWithRetry สั่งใหม่แบบห้ามค้นเว็บเมื่อได้แต่หมุด แล้วไม่ยอมรับหมุดเป็นคำตอบ', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async turnWithRetry('), src.indexOf('/** บันทึกล่าสุดของงานนี้'));
  // ต้องดักที่ status ok เพราะเทิร์นแบบนี้ผ่านทุกด่านแล้วไปพังตอนแกะ JSON
  assert.match(body, /res\.status === 'ok' && X\.citationGutted\(res\.text\)/);
  assert.match(body, /P\.NO_CITATION_RULE/);
  // สั่งห้ามค้นเว็บแล้วยังได้หมุดอีก ต้องนับเป็นล้ม ไม่ใช่ส่งหมุดต่อให้ขั้นบน
  assert.match(body, /citation_only/);
});

test('ขั้นเสนอสารบัญก็พกกฎห้ามอ้างอิงไปด้วย เพราะมันรับหัวข้อจากกระแสมาต่อ', async () => {
  const { outlineDirectionsPrompt } = await import('./prompts.js');
  for (const contentMode of ['prose', 'fiction']) {
    const p = outlineDirectionsPrompt({ title: 'ชื่อเล่ม', contentMode, trendSeed: { trend: 'หัวข้อ' } });
    assert.ok(/oaicite/.test(p), `ขาดกฎห้ามอ้างอิงในโหมด ${contentMode}`);
  }
});
