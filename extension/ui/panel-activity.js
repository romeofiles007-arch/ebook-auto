import { crewMarkup, crewSource } from './crew-sprites.js';
import { mountRunStatus } from './run-status.js';
import { mountRunTimer } from './run-timer.js';
import { mountCeoPanel } from './ceo-panel.js';
const paintCeo = mountCeoPanel(document.getElementById('ceoPanel'));
const paintRunStatus = mountRunStatus(document.querySelector('main'), async () => {
  const result = await chrome.runtime.sendMessage({type:'sw.openStudio'});
  if (!result?.ok) throw new Error(result?.error || 'เปิด Studio ไม่สำเร็จ');
});
const paintRunTimer = mountRunTimer(document.body);
const $ = (id) => document.getElementById(id);
const events = new Map();
let follow = true;
let lastAt = 0;
const crewIds = ['research', 'planner', 'writer', 'editor', 'art', 'proof', 'layout', 'ship'];
const names = ['นักค้นคว้า', 'นักวางโครงหนังสือ', 'นักเขียน', 'บรรณาธิการ', 'นักออกแบบภาพ', 'พิสูจน์คำสั่งภาพ', 'ฝ่ายจัดเล่ม', 'ฝ่ายส่งออก'];
crewIds.forEach((id, i) => {
  const item = document.createElement('span');
  item.innerHTML = crewMarkup(id);
  item.title = names[i]; item.setAttribute('aria-label', names[i]); item.dataset.crew = id;
  $('crewRoster').append(item);
});
/** สถานะทีมงานล่าสุดที่แผงนี้รู้ ใช้คู่กับเวลาที่มีความเคลื่อนไหวจริงเพื่อตัดสินว่าจะขยับไหม */
let crewState = null;

/**
 * หุ่นขยับตาม "ยังมีความเคลื่อนไหวจริงไหม" ไม่ใช่ตามธงที่อัปเดตเฉพาะตอนเปลี่ยนขั้น
 *
 * ธง working ถูกส่งมาพร้อมเหตุการณ์ของทีมงาน ซึ่งเกิดตอนเปลี่ยนขั้นเท่านั้น
 * ขั้นเขียนหนึ่งขั้นกินเวลาหลายนาที ระหว่างนั้นไม่มีเหตุการณ์ทีมงานเลยสักครั้ง
 * ถ้าแผงถูกเปิดใหม่กลางทาง (Side Panel สร้างตัวเองใหม่ทุกครั้งที่ปิด/เปิด)
 * มันจะกู้สถานะจาก snapshot ที่อาจค้างเป็น "ไม่ได้ทำงาน" แล้วหุ่นก็นิ่งทั้งที่งานเดินอยู่
 *
 * ความเคลื่อนไหวจริงวัดได้จากเหตุการณ์ที่ไหลเข้ามา — ตอนรอ ChatGPT มีรายงานทุกห้าวินาที
 * ส่วนตอนที่ระบบรอคนกด เหตุการณ์จะหยุดเอง หุ่นก็หยุดเองโดยไม่ต้องมีใครสั่ง
 */
const MOTION_WINDOW_MS = 20000;

function paintCrewMotion() {
  if (!crewState) return;
  const live = crewState.working !== false && Date.now() - lastAt < MOTION_WINDOW_MS;
  const activeIds = new Set(validCrewIds(crewState));
  $('panelCrew').classList.toggle('working', live);
  $('panelCrew').querySelector('strong').textContent = `${live ? (activeIds.size > 1 ? 'กำลังทำงานร่วมกัน · ' : 'กำลังทำงาน · ') : ''}${crewState.name}`;
  $('crewRoster').querySelectorAll('[data-crew]').forEach((item) => {
    item.classList.toggle('working', activeIds.has(item.dataset.crew) && live);
  });
}

function validCrewIds(crew) {
  return [...new Set([crew?.id, ...(Array.isArray(crew?.ids) ? crew.ids : [])])]
    .filter((id) => crewIds.includes(id));
}

