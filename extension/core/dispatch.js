/**
 * ฝ่ายธุรการ — บันทึกกลางของ "งานติดที่ไหน ใครลองท่าอะไรไปแล้ว ผลเป็นยังไง"
 *
 * ทำไมต้องมี
 *   ตัวกู้งานในระบบนี้มีอยู่ห้าที่ และเพดานการลองมีสิบสี่ตัวประกาศแยกกันในสี่ไฟล์
 *   (MAX_RETRIES · OUTLINE_ATTEMPTS · MAX_IMAGE_ATTEMPTS · MAX_FREE_RETRIES ·
 *    AUTO_CONTINUE_MAX · AUTO_PHASE2_ROUNDS · …) บวกตัวนับที่เป็นตัวแปรท้องถิ่นอีกชุด
 *   (ceoRecoveries · dupeHits · unstuck · hardened) ซึ่งตายไปพร้อมฟังก์ชันที่ประกาศมัน
 *
 *   ผลคือไม่มีใครในระบบตอบได้เลยว่า "เล่มนี้ติดอะไรไปแล้วกี่ครั้ง และท่าไหนเคยได้ผล"
 *   ผู้คุมกระบวนการจึงได้บริบทบาง ๆ เท่าเดิมทุกครั้งที่ถูกถาม และคนอ่านหน้าจอ
 *   ต้องไล่อ่านบันทึกย้อนหลังเองเพื่อประกอบภาพว่าเกิดอะไรขึ้น
 *
 * เส้นแบ่งที่ห้ามข้าม — ตัวนี้ "มองอย่างเดียว"
 *   มันไม่ตัดสินใจ ไม่สั่งใคร ไม่มีเพดานของตัวเอง และไม่มีผลข้างเคียงใด ๆ
 *   ตัวกู้ทั้งห้าที่ยังตัดสินใจเองเหมือนเดิมทุกบรรทัด ตัวนี้แค่จดว่าเกิดอะไรขึ้น
 *   เพราะการเพิ่มตัวตัดสินใจตัวที่หก ที่ไม่รู้ว่าอีกห้าตัวกำลังทำอะไรอยู่ จะทำให้แย่ลง
 *   ไม่ใช่ดีขึ้น — มันจะสั่งกดทำต่อตอนที่บันไดกู้เพิ่งเริ่มเดิน
 */

/** อาการที่ระบบนี้เจอจริง — คำศัพท์ปิดตาย ไม่ใช่ข้อความอิสระที่พิมพ์ใหม่ทุกที่ */
export const SYMPTOMS = {
  citation_only: 'คำตอบเหลือแต่หมุดอ้างอิงของการค้นเว็บ',
  composer_busy: 'ปุ่มส่งเป็นวงกลมหมุนค้าง',
  prompt_not_sent: 'ส่งคำสั่งไม่ออกจากเครื่องเรา',
  outcome_unknown: 'ตอบไม่ได้ว่าคำสั่งไปถึงหรือยัง',
  turn_lost: 'เทิร์นหายไปจนหมดเวลา',
  parse_failed: 'แกะคำตอบไม่ได้',
  image_not_grabbed: 'วาดเสร็จแล้วแต่คว้าภาพไม่ได้',
  image_duplicate: 'คว้าได้ภาพเดียวกับรูปก่อนหน้า',
  quiet_stall: 'งานนิ่งโดยไม่มีอะไรเดินอยู่',
  rate_limited: 'ชนลิมิตข้อความของ ChatGPT',
};

/** ท่าที่ระบบเดินได้จริง — ใช้คำเดียวกับผู้คุมกระบวนการ เพื่อไม่ให้มีคำศัพท์สองชุด */
export const MOVES = {
  retry: 'สั่งขั้นเดิมใหม่',
  new_thread: 'เปิดห้องแชตใหม่',
  reload_tab: 'โหลดแท็บ ChatGPT ใหม่',
  harden_prompt: 'สั่งใหม่ด้วยคำสั่งที่เข้มขึ้น',
  press_continue: 'กดทำต่อให้เอง',
  press_images: 'กดทำต่อขั้นสร้างภาพ',
  open_chat: 'เปิดหน้าต่าง ChatGPT',
  recovered: 'เก็บผลที่หายกลับมาได้',
  skipped: 'ข้ามไปทำรายการถัดไป',
  stop: 'หยุดรอคน',
};

const MAX_ENTRIES = 60;
let entries = [];
let bookId = '';

