/**
 * Transport ปลอม — สร้างข้อความยาวตามสั่งโดยไม่ต้องยิง ChatGPT
 *
 * มีไว้เพื่อพิสูจน์ว่าลูปนับหน้าทำงานจริง ซึ่งเป็นหัวใจของระบบและเป็นส่วนที่เสี่ยงที่สุด
 * ควรทำให้ผ่านด้วยตัวนี้ก่อน แล้วค่อยต่อของจริง
 */

import { countChars } from '../core/thai.js';

const WORDS_TH =
  'รายได้ เงินออม ค่าใช้จ่าย กระแสเงินสด ความเสี่ยง เดือน ปี ลูกค้า งาน ใบเสนอราคา ภาษี บัญชี เป้าหมาย แผน วินัย ระบบ ตัวเลข สัดส่วน กันชน ฉุกเฉิน ลงทุน หนี้ ดอกเบี้ย ต้นทุน กำไร ราคา เวลา ความมั่นคง อิสระ การตัดสินใจ ข้อมูล ตัวอย่าง กรณี วิธี ขั้นตอน เครื่องมือ นิสัย ความจริง ปัญหา ทางออก'.split(
    ' ',
  );

const WORDS_EN =
  'income savings expense cashflow risk month year client invoice tax account goal plan discipline system number ratio buffer emergency invest debt interest cost profit price time security freedom decision data example case method step tool habit truth problem solution'.split(
    ' ',
  );

// นับความยาวคำล่วงหน้าด้วยหน่วยเดียวกับ countChars (grapheme) ไม่ใช่ code unit
// ไม่งั้นข้อความปลอมจะสั้นกว่าที่สั่งราว 20% ทุกครั้ง แล้วลูปนับหน้าจะถูกทดสอบผิดโจทย์
const LEN_TH = new Map(WORDS_TH.map((w) => [w, countChars(w)]));

function lorem(units, lang) {
  const bank = lang === 'th' ? WORDS_TH : WORDS_EN;
  const sep = lang === 'th' ? '' : ' ';
  const out = [];
  let n = 0;
  let sentence = [];
  while (n < units) {
    const w = bank[Math.floor(Math.random() * bank.length)];
    sentence.push(w);
    n += lang === 'th' ? LEN_TH.get(w) : 1;
    if (sentence.length >= 8 + Math.floor(Math.random() * 8)) {
      out.push(sentence.join(sep) + (lang === 'th' ? ' ' : '. '));
      sentence = [];
      if (out.length % 4 === 0) out.push('\n\n');
    }
  }
  if (sentence.length) out.push(sentence.join(sep));
  return out.join('').replace(/\n\n\s+/g, '\n\n').trim();
}

function fakeOutline(prompt) {
  const pages = Number(prompt.match(/ขนาดเล่มโดยประมาณ:\s*(\d+)/)?.[1] || 120);
  // ต้องอยู่ในเพดานเดียวกับของจริง ไม่งั้นโหมดทดสอบจะจำลองปัญหาที่ระบบจริงไม่มี
  const cap = Math.max(3, Math.floor(pages / 1.5));
  const nCh = Math.max(1, Math.min(16, Math.min(Math.round(pages / 16) || 1, Math.floor(cap / 3))));
  const chapters = [];
  for (let c = 1; c <= nCh; c++) {
    const nSec = 3 + (c % 2);
    const sections = [];
    for (let s = 1; s <= nSec; s++) {
      sections.push({
        id: `${c}.${s}`,
        title: `ตอนทดสอบ ${c}.${s}`,
        beats: ['เปิดด้วยเคส', 'อธิบายหลักการ', 'สรุปเป็นกฎ'],
        takeaways: [`ประเด็นสำคัญของตอน ${c}.${s}`],
        elastic: true,
      });
    }
    chapters.push({
      n: c,
      title: `บททดสอบที่ ${c}`,
      weight: 0.8 + (c % 3) * 0.2,
      objective: 'ทดสอบลูปนับหน้า',
      adds: 'เพิ่มมุมที่บทก่อนยังไม่มี',
      promises: [],
      sections,
    });
  }
  return {
    title: 'เล่มทดสอบลูปนับหน้า',
    subtitle: 'สร้างด้วย transport ปลอม',
    thesis: 'ระบบต้องทำให้จำนวนหน้าตรงเป้าได้จริงก่อนจะไปสนใจเรื่องอื่น',
    voice_card: 'ตรงไปตรงมา ประโยคสั้น',
    chapters,
  };
}

