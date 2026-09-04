/**
 * แกะคำตอบจาก ChatGPT
 *
 * กลไกที่ทำให้ระบบนี้เชื่อถือได้: เราไม่อ่าน HTML ที่เรนเดอร์แล้วแปลงกลับเป็น markdown
 * แต่บังคับให้โมเดลตอบในบล็อกโค้ดเดียว แล้วอ่าน textContent ตรง ๆ (ทำใน adapter)
 * จากนั้นตรวจด้วย sentinel ที่นี่ ว่าได้ของถูกตอนและครบไม่ถูกตัด
 */

const secRe = (id) =>
  new RegExp(`<<<SEC ${escape(id)} BEGIN>>>([\\s\\S]*?)<<<SEC ${escape(id)} END>>>`);
const anySecRe = /<<<SEC ([\w.]+) BEGIN>>>([\s\S]*?)<<<SEC \1 END>>>/;
const metaRe = (id) =>
  new RegExp(`<<<META ${escape(id)} BEGIN>>>([\\s\\S]*?)<<<META ${escape(id)} END>>>`);
const beginOnly = (id) => new RegExp(`<<<SEC ${escape(id)} BEGIN>>>`);

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @returns {{status:string, body?:string, meta?:object, partial?:string}}
 *  ok            ได้ครบ
 *  truncated     เจอ BEGIN แต่ไม่เจอ END → สั่งเขียนต่อได้
 *  wrong_section ตอบมาผิดตอน → ยิงใหม่
 *  no_sentinel   ไม่ทำตามรูปแบบเลย → ยิงใหม่พร้อมย้ำรูปแบบ
 *  short         ทำตามรูปแบบครบ แต่เขียนสั้นกว่าที่กำหนด — มีเนื้อหาจริง ห้ามทิ้ง
 *  refused       ตอบสั้นโดยไม่มีเครื่องหมายกำกับเลย น่าจะโดนปฏิเสธหรือเตือนนโยบาย
 */
export function extractSection(raw, expectId, { minChars = 200 } = {}) {
  const text = String(raw || '');

  const m = text.match(secRe(expectId));
  if (m) {
    const body = cleanBody(m[1]);
    /**
     * ใส่เครื่องหมายเปิด-ปิดครบแต่เนื้อสั้น ไม่ใช่การถูกปฏิเสธ
     *
     * การปฏิเสธคือโมเดลไม่ยอมเขียนให้เลย ส่วนกรณีนี้คือเขียนให้แล้วแต่เขียนสั้น
     * เดิมเหมารวมเป็น refused เหมือนกัน แล้วเนื้อหาที่ได้มาจริงถูกทิ้งทั้งก้อน
     * ตอนนั้นจึงถูกบันทึกเป็นว่างเปล่า ไปโดนด่านสุดท้ายจับว่า "เขียนไม่สำเร็จ" แล้วหยุดทั้งเล่ม
     * ทั้งที่มีเนื้อหาอยู่ในมือแล้ว แค่สั้นกว่าเป้า ซึ่งมีขั้นปรับจำนวนหน้าคอยตามแก้อยู่แล้ว
     */
    if (body.length < minChars) return { status: 'short', body, meta: extractMeta(text, expectId) };
    return { status: 'ok', body, meta: extractMeta(text, expectId) };
  }

  // เจอ BEGIN แต่ยังไม่จบ = ถูกตัดกลางคัน
  if (beginOnly(expectId).test(text)) {
    const partial = cleanBody(text.split(`<<<SEC ${expectId} BEGIN>>>`)[1] || '');
    return { status: 'truncated', partial };
  }

  // ตอบมาแต่เป็นตอนอื่น
  const other = text.match(anySecRe);
  if (other) return { status: 'wrong_section', gotId: other[1] };

  if (text.trim().length < minChars) return { status: 'refused', body: text.trim() };
  return { status: 'no_sentinel' };
}

/** ต่อชิ้นที่ถูกตัดเข้ากับชิ้นใหม่ โดยตัดส่วนที่ทับกัน */
export function joinContinuation(partial, next) {
  const a = String(partial || '');
  const b = String(next || '');
  const probe = a.slice(-160).trim();
  if (probe) {
    const at = b.indexOf(probe);
    if (at >= 0) return a + b.slice(at + probe.length);
  }
  return a.replace(/\s+$/, '') + '\n' + b.replace(/^\s+/, '');
}

