/**
 * โหมดรายชิ้น — หนังสือที่หน่วยของเนื้อหาไม่ใช่ "ตอน" แต่เป็น "ชิ้น"
 * คำคม กลอน บทกวีสั้น คำให้กำลังใจ สุภาษิต
 *
 * ทำไมต้องแยกโหมด: ทั้งระบบร้อยแก้วสร้างบนสมมติฐาน "หน้า = จำนวนอักษร"
 * ซึ่งคลาดสิบเท่ากับหนังสือที่หน้าหนึ่งมีข้อความ 40 ตัวอักษร
 * และลูปปรับจำนวนหน้าที่ยืด/หดข้อความก็ใช้ไม่ได้ เพราะกลอนยืดไม่ได้
 *
 * ข้อดีคือโหมดนี้ง่ายกว่ามาก จำนวนหน้ากลายเป็นเลขคณิตตรง ๆ
 * ไม่ต้องเดา ไม่ต้องวนลูป และขอทีละหลายสิบชิ้นต่อหนึ่งข้อความได้
 */

export const ITEM_KINDS = {
  quote: {
    label: 'คำคม',
    brief: 'คำคมสั้น กระชับ จบในตัว อ่านแล้วสะกิดใจทันที',
    len: '40-120 ตัวอักษร',
    lines: '1-3 บรรทัด',
  },
  poem: {
    label: 'กลอน',
    brief: 'กลอนสี่หรือกลอนแปด มีสัมผัสตามฉันทลักษณ์ไทย',
    len: '150-400 ตัวอักษร',
    lines: '4-8 บรรทัด',
  },
  'short-poem': {
    label: 'บทกวีสั้น',
    brief: 'บทกวีอิสระ ไม่บังคับสัมผัส เน้นภาพและจังหวะ',
    len: '80-250 ตัวอักษร',
    lines: '3-6 บรรทัด',
  },
  affirmation: {
    label: 'คำให้กำลังใจ',
    brief: 'ประโยคให้กำลังใจที่พูดกับผู้อ่านตรง ๆ ใช้สรรพนามบุรุษที่สอง',
    len: '40-120 ตัวอักษร',
    lines: '1-3 บรรทัด',
  },
  proverb: {
    label: 'สุภาษิต/ข้อคิด',
    brief: 'ข้อคิดแบบสุภาษิต มีภาพเปรียบเทียบ จำง่าย',
    len: '40-140 ตัวอักษร',
    lines: '1-3 บรรทัด',
  },
  tip: {
    label: 'เคล็ดลับสั้น',
    brief: 'เคล็ดลับที่ทำตามได้ทันที หนึ่งข้อหนึ่งเรื่อง',
    len: '80-200 ตัวอักษร',
    lines: '2-4 บรรทัด',
  },
};

/** กี่ชิ้นต่อหนึ่งข้อความของ ChatGPT — ชิ้นสั้นขอได้เยอะ */
const PER_TURN = { quote: 20, affirmation: 20, proverb: 18, 'short-poem': 14, tip: 14, poem: 10 };

export function itemsPerTurn(kind) {
  return PER_TURN[kind] || 15;
}

/**
 * คำนวณจำนวนชิ้นที่ต้องใช้ — ตรงเป๊ะ ไม่ต้องเดา
 * นี่คือเหตุผลที่โหมดนี้ไม่ต้องมีลูปปรับจำนวนหน้า
 */
export function planItems(book) {
  const perPage = Math.max(1, book.itemsPerPage || 1);
  const short = (book.targetPages || 120) <= 12;
  const front = Math.max(1, (book.frontMatter || []).length);
  const back = Math.max(0, (book.backMatter || []).length * 2);
  const themes = short ? 1 : Math.max(1, book.themeCount || 1);
  const dividerPages = themes > 1 ? themes * 1.5 : 0;

  const itemPages = Math.max(1, book.targetPages);
  const total = Math.max(perPage, Math.round(itemPages * perPage));

  return {
    total,
    perPage,
    perTheme: Math.max(1, Math.round(total / themes)),
    themes,
    turns: Math.ceil(total / itemsPerTurn(book.itemKind)) + 1,
    breakdown: { front, back, dividerPages, itemPages, targetPhysical: front + back + dividerPages + itemPages },
  };
}

/** ขนาดตัวอักษรที่เหมาะกับจำนวนชิ้นต่อหน้า */
export function suggestItemSize(book) {
  const perPage = book.itemsPerPage || 1;
  const base = { 1: 26, 2: 20, 3: 17, 4: 15 }[perPage] || 18;
  // เล่มเล็กต้องลดขนาดลงตามส่วน
  const scale = Math.min(1, book.trim.widthMm / 148);
  return Math.round(base * scale * 10) / 10;
}

// ---------- prompt ----------