const json = (obj) => ({ status: 'ok', text: '```json\n' + JSON.stringify(obj, null, 2) + '\n```' });

/**
 * ภาพปลอม — วาดด้วย canvas ในหน้า Studio เอง ไม่ต้องพึ่ง ChatGPT
 *
 * ต้องผ่านสายตรวจจริงทุกด่าน (ขนาดขั้นต่ำ decode ได้ ปรับขนาดตรงช่อง)
 * ไม่งั้นโหมดทดสอบจะผ่านทั้งที่ของจริงพัง หรือพังทั้งที่ของจริงผ่าน
 */
async function fakeImage(prompt) {
  const px = prompt.match(/(\d{3,5})\s*[×x]\s*(\d{3,5})\s*px/);
  const ratio = prompt.match(/ratio\s+(\d+):(\d+)/);
  let w = 1024;
  let h = 1024;
  if (px) {
    w = Number(px[1]);
    h = Number(px[2]);
  } else if (ratio) {
    const r = Number(ratio[1]) / Number(ratio[2]);
    h = 1600;
    w = Math.round(h * r);
  }
  w = Math.max(256, Math.min(2400, w));
  h = Math.max(256, Math.min(2400, h));

  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d');
  const hue = Math.floor(Math.random() * 360);
  const g = cx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 45% 32%)`);
  g.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 68%)`);
  cx.fillStyle = g;
  cx.fillRect(0, 0, w, h);
  cx.fillStyle = 'rgba(255,255,255,.85)';
  cx.font = `${Math.round(Math.min(w, h) / 12)}px sans-serif`;
  cx.textAlign = 'center';
  cx.fillText('TEST', w / 2, h / 2);
  cx.font = `${Math.round(Math.min(w, h) / 26)}px sans-serif`;
  cx.fillText(`${w}×${h}`, w / 2, h / 2 + Math.round(Math.min(w, h) / 9));

  const blob = await cv.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
  return { dataUrl, w, h };
}

export class FakeTransport {
  constructor(opts = {}) {
    this.lang = opts.lang || 'th';
    this.latencyMs = opts.latencyMs ?? 120;
    // ทำให้ไม่แม่นเป๊ะ เหมือนโมเดลจริงที่คุมความยาวได้คร่าว ๆ เท่านั้น
    this.sloppiness = opts.sloppiness ?? 0.12;
  }

  get kind() {
    return 'fake';
  }

  async health() {
    return { ok: true, found: {}, missing: [], model: 'fake' };
  }