export function extractMeta(raw, id) {
  const m = String(raw || '').match(metaRe(id));
  if (!m) return null;
  return parseJson(m[1]);
}

/**
 * ดึงก้อน {...} ที่วงเล็บปิดครบจริง ๆ ออกมาทุกก้อนจากข้อความ
 *
 * จำเป็นเพราะคำตอบที่ผ่านการค้นเว็บ/มีหลายบล็อกโค้ด อาจมีวงเล็บปีกกาหลายชุดปนกัน
 * การตัดจาก "{ ตัวแรก" ถึง "} ตัวสุดท้าย" แบบเดิมจะได้ข้อความที่ไม่ใช่ JSON ที่ถูกต้อง
 * ตัวนี้ข้ามวงเล็บที่อยู่ในสตริงและ escape ให้ด้วย
 */
function balancedJsonChunks(s) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/**
 * ข้อความที่อ่านจากหน้าเว็บไม่ใช่ JSON สะอาดเสมอไป — ล้างของแถมของตัวเรนเดอร์ออกก่อน
 *
 * คำตอบที่ผ่านการค้นเว็บมักถูกวาดเป็นย่อหน้า ไม่ใช่บล็อกโค้ด innerText จึงพาของแถมมาด้วย
 *   - เครื่องหมายอ้างอิงของหน้าเว็บ ทั้งอักขระเขตส่วนตัว (U+E000–U+F8FF) และข้อความ citeturn0search3
 *   - ช่องว่างไม่ตัดคำ (NBSP) ที่ JSON.parse ไม่ยอมรับเมื่ออยู่นอกสตริง
 *   - การขึ้นบรรทัดใหม่ที่ตัวเรนเดอร์แทรกกลางค่าสตริง ซึ่ง JSON ห้ามมีดิบ ๆ
 * ทั้งหมดนี้ทำให้ JSON.parse ล้มทั้งที่เนื้อหาที่โมเดลตอบมาครบดี
 *
 * ห้ามแปลงเครื่องหมายคำพูดโค้งเป็นตรงเด็ดขาด เพราะเนื้อหาไทย/อังกฤษใช้ “ ” ในค่าสตริงจริง
 * การแปลงจะกลายเป็นการเปิด/ปิดสตริงเกินและพัง JSON ที่เดิมยังดีอยู่
 */
function stripRendererNoise(s) {
  return String(s)
    .replace(/\ue200[\s\S]*?[\ue201\ue202]/g, '') // บล็อกอ้างอิงที่ห่อด้วยอักขระเขตส่วนตัว
    .replace(/(?:cite)?turn\d+(?:search|news|view|image|video|forecast|finance|academia|product)\d+/gi, '')
    .replace(/[\ue000-\uf8ff]/g, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ');
}

/** JSON ห้ามมีอักขระควบคุมดิบในสตริง — แปลงให้ถูกต้องแทนการทิ้งทั้งก้อน */
function escapeControlCharsInStrings(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = false;
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ') continue; // อักขระควบคุมอื่นไม่มีความหมายกับเนื้อหา
    else out += ch;
  }
  return out;
}

function repairJsonText(s) {
  return escapeControlCharsInStrings(stripRendererNoise(s)).replace(/,(\s*[}\]])/g, '$1');
}

/**
 * ปิดสตริงและวงเล็บที่ยังค้างอยู่ให้ครบ คืน '' ถ้าโครงสร้างพังจนปิดไม่ได้
 */
function closeOpenJson(t) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (!stack.length) return '';
      stack.pop();
    }
  }
  let out = t.replace(/\s+$/, '');
  if (esc) out = out.slice(0, -1);
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  return out + stack.reverse().join('');
}

/** ตำแหน่งตัดที่ปลอดภัยตัวสุดท้าย = ลูกน้ำหรือวงเล็บเปิดที่อยู่นอกสตริง */
function lastStructuralCut(t) {
  let inStr = false;
  let esc = false;
  let cut = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ',') cut = i;
    else if (ch === '{' || ch === '[') cut = i + 1; // เก็บวงเล็บเปิดไว้ ให้กลายเป็นก้อนว่าง
  }
  return cut;
}

/**
 * คำตอบที่ถูกตัดกลางคัน (โควตาหมด/เน็ตหลุด/ผู้ใช้กด Stop) ยังกู้ส่วนที่ได้มาแล้วได้
 *
 * ไล่ถอยจากท้ายทีละจุดตัดที่ปลอดภัย แล้วปิดวงเล็บให้ครบในแต่ละรอบ
 * คืนหลายตัวเลือกจากยาวไปสั้น ให้ชั้นบนเลือกอันแรกที่ parse ผ่าน
 */
