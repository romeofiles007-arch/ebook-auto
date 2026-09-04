/**
 * แปลง "จำนวนหน้า" เป็น "งบเนื้อหา" และกระจายเป็นโควตารายตอน
 *
 * จำนวนหน้าไม่ใช่คุณสมบัติของข้อความ แต่เป็นผลลัพธ์ของ
 * ข้อความ x ฟอนต์ x ขนาด x ระยะบรรทัด x ขอบ x ภาพ x กฎการขึ้นหน้าใหม่
 * โมดูลนี้จึงทำได้แค่ "ประมาณให้ใกล้" ส่วนที่ทำให้ตรงจริงคือลูปใน machine.js
 * ที่วัดหน้าจาก PDF จริงแล้ววนแก้
 */

/**
 * ค่าตั้งต้นให้ลูปเริ่มทำงาน — วัดจริงด้วย Typst 0.13 ไม่ใช่ค่าที่คาดเดา
 * เงื่อนไขที่วัด: ข้อความไทย 30,004 อักษร, Sarabun 15pt, line-height 1.62,
 *                ขอบ 18/14/16/18 มม., ไม่จัดชิดขอบสองข้าง
 * เปลี่ยนขนาดฟอนต์หรือขอบเมื่อไหร่ ค่านี้ใช้ไม่ได้ทันที — ระบบจะ calibrate ใหม่เอง
 */
export const TRIM_PRESETS = {
  pocket: { label: 'พ็อกเก็ตบุ๊กไทย', w: 113, h: 185, seedCPP: 462 },
  a5: { label: 'A5 (มาตรฐานไทย)', w: 148, h: 210, seedCPP: 750 },
  'thai-trade': { label: 'ไทยเทรด 14.5x21', w: 145, h: 210, seedCPP: 732 },
  'us-trade': { label: 'US Trade 6x9 (KDP)', w: 152.4, h: 228.6, seedCPP: 833 },
  digest: { label: 'Digest 5.5x8.5', w: 139.7, h: 215.9, seedCPP: 732 },
  textbook: { label: 'ตำรา 16x23.5', w: 160, h: 235, seedCPP: 909 },
  workbook: { label: 'เวิร์กบุ๊ก 8.5x11', w: 215.9, h: 279.4, seedCPP: 1429 },
};

// ขอบในขั้นต่ำตามความหนาเล่ม (เกณฑ์ KDP) — preflight ใช้ตารางนี้ตรวจ
export const MIN_INNER_MM = [
  { maxPages: 150, mm: 9.5 },
  { maxPages: 300, mm: 12.7 },
  { maxPages: 500, mm: 15.9 },
  { maxPages: 700, mm: 19.1 },
  { maxPages: 828, mm: 22.2 },
];

export function minInnerMargin(pages) {
  return (MIN_INNER_MM.find((r) => pages <= r.maxPages) || MIN_INNER_MM.at(-1)).mm;
}

// ความหนากระดาษต่อแผ่น (นิ้ว) — โรงพิมพ์ไทยควรถามค่าจริงมาใส่เอง
export const PAPER_THICKNESS_IN = { white: 0.002252, cream: 0.0025, color: 0.002347 };

/** ที่ว่างเชิงโครงสร้างที่ทุกโปรเจกต์ลืมหัก */
const CHAPTER_OVERHEAD_PAGES = 1.3; // หัวบทเริ่มต่ำลง + ท้ายบทเหลือหน้าไม่เต็ม + บทขึ้นหน้าขวา

export function profileHash(t) {
  const p = t.typography;
  return [t.trim.preset, p.bodyFont, p.sizePt, p.lineHeight, p.marginsMm.inner, p.marginsMm.outer]
    .join('-')
    .replace(/\s+/g, '');
}

/**
 * แปลงหน้าเป็นงบอักษร
 * @returns {{budget:number, textPages:number, breakdown:object}}
 */
