/**
 * ความคืบหน้ารวมของทั้งเล่ม เป็นเปอร์เซ็นต์เดียวที่เชื่อได้
 *
 * เดิมแถบคำนวณจาก "ขั้นที่เท่าไรจากสิบขั้น" ทุกขั้นจึงมีน้ำหนักเท่ากันที่ 10%
 * ทั้งที่ขั้นตรวจระบบใช้ไม่กี่วินาที แต่ขั้นเขียนกินเวลาครึ่งเล่ม และระหว่างขั้นแถบไม่ขยับเลย
 * (เห็นจริง: ขั้นปรับจำนวนหน้าค้างที่ 60% ทั้งขั้น แล้วกระโดดทีเดียวตอนจบ)
 *
 * ตอนนี้แต่ละขั้นมีน้ำหนักตามเวลาที่ใช้จริงโดยประมาณ และขยับได้ภายในขั้นจาก progress ที่เครื่องรายงาน
 */
export const STEP_WEIGHTS = [
  ['health', 1],
  ['calibrate', 2],
  ['outline', 4],
  ['write', 44],
  ['figures', 4],
  ['consistency', 12],
  ['fit', 11],
  ['style', 4],
  ['gate_images', 0],
  ['images', 18],
  ['done', 0],
];

const START = new Map();
const WEIGHT = new Map();
{
  let at = 0;
  for (const [step, w] of STEP_WEIGHTS) { START.set(step, at); WEIGHT.set(step, w); at += w; }
}
export const STEP_COUNT = STEP_WEIGHTS.filter(([s, w]) => w > 0).length;

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** เปอร์เซ็นต์รวม (0-100 ทศนิยมได้) จากขั้นปัจจุบันกับสัดส่วนที่ทำไปแล้วในขั้นนั้น */
export function overallPercent(step, fraction = 0) {
  if (step === 'done') return 100;
  if (!START.has(step)) return 0;
  return START.get(step) + WEIGHT.get(step) * clamp01(fraction);
}

/** ลำดับขั้นที่ผู้ใช้เห็น (นับเฉพาะขั้นที่มีงานจริง) เช่น ขั้น 7/9 */
export function stepNumber(step) {
  const real = STEP_WEIGHTS.filter(([, w]) => w > 0).map(([s]) => s);
  const i = real.indexOf(step);
  return i < 0 ? null : i + 1;
}

/**
 * ตัวติดตามที่ไม่ถอยหลังและประมาณเวลาที่เหลือ
 *
 * ถอยหลังได้เฉพาะเมื่อขั้นถอยจริง (เช่น เริ่มเล่มใหม่ หรือกลับไปเขียนตอนเพิ่มจากขั้นปรับหน้า)
 * ส่วนตัวเลขภายในขั้นที่แกว่ง (รอบตรวจใหม่เริ่มนับ 1 อีกครั้ง) ต้องไม่ดึงแถบกลับ ไม่งั้นดูเหมือนงานหาย
 *
 * เวลาที่เหลือคิดจากความเร็วจริงของเซสชันนี้ ไม่ใช่ตัวเลขตายตัว และจะไม่แสดงจนกว่าจะมีข้อมูลพอ
 * เพราะตัวเลขที่ผิดสิบเท่าในนาทีแรกทำให้คนเลิกเชื่อทั้งแถบ
 */
export function createProgressTracker(now = () => Date.now()) {
  let shown = 0;
  let stepIndex = -1;
  let base = null;
  const order = STEP_WEIGHTS.map(([s]) => s);

  return {
    update(step, fraction = 0) {
      const idx = order.indexOf(step);
      const pct = overallPercent(step, fraction);
      if (idx >= 0 && idx < stepIndex) { shown = pct; base = null; }
      else shown = Math.max(shown, pct);
      if (idx >= 0) stepIndex = idx;
      if (!base && step !== 'done') base = { at: now(), pct: shown };
      return this.snapshot();
    },
    reset() { shown = 0; stepIndex = -1; base = null; },
    snapshot() {
      const t = now();
      let etaMs = null;
      if (base && shown < 100) {
        const gained = shown - base.pct;
        const elapsed = t - base.at;
        if (gained >= 3 && elapsed >= 90_000) etaMs = (elapsed / gained) * (100 - shown);
      }
      return { percent: shown, etaMs };
    },
  };
}

/** เวลาที่เหลือแบบคนอ่าน — ปัดให้ไม่ดูแม่นเกินจริง */
export function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'ไม่ถึง 1 นาที';
  if (min < 60) return `${min} นาที`;
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 5) * 5;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}
