import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { frontCoverPrompt, backCoverPrompt, interiorFigurePrompt, styleTokenPrompt } from './prompts.js';

/**
 * ภาษาภาพของปกเลือกได้ทุกแบบ แต่ต้องเหมาะกับเนื้อหาและทำให้ถึง
 *
 * ของเดิมมีสองอย่างที่ทำให้ปกทุกเล่มออกมาหน้าตาเดียวกันและดูเก่า:
 * บังคับ 3 สีเป็น flat fill ทั้งปก และมีประโยคบอกโมเดลตรง ๆ ว่า
 * "การวาดชนะภาพถ่ายเหมือนจริง" ซึ่งตัดภาพถ่ายทิ้งตั้งแต่ต้น
 * ตอนนี้ทั้งภาพถ่ายและภาพวาด/พิมพ์/คอลลาจ/3D อยู่บนเส้นเริ่มต้นเดียวกัน
 */
const photoStyle = {
  name: 'ทาง A',
  style: 'documentary photograph, real workshop',
  texture: 'ผิวไม้จริง ฝุ่นจริง',
  lighting: 'แสงหน้าต่างตอนเช้า ทิศเดียว',
  mood: 'จริง อุ่น ตั้งใจ',
  visual_metaphor: 'ช่างกำลังวัดไม้',
  human_element: 'ช่างไม้กำลังวัดไม้',
  background_element: 'ราวเครื่องมือบนผนัง',
  palette: [
    { hex: '#2B3A42', name: 'เงาในห้อง' },
    { hex: '#C96A2B', name: 'ไม้ที่โดนแดด' },
    { hex: '#F3EDE4', name: 'ผนังปูน' },
  ],
  typography: {},
};
const paintedStyle = {
  ...photoStyle,
  style: 'gouache painting on rough paper, visible pigment and brush marks',
  texture: 'เนื้อสีฝุ่นบนกระดาษหยาบ',
};
const book = { topic: 'งานไม้', genre: 'how-to', trim: { preset: 'a5' }, style: photoStyle };
const outline = { thesis: 'ลงมือทำจริง', chapters: [] };

test('ปกยึดภาษาภาพที่ art director เลือก ไม่ล็อกว่าต้องเป็นภาพถ่าย', () => {
  const photo = frontCoverPrompt(photoStyle, book, outline);
  assert.match(photo, /execute EXACTLY this[\s\S]{0,120}documentary photograph, real workshop/);
  assert.match(photo, /if it is photographic, it must read as a real photograph/);

  const painted = frontCoverPrompt(paintedStyle, { ...book, style: paintedStyle }, outline);
  assert.match(painted, /gouache painting on rough paper/);
  assert.match(painted, /the medium itself must be visible and convincing/);
  // ไม่มีการแบนภาพวาด/เวกเตอร์/คอลลาจ/3D อีกต่อไป
  assert.equal(/are all failed output/.test(painted), false);
});

test('สิ่งที่ยังห้ามคือคลิปอาร์ต ไม่ใช่การวาด', () => {
  const p = frontCoverPrompt(paintedStyle, book, outline);
  assert.match(p, /never acceptable in any medium is generic clip-art/);
  assert.match(p, /stock icon sets/);
});

test('palette เหลือหน้าที่เดียวคือบอกสีตัวหนังสือ ไม่ใช่ย้อมทั้งปก', () => {
  const p = frontCoverPrompt(photoStyle, book, outline);
  assert.match(p, /sampled FROM this intended image/);
  assert.match(p, /NOT a three-colour palette to repaint the whole cover with/);
  assert.match(p, /Do not flatten everything into three flat fills/);
  // คำสั่งเดิมที่บังคับสีและผลักออกจากภาพถ่าย ต้องไม่เหลืออยู่
  assert.equal(/Reproduce these hex values faithfully/.test(p), false);
  assert.equal(/beats a default photoreal person/.test(p), false);
});

test('คนบนปกทำด้วยสื่อเดียวกับปก และห้ามเป็นหุ่นสต็อก', () => {
  const p = frontCoverPrompt(photoStyle, book, outline);
  assert.match(p, /same visual language as the rest of the cover, executed at the same level of craft/);
  assert.match(p, /generic faceless mannequin or a default stock figure/);
});

test('ปกหลังมาจากการผลิตชุดเดียวกับปกหน้า', () => {
  const p = backCoverPrompt(photoStyle, book, outline);
  assert.match(p, /THE SAME PRODUCTION as the front cover/);
  assert.match(p, /same visual language, same medium and craft/);
  assert.match(p, /photographic front means a photograph from the same shoot/);
  assert.match(p, /reads as a different book and is a failed output/);
});