function showCrew(crew) {
  const activeIds = validCrewIds(crew);
  if (!activeIds.length) return;
  crewState = { ...crew, id: activeIds[0], ids: activeIds };
  const el = $('panelCrew');
  el.dataset.room = activeIds[0];
  const art = el.querySelector('.crew-active-art');
  art.innerHTML = activeIds.map((id) => crewMarkup(id, 'crew-art')).join('');
  const backdrop = el.querySelector('.crew-backdrop .crew-strip');
  const src = crewSource(activeIds[0]);
  if (backdrop?.getAttribute('src') !== src) backdrop.src = src;
  el.querySelector('.crew-description span').textContent = crew.detail;
  $('crewRoster').querySelectorAll('[data-crew]').forEach((item) => {
    item.classList.toggle('current', activeIds.includes(item.dataset.crew));
  });
  paintCrewMotion();
}
function accept(event) {
  if (!event?.id) return;
  if (event.ceo) paintCeo(event.ceo);
  if (event.run) {
    paintRunStatus({...event.run, actionLabel:event.run.action ? 'เปิด Studio เพื่อดำเนินการ' : ''});
    paintRunTimer(event.run);
    paintCeo(null, event.run);
  }
  lastAt = Math.max(lastAt, event.at || 0);
  if (event.crew) showCrew(event.crew);
  else paintCrewMotion(); // เหตุการณ์อื่นก็เป็นหลักฐานว่ายังเดินอยู่
  if (!event.message) return;
  events.set(event.id, event);
  const sorted = [...events.values()].sort((a, b) => a.at - b.at).slice(-200);
  events.clear(); sorted.forEach((e) => events.set(e.id, e));
  renderLog(sorted);
  $('live').textContent = sorted.at(-1)?.message || 'พร้อมเริ่มงาน';
}

const span = (cls, text) => {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
};

/**
 * แยกสีทีละส่วนแบบจอ DOS: เวลา · ชนิดเหตุการณ์ · ชื่อเล่ม · ข้อความ
 *
 * เขียวล้วนทั้งกองอ่านยากเมื่อบรรทัดไหลเร็ว เพราะตาไม่มีจุดเกาะว่าอันไหนขึ้นบรรทัดใหม่
 * และแยกไม่ออกว่าอันไหนคำเตือน สีจึงทำหน้าที่แทนการเพ่งอ่าน
 */
function lineEl(e) {
  const level = e.level || 'info';
  const line = document.createElement('div');
  line.className = `terminal-line lv-${/^[a-z]+$/.test(level) ? level : 'info'}`;
  line.dataset.eventId = e.id;
  line.append(
    span('t-time', `[${new Date(e.at).toLocaleTimeString('th-TH')}] `),
    span('t-level', `[${level}] `),
  );
  if (e.bookTitle) line.append(span('t-book', e.bookTitle), span('t-sep', ' > '));
  line.append(span('t-msg', e.message));
  return line;
}

/**
 * ต่อท้ายเฉพาะบรรทัดใหม่ ไม่วาดใหม่ทั้งกอง
 *
 * เดิมใช้ replaceChildren ทุกครั้งที่มีเหตุการณ์เข้ามา ซึ่งรื้อ 200 บรรทัดทิ้งแล้วสร้างใหม่หมด
 * ตำแหน่งเลื่อนจึงต้องถูกจำแล้วยัดกลับ กลายเป็นการกระโดดทุกบรรทัด และการเลื่อนแบบนุ่ม ๆ
 * ก็ทำไม่ได้เลย เพราะ element ที่กำลังเลื่อนหาถูกลบทิ้งกลางทางทุกครั้ง
 * รื้อทั้งกองเหลือไว้เฉพาะตอนที่ลำดับเปลี่ยนจริง (เช่นตอนดึงประวัติเก่ามาเติมย้อนหลัง)
 */
function renderLog(sorted) {
  const log = $('panelLog');
  const shown = [...log.children];
  const sameSoFar = shown.every((el, i) => el.dataset.eventId === sorted[i]?.id);
  if (sameSoFar && shown.length <= sorted.length) {
    sorted.slice(shown.length).forEach((e) => {
      const line = lineEl(e);
      line.classList.add('fresh');
      log.append(line);
    });
  } else {
    const scroll = log.scrollTop;
    log.replaceChildren(...sorted.map(lineEl));
    log.scrollTop = scroll;
  }
  stickToBottom(log);
}

const stillFrames = window.matchMedia?.('(prefers-reduced-motion: reduce)');