const label = (table, key) => table[key] || key || '-';

/**
 * เริ่มเล่มใหม่หรือรอบใหม่ = ล้างกระดาน
 * ประวัติของเล่มก่อนไม่ได้ช่วยอ่านอาการของเล่มนี้ มีแต่จะทำให้ตัวเลขดูน่ากลัวเกินจริง
 */
export function startTrouble(id = '') {
  if (id && id === bookId) return;
  bookId = id;
  entries = [];
}

/**
 * จดหนึ่งเหตุการณ์ — "ติดอะไร ที่ขั้นไหน แล้วเราทำอะไรไป"
 *
 * เรียกได้จากทุกที่โดยไม่ต้องกลัวว่าจะทำให้ทางเดินหลักพัง: ไม่โยน error ไม่ await อะไร
 * และไม่แตะสถานะของใครเลย ถ้าที่เรียกส่งของแปลกมาก็แค่ได้บรรทัดที่อ่านไม่รู้เรื่องหนึ่งบรรทัด
 *
 * @param {object} o
 * @param {string} o.step ขั้นของงานตอนนั้น
 * @param {keyof SYMPTOMS} o.symptom อาการ
 * @param {keyof MOVES} [o.move] ท่าที่เดินตอบสนองอาการนั้น (ไม่มีก็ได้ = ยังไม่ได้ทำอะไร)
 * @param {string} [o.detail] รายละเอียดสั้น ๆ ไว้ให้คนอ่าน
 * @param {string} [o.by] ใครเป็นคนเดินท่านั้น (เครื่องผลิต · หน้า Studio · ผู้คุม · หน้าเว็บ)
 */
export function noteTrouble({ step = '', symptom = '', move = '', detail = '', by = '' } = {}) {
  entries.push({
    at: Date.now(),
    step: String(step || ''),
    symptom: String(symptom || ''),
    move: String(move || ''),
    detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 200),
    by: String(by || ''),
  });
  if (entries.length > MAX_ENTRIES) entries.shift();
  return entries[entries.length - 1];
}

/** รายการดิบล่าสุด ใหม่อยู่ท้าย */
export const troubleEntries = (n = MAX_ENTRIES) => entries.slice(-n);

/**
 * สรุปให้อ่านได้ในบรรทัดเดียว — ตอบสามคำถามที่ตอบไม่ได้มาตลอด
 *   ติดอะไรอยู่ · ติดซ้ำที่เดิมกี่ครั้ง · ลองท่าอะไรไปแล้วบ้าง
 */
export function troubleSummary() {
  if (!entries.length) return { total: 0, open: null, repeats: 0, moves: [], line: '' };
  const last = entries[entries.length - 1];
  // "ซ้ำที่เดิม" = อาการเดียวกันที่ขั้นเดียวกัน ไล่นับย้อนจากรายการล่าสุด
  let repeats = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].symptom !== last.symptom || entries[i].step !== last.step) break;
    repeats++;
  }
  const moves = [...new Set(entries.filter((e) => e.move).map((e) => e.move))];
  const counted = new Map();
  for (const e of entries) if (e.move) counted.set(e.move, (counted.get(e.move) || 0) + 1);
  const movesLine = [...counted].map(([m, n]) => `${label(MOVES, m)}${n > 1 ? ` ${n} ครั้ง` : ''}`).join(' · ');
  return {
    total: entries.length,
    open: last,
    repeats,
    moves,
    line:
      `${label(SYMPTOMS, last.symptom)}${last.step ? ` ที่ขั้น ${last.step}` : ''}` +
      `${repeats > 1 ? ` · ซ้ำที่เดิม ${repeats} ครั้ง` : ''}` +
      `${movesLine ? ` · ลองแล้ว: ${movesLine}` : ''}`,
  };
}

/**
 * ย่อให้ผู้คุมกระบวนการอ่าน — สั้นที่สุดเท่าที่ยังตัดสินใจได้ เพราะทุก token มีราคา
 * ยังไม่ได้ถูกต่อเข้ากับผู้คุมในรอบนี้ (ตกลงกันว่าเริ่มจากตัวมองอย่างเดียวก่อน)
 */
export function troubleBrief(n = 8) {
  return troubleEntries(n).map(
    (e) => `${label(SYMPTOMS, e.symptom)}${e.step ? ` (${e.step})` : ''}${e.move ? ` → ${label(MOVES, e.move)}` : ''}`,
  );
}