test('ภาพในเล่มถูกบอกว่าปกหน้าตาอย่างไร แล้วต้องอยู่โลกเดียวกัน', () => {
  const p = interiorFigurePrompt('photoColor', 'ช่างกำลังไสไม้', 120, 80, '3:2', {
    color: true,
    palette: photoStyle.palette,
    cover: photoStyle,
  });
  assert.match(p, /SAME BOOK AS THE COVER/);
  assert.match(p, /documentary photograph, real workshop/);
  assert.match(p, /แสงหน้าต่างตอนเช้า/);
  assert.match(p, /Match its medium, its level of realism/);
  // สีของภาพในเล่มอ้างอิงโลกของปก ไม่ใช่เอา hex ไปถมเป็นสีแบน
  assert.match(p, /do not paste those hex values in as flat brand fills/);
});

test('ไม่รู้จักปก ก็ยังสร้างคำสั่งภาพในเล่มได้ตามปกติ', () => {
  const p = interiorFigurePrompt('line', 'แผนผังขั้นตอน', 120, 80, '3:2', { color: false });
  assert.equal(/SAME BOOK AS THE COVER/.test(p), false);
  assert.match(p, /Interior book illustration/);
});

test('บรีฟ art director เปิดให้เลือกทุกภาษาภาพ แต่ต้องมีเหตุผล', async () => {
  const src = await readFile(new URL('./prompts.js', import.meta.url), 'utf8');
  const start = src.indexOf('8. ภาษาภาพของปกเลือกได้ทุกแบบ');
  assert.ok(start > 0, 'กติกาข้อ 8 ต้องเปิดให้เลือกภาษาภาพ');
  const rule = src.slice(start, start + 900);
  assert.match(rule, /ภาพถ่ายเหมือนจริง ภาพวาด ภาพเวกเตอร์ กราฟิกแบน คอลลาจ ภาพพิมพ์ 3D render/);
  assert.match(rule, /ต้องบอกใน why_it_fits ว่าทำไมภาษาภาพนี้ถึงเหมาะกับเล่มนี้/);
  assert.match(rule, /ไม่ใช่ภาพเวกเตอร์สำเร็จรูปแบบคลิปอาร์ต/);
  // กติกาเดิมที่บังคับกลยุทธ์สีเป็นตัวแยกสามทิศทาง ต้องไม่เหลืออยู่
  assert.equal(/ทั้ง 3 ทิศทางต้องต่างกันที่ "กลยุทธ์สี"/.test(src), false);
  // และต้องไม่แบนภาษาภาพใด
  assert.equal(/ห้ามเสนอภาพประกอบวาด/.test(src), false);
});

test('มีสไตล์ภาพในเล่มแบบภาพถ่ายสีให้เลือกด้วย', async () => {
  const { FIGURE_STYLES } = await import('./prompts.js');
  assert.ok(FIGURE_STYLES.photoColor);
  assert.match(FIGURE_STYLES.photoColor.brief, /photorealistic documentary photograph/);
});

test('บรีฟทิศทางปกยังสร้างได้ครบหลังแก้กติกา', () => {
  const p = styleTokenPrompt(book, outline);
  assert.match(p, /ภาษาภาพของปกเลือกได้ทุกแบบ/);
  assert.match(p, /"palette"/);
});

/**
 * ทิ้งทั้งแนวปกเพราะนับสีได้ไม่ครบสาม เป็นกติกาที่ตกยุคไปแล้ว
 * ตอนที่ palette ยังเป็นคำสั่งระบายสี ครบสามคือเงื่อนไขจำเป็นจริง
 * ตอนนี้มันเหลือหน้าที่เดียวคือบอกสีตัวหนังสือ แนวที่ดีจึงไม่ควรถูกโยนทิ้งเพราะนับสีไม่ครบ
 */