  async send(prompt, opts = {}) {
    await new Promise((r) => setTimeout(r, this.latencyMs));

    // ---- เทิร์นสร้างภาพ ----
    if (opts.wantImages) {
      const img = await fakeImage(prompt);
      return {
        status: 'ok',
        text: '',
        images: [img.dataUrl],
        imageDataUrl: img.dataUrl,
        meta: { model: 'fake', imageCapture: { bytes: img.dataUrl.length, width: img.w, height: img.h, errors: [] } },
      };
    }

    // ---- ขั้นที่เพิ่มเข้ามาทีหลัง ----
    if (/"who"\s*:/.test(prompt) && /was_wrong_about/.test(prompt))
      return json({
        who: 'คนที่ทำเรื่องนี้มาเองจนเจ็บมาแล้ว (ข้อมูลทดสอบ)',
        why_this_book: 'เคยพลาดเรื่องเดียวกันนี้ตอนเริ่มต้น',
        believes: 'เริ่มเล็กแล้วแก้เร็ว ดีกว่าวางแผนใหญ่แล้วไม่ได้เริ่ม',
        rejects: 'สูตรสำเร็จที่ใช้ได้กับทุกคน',
        was_wrong_about: 'เคยคิดว่าต้องพร้อมก่อนถึงจะเริ่มได้',
        still_unsure_about: 'ยังไม่รู้ว่าวิธีนี้ใช้กับคนที่มีเงื่อนไขต่างมากได้แค่ไหน',
        avoid_words: ['ปรับกระบวนทัศน์', 'ยกระดับศักยภาพ'],
      });

    if (/"hook"\s*:/.test(prompt) && /"bullets"/.test(prompt))
      return json({
        hook: 'ปัญหานี้ไม่ได้แก้ด้วยความพยายามมากขึ้น (ข้อมูลทดสอบ)',
        body: 'เล่มนี้พาไปดูว่าอะไรคือจุดที่ติดจริง แล้วเปลี่ยนทีละอย่างจนเห็นผล',
        bullets: ['รู้ว่าติดตรงไหน', 'เปลี่ยนได้ตั้งแต่วันนี้', 'รับมือตอนพลาด'],
        closing: 'เริ่มจากหน้าแรกได้เลย',
      });

    if (/"figures"\s*:/.test(prompt)) {
      const ids = [...prompt.matchAll(/^\s{2}(\d+\.\d+)\s/gm)].map((m) => m[1]);
      const pick = ids.filter((_, i) => i % 3 === 0).slice(0, 12);
      return json({
        figures: pick.map((id, i) => ({
          section: id,
          kind: i % 3 === 2 ? 'box' : 'image',
          caption: `ภาพทดสอบของตอน ${id}`,
          subject: `ฉากทดสอบที่อธิบายสาระของตอน ${id}`,
          placement: 'middle',
          aspect: '4:3',
          lines: ['บรรทัดทดสอบ 1', 'บรรทัดทดสอบ 2', 'บรรทัดทดสอบ 3'],
        })),
      });
    }

    // ต้องจำเพาะกว่านี้ เพราะ prompt สารบัญเต็มก็มี "sections":[{"id" และคำว่า beats เหมือนกัน
    if (/ตอนที่ยังขาดข้อมูล/.test(prompt)) {
      const ids = [...prompt.matchAll(/^-\s+(\d+\.\d+)\s/gm)].map((m) => m[1]);
      return json({
        sections: (ids.length ? ids : ['1.1']).map((id) => ({
          id,
          beats: ['เปิดด้วยเคส', 'อธิบายหลักการ', 'สรุปเป็นกฎ'],
          pov_character: 'ตัวละครหลัก',
          scene_goal: 'เป้าหมายทดสอบ',
          conflict: 'แรงต้านทดสอบ',
          turn: 'จุดเปลี่ยนทดสอบ',
        })),
      });
    }

    if (/"titles"\s*:/.test(prompt))
      return json({ titles: [1, 2, 3].map((n) => ({ title: `ชื่อทดสอบที่ ${n}`, subtitle: 'คำขยายทดสอบ', angle: `มุมที่ ${n}` })) });

    if (/"trends"\s*:/.test(prompt))
      return json({
        verified: true,
        searched_at: '2026-01-01',
        trends: [1, 2, 3].map((n) => ({
          trend: `กระแสทดสอบที่ ${n}`,
          why_now: 'ข้อมูลทดสอบ',
          fact_anchor: 'ข้อเท็จจริงทดสอบ',
          book_angle: 'มุมหนังสือทดสอบ',
          suggested_title: `ชื่อจากกระแสที่ ${n}`,
          subtitle: 'คำขยายทดสอบ',
          sources: [{ title: 'แหล่งทดสอบ', publisher: 'Test', url: 'https://example.com/test', date: '2026-01-01' }],
        })),
      });

    if (/"directions"\s*:/.test(prompt) && /"chapters"/.test(prompt))
      return json({
        directions: ['A', 'B', 'C'].map((id) => ({
          id,
          name: `ทิศทางทดสอบ ${id}`,
          promise: 'ผู้อ่านจะได้อะไรจากทางนี้',
          why_choose: 'เหมาะกับคนที่อยากได้แบบนี้',
          chapters: [1, 2, 3, 4, 5, 6].map((n) => ({ n, title: `บททดสอบ ${id}-${n}`, purpose: 'จุดประสงค์ทดสอบ' })),
        })),
      });

    if (/ตอบว่า พร้อม/.test(prompt)) return { status: 'ok', text: 'พร้อม' };
    if (/^ตอบกลับมาคำเดียวว่า OK/.test(prompt)) return { status: 'ok', text: 'OK' };

    if (/"chapters"\s*:\s*\[/.test(prompt) && /"thesis"/.test(prompt)) {
      return { status: 'ok', text: '```json\n' + JSON.stringify(fakeOutline(prompt), null, 2) + '\n```' };
    }

    if (/"duplicates"/.test(prompt)) {
      return {
        status: 'ok',
        text:
          '```json\n' +
          JSON.stringify({
            duplicates: [],
            term_conflicts: [],
            unpaid_promises: [],
            reorder: [],
            chapter_summary: 'บททดสอบผ่าน',
            verdict: 'ok',
          }) +
          '\n```',
      };
    }

    if (/"visual_metaphor"/.test(prompt)) {
      return {
        status: 'ok',
        text:
          '```json\n' +
          JSON.stringify({
            editorial_read: {
              core_promise: 'เห็นภาพเดียวแล้วเข้าใจแก่นของเล่ม',
              reader_expectation: 'ร่วมสมัย อ่านง่าย ไม่เหมือน stock',
              visual_risk: 'องค์ประกอบสำเร็จรูปและพื้นที่ว่างที่ไม่มีหน้าที่',
              thumbnail_strategy: 'วัตถุเด่นเพียงหนึ่งอย่าง',
            },
            directions: [
              {
                id: 'A',
                name: 'ภาพหลักเชิงบรรณาธิการ',
                sales_angle: 'ขายแก่นของเล่มด้วยวัตถุจริงที่จดจำง่าย',
                why_it_fits: 'ผูกกับ thesis โดยตรง',
                risk: 'อย่าใส่รายละเอียดมากเกินไป',
                visual_metaphor: 'แก้วน้ำสามใบวางซ้อนกัน น้ำในแต่ละใบสูงไม่เท่ากัน',
                composition: 'วัตถุหลักกินพื้นที่กลางภาพ มี negative space เฉพาะบริเวณข้อความตาม layout',
                style: 'flat vector editorial illustration',
                palette: [
                  { hex: '#0F2A3D', name: 'deep teal' },
                  { hex: '#E8B33A', name: 'warm ochre' },
                  { hex: '#F2EFE9', name: 'bone white' },
                ],
                texture: 'subtle paper grain',
                lighting: 'soft directional light from upper left',
                mood: 'calm, grounded, honest',
                background_element: 'ผิวน้ำนิ่ง',
                typography: {
                  title: { x_pct: 8, y_pct: 8, width_pct: 84, align: 'left', size_scale: 2.8, color_role: 'palette_3' },
                  subtitle: { x_pct: 8, y_pct: 24, width_pct: 70, align: 'left', size_scale: 1.0, color_role: 'palette_3' },
                  author: { x_pct: 8, y_pct: 88, width_pct: 60, align: 'left', size_scale: 1.1, color_role: 'palette_3' },
                },
                avoid: ['พื้นที่ว่างใหญ่โดยไม่มีหน้าที่', 'stock metaphor'],
              },
            ],
            recommended_id: 'A',
            why_recommended: 'อ่านออกเร็วและผูกกับแก่นของเล่มที่สุด',
          }) +
          '\n```',
      };
    }

    // คำสั่งเขียนตอน หรือเขียนใหม่
    const id = prompt.match(/<<<SEC ([\w.]+) BEGIN>>>/)?.[1];
    const want =
      Number(prompt.match(/ความยาวเป้าหมายใหม่\s*([\d,]+)/)?.[1]?.replace(/,/g, '')) ||
      Number(prompt.match(/ความยาว\s*([\d,]+)/)?.[1]?.replace(/,/g, '')) ||
      3000;

    if (!id) return { status: 'ok', text: lorem(400, this.lang) };

    const noise = 1 + (Math.random() * 2 - 1) * this.sloppiness;
    const body = lorem(Math.max(300, Math.round(want * noise)), this.lang);

    const text = [
      '```markdown',
      `<<<SEC ${id} BEGIN>>>`,
      body,
      `<<<SEC ${id} END>>>`,
      `<<<META ${id} BEGIN>>>`,
      JSON.stringify({
        summary: `สรุปตอน ${id} แบบปลอมสองประโยค เพื่อใช้เป็นบริบทของตอนถัดไป`,
        new_terms: [],
        examples: [`ตัวอย่างปลอมของตอน ${id}`],
        promises: [],
        paid: [],
      }),
      `<<<META ${id} END>>>`,
      '```',
    ].join('\n');

    return { status: 'ok', text, meta: { model: 'fake' } };
  }
}