/**
 * เลื่อนตามบรรทัดใหม่แบบนุ่ม ๆ แต่ห้ามนุ่มจนตามไม่ทัน
 *
 * ถ้าเหตุการณ์เข้ามารัวหรือเพิ่งเปิดหน้ามา ระยะห่างจากท้ายจะไกลมาก
 * การไถลไปเรื่อย ๆ จะดูเหมือนค้าง กรณีนั้นกระโดดไปท้ายทันทีแล้วค่อยนุ่มในบรรทัดถัด ๆ ไป
 */
function stickToBottom(log, { instant = false } = {}) {
  if (!follow) return;
  const behind = log.scrollHeight - log.scrollTop - log.clientHeight;
  // การเปลี่ยนขนาดกล่องไม่ใช่ "บรรทัดใหม่มา" จึงไม่ต้องไถล และการไถลระหว่างที่ layout
  // เพิ่งเปลี่ยนจะถูกตัดกลางคันจนค้างไม่ถึงท้าย (เห็นตอนย่อจากเต็มจอแล้วห่างท้าย 400px)
  const smooth = !instant && behind < log.clientHeight * 2 && !stillFrames?.matches;
  log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
$('logFollow').onclick = () => {
  follow = !follow;
  $('logFollow').setAttribute('aria-pressed', String(follow));
  $('logFollow').textContent = follow ? 'ตามล่าสุด' : 'หยุดเลื่อน';
  if (follow) stickToBottom($('panelLog'));
};
/**
 * ขยายบันทึกให้เต็มแผง — กล่องสูง 300px อ่านย้อนหลังไม่ไหวเมื่อมีของ 200 รายการ
 * ปิดด้วยปุ่มเดิมหรือ Esc และเมื่อขยาย/ย่อ ต้องเกาะท้ายให้เหมือนเดิม
 * เพราะความสูงที่เปลี่ยนทำให้ตำแหน่งท้ายสุดย้าย
 */
function setLogFull(on) {
  const term = document.querySelector('.terminal');
  term.classList.toggle('expanded', on);
  document.body.classList.toggle('logFull', on);
  const btn = $('logExpand');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '⤡ ย่อลง' : '⤢ เต็มจอ';
  // รอให้เบราว์เซอร์คำนวณ layout ใหม่เสร็จก่อน ไม่งั้นค่าความสูงที่อ่านได้ยังเป็นของขนาดเดิม
  requestAnimationFrame(() => stickToBottom($('panelLog'), { instant: true }));
}
$('logExpand').onclick = () => setLogFull(!document.querySelector('.terminal').classList.contains('expanded'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.terminal').classList.contains('expanded')) setLogFull(false);
});

// ย่อ/ขยาย Side Panel แล้วความสูงกล่องเปลี่ยน ตำแหน่งท้ายสุดก็เลื่อนตาม
// ถ้าไม่ตามให้ ปุ่มจะบอกว่า "ตามล่าสุด" ทั้งที่บรรทัดล่าสุดหลุดจอไปแล้ว
new ResizeObserver(() => stickToBottom($('panelLog'), { instant: true })).observe($('panelLog'));
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'ui.activity') accept(m.event); });
chrome.runtime.sendMessage({ type: 'ui.activitySnapshot' }).then((snapshot) => {
  paintCeo(snapshot?.ceo || null, snapshot?.run || null);
  if (snapshot?.run) {
    paintRunStatus({...snapshot.run, actionLabel:snapshot.run.action ? 'เปิด Studio เพื่อดำเนินการ' : ''});
    paintRunTimer(snapshot.run); // เปิดแผงกลางงาน ต้องเห็นเวลาที่เดินมาแล้ว ไม่ใช่เริ่มนับใหม่
  }
  const receivedLive = lastAt > 0;
  for (const e of snapshot?.events || []) {
    if (!events.has(e.id)) accept({ ...e, crew: null });
  }
  if (!receivedLive) showCrew(snapshot?.crew);
  lastAt = Math.max(lastAt, snapshot?.at || 0);
}).catch(() => { $('logUpdated').textContent = 'ยังอ่านประวัติไม่ได้ · รอ Studio ส่งสถานะใหม่'; });
setInterval(() => {
  paintCrewMotion();
  if (lastAt) $('logUpdated').textContent = `ข้อมูลล่าสุด ${Math.max(0, Math.floor((Date.now() - lastAt) / 1000))} วินาทีที่แล้ว · เก็บล่าสุด 200 รายการ`;
}, 1000);