export function themePrompt(book, plan) {
  const k = ITEM_KINDS[book.itemKind] || ITEM_KINDS.quote;
  return `วางโครงหนังสือรวม${k.label}

หัวข้อ/แก่นของเล่ม: ${book.topic}
กลุ่มผู้อ่าน: ${book.audience}
โทน: ${book.tone}
${book.trendSeed?.trend ? `กระแสตั้งต้น: ${book.trendSeed.trend}\nเหตุผลที่กำลังมา: ${book.trendSeed.why_now || '-'}\nมุมหนังสือ: ${book.trendSeed.book_angle || '-'}\nแหล่งตั้งต้น: ${(book.trendSeed.sources || []).map((s) => `${s.publisher || s.title}: ${s.url || ''}`).join(' · ')}\n` : ''}${book.outlineDirection?.chapters?.length ? `โครงหมวดที่ผู้ใช้เลือก:\n${book.outlineDirection.chapters.map((c) => `${c.n}. ${c.title}${c.purpose ? ` — ${c.purpose}` : ''}`).join('\n')}\nต้องยึดโครงหมวดนี้เป็นหลัก\n` : ''}ต้องใช้ทั้งหมด ${plan.total} ชิ้น

แบ่งเป็น ${plan.themes} หมวด หมวดละประมาณ ${plan.perTheme} ชิ้น
แต่ละหมวดต้องมีมุมที่ต่างกันจริง ไม่ใช่ชื่อต่างกันแต่เนื้อเดียวกัน

ตอบเป็น JSON ในบล็อกโค้ดเดียว
\`\`\`json
{
  "title": "ชื่อหนังสือที่คนหยิบขึ้นมาอ่าน",
  "subtitle": "ขยายความสั้น ๆ",
  "themes": [
    { "n": 1, "title": "ชื่อหมวด", "angle": "หมวดนี้พูดถึงมุมไหนโดยเฉพาะ", "count": ${plan.perTheme} }
  ]
}
\`\`\``;
}

export function itemBatchPrompt({ book, outline, theme, count, avoid, startIndex }) {
  const k = ITEM_KINDS[book.itemKind] || ITEM_KINDS.quote;
  const ids = Array.from({ length: count }, (_, i) => `${theme.n}.${startIndex + i}`);

  return `เขียน${k.label} ${count} ชิ้นสำหรับหมวด "${theme.title}"

หนังสือ: ${outline.title}
มุมของหมวดนี้: ${theme.angle || theme.title}
กลุ่มผู้อ่าน: ${book.audience}
โทน: ${book.tone}

ข้อกำหนดของแต่ละชิ้น
- ${k.brief}
- ความยาว ${k.len} ประมาณ ${k.lines}
- แต่ละชิ้นต้องจบในตัว อ่านเดี่ยว ๆ ได้ ไม่อ้างถึงชิ้นอื่น
- ห้ามซ้ำความหมายกันเอง และห้ามซ้ำกับรายการด้านล่าง
${book.itemAttribution ? '- ถ้าอ้างคำพูดของบุคคลจริง ต้องเป็นคำพูดที่มีอยู่จริงเท่านั้น ถ้าไม่แน่ใจให้เขียนขึ้นเองแล้วเว้นช่องที่มาว่าง ห้ามกุชื่อคนใส่' : '- ไม่ต้องใส่ชื่อผู้พูด'}

${avoid?.length ? `ใจความที่ใช้ไปแล้ว ห้ามซ้ำ\n${avoid.map((a) => `- ${a}`).join('\n')}\n` : ''}
รูปแบบคำตอบ — สำคัญมาก ห้ามผิด:
ตอบเป็นบล็อกโค้ดเดียว ขึ้นต้นด้วยสามแบ็กทิกตามด้วยคำว่า markdown
ในบล็อกใส่ทีละชิ้นตามรูปนี้ ให้ครบ ${count} ชิ้น เรียงตามรหัสที่ให้มา

${ids
  .map(
    (id) => `<<<ITEM ${id}>>>
(ข้อความของชิ้นนี้ ขึ้นบรรทัดใหม่ได้ตามฉันทลักษณ์)
${book.itemAttribution ? '~ ที่มา (ถ้าไม่มีให้เว้นบรรทัดนี้ทิ้ง)' : ''}
<<<END ${id}>>>`,
  )
  .join('\n')}

ห้ามเขียนอะไรนอกบล็อกโค้ด ห้ามใส่หมายเลขข้อ ห้ามทักทาย ห้ามสรุปท้าย`;
}

/** แกะชิ้นทั้งหมดจากคำตอบเดียว */
export function extractItems(raw, ids) {
  const out = [];
  for (const id of ids) {
    const re = new RegExp(
      `<<<ITEM ${id.replace(/\./g, '\\.')}>>>([\\s\\S]*?)<<<END ${id.replace(/\./g, '\\.')}>>>`,
    );
    const m = String(raw || '').match(re);
    if (!m) continue;

    const body = m[1].trim();
    const lines = body.split('\n').map((l) => l.trim());
    let attribution = '';
    if (lines.length && lines.at(-1).startsWith('~')) {
      attribution = lines.pop().replace(/^~\s*/, '').trim();
    }
    const text = lines.join('\n').trim();
    if (text) out.push({ id, text, attribution });
  }
  return out;
}