function salvageTruncatedJson(s, limit = 80) {
  const from = s.search(/[{[]/);
  if (from < 0) return [];
  let t = s.slice(from);
  const out = [];
  for (let n = 0; n < limit && t.length > 2; n++) {
    const closed = closeOpenJson(t);
    if (closed) out.push(closed);
    const cut = lastStructuralCut(t);
    if (cut <= 0) break;
    t = t.slice(0, cut);
  }
  return out;
}

/** แกะ JSON จากคำตอบ ไม่ว่าจะห่อด้วยอะไรมา */
export function parseJson(raw) {
  const text = String(raw || '').trim();

  // เดิมจับบล็อกโค้ดแค่ก้อนแรกก้อนเดียว ถ้า ChatGPT ตอบหลายบล็อก (พบบ่อยตอนค้นเว็บ)
  // แล้ว JSON จริงอยู่บล็อกหลัง ระบบจะอ่านไม่เจอ จึงต้องลองทุกบล็อก
  const fencedAll = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fencedAll, text];

  // เก็บทุกก้อนที่ parse ผ่าน แล้วค่อยเลือกก้อนที่ "เป็นคำตอบจริง" ทีหลัง
  // เพราะโมเดลมักใส่ตัวอย่างสั้น ๆ นำหน้าคำตอบจริง ถ้าคืนก้อนแรกที่ parse ผ่านจะได้ตัวอย่างแทน
  const parsedAll = [];
  const tryParse = (s) => {
    if (!s) return;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') parsedAll.push(v);
    } catch (_) {
      /* ข้าม */
    }
  };

  for (const c of candidates) {
    if (!c) continue;
    const raw0 = c.trim();
    if (!raw0) continue;

    tryParse(raw0);
    for (const chunk of balancedJsonChunks(raw0)) tryParse(chunk);

    // ลองอีกรอบหลังล้างของแถมของหน้าเว็บออก
    const fixed = repairJsonText(raw0);
    if (fixed !== raw0) {
      tryParse(fixed);
      for (const chunk of balancedJsonChunks(fixed)) tryParse(chunk);
    }

    // ยังไม่ได้เลย ค่อยกู้แบบคำตอบถูกตัดกลางคันเป็นทางสุดท้าย
    if (!parsedAll.length) {
      for (const closed of salvageTruncatedJson(fixed)) {
        tryParse(closed);
        if (parsedAll.length) break; // ตัวแรกที่ผ่านคือตัวที่กู้เนื้อหาได้มากที่สุด
      }
    }
  }

  if (!parsedAll.length) return null;
  // ก้อนที่มีเนื้อหามากที่สุดคือคำตอบจริงเสมอในทางปฏิบัติ ส่วนตัวอย่างประกอบจะสั้นกว่ามาก
  return parsedAll.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
}