export function computeBudget(book, outline) {
  const chapters = outline?.chapters?.length || 0;
  const entries = (outline?.chapters || []).reduce((n, c) => n + 1 + (c.sections?.length || 0), 0);

  const front = frontMatterPages(book);
  const toc = (book.frontMatter || []).includes('toc') ? Math.max(1, Math.ceil(entries / 34)) : 0;
  const back = backMatterPages(book);

  // จำนวนหน้าที่ผู้ใช้กรอกหมายถึงหน้าเนื้อหาหลักเท่านั้น
  // หน้าชื่อเรื่อง ลิขสิทธิ์ คำนำ สารบัญ และส่วนท้ายเพิ่มต่างหาก
  const bodyPages = book.targetPages;
  const overhead = chapters * CHAPTER_OVERHEAD_PAGES;
  const figurePages = estimateFigurePages(book, outline);
  const textPages = Math.max(1, bodyPages - overhead - figurePages);

  const cpp = book.calibration?.charsPerPage || TRIM_PRESETS[book.trim.preset]?.seedCPP || 1800;
  const budget = Math.round(textPages * cpp);

  return {
    budget,
    textPages,
    breakdown: {
      front,
      toc,
      back,
      bodyPages,
      overhead,
      figurePages,
      cpp,
      chapters,
      entries,
      targetPhysical: bodyPages + front + toc + back,
    },
  };
}

function frontMatterPages(book) {
  // สารบัญนับแยกตามจำนวนรายการ ห้ามนับซ้ำใน front
  const n = (book.frontMatter || []).filter((x) => x !== 'toc').length;
  return Math.max(1, n);
}

/** เป้าจำนวนหน้ากระดาษจริง รวมหน้าต้น/ท้ายที่ไม่นับเป็นเนื้อหา */
export function targetPhysicalPages(book, outline) {
  const { breakdown } = computeBudget(book, outline);
  return breakdown.targetPhysical;
}

function backMatterPages(book) {
  const n = (book.backMatter || []).length;
  return n ? n * 2 : 0;
}

function estimateFigurePages(book, outline) {
  const per = { none: 0, light: 0.375, rich: 1.1 }[book.illustrationLevel || 'none'];
  return (outline?.chapters?.length || 0) * per;
}

/**
 * ตอนที่สั้นกว่านี้ ChatGPT เขียนให้มีสาระไม่ได้จริง ไม่ว่าเล่มจะเล็กแค่ไหน
 * เป็นเกณฑ์ "เขียนได้จริงไหม" คนละเรื่องกับเกณฑ์ "ตอนนี้สั้นกว่าตอนอื่นไหม"
 */
const MIN_WRITABLE_UNITS = { th: 900, en: 220 };
/** ยาวกว่านี้ ChatGPT ตอบไม่จบในเทิร์นเดียว ต้องแตกตอน */
const MAX_TURN_UNITS = { th: 8000, en: 1900 };
/** กรอบที่ยอมให้ตอนหนึ่งต่างจากค่าเฉลี่ยของเล่ม */
const SPREAD_LO = 0.55;
const SPREAD_HI = 1.8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 1));

/**
 * แจกโควตาให้ลงตัวพอดีงบ โดยไม่มีตอนไหนหลุดออกนอกกรอบ [floor, ceil]
 *
 * บีบตัวที่หลุดกรอบให้เข้ากรอบ แล้วโยนส่วนต่างไปเฉลี่ยต่อในกลุ่มที่ยังขยับได้
 * ทำซ้ำไม่กี่รอบก็ลู่เข้า ถ้ากรอบแคบจนแจกไม่ลง (ตอนเยอะเกินกว่างบจะรับไหว)
 * จะเหลือส่วนต่างค้าง ซึ่งเป็นสัญญาณว่าโครงสารบัญเองมีปัญหา ไม่ใช่การแจกโควตา
 */
