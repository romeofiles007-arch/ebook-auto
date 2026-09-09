/**
 * นาฬิกาจับเวลาเล็ก ๆ มุมขวาบน — ตั้งแต่สั่งงานจนถึงงานส่งมอบ
 *
 * งานหนึ่งเล่มกินเวลาเป็นสิบนาทีถึงเป็นชั่วโมง และคนเฝ้าไม่ได้นั่งดูตลอด
 * กล่องสถานะบอกได้แค่ "อัปเดตล่าสุดกี่วินาทีที่แล้ว" ซึ่งตอบไม่ได้ว่าทั้งงานใช้เวลาไปเท่าไรแล้ว
 * ตัวเลขนั้นคือสิ่งที่ใช้ตัดสินว่าจะรอต่อหรือจะหยุด และใช้เทียบเล่มต่อเล่มได้จริง
 *
 * เวลาถูกนับจากเหตุการณ์สถานะที่ Studio ส่งอยู่แล้ว ไม่ใช่จับเองแยกอีกชุด
 * แผงข้างจึงเห็นเลขเดียวกับ Studio แม้เพิ่งเปิดกลางทาง (Side Panel สร้างตัวเองใหม่ทุกครั้ง)
 *
 * ช่วงที่งานหยุด (ผิดพลาด/โควตาหมด) นาฬิกาหยุดเดินแต่ไม่รีเซ็ต เพราะเวลาที่ระบบไม่ได้ทำอะไร
 * ไม่ใช่เวลาทำงาน แต่สิ่งที่ทำไปแล้วก็ไม่ได้หายไป พอทำต่อจึงเดินต่อจากเลขเดิม
 */

/** สถานะที่แปลว่า "ยังไม่มีงาน" — เห็นแล้วเก็บนาฬิกาไปเลย ไม่ใช่โชว์ 00:00 ค้างไว้ */
const IDLE = 'ready';
/** สถานะที่แปลว่างานหยุดชั่วคราว รอคนหรือรอโควตา — พักเข็มไว้ก่อน */
const PAUSED = 'stopped';
const FINISHED = 'done';

/** เวลาที่ผ่านไปจริงของงานนี้ = ที่สะสมไว้ + ช่วงที่กำลังเดินอยู่ตอนนี้ */
export function clockElapsed(clock, now) {
  if (!clock) return 0;
  return Math.max(0, clock.base + (clock.running ? now - clock.since : 0));
}

/**
 * เดินนาฬิกาไปหนึ่งสถานะ — บริสุทธิ์ ทดสอบได้ ไม่แตะ DOM
 * คืน null เมื่อไม่ควรมีนาฬิกาอยู่เลย
 */
export function nextClock(prev, run) {
  if (!run?.kind) return prev || null;
  const at = run.at ?? Date.now();
  if (run.kind === IDLE) return null;
  if (run.kind === FINISHED) return { base: clockElapsed(prev, at), since: at, running: false, done: true };
  if (run.kind === PAUSED) return { base: clockElapsed(prev, at), since: at, running: false, done: false };
  // งานใหม่หลังส่งมอบเล่มก่อน ต้องเริ่มนับใหม่ ไม่ใช่ต่อยอดเวลาของเล่มที่จบไปแล้ว
  if (!prev || prev.done) return { base: 0, since: at, running: true, done: false };
  if (prev.running) return prev;
  return { base: prev.base, since: at, running: true, done: false };
}

const pad = (n) => String(n).padStart(2, '0');

/** สั้นที่สุดที่ยังอ่านออก: ต่ำกว่าชั่วโมงใช้ นาที:วินาที เกินนั้นค่อยเติมชั่วโมง */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const TITLES = {
  running: 'กำลังจับเวลา — นับตั้งแต่สั่งงานครั้งนี้',
  paused: 'งานหยุดอยู่ — เวลาหยุดนับ และจะเดินต่อจากเลขนี้เมื่อทำต่อ',
  done: 'ส่งมอบแล้ว — เวลารวมที่ใช้ทั้งงาน',
};

export function timerView(clock, now) {
  if (!clock) return { hidden: true, text: '', state: 'idle', title: '' };
  const state = clock.done ? 'done' : clock.running ? 'running' : 'paused';
  return { hidden: false, text: formatElapsed(clockElapsed(clock, now)), state, title: TITLES[state] };
}

/**
 * ติดนาฬิกาไว้มุมขวาบนของหน้า และคืนฟังก์ชันรับสถานะงาน
 * เดินเองทุกวินาที เพราะระหว่างขั้นเขียนยาว ๆ ไม่มีเหตุการณ์เข้ามาเลยหลายนาที
 */
export function mountRunTimer(parent = document.body) {
  const box = document.createElement('aside');
  box.className = 'run-timer';
  box.hidden = true;
  const face = document.createElement('span');
  face.className = 'run-timer-face';
  face.setAttribute('aria-hidden', 'true');
  const value = document.createElement('span');
  value.className = 'run-timer-value';
  value.setAttribute('role', 'timer');
  box.append(face, value);
  parent.append(box);

  let clock = null;
  const tick = () => {
    const view = timerView(clock, Date.now());
    box.hidden = view.hidden;
    if (view.hidden) return;
    box.dataset.state = view.state;
    box.title = view.title;
    box.setAttribute('aria-label', `${view.title} · ${view.text}`);
    if (value.textContent !== view.text) value.textContent = view.text;
  };
  tick();
  setInterval(tick, 1000);
  return (run) => {
    // Studio ประทับนาฬิกามากับสถานะอยู่แล้ว แผงข้างจึงแค่อ่านตาม ไม่ต้องเดาเวลาเริ่มเอง
    clock = run && 'clock' in run ? run.clock || null : nextClock(clock, run);
    tick();
  };
}