function cleanBody(s) {
  return String(s)
    .replace(/^\s*```[\w]*\s*$/gm, '') // เผื่อมีรั้วโค้ดหลงมาในเนื้อ
    .replace(/<<<META[\s\S]*$/, '') // ตัดบล็อก META ออกจากเนื้อหา
    // เครื่องหมายคั่นที่หลงเข้ามาอยู่กลางเนื้อหา ต้องกวาดออกให้หมด
    //
    // เกิดเมื่อคำตอบแรกไม่ครบแล้วเราสั่งเขียนต่อ คำตอบที่สองมีเครื่องหมายเปิดของตัวเอง
    // พอเอามาต่อกันจึงได้ BEGIN ... BEGIN ... END แล้วตัวแกะจับจาก BEGIN แรกถึง END
    // เครื่องหมายอันที่สองเลยติดไปอยู่ในเนื้อหา แล้วโผล่ในหนังสือจริงว่า
    // "คำ <<<SEC 4.1 BEGIN>>> ว่า ..."
    // ถ้าเครื่องหมายที่หลงมาคั่นอยู่กลางคำ ให้เชื่อมสองฝั่งติดกันสนิท
    // (คำตอบแรกจบกลางคำว่า "คำ" คำตอบที่สองเริ่มด้วย "ว่า" ต้องได้ "คำว่า" ไม่ใช่คนละย่อหน้า)
    .replace(/(\S)\s*<<<\s*SEC\s+[\w.]+\s+BEGIN\s*>>>\s*(\S)/g, '$1$2')
    .replace(/<<<\s*(?:SEC|META)\s+[\w.]+\s+(?:BEGIN|END)\s*>>>/g, '')
    .replace(/<<<\s*END\s+[\w.]+\s*>>>|<<<\s*ITEM\s+[\w.]+\s*>>>/g, '')
    // หมายเหตุถึงคนทำรูปเล่มที่โมเดลชอบแถมมาท้ายตอน ถ้าไม่กวาดออกจะถูกพิมพ์ลงหนังสือจริง
    // (ตรวจไฟล์ที่ส่งออกจริงพบบรรทัดแบบนี้ 32 จุด ผู้อ่านเห็นเป็นคำสั่งถึงกองบรรณาธิการกลางเล่ม)
    .replace(/^\s*(?:\*{0,2})(?:ภาพประกอบ(?:ที่ควรมี)?|ภาพที่ควรใช้|หมายเหตุ(?:สำหรับ)?(?:นักออกแบบ|บรรณาธิการ|รูปเล่ม)|Illustration note|Design note)\s*(?:\*{0,2})\s*[:：].*$/gim, '')
    .replace(/^\s*#{1,2}\s+.*$/gm, (l) => l.replace(/^\s*#{1,2}\s+/, '### ')) // ยึดคืนระดับหัวข้อ
    .replace(/[ \t]{2,}/g, ' ') // ช่องว่างที่เหลือจากการกวาดเครื่องหมายออก
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ตรวจ schema ของสารบัญแบบเบา ๆ — คืนรายการปัญหาเพื่อส่งกลับให้โมเดลแก้ */
export function validateOutline(o) {
  const errs = [];
  if (!o || typeof o !== 'object') return ['ไม่ใช่ออบเจ็กต์ JSON'];
  if (!o.title) errs.push('ขาด title');
  if (!o.thesis) errs.push('ขาด thesis');
  if (!Array.isArray(o.chapters) || !o.chapters.length) errs.push('ขาด chapters หรือเป็นอาเรย์ว่าง');
  (o.chapters || []).forEach((c, i) => {
    if (!c.title) errs.push(`บทที่ ${i + 1} ขาด title`);
    if (!Array.isArray(c.sections) || !c.sections.length)
      errs.push(`บทที่ ${i + 1} ขาด sections`);
    (c.sections || []).forEach((s, j) => {
      if (!s.id) errs.push(`บท ${i + 1} ตอน ${j + 1} ขาด id`);
      if (!s.title) errs.push(`บท ${i + 1} ตอน ${j + 1} ขาด title`);
      if (!Array.isArray(s.beats) || !s.beats.length)
        errs.push(`ตอน ${s.id || j + 1} ขาด beats`);
    });
  });
  return errs;
}

/**
 * กู้เนื้อหาที่ ChatGPT ตอบมาจริง แต่ไม่ยอมใส่เครื่องหมายกำกับ
 *
 * จากการใช้งานจริงพบว่าหลายตอน "ล้มเหลว" ทั้งที่ ChatGPT เขียนให้ครบ
 * เพียงแต่ลืมใส่ <<<SEC ...>>> หรือไม่ได้ห่อด้วยบล็อกโค้ด
 * การทิ้งเนื้อหาที่ดีเพราะรูปแบบไม่ตรง แล้วปล่อยให้หน้าในเล่มว่างเปล่า แย่กว่ามาก
 * จึงกู้มาใช้ แต่ทำเครื่องหมายไว้ว่าเป็นของที่กู้มา ให้คนไปตรวจ
 */
export function recoverBody(raw, { minChars = 400 } = {}) {
  let t = String(raw || '');

  // เอาเฉพาะในบล็อกโค้ดถ้ามี เพราะนั่นคือที่ที่เราสั่งให้เขียน
  const fenced = t.match(/```(?:markdown)?\s*([\s\S]*?)```/);
  if (fenced) t = fenced[1];

  t = cleanBody(t)
    // คำนำหน้าที่โมเดลชอบเติมมา
    .replace(/^\s*(นี่คือ|ต่อไปนี้คือ|ตามที่ขอ)[^\n]{0,80}\n+/i, '')
    .trim();

  if (t.length < minChars) return null;
  // ถ้าเป็นคำปฏิเสธหรือคำถามกลับ ไม่ใช่เนื้อหา
  if (/^(ขอโทษ|ผมไม่สามารถ|I(?:'m| am) sorry|I can(?:'t|not))/i.test(t)) return null;
  return t;
}