function distribute(budget, weights, floor, ceil) {
  const n = weights.length;
  const out = new Array(n).fill(0);
  const fixed = new Array(n).fill(false);
  let remaining = budget;

  for (let round = 0; round < 6; round++) {
    const free = [];
    let freeWeight = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      free.push(i);
      freeWeight += weights[i];
    }
    if (!free.length || freeWeight <= 0) break;

    let clampedAny = false;
    for (const i of free) {
      const raw = (remaining * weights[i]) / freeWeight;
      if (raw < floor) {
        out[i] = floor;
        fixed[i] = true;
        remaining -= floor;
        clampedAny = true;
      } else if (raw > ceil) {
        out[i] = ceil;
        fixed[i] = true;
        remaining -= ceil;
        clampedAny = true;
      } else {
        out[i] = raw;
      }
    }
    if (!clampedAny) break;
  }
  return out.map((v) => Math.round(v));
}

/** กระจายงบให้แต่ละตอนตามน้ำหนักบท และคืน outline ที่มีโควตาแล้ว */
export function assignQuotas(book, outline) {
  const { budget, textPages, breakdown } = computeBudget(book, outline);
  const lang = book.language === 'en' ? 'en' : 'th';

  /**
   * น้ำหนักบทกับน้ำหนักตอน "ห้ามคูณทบกัน"
   *
   * เดิมใช้ weight ของบท × weight ของตอนตรง ๆ ทั้งสองค่าอยู่ในช่วง 0.5–1.5
   * ผลคูณจึงกว้างได้ถึง 9 เท่า (0.25 ถึง 2.25) ตอนที่ซวยได้ทั้งบทเบาและตอนเบา
   * จะได้โควตาต่ำกว่าค่าเฉลี่ยของเล่มหลายเท่า — นี่คือที่มาของ
   * "มีตอนที่โควตาเพียง 764 อักษร" ทั้งที่เล่มเดียวกันเฉลี่ยตอนละพันกว่า
   * แล้วตอนนั้นก็เขียนออกมาสั้นกว่าเป้าจริง ๆ เพราะเป้ามันเล็กเกินจะมีสาระ
   *
   * แก้โดย normalize น้ำหนักตอนให้เฉลี่ยเป็น 1 ภายในบทของตัวเอง
   * ภายในบทยังหนัก/เบาต่างกันได้ตามที่โมเดลตั้งใจ แต่ส่วนแบ่งระดับบท
   * ถูกกำหนดด้วยน้ำหนักบทกับจำนวนตอนเท่านั้น ไม่ทบกันจนบานปลาย
   */
  const entries = [];
  for (const ch of outline.chapters || []) {
    const list = ch.sections || [];
    if (!list.length) continue;
    const cw = clamp(ch.weight ?? 1, 0.5, 1.5);
    const raw = list.map((s) => clamp(s.weight ?? 1, 0.5, 1.5));
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length || 1;
    list.forEach((s, i) => entries.push({ s, w: cw * (raw[i] / mean) }));
  }

  const warnings = [];
  if (!entries.length) {
    return { outline, budget, textPages, breakdown, warnings: ['สารบัญไม่มีตอนให้เขียน'], quotaRange: [0, 0] };
  }

  const minUnits = MIN_WRITABLE_UNITS[lang];
  const maxUnits = MAX_TURN_UNITS[lang];
  const avg = budget / entries.length;
  // ถ้างบทั้งเล่มยังพอ ห้ามแจกตอนไหนต่ำกว่าเกณฑ์เขียนได้จริง
  // แต่ถ้าเล่มเล็กจนค่าเฉลี่ยเองยังต่ำกว่าเกณฑ์ ก็บังคับไม่ได้ ต้องปล่อยแล้วไปเตือนแทน
  const floor = Math.round(Math.max(avg * SPREAD_LO, Math.min(minUnits, avg * 0.9)));
  const ceil = Math.round(Math.max(floor + 1, avg * SPREAD_HI));
  const quotas = distribute(budget, entries.map((e) => e.w), floor, ceil);

  entries.forEach(({ s }, i) => {
    s.quota = Math.max(1, quotas[i]);
    s.minChars = Math.round(s.quota * 0.75);
    s.maxChars = Math.round(s.quota * 1.25);
    if (s.elastic === undefined) s.elastic = true;
  });

  /**
   * คำเตือนต้องพูดถึง "โครงสารบัญ" ไม่ใช่ตอนที่เผอิญได้โควตาน้อยที่สุด
   *
   * เดิมเตือนจากค่าต่ำสุด/สูงสุดเทียบตัวเลขตายตัว 1,500 กับ 8,000
   * ซึ่งใช้ไม่ได้กับเล่มพ็อกเก็ตบุ๊ก (หน้าละ 462 หน่วย) ที่เฉลี่ยตอนละพันกว่าเป็นปกติ
   * — เตือนทุกเล่มจนคำเตือนกลายเป็นเสียงรบกวนที่ไม่มีใครแก้ตาม
   * ตอนนี้เทียบกับค่าเฉลี่ยของเล่มจริง และบอกตัวเลขที่กดต่อได้ว่าควรเหลือกี่ตอน
   */
  if (avg < minUnits) {
    const fit = Math.max(1, Math.floor(budget / minUnits));
    warnings.push(
      `สารบัญมี ${entries.length} ตอนสำหรับ ${book.targetPages} หน้า เฉลี่ยได้ตอนละ ${Math.round(avg).toLocaleString()} หน่วย ซึ่งสั้นเกินกว่าจะเขียนให้มีสาระ — ควรยุบให้เหลือไม่เกิน ${fit} ตอน หรือเพิ่มจำนวนหน้าเป้าหมาย`,
    );
  }
  if (avg > maxUnits) {
    const fit = Math.max(1, Math.ceil(budget / maxUnits));
    warnings.push(
      `สารบัญมีแค่ ${entries.length} ตอนสำหรับ ${book.targetPages} หน้า เฉลี่ยตอนละ ${Math.round(avg).toLocaleString()} หน่วย ซึ่งยาวเกินกว่าที่ ChatGPT ตอบจบในเทิร์นเดียว — ควรแตกให้ได้อย่างน้อย ${fit} ตอน หรือลดจำนวนหน้าเป้าหมาย`,
    );
  }

  const all = entries.map((e) => e.s.quota);
  return {
    outline,
    budget,
    textPages,
    breakdown,
    warnings,
    quotaRange: [Math.min(...all), Math.max(...all)],
  };
}