test('แนวปกไม่ถูกทิ้งเพราะบรีฟสีมาไม่ครบสามสี', async () => {
  const vm = await import('node:vm');
  const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
  const block = machine.slice(machine.indexOf('const HEX = /^#'), machine.indexOf('const dropped = directions.length'));
  const scope = {
    directions: [
      { id: 'A', typography: {}, palette: [{ hex: '#112233' }, { hex: '#445566' }] },
      { id: 'B', typography: {}, palette: [{ hex: '#a1b2c3' }, { hex: '#d4e5f6' }, { hex: '#010203' }, { hex: '#ffffff' }] },
      { id: 'C', typography: {}, palette: [{ hex: 'ไม่ใช่สี' }] },
      { id: 'D', palette: [{ hex: '#123456' }] },
    ],
  };
  vm.createContext(scope);
  vm.runInContext(`${block}
globalThis.usable = usable;`, scope);
  const ids = scope.usable.map((d) => d.id);

  // สองสีก็ใช้ได้ เติมช่องที่ขาดด้วยสีจริงที่มีอยู่ ไม่ใช่สีที่คิดขึ้นเอง
  assert.deepEqual(ids, ['A', 'B']);
  assert.deepEqual(scope.usable[0].palette.map((c) => c.hex), ['#112233', '#445566', '#445566']);
  // สี่สีถูกตัดเหลือสามช่องตามที่ระบบอ้างถึง palette_1..3
  assert.equal(scope.usable[1].palette.length, 3);
  // ไม่มีสีที่อ่านค่าได้เลย หรือไม่มีตำแหน่งตัวหนังสือ = ใช้ไม่ได้จริง
  assert.equal(ids.includes('C'), false);
  assert.equal(ids.includes('D'), false);
});

test('หน้าจอบอกว่าสีชุดนี้มีไว้วางตัวหนังสือ ไม่ใช่ชุดสีของภาพ', async () => {
  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /สีสำหรับวางตัวหนังสือ/);
  assert.match(studio, /ไม่ใช่สีที่ใช้ย้อมภาพ/);
});

/**
 * "อันไหนสีน้อย จะดูไม่น่าดึงดูดเลย" — ดูจากปกที่พิมพ์มาแล้วทั้งกระดาน
 *
 * ปกที่รอดคือปกที่มีสีสดเป็นก้อนใหญ่ (พื้นส้ม แผงแดง ผนังเขียว)
 * ปกที่จมคือออฟฟิศแสงฟ้าเทา ขาว-เทา-ฟ้าอ่อน ซึ่งเป็นค่าเริ่มต้นที่โมเดลตกไปเองทุกครั้ง
 * ที่ผ่านมากติกาสีผูกกับ energy ของเนื้อหา เล่มแนวเงิน/งาน/ระบบจึงถูกอ่านว่าพลังงานต่ำ
 * แล้วได้ใบอนุญาตให้จืดทั้งใบอย่างถูกกติกา
 */
test('สีสดก้อนใหญ่เป็นขั้นต่ำของทุกทิศทาง ไม่ใช่สิทธิ์ที่ได้มาจากพลังงานของเนื้อหา', () => {
  const p = styleTokenPrompt({ topic: 'เงินเดือนหมดก่อนสิ้นเดือน' }, { title: 'เงินพอใช้' });
  assert.match(p, /ขั้นต่ำที่ทุกทิศทางต้องมี ไม่ว่าพลังงานของเล่มจะเป็นระดับไหน/);
  assert.match(p, /ก้อนใหญ่ที่เห็นได้ตอนย่อเป็นรูปเล็ก/);
  // เล่มหม่นก็ยังต้องมีสี — เดิมบรรทัดนี้เป็นทางออกให้ปกจืดทั้งใบ
  assert.match(p, /energy level 1-2[^\n]*แต่สีสดก้อนใหญ่นั้นยังต้องมี/);
  assert.match(p, /ห้ามฉาก "ออฟฟิศแสงฟ้าเทา/);
});

/**
 * กรรมการเคยให้คะแนนความมีชีวิตของสีจากช่อง palette
 * ซึ่งตอนนี้เหลือหน้าที่เดียวคือเลือกสีตัวหนังสือ ไม่ใช่สีของภาพ
 * เท่ากับตรวจผิดของมาตลอด ปกจืดจึงผ่านด่านนี้ได้สบาย
 */
test('กรรมการตัดสินสีจากภาพที่บรรยายไว้ ไม่ใช่จากสามสีของตัวหนังสือ', async () => {
  const { coverJuryPrompt } = await import('./prompts.js');
  const jury = coverJuryPrompt({ topic: 'x' }, { title: 'y' }, null, []);
  assert.match(jury, /ไม่ใช่ดูที่ช่อง palette/);
  assert.match(jury, /ขาว-เทา-ฟ้าอ่อน-เบจทั้งใบ[^\n]*ให้ไม่เกิน 3 คะแนน/);
  assert.match(jury, /ปกที่จืดไม่ได้แปลว่าน่าเชื่อถือ/);
});
