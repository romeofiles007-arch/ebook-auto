/**
 * ราคาของงานเขียนผ่าน API — บอกก่อนจ่าย และนับจริงหลังจ่าย
 *
 * ทำไมต้องมีไฟล์นี้
 *   คนที่เลือกทาง API คือคนที่ยอมจ่ายเพื่อความเร็วและความเสถียร แต่ "ยอมจ่าย" กับ
 *   "ไม่รู้ว่าจ่ายเท่าไร" เป็นคนละเรื่องกัน เครื่องมือที่ยิง API ให้โดยไม่บอกราคา
 *   คือเครื่องมือที่ผู้ใช้ไม่กล้ากดปุ่มเริ่ม
 *
 * ตัวเลขสองชุดที่ต่างกันโดยสิ้นเชิง
 *   1. "คาดว่าจะจ่าย" — ประเมินก่อนเริ่ม จากจำนวนเทิร์นและงบตัวอักษร เป็นการเดาที่มีสมมติฐาน
 *   2. "จ่ายไปแล้ว" — คำนวณจากจำนวน token จริงที่เซิร์ฟเวอร์ส่งกลับมาทุกเทิร์น แม่นยำ
 *   ตัวที่สองคือตัวที่เชื่อได้ และเป็นตัวที่ใช้ปรับความแม่นของตัวแรกไปเรื่อย ๆ
 *
 * ราคาเปลี่ยนได้ตลอดและเปลี่ยนบ่อย
 *   ตารางนี้เป็นแค่ค่าตั้งต้น ผู้ใช้แก้เองได้จากหน้าจอ และระบบจะบอกเสมอว่า
 *   ตัวเลขที่ใช้อยู่ถูกจดไว้เมื่อไร ไม่ใช่ยืนยันว่านี่คือราคาวันนี้
 *   ราคาจริงดูได้ที่ https://platform.openai.com/docs/pricing
 */

/** วันที่จดราคาชุดนี้ไว้ — แสดงบนหน้าจอเสมอ เพื่อไม่ให้ตัวเลขเก่ากลายเป็นคำสัญญา */
export const PRICE_CHECKED_AT = '2026-09-02';

/** ดอลลาร์ต่อหนึ่งล้าน token */
export const MODEL_PRICES = {
  'gpt-5.6-sol': { in: 4.0, out: 20.0, note: 'แพงสุด ฉลาดสุด' },
  'gpt-5.6-terra': { in: 2.0, out: 12.0, note: 'สมดุลราคากับคุณภาพ' },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, note: 'ถูกสุดในรุ่นล่าสุด' },
  'gpt-5.5': { in: 5.0, out: 30.0, note: 'รุ่นก่อนหน้า' },
  'gpt-5.4': { in: 2.5, out: 15.0, note: '' },
  'gpt-5.4-mini': { in: 0.75, out: 4.5, note: '' },
  'gpt-5.4-nano': { in: 0.2, out: 1.25, note: '' },
  'gpt-5': { in: 1.25, out: 10.0, note: '' },
  'gpt-5-mini': { in: 0.25, out: 2.0, note: '' },
  'gpt-5-nano': { in: 0.05, out: 0.4, note: 'ถูกที่สุด' },
  'gpt-4o-mini': { in: 0.15, out: 0.6, note: 'รุ่นเก่า ราคาถูก' },
};

/** โมเดลตั้งต้นสำหรับงานเขียนหนังสือ — สมดุลระหว่างคุณภาพงานเขียนกับค่าใช้จ่าย */
export const DEFAULT_TEXT_MODEL = 'gpt-5.6-terra';

/**
 * ราคาต่อล้าน token ของโมเดลหนึ่ง
 * ค่าที่ผู้ใช้กรอกเองมาก่อนตารางในไฟล์นี้เสมอ เพราะเขารู้ราคาวันนี้ดีกว่าเรา
 */
export function priceFor(model, custom = null) {
  if (custom && Number(custom.in) >= 0 && Number(custom.out) >= 0) {
    return { in: Number(custom.in), out: Number(custom.out), source: 'custom' };
  }
  const p = MODEL_PRICES[model];
  return p ? { ...p, source: 'table' } : null;
}

/** ค่าใช้จ่ายจริงของ token ที่ใช้ไปแล้ว หน่วยเป็นดอลลาร์ */
export function costOf({ promptTokens = 0, completionTokens = 0, price }) {
  if (!price) return null;
  return (Number(promptTokens) * price.in + Number(completionTokens) * price.out) / 1_000_000;
}

/**
 * ตัวอักษรไทยกี่ตัวต่อหนึ่ง token
 *
 * ภาษาไทยกินโทเคนมากกว่าอังกฤษมาก เพราะไม่มีช่องว่างแบ่งคำและตัวสระ/วรรณยุกต์
 * มักถูกแยกเป็นชิ้นของตัวเอง ค่านี้เป็นเพียงจุดตั้งต้น — พอเล่มเดินไปได้สองสามเทิร์น
 * ระบบจะรู้ค่าจริงของเล่มนั้นจาก token ที่เซิร์ฟเวอร์รายงานกลับมา แล้วใช้ค่าจริงแทน
 * เป็นวิธีเดียวกับที่ระบบหาว่าหน้าหนึ่งจุได้กี่อักษร คือวัดของจริงแทนการเดา
 */
export const SEED_CHARS_PER_TOKEN = { th: 1.3, en: 3.8 };

export function charsPerToken(language = 'th', measured = 0) {
  if (Number(measured) > 0.3) return Number(measured);
  return SEED_CHARS_PER_TOKEN[language] || SEED_CHARS_PER_TOKEN.th;
}

/**
 * ประเมินค่าใช้จ่ายทั้งเล่มก่อนกดเริ่ม
 *
 * @param turns        จำนวนเทิร์นที่คาดว่าจะใช้ (มาจาก estimateTurns)
 * @param budgetChars  งบตัวอักษรของเนื้อหาทั้งเล่ม
 * @param promptChars  ความยาวเฉลี่ยของคำสั่งที่ส่งไปต่อเทิร์น (คำสั่งของระบบนี้ยาว
 *                     เพราะพก Book Bible และสรุปตอนก่อนหน้าไปด้วยทุกครั้ง)
 */
export function estimateCost({
  model,
  turns,
  budgetChars,
  language = 'th',
  measuredCharsPerToken = 0,
  promptChars = 5200,
  custom = null,
}) {
  const price = priceFor(model, custom);
  if (!price) return null;
  const cpt = charsPerToken(language, measuredCharsPerToken);

  // คำสั่งที่ส่งออกเป็นภาษาไทยผสมอังกฤษ ใช้ค่ากลางระหว่างสองภาษา
  const promptCpt = (cpt + SEED_CHARS_PER_TOKEN.en) / 2;
  const inTokens = Math.round((turns * promptChars) / promptCpt);
  const outTokens = Math.round(budgetChars / cpt);

  const usd = costOf({ promptTokens: inTokens, completionTokens: outTokens, price });
  return { usd, inTokens, outTokens, price, charsPerToken: cpt };
}

/** เขียนเป็นข้อความสั้น ๆ ที่อ่านแล้วรู้เรื่องทันที ทั้งดอลลาร์และบาท */
export function formatCost(usd, usdToThb = 36) {
  if (usd == null || !Number.isFinite(usd)) return '-';
  const thb = usd * usdToThb;
  const money = usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2);
  return `$${money} (ราว ${thb < 10 ? thb.toFixed(1) : Math.round(thb).toLocaleString()} บาท)`;
}