/**
 * ตัดสินใจว่าลูปนับหน้าจะยืด/หดตอนไหน เท่าไร
 *
 * บทเรียนจากการทดสอบจริง: การกระจายส่วนต่างให้ "ทุกตอนเท่า ๆ กัน" ทำให้ลูปไม่ลู่เข้า
 * ด้วยเหตุผลสองข้อ
 *   1) ส่วนแบ่งของแต่ละตอนเล็กจนต่ำกว่าเกณฑ์ขั้นต่ำ แล้วถูกตัดทิ้ง ส่วนต่างจึงถูกแก้ไม่ครบ
 *   2) โมเดลคุมความยาวได้แค่ราว ±15% ทุกตอนที่แตะจึงเติม "เสียงรบกวน" เข้ามา
 *      ยิ่งแตะหลายตอน เสียงยิ่งกลบสัญญาณ จนหน้าที่ได้แกว่งกว่าเดิม
 *
 * จึงต้องทำตรงข้าม: รวมส่วนต่างไว้กับตอนที่มีที่ว่างมากที่สุด ให้แตะน้อยตอนที่สุด
 * และต้องใช้ส่วนต่างให้ครบจำนวน ไม่ปัดทิ้ง
 */
export function planAdjustment(sections, errPages, charsPerPage, opts = {}) {
  const minChunk = opts.minChunk ?? 250; // ต่ำกว่านี้ การสั่งโมเดลปรับความยาวไม่มีความหมาย
  const need = Math.round(-errPages * charsPerPage); // + คือต้องเพิ่ม, - คือต้องลด
  const grow = need > 0;

  const pool = sections.filter(
    (s) => s.elastic && !s.locked && s.status !== 'blocked' && (s.md || '').trim(),
  );
  if (!pool.length) return { plan: [], reason: 'ไม่มีตอนที่ปลดล็อกให้แก้ได้', shortfall: Math.abs(need) };

  const room = (s) => (grow ? Math.max(0, s.maxChars - s.chars) : Math.max(0, s.chars - s.minChars));

  const ranked = pool.filter((s) => room(s) >= minChunk).sort((a, b) => room(b) - room(a));
  if (!ranked.length) {
    return {
      plan: [],
      reason:
        'ทุกตอนชนกรอบ ±25% ของโควตาแล้ว — เป้าหมายจำนวนหน้าไม่สมเหตุสมผลกับโครงเรื่อง ต้องปรับจำนวนบท/ตอน หรือปรับจำนวนหน้าเป้าหมาย',
      shortfall: Math.abs(need),
    };
  }

  const plan = [];
  let remaining = Math.abs(need);
  for (const s of ranked) {
    if (remaining <= 0) break;
    const take = Math.min(room(s), remaining);
    if (take < minChunk && plan.length) break; // เศษที่เหลือน้อยเกินกว่าจะสั่งแก้ ปล่อยให้รอบหน้าจัดการ
    plan.push({ id: s.id, delta: grow ? take : -take, target: s.chars + (grow ? take : -take) });
    remaining -= take;
  }

  return { plan, reason: null, shortfall: remaining };
}

/**
 * หา charsPerPage จากเล่มจริงที่เพิ่งคอมไพล์
 *
 * ตัวอย่างที่ใช้ตอน calibration เป็นข้อความล้วน ไม่มีหัวบท ไม่มีย่อหน้าสั้น ๆ
 * พอเจอเล่มจริงค่าจึงคลาดได้มาก การคอมไพล์ครั้งแรกของเล่มจริงคือข้อมูลที่ดีที่สุด
 * ที่เรามี ใช้มันปรับความเข้าใจเสียเลย แล้วตั้งโควตาใหม่จากฐานที่ถูก
 */
export function observedCharsPerPage(book, outline, sections, physicalPages) {
  const totalChars = sections.reduce((n, s) => n + (s.chars || 0), 0);
  const { breakdown } = computeBudget(book, outline);
  const nonBody =
    breakdown.front + breakdown.toc + breakdown.back + breakdown.overhead + breakdown.figurePages;
  const textPages = Math.max(1, physicalPages - nonBody);
  return Math.round(totalChars / textPages);
}

/**
 * ขยายกรอบยืดหยุ่นของทุกตอน — ใช้เป็นทางออกสุดท้ายเมื่อทุกตอนชนเพดานแล้ว
 * ยอมให้ตอนห่างจากโควตามากขึ้น ดีกว่าส่งเล่มที่จำนวนหน้าผิดไปสิบหน้า
 */
export function widenBands(sections, ratio = 0.4) {
  for (const s of sections) {
    if (!s.quota) continue;
    s.minChars = Math.round(s.quota * (1 - ratio));
    s.maxChars = Math.round(s.quota * (1 + ratio));
  }
  return sections;
}

/** ตั้งโควตาใหม่ให้ทุกตอนหลังได้ค่า charsPerPage ที่ถูกต้องขึ้น */
export function rebaseQuotas(book, outline, sections, band = 0.25) {
  const { outline: o } = assignQuotas(book, outline);
  const byId = new Map(
    o.chapters.flatMap((c) => c.sections).map((s) => [s.id, s]),
  );
  for (const s of sections) {
    const fresh = byId.get(s.id);
    if (!fresh) continue;
    s.quota = fresh.quota;
    s.minChars = Math.round(fresh.quota * (1 - band));
    s.maxChars = Math.round(fresh.quota * (1 + band));
  }
  return sections;
}

/**
 * ประเมินว่างานนี้จะกินข้อความ ChatGPT กี่ข้อความ — ต้องบอกผู้ใช้ก่อนเริ่ม ไม่ใช่หลังหมดโควตา
 *
 * บทเรียนจากการใช้จริง: เวอร์ชันแรกยิงหนึ่งข้อความต่อหนึ่งตอน บวกข้อความทักทายต่อบท
 * บวกตรวจความสอดคล้องต่อบท บวกรอบแก้ความยาวที่สั่งแก้ทีละยี่สิบตอน
 * เล่ม 120 หน้าจึงกินเกินร้อยข้อความ และวิ่งกินโควตาทั้งวันโดยไม่มีใครรู้
 */
export function estimateTurns(book) {
  const pages = book.targetPages || 120;
  const chapters = pages <= 80 ? 6 : pages <= 150 ? 9 : pages <= 250 ? 12 : 16;

  const cpp = book.calibration?.charsPerPage || TRIM_PRESETS[book.trim?.preset]?.seedCPP || 750;
  const front = Math.max(4, (book.frontMatter || []).length + 2);
  const back = Math.max(2, (book.backMatter || []).length * 2);
  const textPages = Math.max(1, pages - front - 2 - back - chapters * 1.3);
  const budget = textPages * cpp;

  // นับกลุ่มแบบเดียวกับ Machine.planBatches: จัดกลุ่มภายในบท ไม่ข้ามบท
  // จึงต้องคิดจากขนาดตอน ไม่ใช่หารความยาวบทด้วยเพดานตรง ๆ
  const cap = book.maxCharsPerTurn || 6000;
  const secPerChapter = 4;
  const perSection = budget / (chapters * secPerChapter);
  const fitPerTurn = Math.max(1, Math.floor(cap / Math.max(1, perSection)));
  const batches = Math.ceil((chapters * Math.ceil(secPerChapter / fitPerTurn)) * 1.15);

  const write = batches;
  const continues = Math.ceil(batches * 0.2); // บางเทิร์นตอบไม่ครบ ต้องสั่งเขียนต่อ
  const consistency = book.runConsistency ? chapters : 0;
  /**
   * ลูปปรับจำนวนหน้าแก้ทีละตอน = หนึ่งข้อความต่อตอน
   * โหมดเป้าหมายแบบยืดหยุ่นไม่เรียกลูปนี้เลย จึงต้องไม่ตีราคาให้ผู้ใช้เกินจริง
   */
  const rewrites = (book.pageMode || 'soft') === 'strict' ? 6 : 0;

  /**
   * ขั้นขยายตอนที่สั้นกว่าครึ่งโควตา มีทั้งในโหมดยืดหยุ่นและโหมดเป๊ะ
   *
   * ราคาจริงขึ้นกับว่าโมเดลเขียนสั้นแค่ไหน โมเดลที่เขียนได้ตามเป้าจะไม่เสียเทิร์นตรงนี้เลย
   * ส่วนโมเดลที่เขียนสั้นเป็นนิสัยจะถูกจับได้แล้วหยุดที่สองตอน ไม่ไล่จนครบเพดาน
   * ตีเป็นศูนย์ในกรณีดีที่สุด สองในกรณีปกติ และแปดในกรณีแย่ที่สุด ตามเพดานจริงในเครื่อง
   */
  const grow = 2;

  const min = 1 + write + consistency + 1;
  const likely = 1 + write + continues + consistency + rewrites + grow + 1;
  const max = 1 + write + continues * 2 + consistency + rewrites * 2 + 8 + 1;

  return { chapters, batches, budget: Math.round(budget), min, likely, max };
}

/** คณิตศาสตร์ปก */
export function coverGeometry({ trimWmm, trimHmm, pages, paper = 'white', bleedMm = 3 }) {
  const spineIn = pages * PAPER_THICKNESS_IN[paper];
  const spineMm = spineIn * 25.4;
  return {
    spineMm,
    widthMm: trimWmm * 2 + spineMm + bleedMm * 2,
    heightMm: trimHmm + bleedMm * 2,
    spineTextAllowed: spineIn >= 0.0625,
    pxAt300dpi: {
      w: Math.round(((trimWmm * 2 + spineMm + bleedMm * 2) / 25.4) * 300),
      h: Math.round(((trimHmm + bleedMm * 2) / 25.4) * 300),
    },
  };
}
