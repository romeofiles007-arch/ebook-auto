/**
 * Studio — สมองและโต๊ะทำงาน
 * หน้านี้ต้องเปิดค้างไว้ตลอดงาน เพราะ MV3 ฆ่า service worker เมื่อไม่มีงานราว 30 วินาที
 * ส่วน service worker เหลือหน้าที่แค่ส่งต่อข้อความและปลุกหน้านี้คืนถ้าถูกปิด
 */

import * as db from '../core/db.js';
import { Machine, plannedImageJobs, ingestImageDataUrl, promptForImage } from '../core/machine.js';
import { makeTransport, hasPendingTurn } from '../transport/index.js';
import {
  MODEL_PRICES,
  DEFAULT_TEXT_MODEL,
  PRICE_CHECKED_AT,
  priceFor,
  costOf,
  estimateCost,
  estimateImageCost,
  plannedImageCount,
  costOfImages,
  formatCost,
} from '../core/pricing.js';
import { TRIM_PRESETS, estimateTurns, targetPhysicalPages } from '../core/budget.js';
import { bookIssues, issuesBySection, issuesForSection } from '../core/review.js';
import { authorRefSummary } from '../core/imageRef.js';
import {
  FIGURE_STYLES,
  polishAboutPrompt,
  titleIdeasPrompt,
  trendIdeasPrompt,
  outlineDirectionsPrompt,
  outlinePolishPrompt,
  frontCoverPrompt,
  backCoverPrompt,
  coverTextBaked,
  sectionPrompt,
} from '../core/prompts.js';
import { parseJson, extractSection } from '../core/extract.js';
import * as B from '../core/bible.js';
import { ITEM_KINDS, planItems, suggestItemSize } from '../core/items.js';
import { countUnits } from '../core/thai.js';
import { preflight } from '../core/preflight.js';
import { compileBook, selfTest } from '../typeset/compiler.js';
import * as X from '../core/export.js';
import * as W from '../core/workspace.js';
import { testKey as testImageApiKey, DEFAULT_IMAGE_MODEL } from '../core/imageApi.js';

// บอกยามเฝ้าการบูตว่าโมดูลนี้รันถึงบรรทัดนี้จริง (ดู ui/boot-guard.js)
window.__studioBooted = true;

const $ = (id) => document.getElementById(id);
let book = null;
let machine = null;
let sections = [];
let assetNames = [];
let selected = null;
let eventCount = 0;
/**
 * คีย์ OpenAI ที่โหลดไว้ในหน่วยความจำ
 *
 * transport ถูกสร้างแบบ synchronous ในหลายจุด จะไปอ่าน IndexedDB ตอนนั้นไม่ได้
 * จึงโหลดคีย์ไว้ตั้งแต่เปิดหน้า แล้วอัปเดตทุกครั้งที่ผู้ใช้พิมพ์
 */
let apiKeyValue = '';
let currentEstimate = null; // ผลประเมินล่าสุด ใช้คิดราคาโดยไม่ต้องคำนวณซ้ำ
const textApiModel = () => $('textApiModel')?.value.trim() || DEFAULT_TEXT_MODEL;
let trendSeed = null;
let trendPool = [];
let outlineDirection = null;
/**
 * สารบัญชุดที่เห็นอยู่มาจากทางไหน — 'auto' คือ ChatGPT คิดเอง, 'inspire' คือผู้ใช้เขียนมาเอง
 * ต้องจำไว้ เพราะปุ่ม "เสนอสารบัญใหม่" ในกล่องเตือนค่าเปลี่ยน ต้องเรียกตัวที่ถูก
 * ไม่งั้นสารบัญที่ผู้ใช้อุตส่าห์เขียนเองจะถูกแทนที่ด้วยของที่โมเดลคิดใหม่ทั้งชุด
 */
let outlineOrigin = 'auto';
let inspirePolishRound = 0;
let coverPreviewUrl = null;

const STEP_ORDER = ['health', 'calibrate', 'outline', 'write', 'figures', 'consistency', 'fit', 'style', 'gate_images', 'images', 'done'];
const STEP_NAMES = {
  health: 'ตรวจระบบ',
  calibrate: 'วัดรูปเล่ม',
  outline: 'คิดสารบัญ',
  write: 'เขียนเนื้อหา',
  figures: 'วางแผนภาพประกอบ',
  consistency: 'ตรวจความต่อเนื่อง',
  fit: 'ปรับจำนวนหน้า',
  style: 'เตรียม Prompt ภาพ',
  gate_images: 'พร้อมเปลี่ยนบัญชี',
  images: 'Phase 2 · สร้างและแทรกภาพ',
  done: 'เสร็จแล้ว',
};

// ---------- utility ----------
/**
 * โหมดที่กำลังทำงานอยู่ — ผู้ใช้ต้องรู้ได้ตลอดว่าที่เห็นบนจอเป็นผลของปุ่มไหน
 * ข้อความสถานะบรรทัดเดียว (เช่น "กำลังรอ ChatGPT ตอบ") ไม่บอกว่ากำลังคิดชื่อ ค้นกระแส หรือเขียนเล่มอยู่
 */
let currentMode = '';

function setMode(label = '', { busy = false } = {}) {
  currentMode = label;
  const el = $('mode');
  if (!el) return;
  // โหมดทดสอบต้องเห็นชัดตลอดเวลา ไม่งั้นจะเผลอคิดว่าผลลัพธ์ที่ได้เป็นของจริง
  const tag = testing() ? '🧪 ทดสอบ' : '';
  el.textContent = label ? `โหมด: ${label}${tag ? ` · ${tag}` : ''}` : tag;
  el.classList.toggle('hidden', !label && !tag);
  el.classList.toggle('busy', !!label && busy);
}

const status = (s) => {
  $('status').textContent = s;
  // แถบข้างเห็นได้บรรทัดเดียว จึงต้องพ่วงชื่อโหมดไปกับข้อความ
  chrome.runtime
    .sendMessage({ type: 'ui.status', message: currentMode ? `[${currentMode}] ${s}` : s })
    .catch(() => {});
};
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (v, max = 900) => {
  const s = String(v ?? '');
  return s.length > max ? s.slice(0, max) + '\n…' : s;
};

async function syncSharedProject(id = book?.id) {
  if (!id) return false;
  try {
    const r = await W.syncProject(id);
    return !!r?.ok;
  } catch {
    return false;
  }
}

function addEvent(direction, label, text, meta = '') {
  const feed = $('feed');
  if (eventCount === 0) feed.innerHTML = '';
  eventCount++;
  const el = document.createElement('div');
  el.className = `event ${direction}`;
  const who =
    direction === 'send' ? '➡️ Extension → ChatGPT' : direction === 'receive' ? '⬅️ ChatGPT → Extension' : '⚙️ Extension';
  el.innerHTML =
    `<div class="head"><span>${who}</span><span>${new Date().toLocaleTimeString()}</span></div>` +
    `<div class="label">${esc(label)}</div>` +
    (text ? `<pre>${esc(short(text))}</pre>` : '') +
    (meta ? `<div class="muted">${esc(meta)}</div>` : '');
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

function setPhase(name, detail = '') {
  $('phase').textContent = STEP_NAMES[name] || name || 'กำลังทำงาน';
  $('detail').textContent = detail || '';
  const idx = Math.max(0, STEP_ORDER.indexOf(name));
  $('bar').style.width = `${Math.min(99, Math.round((idx / (STEP_ORDER.length - 1)) * 100))}%`;
  const dept = DEPT_OF_STEP.get(name);
  if (dept != null) activeDept = dept;
  renderSteps();
}

/**
 * กระดานทีมงาน — 7 แผนก ตรงกับที่สื่อสารกับผู้ใช้ภายนอก
 *
 * ภายในระบบมี 12 ขั้นตอน แต่ผู้ใช้ไม่ได้คิดเป็นขั้นตอน เขาคิดเป็น "ใครทำอะไร"
 * ตารางนี้จึงยุบขั้นตอนภายในเข้าเป็นแผนก แล้วบอกสามอย่างต่อหนึ่งแผนก:
 * ทำอะไร · ผลล่าสุดเป็นอย่างไร · ถ้าจะปรับต้องไปแก้ที่ไหน
 * ช่องสุดท้ายคือหัวใจ เพราะแต่ละแผนกมี prompt ของตัวเอง แก้ที่หนึ่งไม่กระทบอีกที่
 */
const DEPARTMENTS = [
  {
    id: 'research',
    name: 'นักค้นคว้า',
    role: 'ค้นกระแส หาแหล่งอ้างอิง ตั้งชื่อหนังสือ และตรวจการเชื่อมต่อ ChatGPT ก่อนเริ่ม',
    steps: ['health'],
    tune: 'trendIdeasPrompt · titleIdeasPrompt · adapter/selectors.json',
  },
  {
    id: 'planner',
    name: 'นักวางโครงหนังสือ',
    role: 'วางสารบัญ แบ่งบทแบ่งตอน และกำหนดโควตาความยาวของแต่ละตอน',
    steps: ['outline'],
    tune: 'outlinePrompt · outlineDirectionsPrompt · suggestChapters',
  },
  {
    id: 'writer',
    name: 'นักเขียน',
    role: 'สร้างการ์ดผู้เขียน แล้วเขียนเนื้อหาจริงทีละตอนตามรูปทรงที่กำหนด',
    steps: ['voice', 'write'],
    tune: 'sectionPrompt · voiceRules · SECTION_SHAPES · authorVoicePrompt',
  },
  {
    id: 'editor',
    name: 'บรรณาธิการ',
    role: 'จับศัพท์ที่นิยามซ้ำ ตัวอย่างที่ใช้ซ้ำ และเนื้อหาที่ขัดกันเอง',
    steps: ['consistency'],
    tune: 'consistencyPrompt',
  },
  {
    id: 'art',
    name: 'นักออกแบบภาพ',
    role: 'เลือกจุดที่ควรมีภาพ ออกแบบแนวปก แล้วสั่งสร้างภาพจริงทีละรูป',
    steps: ['figures', 'style', 'gate_images', 'images'],
    tune: 'figurePlanPrompt · styleTokenPrompt · frontCoverPrompt · imageTurn',
  },
  {
    id: 'layout',
    name: 'ฝ่ายจัดเล่ม',
    role: 'วัดว่าหนึ่งหน้าใส่ได้เท่าไร แล้วยืด/ย่อเนื้อหาให้จำนวนหน้าเข้าเป้า',
    steps: ['calibrate', 'fit'],
    tune: 'core/budget.js · rewritePrompt · typeset/template.js',
  },
  {
    id: 'ship',
    name: 'ฝ่ายส่งออก',
    role: 'ประกอบเป็น PDF / EPUB / DOCX แล้วตั้งชื่อไฟล์ตามชื่อหนังสือ',
    steps: ['done'],
    tune: 'core/export.js · core/docx.js',
  },
];

const DEPT_OF_STEP = new Map(DEPARTMENTS.flatMap((d, i) => d.steps.map((st) => [st, i])));

// ผลงานล่าสุด/ปัญหาล่าสุดของแต่ละแผนก เก็บไว้ระหว่างที่หน้ายังเปิดอยู่
const deptNotes = new Map();
let activeDept = -1;

/** บันทึกผลงานล่าสุดของแผนกที่กำลังทำงานอยู่ ใช้กับ log ที่ไม่ได้บอกขั้นตอนมาด้วย */
function noteActiveDept(text, bad = false) {
  if (activeDept < 0) return;
  deptNotes.set(activeDept, { text: String(text || '').replace(/\s+/g, ' ').slice(0, 200), bad });
  renderSteps();
}

function noteDept(step, text, bad = false) {
  const i = DEPT_OF_STEP.get(step);
  if (i == null) return;
  deptNotes.set(i, { text: String(text || '').replace(/\s+/g, ' ').slice(0, 200), bad });
  renderSteps();
}

const renderSteps = () => {
  $('steps').innerHTML = DEPARTMENTS.map((d, i) => {
    const note = deptNotes.get(i);
    const state = note?.bad ? 'bad' : i === activeDept ? 'active' : activeDept >= 0 && i < activeDept ? 'done' : '';
    const mark = note?.bad ? '✕' : i === activeDept ? '⟳' : activeDept >= 0 && i < activeDept ? '✓' : i + 1;
    return (
      `<div class="dept ${state}">` +
      `<div class="mark">${mark}</div>` +
      `<div class="body"><b>${esc(d.name)}</b><span class="role">${esc(d.role)}</span>` +
      (note ? `<span class="note">${esc(note.text)}</span>` : '') +
      `<span class="tune">ปรับที่: ${esc(d.tune)}</span></div></div>`
    );
  }).join('');
};

/**
 * แถบขั้นตอนหลัก — คงอยู่ทุกหน้าจอ (ต่างจาก #steps ที่อยู่แค่ในหน้า progress)
 * เพื่อให้ผู้ใช้รู้เสมอว่ากำลังอยู่ตรงไหนของงาน แม้ระหว่างขั้นตอนที่ #steps ถูกซ่อนไปแล้ว
 */
const MACRO_STAGES = [
  { key: 'start', label: 'เริ่มต้น' },
  { key: 'write', label: 'เขียนเนื้อหา' },
  { key: 'edit', label: 'ตรวจ/แก้' },
  { key: 'images', label: 'สร้างภาพ' },
  { key: 'done', label: 'เสร็จสมบูรณ์' },
];

/**
 * ป้ายโหมดของแต่ละขั้นหลัก — ผูกไว้กับ setMacroStage เพื่อไม่ให้ค้างเป็นโหมดเก่า
 * (อาการที่เจอ: เดินมาถึงหน้า "ตรวจ/แก้" แล้ว แต่ป้ายยังบอกว่าอยู่โหมด "สุ่มข่าว · ค้นกระแส")
 */
const MACRO_MODE = {
  start: { label: '', busy: false },
  write: { label: 'สร้าง Ebook', busy: true },
  edit: { label: 'ตรวจ/แก้ก่อนส่งออก', busy: false },
  images: { label: 'Phase 2 · สร้างภาพ', busy: true },
  done: { label: 'เสร็จสมบูรณ์', busy: false },
};

function setMacroStage(key) {
  const mode = MACRO_MODE[key];
  if (mode) setMode(mode.label, { busy: mode.busy });
  const idx = Math.max(0, MACRO_STAGES.findIndex((s) => s.key === key));
  $('macroSteps').innerHTML = MACRO_STAGES.map((s, i) => {
    const cls = i === idx ? 'active' : i < idx ? 'done' : '';
    const mark = i < idx ? '<svg class="i" aria-hidden="true"><use href="#i-check"/></svg>' : i + 1;
    return `<div class="macroStep ${cls}"><div class="track"></div><div class="dot">${mark}</div><div class="label">${esc(s.label)}</div></div>`;
  }).join('');
}

/** เดาขั้นหลักจาก job.step ที่บันทึกไว้ ใช้ตอนกลับมาทำต่อ (halted/resumeGo) ซึ่งไม่ได้เรียกผ่าน openEditor/openImagePhaseGate ตรง ๆ */
function macroStageForJobStep(step) {
  if (!step || step === 'health') return 'start';
  if (step === 'done') return 'done';
  if (step === 'gate_edit') return 'edit';
  if (['gate_images', 'images', 'style'].includes(step)) return 'images';
  return 'write';
}

function showPages(pages, target, tol) {
  const el = $('pagestat');
  el.classList.remove('hidden', 'hit', 'miss');
  const err = pages - target;
  const hit = Math.abs(err) <= tol;
  el.classList.add(hit ? 'hit' : 'miss');
  el.textContent = `${pages} / ${target} หน้า · ห่าง ${err >= 0 ? '+' : ''}${err} · ยอมรับ ±${tol} · ${hit ? 'ผ่าน' : 'ยังไม่เข้าเป้า'}`;
}

function expectedPhysicalPages(b) {
  if (!b) return 0;
  if (b.contentMode === 'items' || b.outline?.themes?.length)
    return Math.round(b.itemPlan?.breakdown?.targetPhysical || planItems(b).breakdown.targetPhysical);
  return b.outline ? targetPhysicalPages(b, b.outline) : b.targetPages;
}

function logMachine(e) {
  if (e.type === 'turn.start') {
    lastProgressAt = Date.now();
    lastProgressPhase = 'เริ่มเทิร์น';
  }
  if (e.type === 'turn.start') return addEvent('send', `Turn ${e.n}${e.label ? ' · ' + e.label : ''}`, e.prompt, 'ส่ง Prompt ไปยังหน้า ChatGPT');
  if (e.type === 'turn.end') {
    /**
     * ค่าใช้จ่ายต้องเห็นระหว่างทำงาน ไม่ใช่ตอนเปิดบิลสิ้นเดือน
     * ตัวเลข token มาจากเซิร์ฟเวอร์โดยตรง จึงเป็นค่าจริงไม่ใช่การประเมิน
     */
    const bits = [];
    if (e.meta?.ms) bits.push(`ตอบกลับใน ${e.meta.ms} ms`);
    if (e.meta?.promptTokens != null) {
      const price = priceFor(e.meta.model || textApiModel(), customPrice);
      const usd = costOf({ promptTokens: e.meta.promptTokens, completionTokens: e.meta.completionTokens, price });
      bits.push(
        `token เข้า ${Number(e.meta.promptTokens).toLocaleString()} · ออก ${Number(e.meta.completionTokens || 0).toLocaleString()}` +
          (usd != null ? ` · เทิร์นนี้ ${formatCost(usd, usdThb)}` : ''),
      );
      showRunningCost();
    }
    return addEvent('receive', `Turn ${e.n} · ${e.status}`, e.response, bits.join(' · '));
  }
  if (e.type === 'image.progress') {
    const pos = e.total ? `${e.current || 0}/${e.total}` : '';
    const label = e.what || e.name || 'ภาพ';
    const stage = {
      check: `กำลังตรวจภาพ ${pos} · ${label}`,
      generate: `กำลังสร้างภาพ ${pos} · ${label}`,
      retry: `กำลังลองสร้างใหม่ ${pos} · ${label} (ครั้งที่ ${e.attempt}/${e.maxAttempts})`,
      grab: `ภาพยังไม่ขึ้นในคำตอบ · กำลังรอแล้วไล่คว้าจากหน้าแชตให้เอง ${pos} · ${label}`,
      download: `กำลังดึงและปรับขนาดภาพ ${pos} · ${label}`,
      saved: `✓ บันทึกภาพ ${pos} · ${label}`,
      failed: `ภาพ ${pos} ไม่ผ่าน · ${label}${e.reason ? ` — ${e.reason}` : ''}`,
      verify_all: `กำลัง Final Check ภาพทั้งหมด ${e.total || ''} รูป`,
      compile: '✓ Images OK · กำลังประกอบ Ebook',
    }[e.stage] || `กำลังทำภาพ ${pos} · ${label}`;
    setPhase('images', stage);
    status(e.stage === 'failed' ? 'Image Phase 2 หยุดรอแก้' : 'กำลังทำ Image Phase 2');
    // อัปเดตแถวของรูปที่กำลังทำอยู่ในหน้า Phase 2 ให้เห็นสด ๆ ว่าอยู่ขั้นไหน
    if (phase2Running) {
      phase2Stage = { name: e.name || null, text: stage, base: stage };
      renderPhase2();
    }
    return;
  }
  if (e.type === 'log') {
    addEvent('system', e.level || 'log', e.message);
    noteActiveDept(e.message, e.level === 'warn');
    if (book?.lastCompile?.pages)
      showPages(book.lastCompile.pages, expectedPhysicalPages(book), book.pageTolerance ?? 2);
    return;
  }
  if (e.type === 'step') return setPhase(e.step) || addEvent('system', STEP_NAMES[e.step] || e.step, '');
  if (e.type === 'step_done') return addEvent('system', 'เสร็จขั้นตอน', STEP_NAMES[e.step] || e.step);
  if (e.type === 'state') book = e.book;
}

/**
 * นาฬิกาเฝ้าดูความคืบหน้า
 *
 * ทุกครั้งที่ระบบค้าง สิ่งที่เห็นคือหน้าจอเงียบสนิท แล้วต้องมานั่งเดากันว่าติดด่านไหน
 * ทั้งที่ตัว adapter รายงานทุกขั้นอยู่แล้ว แค่ไม่มีใครจับเวลาว่ารายงานล่าสุดมาเมื่อไร
 * ตัวนี้จับเวลาให้ แล้วพอเงียบนานผิดปกติก็เขียนบนหน้าจอเลยว่าเงียบมากี่วินาที
 * และขั้นล่าสุดที่ได้ยินคืออะไร — เท่านี้ก็ไม่ต้องเดากันอีก
 */
let lastProgressAt = 0;
let lastProgressPhase = '';
const PHASE_NAME = {
  waiting_ready: 'รอหน้า ChatGPT พร้อม',
  new_thread: 'เปิดห้องแชตใหม่',
  new_thread_failed: 'เปิดห้องแชตใหม่ไม่สำเร็จ',
  waiting_idle: 'รอเทิร์นก่อนหน้าจบ',
  typing: 'พิมพ์ Prompt ลงช่อง',
  sending: 'กดส่ง Prompt',
  waiting: 'รอ ChatGPT ตอบ',
  streaming: 'ChatGPT กำลังพ่นคำตอบ',
  received: 'ได้รับคำตอบแล้ว',
  awaiting_user_send: 'รอคุณกด Enter',
};

setInterval(() => {
  if (!hasPendingTurn() || !lastProgressAt) return;
  const quiet = Math.round((Date.now() - lastProgressAt) / 1000);
  if (quiet < 25) return;
  const where = PHASE_NAME[lastProgressPhase] || lastProgressPhase || 'ไม่ทราบขั้น';
  $('detail').textContent =
    `⏳ ไม่มีสัญญาณจากหน้า ChatGPT มา ${quiet} วินาที · ค้างอยู่ที่ขั้น “${where}”` +
    (quiet > 90 ? ' — ลองดูแท็บ ChatGPT ว่ามี Prompt ค้างในช่องพิมพ์หรือปุ่มหยุดค้างอยู่ไหม' : '');
  status(`ค้างที่ขั้น ${where} มา ${quiet} วินาที`);
}, 5000);


/**
 * ความคืบหน้าของเทิร์นที่วิ่งผ่าน API
 *
 * ทางขับหน้าเว็บมีข้อดีที่มองข้ามไม่ได้: ผู้ใช้เห็น ChatGPT พิมพ์ทีละตัวอักษร
 * จึงรู้ตลอดว่าระบบยังไม่ตาย ทางนี้ต้องสร้างสัญญาณชีพนั้นขึ้นมาเอง
 * จากข้อความที่สตรีมกลับมา — เห็นทั้งจำนวนตัวอักษรที่ได้แล้ว เวลาที่ใช้ไป
 * และท้ายประโยคล่าสุดที่โมเดลเพิ่งเขียน
 */
function showApiProgress(m) {
  const secs = m.ms ? (m.ms / 1000).toFixed(1) : '0.0';
  if (m.phase === 'sending') {
    status(`ส่งงานให้ ${m.model || 'API'} แล้ว รอคำตอบ`);
    $('detail').textContent = '';
    return;
  }
  if (m.phase === 'streaming') {
    status(`กำลังเขียน · ${Number(m.chars || 0).toLocaleString()} ตัวอักษร · ${secs} วินาที`);
    $('detail').textContent = m.tail ? `…${m.tail}` : '';
    return;
  }
  if (m.phase === 'done') {
    status(`เขียนจบแล้ว ${Number(m.chars || 0).toLocaleString()} ตัวอักษร ใน ${secs} วินาที`);
    $('detail').textContent = '';
  }
}

function handleGptMessage(m) {
  if (m?.type !== 'gpt.progress') return;
  lastProgressAt = Date.now();
  lastProgressPhase = m.phase || lastProgressPhase;

  /**
   * ความคืบหน้าจากทาง API มีคิวของตัวเอง ไม่ได้อยู่ในทะเบียนเทิร์นของแท็บ ChatGPT
   *
   * ตัวกรองด้านล่างใช้ทะเบียนของแท็บเป็นเกณฑ์ ซึ่งของทาง API ว่างเสมอ
   * เหตุการณ์ทั้งหมดจึงถูกทิ้งตั้งแต่บรรทัดแรก หน้าจอเลยเงียบสนิทตลอดการทำงาน
   * ทั้งที่ระบบกำลังเขียนอยู่จริง — เป็นความเงียบที่ทำให้คนกดปิดทิ้งกลางทาง
   */
  if (m.via === 'api') return showApiProgress(m);

  // ไม่มีเทิร์นไหนรอผลอยู่ = ข้อความนี้มาช้ากว่างานที่จบไปแล้ว ห้ามทับสถานะปัจจุบัน
  if (!hasPendingTurn()) return;
  const map = {
    waiting_ready: 'รอหน้า ChatGPT โหลดให้พร้อม',
    waiting_idle: 'รอให้ ChatGPT ตอบงานก่อนหน้าจบ',
    new_thread: 'กำลังเปิดบทสนทนาใหม่',
    typing: 'กำลังใส่ Prompt ลงใน ChatGPT',
    sending: 'กำลังกดส่ง Prompt',
    waiting: 'กำลังรอ ChatGPT ตอบ',
    awaiting_user_send: '⌨️ ไปกด Enter ในแท็บ ChatGPT หนึ่งครั้ง',
  };
  status(map[m.phase] || m.phase || 'ChatGPT กำลังทำงาน');
  if (m.phase === 'waiting')
    $('detail').textContent =
      `รอคำตอบจาก ChatGPT ${m.detail ? m.detail + ' วินาที' : ''}` + (m.note ? ` · ${m.note}` : '');

  /**
   * ด่านที่ต้องให้คนช่วยหนึ่งจังหวะ ต้องเห็นชัดที่สุดในหน้าจอ
   * ถ้าแจ้งเบา ๆ เหมือนสถานะอื่น ผู้ใช้จะนั่งรอต่ออีกสามนาทีโดยไม่รู้ว่าระบบรออะไรอยู่
   */
  if (m.phase === 'awaiting_user_send') {
    $('detail').textContent = String(m.detail || '');
    addEvent('system', '⌨️ ต้องกด Enter เอง', String(m.detail || ''));
    if (phase2Running && phase2Stage) {
      phase2Stage.text = '⌨️ กดส่งอัตโนมัติไม่ติด — ไปกด Enter ในแท็บ ChatGPT หนึ่งครั้ง';
      const cell = document.querySelector(`[data-p2-row="${CSS.escape(phase2Stage.name || '')}"] .p2Note`);
      if (cell) cell.textContent = phase2Stage.text;
    }
  }

  /**
   * หน้า Phase 2 เคยนิ่งสนิทตลอดเวลาที่รอ ChatGPT วาดภาพ
   *
   * เทิร์นสร้างภาพของโมเดลสายคิดก่อนตอบใช้เวลาเป็นนาที (เห็น "Worked for 1m 24s")
   * ระหว่างนั้นแถวของรูปโชว์ข้อความเดิมค้างไว้ ผู้ใช้จึงแยกไม่ออกระหว่าง "กำลังทำงาน"
   * กับ "ค้างไปแล้ว" แล้วต้องมานั่งเดาว่าจะรอต่อดีไหม
   * อัปเดตเฉพาะบรรทัดสถานะของแถวนั้น ไม่วาดรายการใหม่ทั้งชุด เพราะรับข้อความทุกวินาที
   */
  if (phase2Running && phase2Stage?.name && phase2Stage.base) {
    const live =
      m.phase === 'waiting'
        ? `${phase2Stage.base} · รอ ChatGPT ตอบมาแล้ว ${m.detail || 0} วินาที${m.note ? ` (${m.note})` : ''}`
        : `${phase2Stage.base} · ${map[m.phase] || m.phase}`;
    phase2Stage.text = live;
    const cell = document.querySelector(`[data-p2-row="${CSS.escape(phase2Stage.name)}"] .p2Note`);
    if (cell) cell.textContent = live;
  }
}

/**
 * สถานะที่ "ลองใหม่แล้วมักผ่าน" — เกือบทั้งหมดคือหน้าเว็บยังไม่พร้อมตอนสั่งงาน
 * ไม่รวม timeout เพราะเทิร์นที่หมดเวลาอาจกำลังตอบอยู่จริง ยิงซ้ำจะเปลืองโควตาฟรี
 */
const RETRYABLE_TURN_STATUS = new Set(['error', 'empty', 'no_response']);

function turnErrorMessage(res) {
  const why = res?.meta?.error ? ` (${res.meta.error})` : '';
  if (res?.meta?.error === 'chat_page_not_ready' || res?.meta?.error === 'adapter_unavailable')
    return 'หน้า ChatGPT ยังเปิดไม่พร้อม — เปิดแท็บ chatgpt.com ค้างไว้แล้วลองใหม่อีกครั้ง';
  return `ChatGPT ตอบกลับสถานะ ${res?.status || 'error'}${why}`;
}

function retryNotice(box, n, max, what, res) {
  const why = res?.error ? ` — ${String(res.error).slice(0, 200)}` : '';
  const msg = `${what}ยังไม่สำเร็จ${why} · กำลังลองใหม่อัตโนมัติ ครั้งที่ ${n + 1}/${max}...`;
  if (box) box.textContent = msg;
  status(`${what}ยังไม่สำเร็จ กำลังลองใหม่ ${n + 1}/${max}`);
}

/**
 * ยิงหนึ่งเทิร์น แล้วลองใหม่เองเมื่อพลาดแบบชั่วคราว "หรือคำตอบไม่ตรงรูปที่ขอ"
 *
 * งานสาย Machine มีการลองใหม่ให้อยู่แล้ว แต่ปุ่มคิดชื่อ/ค้นกระแส/เสนอสารบัญ ยิงตรงผ่าน transport
 * ความล้มเหลวจึงเด้งกลับมาเป็น error ให้ผู้ใช้กดเอง ซึ่งคือที่มาของอาการ
 * "ต้องกดสามรอบถึงจะได้ข้อมูล"
 *
 * parse(res) คืน { data } เมื่อคำตอบใช้ได้ หรือ { error, fatal } เมื่อไม่ผ่าน
 * fatal = ตอบมาชัดเจนแล้วว่าทำให้ไม่ได้ (เช่นค้นเว็บไม่ได้) ยิงซ้ำก็ได้ผลเดิม เปลืองโควตาเปล่า
 */
async function sendTurn(transport, prompt, opts = {}, { attempts = 3, onRetry, parse } = {}) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const res = (await transport.send(prompt, opts)) || { status: 'error' };
    let fatal = false;
    if (res.status !== 'ok') {
      res.error = turnErrorMessage(res);
      fatal = !RETRYABLE_TURN_STATUS.has(res.status);
    } else if (parse) {
      let out;
      try {
        out = parse(res) || {};
      } catch (e) {
        out = { error: `ตรวจคำตอบไม่สำเร็จ: ${e?.message || e}` };
      }
      if (!out.error) {
        res.data = out.data;
        return res;
      }
      res.error = out.error;
      fatal = !!out.fatal;
    } else {
      return res;
    }
    last = res;
    if (fatal || i === attempts) break;
    onRetry?.(i, attempts, res);
    await new Promise((r) => setTimeout(r, 250 * i)); // ตัวรอฝั่ง adapter ขับด้วย event แล้ว ไม่ต้องหน่วงยาว
  }
  return last;
}

/** ข้อความวินิจฉัยที่ "เห็นแล้วรู้เลยว่าได้อะไรกลับมา" ไม่ใช่แค่บอกว่าไม่ผ่าน */
function answerEvidence(raw, parsed) {
  const flat = String(raw || '').replace(/\s+/g, ' ');
  const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
  // คำตอบที่วงเล็บเปิดค้างไว้ = อ่านกลับมาไม่ครบ ไม่ใช่โมเดลตอบผิดฟอร์แมต
  // แยกสองกรณีนี้ให้ออก ไม่งั้นจะไปไล่แก้ prompt ทั้งที่ต้นเหตุอยู่ที่การอ่านหน้าเว็บ
  const opens = (flat.match(/[{[]/g) || []).length - (flat.match(/[}\]]/g) || []).length;
  const cut = opens > 0 ? ' · คำตอบถูกอ่านกลับมาไม่ครบ (ตัดกลางคัน) ระบบยิงซ้ำให้แล้ว' : '';
  return (
    `[ยาว ${String(raw || '').length} ตัวอักษร${cut}` +
    (keys.length ? ` · คีย์ที่อ่านได้: ${keys.slice(0, 12).join(', ')}` : '') +
    `] ต้นข้อความ: ${flat.slice(0, 160) || '(ว่าง)'}` +
    (flat.length > 320 ? ` … ท้ายข้อความ: ${flat.slice(-160)}` : '')
  );
}

const safeHttpUrl = (v) => {
  // ข้อความที่อ่านจากหน้า ChatGPT มักติดสัญลักษณ์ที่หน้าเว็บวาดเพิ่มมาด้วย
  // โดยเฉพาะไอคอนลิงก์ภายนอก ↗ ที่ต่อท้าย URL ในคำตอบที่มีการค้นเว็บ
  // ถ้าไม่ล้างออก URL จะกลายเป็น ".../ %20%E2%86%97" ซึ่งเปิดไม่ได้จริง
  const raw = String(v || '')
    .replace(/[↗→↳⧉⬈︎️]/g, ' ') // ไอคอนลิงก์/ลูกศรที่ UI ใส่มา
    .trim()
    .split(/\s+/)[0] // URL จริงคือก้อนแรกก่อนช่องว่าง
    .replace(/[)\]}>,.;:'"”’]+$/, ''); // เครื่องหมายวรรคตอนที่ติดท้ายมาจากประโยค
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch (_) {
    return '';
  }
};

/**
 * ไล่ลำดับให้เห็นกับตาว่าตอนนี้อยู่ขั้นไหน และเหลืออะไรก่อนกดขั้นถัดไป
 *
 * ปุ่ม "เสนอสารบัญ" วางอยู่บนสุดของหน้า แต่เป็นขั้นที่ 3 จริง ๆ
 * คนที่กดไล่จากบนลงล่างจะได้สารบัญของค่าตั้งต้น พอมาแก้จำนวนหน้าทีหลังก็ต้องเสนอใหม่ทั้งชุด
 * — เสียเวลาไปหนึ่งรอบเต็มโดยไม่จำเป็น
 */
function renderStepGuide() {
  const guide = $('stepGuide');
  if (!guide) return;
  const done = {
    setup: !!($('audience')?.value.trim() && $('tone')?.value.trim() && Number($('pages')?.value) > 0),
    title: !!$('title')?.value.trim(),
    outline: !!outlineDirection,
    create: false,
  };
  let marked = false;
  guide.querySelectorAll('[data-step]').forEach((li) => {
    const ok = done[li.dataset.step];
    li.classList.toggle('done', !!ok);
    const now = !ok && !marked;
    if (now) marked = true;
    li.classList.toggle('now', now);
  });
}

function resetOutlineDirection({ hide = true } = {}) {
  outlineDirection = null;
  outlineOrigin = 'auto';
  const box = $('outlineDirections');
  if (box) {
    box.dataset.ready = '0';
    box.classList.remove('stale');
    box.querySelector('[data-outline-stale]')?.remove();
    if (hide) box.classList.add('hidden');
  }
  setBtn('create', 'rocket', 'เริ่มสร้าง Ebook');
  renderStepGuide();
}

/**
 * ค่าที่แก้ทำให้สารบัญชุดเดิมใช้ไม่ได้ — แต่ห้ามลบทิ้งเงียบ ๆ
 *
 * สารบัญที่เลือกไว้ถูกล็อกเข้าไปในสารบัญจริง ถ้าแก้ผู้อ่าน/โทน/จำนวนหน้า/แนวหนังสือทีหลัง
 * โดยไม่รีเซ็ต จะได้สารบัญที่คำสั่งขัดกันเอง การรีเซ็ตจึงถูกต้อง
 * แต่ของเดิมสั่งซ่อนกล่องทิ้งไปทั้งดุ้นโดยไม่บอกอะไร ผู้ใช้เห็นแค่ "ตัวเลือกสารบัญหายไปเฉย ๆ"
 * และไม่รู้ว่าต้องกดอะไรต่อ ตอนนี้คาไว้บนจอพร้อมบอกเหตุผลและปุ่มเสนอใหม่ในคลิกเดียว
 */
function markOutlineStale(reason) {
  const box = $('outlineDirections');
  // เรียกซ้ำได้ (ผู้ใช้พิมพ์ทีละตัวอักษรใน ผู้อ่าน/โทน/จำนวนหน้า)
  // กล่องที่ค้างสถานะ stale อยู่แล้วต้องไม่ถูกตีความว่า "ไม่มีอะไรให้ค้าง" แล้วโดนซ่อนทิ้ง
  const hasChoices = box && !box.classList.contains('hidden') && (box.dataset.ready === '1' || box.classList.contains('stale'));
  if (!hasChoices) return resetOutlineDirection();

  outlineDirection = null;
  box.dataset.ready = '0';
  box.classList.add('stale');
  setBtn('create', 'rocket', 'เริ่มสร้าง Ebook');
  renderStepGuide();

  let note = box.querySelector('[data-outline-stale]');
  if (!note) {
    note = document.createElement('div');
    note.setAttribute('data-outline-stale', '1');
    note.className = 'outlineStale';
    box.prepend(note);
  }
  note.innerHTML =
    `<b>${esc(reason)} — สารบัญชุดนี้เป็นของค่าเดิมแล้ว</b>` +
    `<span>เลือกจากชุดนี้ต่อไม่ได้ เพราะจำนวนบทและกติกาจะขัดกับค่าที่เพิ่งแก้</span>` +
    `<button type="button" data-outline-again class="primary inline">เสนอสารบัญใหม่ 3 ทาง</button>`;
  note.querySelector('[data-outline-again]').onclick = () =>
    (outlineOrigin === 'inspire' ? polishUserOutline() : generateOutlineDirections());
}

function renderRandomTrend() {
  const box = $('trendIdeas');
  const usable = trendPool.filter((x) => Array.isArray(x?.sources) && x.sources.filter((s) => safeHttpUrl(s?.url)).length >= 1);
  if (!usable.length) {
    box.innerHTML = '<b>ยังไม่มีกระแสที่ยืนยันได้</b><div class="muted">ChatGPT ต้องค้นเว็บและคืนอย่างน้อย 1 แหล่งจริงต่อหนึ่งกระแส ระบบจะไม่สุ่มจากข้อมูลที่ไม่มีที่มา</div>';
    return;
  }
  const previous = trendSeed?.trend;
  const choices = usable.length > 1 ? usable.filter((x) => x.trend !== previous) : usable;
  const pick = choices[Math.floor(Math.random() * choices.length)] || usable[0];
  trendSeed = structuredClone(pick);
  const sources = (pick.sources || [])
    .filter((s) => safeHttpUrl(s.url))
    .map((s) => `<li><b>${esc(s.publisher || s.title || 'แหล่งข้อมูล')}</b>${s.date ? ` · ${esc(s.date)}` : ''}<br><span>${esc(s.title || '')}</span><br><a href="${esc(safeHttpUrl(s.url))}" target="_blank" rel="noreferrer">${esc(s.url)}</a></li>`)
    .join('');
  box.innerHTML = `<b>🎲 สุ่มได้กระแสนี้</b>
    <div class="trendPick">
      <h3>${esc(pick.trend)}</h3>
      <p><b>ทำไมตอนนี้:</b> ${esc(pick.why_now || '-')}</p>
      <p><b>หลักฐานแกน:</b> ${esc(pick.fact_anchor || '-')}</p>
      <p><b>มุม Ebook:</b> ${esc(pick.book_angle || '-')}</p>
      <p><b>ชื่อชั่วคราว:</b> ${esc(pick.suggested_title || pick.trend)}${pick.subtitle ? ` — ${esc(pick.subtitle)}` : ''}</p>
      <ul class="trendSources">${sources}</ul>
      <div class="trendActions">
        <button type="button" data-use-trend class="primary inline">ใช้กระแสนี้ → คิดชื่อ</button>
        <button type="button" data-reroll-trend>สุ่มอีกเรื่องจากผลค้นนี้</button>
        <button type="button" data-refresh-trend>ค้นกระแสใหม่</button>
      </div>
    </div>`;
  box.querySelector('[data-use-trend]').onclick = async () => {
    $('title').value = pick.suggested_title || pick.trend;
    if ($('bm_references')) $('bm_references').checked = true;
    resetOutlineDirection();
    status('เลือกกระแสแล้ว — กำลังเสนอชื่อหนังสือ');
    await generateTitleIdeas();
  };
  box.querySelector('[data-reroll-trend]').onclick = () => renderRandomTrend();
  box.querySelector('[data-refresh-trend]').onclick = () => generateTrendIdeas();
}

/**
 * ตรวจคำตอบโหมดกระแสให้ครบทุกด่าน แล้วบอกให้ชัดว่าตกด่านไหนพร้อมของจริงที่ได้มา
 * คืน { data } เมื่อใช้ได้ หรือ { error } เพื่อให้ sendTurn ยิงใหม่ให้เองโดยไม่ต้องให้ผู้ใช้กด
 */
function parseTrendAnswer(res) {
  const raw = String(res.text || '');
  const parsed = parseJson(raw);
  if (!parsed) return { error: `อ่านคำตอบเป็น JSON ไม่ได้ ${answerEvidence(raw, null)}` };
  if (parsed.verified === false)
    return {
      error:
        parsed.reason ||
        'แชทนี้ค้นเว็บเพื่อยืนยันกระแสไม่ได้ตอนนี้ — เช็คว่าโมเดล/แชทที่ใช้เปิดใช้การค้นเว็บอยู่',
      fatal: true, // ตอบชัดแล้วว่าทำไม่ได้ ยิงซ้ำก็ได้คำตอบเดิม
    };

  // เก็บสถิติทีละด่านไว้บอกผู้ใช้ว่าติดตรงไหนจริง ๆ แทนข้อความเหมารวมว่า "ไม่มีแหล่งข่าว"
  const rawTrends = Array.isArray(parsed.trends) ? parsed.trends : [];
  const named = rawTrends.filter((x) => x?.trend);
  const withSources = named.filter((x) => Array.isArray(x.sources) && x.sources.length);
  const pool = withSources.filter((x) => x.sources.filter((s) => safeHttpUrl(s?.url)).length >= 1).slice(0, 8);
  if (pool.length) return { data: pool };

  return {
    error: !rawTrends.length
      ? `คำตอบไม่มีรายการ trends เลย ${answerEvidence(raw, parsed)}`
      : !named.length
        ? `มี ${rawTrends.length} รายการ แต่ไม่มีรายการไหนใส่ชื่อกระแส (field "trend")`
        : !withSources.length
          ? `มี ${named.length} กระแส แต่ไม่มีรายการไหนแนบ sources มาเลย`
          : `มี ${withSources.length} กระแสที่แนบ sources แต่ URL ทุกอันอ่านเป็นลิงก์จริงไม่ได้ (ตัวอย่าง: ${String(withSources[0].sources?.[0]?.url || '-').slice(0, 120)})`,
  };
}

async function generateTrendIdeas() {
  const button = $('trendRandom');
  const box = $('trendIdeas');
  button.disabled = true;
  trendSeed = null;
  trendPool = [];
  setMode('สุ่มข่าว · ค้นกระแส', { busy: true });
  resetOutlineDirection();
  box.classList.remove('hidden');
  box.textContent = 'กำลังให้ ChatGPT ค้นเว็บเพื่อดูว่าตอนนี้อะไรเป็นกระแส...';
  status('กำลังค้นกระแสปัจจุบัน');
  await saveCreatorDefaults();
  await focusChat();
  try {
    const transport = makeTransport(transportKind(), transportOpts());
    const res = await sendTurn(
      transport,
      trendIdeasPrompt({
        seed: $('title').value.trim(),
        audience: $('audience').value.trim(),
        tone: $('tone').value.trim(),
        language: val('lang', 'th'),
        contentMode: val('contentMode', 'prose'),
        fictionGenre: val('fictionGenre', 'fantasy'),
        today: new Date().toISOString().slice(0, 10),
      }),
      { label: 'ค้นกระแสปัจจุบัน' },
      { onRetry: (n, max, res) => retryNotice(box, n, max, 'ค้นกระแสปัจจุบัน', res), parse: parseTrendAnswer },
    );
    if (res?.error) throw new Error(res.error);
    trendPool = res.data;
    renderRandomTrend();
    status('สุ่มกระแสแล้ว — เลือกใช้หรือสุ่มอีกเรื่อง');
  } catch (e) {
    box.innerHTML = `<b>ค้นกระแสไม่สำเร็จ</b><div class="muted">${esc(e?.message || e)}<br>ระบบไม่สร้างหัวข้อจากคำว่า “กำลังเป็นกระแส” ถ้ายังไม่มีแหล่งยืนยัน — ปุ่ม “ค้นกระแสใหม่” ลองใหม่ได้ทันที</div>`;
    status('ค้นกระแสไม่สำเร็จ');
  } finally {
    button.disabled = false;
  }
}

async function generateOutlineDirections() {
  const title = $('title').value.trim();
  if (!title) return $('title').focus();
  const button = $('outlineIdeate');
  const box = $('outlineDirections');
  button.disabled = true;
  outlineDirection = null;
  setBtn('create', 'rocket', 'เริ่มสร้าง Ebook');
  box.classList.remove('hidden');
  box.dataset.ready = '0';
  setMode('เสนอสารบัญ', { busy: true });
  box.textContent = 'กำลังให้ ChatGPT วางสารบัญหลายทาง เพื่อให้เลือกทิศทางก่อนเขียนจริง...';
  status('กำลังเสนอสารบัญ 3 ทาง');
  await focusChat();
  try {
    const contentMode = val('contentMode', 'prose');
    const fictionGenre = val('fictionGenre', 'fantasy');
    const genre = contentMode === 'fiction' ? fictionGenre : val('genre', 'how-to');
    const res = await sendTurn(
      makeTransport(transportKind(), transportOpts()),
      outlineDirectionsPrompt({
        title,
        audience: $('audience').value.trim(),
        tone: $('tone').value.trim(),
        language: val('lang', 'th'),
        contentMode,
        fictionGenre,
        targetPages: Math.max(5, Number($('pages').value) || 120),
        genreBrief: contentMode === 'fiction' ? FICTION_GENRE_LABEL[fictionGenre] : GENRE_LABEL[genre],
        trendSeed,
      }),
      { label: 'เสนอสารบัญหลายทาง' },
      {
        onRetry: (n, max, res) => retryNotice(box, n, max, 'เสนอสารบัญ', res),
        parse: (r) => parseDirections(r),
      },
    );
    if (res?.error) throw new Error(res.error);
    renderOutlineChoices(res.data, { title, origin: 'auto' });
    setMode(currentMode);
    status('รอเลือกทิศทางสารบัญ');
  } catch (e) {
    box.innerHTML = `<b>สร้างตัวเลือกสารบัญไม่สำเร็จ</b><div class="muted">${esc(e?.message || e)}</div>`;
    status('สร้างตัวเลือกสารบัญไม่สำเร็จ');
  } finally {
    button.disabled = false;
  }
}

/** ตรวจคำตอบชุดสารบัญให้เป็นรูปเดียวกัน ใช้ร่วมกันทั้งโหมดคิดเองและโหมดแรงบันดาลใจ */
function parseDirections(r) {
  const parsed = parseJson(r.text);
  const list = (parsed?.directions || [])
    .filter((d) => d?.name && Array.isArray(d.chapters) && d.chapters.length)
    .slice(0, 4);
  return list.length
    ? { data: list }
    : { error: `ไม่พบสารบัญที่เลือกได้ในคำตอบ ${answerEvidence(r.text, parsed)}` };
}

/**
 * วาดการ์ดตัวเลือกสารบัญ — ใช้ร่วมกันทั้งสองโหมด
 *
 * โหมดแรงบันดาลใจต้องโชว์เพิ่มสองอย่างที่โหมดปกติไม่มี คือ "แก้อะไรจากของเดิมบ้าง"
 * และ "จำนวนบทเทียบกับจำนวนหน้า" เพราะผู้ใช้ต้องตัดสินใจว่ายอมให้แก้โครงตัวเองแค่ไหน
 * ถ้าไม่บอก ผู้ใช้ต้องนั่งไล่เทียบทีละบทเองว่าโมเดลไปแตะอะไรมา
 */
function renderOutlineChoices(directions, { title, origin = 'auto' }) {
  const box = $('outlineDirections');
  outlineOrigin = origin;
  const head =
    origin === 'inspire'
      ? `<b>ChatGPT ตกแต่งสารบัญของคุณมาให้ ${directions.length} ทาง</b><div class="muted">ทาง A คือโครงเดิมของคุณ แก้แค่ถ้อยคำ · ถ้ายังไม่พอใจ กด “ตกแต่งใหม่อีกรอบ” ได้เรื่อย ๆ หรือกลับไปแก้สารบัญของคุณเองแล้วส่งใหม่</div>`
      : '<b>เลือกว่าหนังสือจะไปทางไหน</b><div class="muted">เลือก 1 ทางก่อน ระบบจึงค่อยแตกเป็นตอนย่อยและเริ่มเขียนจริง</div>';

  box.innerHTML = head + '<div class="outlineChoiceList">' +
    directions.map((d, i) => `<div class="outlineChoice" data-outline-card="${i}">
      <h3>${esc(d.id || String.fromCharCode(65 + i))}. ${esc(d.name)}</h3>
      <p><b>คำสัญญาของทางนี้:</b> ${esc(d.promise || d.premise || '-')}</p>
      <p>${esc(d.why_choose || '')}</p>
      ${d.changes ? `<p class="outlineChanged"><b>แก้จากของคุณ:</b> ${esc(d.changes)}</p>` : ''}
      ${d.fit_note ? `<p class="muted">ความยาว: ${esc(d.fit_note)}</p>` : ''}
      <ol>${d.chapters.map((c) => `<li><b>${esc(c.title)}</b>${c.added ? ' <span class="tagAdded">บทที่เติมให้</span>' : ''}${c.purpose ? ` — ${esc(c.purpose)}` : ''}</li>`).join('')}</ol>
      <div class="trendActions"><button type="button" data-outline-index="${i}" class="primary inline">เลือกสารบัญทางนี้</button></div>
    </div>`).join('') + '</div>' +
    (origin === 'inspire'
      ? '<div class="trendActions"><button type="button" id="inspireAgain" class="inline">🎨 ตกแต่งใหม่อีกรอบ</button></div>'
      : '');

  box.dataset.ready = '1';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-outline-index]').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.outlineIndex);
      outlineDirection = {
        ...structuredClone(directions[i]),
        titleBase: title,
        origin,
        selectedAt: Date.now(),
      };
      box.querySelectorAll('.outlineChoice').forEach((card) => card.classList.remove('selected'));
      box.querySelector(`[data-outline-card="${i}"]`)?.classList.add('selected');
      setBtn('create', 'rocket', 'สร้าง Ebook ตามสารบัญที่เลือก');
      renderStepGuide();
      status(`เลือกสารบัญ: ${outlineDirection.name}`);
    };
  });
  const again = box.querySelector('#inspireAgain');
  if (again) again.onclick = () => polishUserOutline();
  renderStepGuide();
}

/**
 * อ่านสารบัญที่ผู้ใช้พิมพ์มาเอง
 *
 * รับได้ทั้ง "1. ชื่อบท", "- ชื่อบท", "บทที่ 1 ชื่อบท" หรือชื่อบทเปล่า ๆ บรรทัดละบท
 * และคั่นคำอธิบายด้วย em dash, ยัติภังค์ หรือทวิภาคก็ได้ เพราะคนส่วนใหญ่ก๊อปมาจากที่จดไว้
 * ถ้าบังคับรูปแบบเดียว จะกลายเป็นด่านที่ทำให้เลิกใช้โหมดนี้ตั้งแต่บรรทัดแรก
 */
function parseUserOutline(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[-=_*·]{3,}$/.test(line))
    .map((line, i) => {
      const body = line
        .replace(/^(?:บทที่|ตอนที่|chapter|part)\s*\d+\s*[.):\-]?\s*/i, '')
        .replace(/^\d+(?:\.\d+)*\s*[.)]?\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .trim();
      const m = body.match(/^(.+?)\s*(?:—|–|\s-\s|:)\s*(.+)$/);
      return m
        ? { n: i + 1, title: m[1].trim(), purpose: m[2].trim() }
        : { n: i + 1, title: body, purpose: '' };
    })
    .filter((c) => c.title);
}

/** โหมดแรงบันดาลใจ — ส่งสารบัญที่ผู้ใช้เขียนเองไปให้ ChatGPT ตกแต่งเป็นตัวเลือก */
async function polishUserOutline() {
  const title = $('title').value.trim();
  if (!title) {
    status('ใส่ชื่อเรื่องก่อน แล้วจึงส่งสารบัญไปตกแต่ง');
    return $('title').focus();
  }
  const userOutline = parseUserOutline($('inspireOutline').value);
  if (userOutline.length < 2) {
    status('พิมพ์สารบัญของคุณอย่างน้อย 2 บรรทัด (บรรทัดละบท) ก่อนส่งไปตกแต่ง');
    return $('inspireOutline').focus();
  }

  const button = $('inspirePolish');
  const box = $('outlineDirections');
  button.disabled = true;
  outlineDirection = null;
  setBtn('create', 'rocket', 'เริ่มสร้าง Ebook');
  box.classList.remove('hidden', 'stale');
  box.querySelector('[data-outline-stale]')?.remove();
  box.dataset.ready = '0';
  inspirePolishRound += 1;
  setMode('ตกแต่งสารบัญของผู้ใช้', { busy: true });
  box.textContent = `กำลังให้ ChatGPT ตกแต่งสารบัญ ${userOutline.length} บทของคุณ (รอบที่ ${inspirePolishRound})...`;
  status('กำลังตกแต่งสารบัญที่คุณเขียนเอง');
  await saveCreatorDefaults();
  await focusChat();
  try {
    const contentMode = val('contentMode', 'prose');
    const fictionGenre = val('fictionGenre', 'fantasy');
    const genre = contentMode === 'fiction' ? fictionGenre : val('genre', 'how-to');
    const res = await sendTurn(
      makeTransport(transportKind(), transportOpts()),
      outlinePolishPrompt({
        title,
        userOutline,
        userNote: $('inspireNote').value.trim(),
        audience: $('audience').value.trim(),
        tone: $('tone').value.trim(),
        language: val('lang', 'th'),
        contentMode,
        fictionGenre,
        targetPages: Math.max(5, Number($('pages').value) || 120),
        genreBrief: contentMode === 'fiction' ? FICTION_GENRE_LABEL[fictionGenre] : GENRE_LABEL[genre],
        round: inspirePolishRound,
      }),
      { label: 'ตกแต่งสารบัญของผู้ใช้' },
      {
        onRetry: (n, max, res) => retryNotice(box, n, max, 'ตกแต่งสารบัญ', res),
        parse: (r) => parseDirections(r),
      },
    );
    if (res?.error) throw new Error(res.error);
    renderOutlineChoices(res.data, { title, origin: 'inspire' });
    setMode(currentMode);
    status('ตกแต่งสารบัญแล้ว — เลือก 1 ทาง หรือกดตกแต่งใหม่');
  } catch (e) {
    box.innerHTML = `<b>ตกแต่งสารบัญไม่สำเร็จ</b><div class="muted">${esc(e?.message || e)}</div>`;
    status('ตกแต่งสารบัญไม่สำเร็จ');
  } finally {
    button.disabled = false;
  }
}

async function generateTitleIdeas() {
  const button = $('titleIdeate');
  const box = $('titleIdeas');
  button.disabled = true;
  box.classList.remove('hidden');
  setMode('ให้ ChatGPT คิดชื่อ', { busy: true });
  box.textContent = 'กำลังให้ ChatGPT คิดชื่อหนังสือ...';
  status('กำลังคิดชื่อหนังสือ');
  await saveCreatorDefaults();
  await focusChat();
  try {
    const transport = makeTransport(transportKind(), transportOpts());
    const res = await sendTurn(
      transport,
      titleIdeasPrompt({
        topic: $('title').value.trim(),
        audience: $('audience').value.trim(),
        tone: $('tone').value.trim(),
        language: val('lang', 'th'),
        contentMode: val('contentMode', 'prose'),
        fictionGenre: val('fictionGenre', 'fantasy'),
        trendSeed,
      }),
      { label: 'คิดชื่อหนังสือ' },
      {
        onRetry: (n, max, res) => retryNotice(box, n, max, 'คิดชื่อหนังสือ', res),
        parse: (r) => {
          const parsed = parseJson(r.text);
          const list = (parsed?.titles || [])
            .map((x) => (typeof x === 'string' ? { title: x } : x))
            .filter((x) => x?.title)
            .slice(0, 12);
          return list.length
            ? { data: list }
            : { error: `ไม่พบรายการชื่อในคำตอบ ${answerEvidence(r.text, parsed)}` };
        },
      },
    );
    if (res?.error) throw new Error(res.error);
    const ideas = res.data;
    box.innerHTML =
      '<b>เลือกชื่อที่ต้องการ</b><div class="titleIdeaList">' +
      ideas
        .map(
          (x) =>
            `<button type="button" data-book-title="${esc(x.title)}"><b>${esc(x.title)}</b>` +
            `${x.subtitle ? `<span>${esc(x.subtitle)}</span>` : ''}` +
            `${x.angle ? `<small>${esc(x.angle)}</small>` : ''}</button>`,
        )
        .join('') +
      '</div>';
    box.querySelectorAll('[data-book-title]').forEach((choice) => {
      choice.onclick = async () => {
        $('title').value = choice.dataset.bookTitle;
        box.classList.add('hidden');
        resetOutlineDirection();
        status('เลือกชื่อแล้ว — ต่อไปเลือกทิศทางสารบัญ');
        await generateOutlineDirections();
      };
    });
    setMode(currentMode);
    status('รอเลือกชื่อหนังสือ');
  } catch (e) {
    box.textContent = 'คิดชื่อไม่สำเร็จ: ' + (e?.message || e);
    status('คิดชื่อไม่สำเร็จ');
  } finally {
    button.disabled = false;
  }
}

// ---------- สร้างงานใหม่ ----------
const MARGIN_PRESETS = {
  tight: { inner: 16, outer: 13, top: 17, bottom: 19 },
  normal: { inner: 18, outer: 15, top: 20, bottom: 22 },
  airy: { inner: 22, outer: 18, top: 24, bottom: 26 },
};

const GENRE_LABEL = {
  'how-to': 'คู่มือลงมือทำ เน้นขั้นตอนที่ทำตามได้จริง',
  explainer: 'อธิบายเรื่องยากให้เข้าใจ เน้นอุปมาและตัวอย่าง',
  case: 'เล่าเรื่องและกรณีศึกษา เปิดด้วยเคสจริงเสมอ',
  self: 'พัฒนาตัวเอง เน้นเปลี่ยนพฤติกรรมทีละขั้น',
  textbook: 'ตำราวิชาการ มีนิยามชัดและอ้างอิงที่มา',
  workbook: 'เวิร์กบุ๊ก มีแบบฝึกและช่องให้เขียนท้ายตอน',
  business: 'ธุรกิจและการตลาด เน้นตัวเลขและการตัดสินใจ',
};

const FICTION_GENRE_LABEL = {
  romance: 'นิยายโรแมนติก เน้นแรงดึงดูด ความสัมพันธ์ และการเปลี่ยนแปลงทางอารมณ์',
  fantasy: 'นิยายแฟนตาซี มีกฎของโลกชัด พลังหรือเวทมนตร์มีข้อจำกัดและผลตามมา',
  scifi: 'นิยายไซไฟ ให้เทคโนโลยีหรือวิทยาศาสตร์ขับความขัดแย้งโดยมีกติกาสม่ำเสมอ',
  mystery: 'นิยายสืบสวน วางเบาะแสอย่างยุติธรรม มีคำตอบที่ย้อนตรวจได้',
  thriller: 'นิยายทริลเลอร์ เดิมพันสูง จังหวะเร่ง และแรงกดดันเพิ่มต่อเนื่อง',
  horror: 'นิยายสยองขวัญ สร้างความไม่สบายใจจากบรรยากาศ สิ่งที่ไม่รู้ และผลกระทบต่อคน',
  drama: 'นิยายดราม่า เน้นการตัดสินใจ ความสัมพันธ์ และผลของการกระทำ',
  adventure: 'นิยายผจญภัย เป้าหมายชัด อุปสรรคต่อเนื่อง และสถานที่มีบทบาทกับเรื่อง',
  comingofage: 'นิยายเติบโต เน้นการเปลี่ยนมุมมองและตัวตนของตัวละครหลัก',
  literary: 'วรรณกรรมร่วมสมัย เน้นภาษา ชั้นเชิง ตัวละคร และธีมโดยไม่เสียแรงขับของเรื่อง',
};

const DEPTH_LABEL = {
  beginner: 'ผู้อ่านเริ่มจากศูนย์ อธิบายทุกศัพท์ ห้ามข้ามขั้น',
  mixed: 'ผู้อ่านมีพื้นบ้าง ผสมพื้นฐานกับเนื้อหาลึก',
  advanced: 'ผู้อ่านมีพื้นแล้ว ข้ามพื้นฐาน ลงลึกได้เลย',
};

// ค่าว่างต้องตกไปใช้ค่าตั้งต้นด้วย ไม่ใช่เฉพาะตอนหา element ไม่เจอ
// ไม่งั้นค่าว่างจะไหลไปเป็นคีย์ของตารางค่าคงที่ แล้วโยน TypeError ที่ระดับบนสุดของโมดูล
// ซึ่งทำให้การผูกปุ่มทั้งหน้าหยุดกลางคัน = กดอะไรก็เงียบทั้งหน้า
const val = (id, d = '') => $(id)?.value || d;
const on = (id) => !!$(id)?.checked;

/**
 * ช่องภาพที่เลือกให้แนบรูปผู้เขียนไปด้วย
 *
 * เก็บเป็นรายการคีย์ ไม่ใช่ธงจริง/เท็จสามตัว เพราะฝั่งเครื่องต้องถามว่า
 * "งานภาพชิ้นนี้ต้องแนบไหม" ไม่ใช่ "ปกหน้าเปิดอยู่ไหม" — และรายการช่องจะยาวขึ้นได้อีก
 */
/**
 * เล่มนี้ต้องมีไฟล์ author-photo.png ไหม
 *
 * เดิมมีเหตุผลเดียวคือเอาไปแปะปกหลัง ตอนนี้มีเหตุผลที่สองคือแนบไปให้โมเดลดู
 * ทุกที่ที่เคยถามว่า "authorPhotoOnCover ไหม" ต้องถามคำถามนี้แทน
 * ไม่งั้นช่องอัปโหลดจะไม่โผล่ให้คนที่เลือกแนบอย่างเดียว
 */
const needsAuthorPhoto = (b) => !!b?.authorPhotoOnCover || !!authorRefSummary(b);

const pickedAuthorRefTargets = () =>
  [
    on('authorRefFront') && 'cover-front',
    on('authorRefBack') && 'cover-back',
    on('authorRefFigures') && 'figures',
  ].filter(Boolean);

async function saveCreatorDefaults() {
  await Promise.all([
    db.setting('defaultAudience', $('audience').value.trim()),
    db.setting('defaultAuthor', $('author').value.trim()),
    // สารบัญที่ผู้ใช้พิมพ์เองคืองานที่ลงแรงจริง ห้ามหายเพราะปิดแท็บหรือรีโหลด
    db.setting('draftUserOutline', $('inspireOutline')?.value || ''),
  ]);
}

async function loadCreatorDefaults() {
  const [audience, author, draftOutline, imageSource, apiKey, apiQuality, apiModel, textSource, textModel, priceOverride] =
    await Promise.all([
      db.setting('defaultAudience'),
      db.setting('defaultAuthor'),
      db.setting('draftUserOutline'),
      db.setting('imageSource'),
      db.setting('openaiApiKey'),
      db.setting('imageApiQuality'),
      db.setting('imageApiModel'),
      db.setting('textSource'),
      db.setting('textApiModel'),
      db.setting('priceOverride'),
    ]);
  if (imageSource) $('imageSource').value = imageSource;
  if (textSource) $('textSource').value = textSource;
  renderModelOptions();
  if (textModel) $('textApiModel').value = textModel;
  if (priceOverride?.in > 0) {
    customPrice = { in: priceOverride.in, out: priceOverride.out };
    usdThb = Number(priceOverride.usdThb) || 36;
    $('priceIn').value = priceOverride.in;
    $('priceOut').value = priceOverride.out;
    $('usdThb').value = usdThb;
  }
  apiKeyValue = apiKey || '';
  if (apiKey) {
    $('openaiApiKey').value = apiKey;
    $('apiKeyNote').textContent = `✓ ใช้คีย์ที่บันทึกไว้ (${apiKey.length > 12 ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}` : 'บันทึกแล้ว'})`;
  }
  if (apiQuality) $('imageApiQuality').value = apiQuality;
  if (apiModel) $('imageApiModel').value = apiModel;
  syncApiSources();
  if (!$('audience').value.trim() && audience) $('audience').value = audience;
  if (!$('author').value.trim() && author) $('author').value = author;
  if (draftOutline && $('inspireOutline') && !$('inspireOutline').value.trim()) {
    $('inspireOutline').value = draftOutline;
    $('inspireBox')?.setAttribute('open', '');
  }
}

function readForm() {
  const presetKey = val('trim', 'a5');
  const p = TRIM_PRESETS[presetKey];
  const lang = val('lang', 'th');
  const topic = $('title').value.trim();
  const contentMode = val('contentMode', 'prose');
  const fictionGenre = val('fictionGenre', 'fantasy');
  const genre = contentMode === 'fiction' ? fictionGenre : val('genre', 'how-to');
  const secLen = val('secLen', 'auto');
  const targetPages = Math.max(5, Number($('pages').value) || 120);

  const frontMatter = ['title'];
  if (on('fm_copyright')) frontMatter.push('copyright');
  if (on('fm_toc')) frontMatter.push('toc');
  if (on('fm_foreword')) frontMatter.push('foreword');

  const backMatter = [];
  if (on('bm_glossary')) backMatter.push('glossary');
  if (on('bm_references')) backMatter.push('references');
  if (trendSeed?.sources?.length && !backMatter.includes('references')) backMatter.push('references');
  if (on('bm_about')) backMatter.push('about_author');

  // ความยาวตอนคุมจำนวนตอน และคุมว่ากี่ตอนจะรวมได้ในหนึ่งข้อความ
  const capByLen = { short: 5000, auto: 6000, long: 7500 }[secLen];

  // ถ้าเลือกให้ระบบสร้างภาพอัตโนมัติ แต่ dropdown ความหนาแน่นยังเป็น "ไม่มี"
  // ถือว่าเจตนาคืออยากได้ภาพจริง จึงใช้ระดับพอดีแทน ไม่ปล่อยให้ Phase 2 มีแต่ปก
  const selectedFigureMode = val('figureMode', 'prompt');
  const selectedIllustrationLevel = val('illus', 'none');
  const illustrationLevel = selectedFigureMode === 'auto' && selectedIllustrationLevel === 'none'
    ? 'light'
    : selectedIllustrationLevel;

  return {
    id: crypto.randomUUID(),
    topic,
    title: topic,
    audience: $('audience').value.trim() || 'ผู้อ่านทั่วไปที่สนใจเรื่องนี้',
    tone: $('tone').value.trim() || 'เป็นกันเอง ตรงไปตรงมา',
    author: $('author').value.trim(),
    language: lang,
    genre,
    researchMode: trendSeed?.trend ? 'trend' : 'standard',
    trendSeed: trendSeed ? structuredClone(trendSeed) : null,
    outlineDirection: outlineDirection ? structuredClone(outlineDirection) : null,
    // โหมดแรงบันดาลใจ: เก็บของต้นฉบับที่ผู้ใช้เขียนไว้ด้วย ไม่ใช่เก็บแค่ฉบับที่โมเดลตกแต่งแล้ว
    // ขั้นวางสารบัญจริงจะได้รู้ว่าบทไหนเป็นของผู้ใช้เอง และห้ามหายไประหว่างแตกตอนย่อย
    outlineSource: outlineDirection?.origin === 'inspire' ? 'user' : 'auto',
    userOutline: outlineDirection?.origin === 'inspire' ? parseUserOutline($('inspireOutline').value) : null,
    genreBrief: contentMode === 'fiction' ? FICTION_GENRE_LABEL[fictionGenre] : GENRE_LABEL[genre],
    depthBrief: contentMode === 'fiction' ? '' : DEPTH_LABEL[val('depth', 'mixed')],
    fictionGenre,
    fictionPov: val('fictionPov', 'third-limited'),
    fictionEnding: val('fictionEnding', 'auto'),
    fictionRomance: val('fictionRomance', 'subplot'),
    sectionLength: secLen,
    targetPages,
    pageTolerance: 2,
    illustrationLevel,
    figureStyle: val('figureStyle', 'box'),
    figureMode: selectedFigureMode,
    coverMode: val('coverMode', 'prompt'),
    coverTextMode: val('coverTextMode', 'baked'),
    figureColor: val('figureColor', 'color'),
    testMode: on('testMode'),
    authorVoice: val('authorVoice', 'auto'),
    authorVoiceText: val('authorVoiceText', '').trim(),
    authorPhotoOnCover: on('authorPhotoCover'),
    authorRefTargets: pickedAuthorRefTargets(),
    frontMatter,
    backMatter,
    paper: val('paper', 'white'),
    trim: { preset: presetKey, widthMm: p.w, heightMm: p.h, bleedMm: 3 },
    typography: {
      standardVersion: 2,
      bodyFont: val('bodyFont', 'Sarabun'),
      headFont: val('headFont', 'IBM Plex Sans Thai'),
      sizePt: Number(val('sizePt')) || (lang === 'th' ? 14 : 11),
      lineHeight: Number(val('lineHeight')) || (lang === 'th' ? 1.55 : 1.45),
      // ไทยไม่มียัติภังค์ การจัดชิดขอบสองข้างจะเกิดช่องว่างพาดกลางหน้า
      justify: val('justify', 'off') === 'on',
      marginsMm: MARGIN_PRESETS[val('margins', 'normal')],
    },
    contentMode,
    pagePattern: val('pagePattern', 'none'),
    // ภาพเลือกแหล่งได้ ส่วนเนื้อหายังใช้หน้าเว็บเสมอ
    imageSource: val('imageSource', 'web'),
    imageApiQuality: val('imageApiQuality', 'medium'),
    imageApiModel: val('imageApiModel', DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL,
    itemKind: val('itemKind', 'quote'),
    itemsPerPage: Number(val('itemsPerPage')) || 1,
    itemAlign: val('itemAlign', 'center'),
    itemAttribution: val('itemAttribution', 'off') === 'on',
    itemSizePt: Number(val('itemSizePt')) || 26,
    themeCount: Number(val('themeCount')) || 5,
    // ประวัติผู้เขียนมาจากผู้ใช้เท่านั้น ระบบไม่แต่งเอง
    aboutAuthor: $('aboutAuthor').value.trim(),
    calibration: { charsPerPage: p.seedCPP },
    transport: { delayMs: [4000, 9000] },
    threadMode: val('threadMode', 'single'),
    writeMode: val('writeMode', 'section'),
    maxCharsPerTurn: capByLen,
    runConsistency: on('opt_consistency'),
    pageMode: val('pageMode', 'soft'),
    /**
     * เล่มหนึ่งต้องเขียนด้วยเครื่องยนต์เดียวตลอด
     *
     * ตัวเลือกแหล่งเขียนเป็นค่าของโปรแกรม ไม่ใช่ของเล่ม ถ้าอ่านจากหน้าจอตอนทำงาน
     * เล่มที่เขียนค้างไว้ด้วย API แล้วกลับมาทำต่อวันหลังตอนสลับเป็นหน้าเว็บ
     * จะถูกเขียนต่อด้วยคนละโมเดล ได้สำนวนคนละแบบกลางเล่มโดยไม่มีใครทัก
     * จึงล็อกไว้กับเล่มตั้งแต่วันที่สร้าง เหมือนที่ทำกับโหมดทดสอบ
     */
    textSource: val('textSource', 'web'),
    textApiModel: textApiModel(),
    job: { step: 'health', cursor: 0, round: 0, status: 'idle' },
  };
}

/** บอกราคาเป็นจำนวนข้อความก่อนเริ่ม ไม่ใช่ให้รู้ตอนโควตาหมด */
function updateEstimate() {
  const p = TRIM_PRESETS[val('trim', 'a5')] || TRIM_PRESETS.a5;
  const draft = {
    targetPages: Number($('pages').value) || 120,
    trim: { preset: val('trim', 'a5') },
    calibration: { charsPerPage: p.seedCPP },
    frontMatter: ['title', 'copyright', 'toc'],
    backMatter: [],
    maxCharsPerTurn: { short: 5000, auto: 6000, long: 7500 }[val('secLen', 'auto')],
    runConsistency: on('opt_consistency'),
    pageMode: val('pageMode', 'soft'),
  };
  const perSection = val('writeMode', 'section') === 'section';
  if (perSection) draft.maxCharsPerTurn = 1; // เขียนทีละตอน จำนวนข้อความ = จำนวนตอน

  const e = estimateTurns(draft);
  currentEstimate = e;
  /**
   * ทาง API ไม่ต้องหน่วงระหว่างเทิร์นและตอบเร็วกว่าการรอหน้าเว็บพิมพ์ทีละตัวอักษร
   * เวลาที่ประเมินจึงต้องต่างกัน ไม่ใช่บอกตัวเลขเดียวแล้วให้ผู้ใช้ไปเจอเองว่าไม่ตรง
   */
  const viaApi = val('textSource', 'web') === 'api';
  const secPerTurn = viaApi ? 30 : 70;
  const mins = Math.round((e.likely * secPerTurn) / 60);

  $('estimate').className = 'estimate';
  $('estimate').innerHTML =
    `คาดว่าจะใช้ราว <span class="big">${e.likely}</span> ${viaApi ? 'เทิร์น API' : 'ข้อความ ChatGPT'} ` +
    `<b>(อย่างน้อย ${e.min} · มากสุด ${e.max})</b><br>` +
    `ราว ${e.chapters} บท · เขียน ${e.batches} ${viaApi ? 'เทิร์น' : 'ข้อความ'}${perSection ? ' (ทีละตอน)' : ' (รวมหลายตอนต่อข้อความ)'} · เนื้อหา ${e.budget.toLocaleString()} อักษร<br>` +
    `ใช้เวลาเดินเครื่องราว ${mins} นาที ระบบจะเดินต่อจนจบเนื้อหา` +
    (viaApi
      ? `<br>ทาง API ไม่มีลิมิตข้อความรายสามชั่วโมง แต่คิดเงินตาม token ที่ใช้จริง`
      : '');
  renderTextPrice();
}

/**
 * โหมดทดสอบใช้ transport ปลอมซึ่งตอบทันทีโดยไม่ยิง ChatGPT
 * มีไว้ไล่ดูว่าทุกขั้นตอนต่อกันครบไหมภายในไม่กี่วินาที แทนการรอของจริงเป็นชั่วโมง
 */
const testing = () => (book ? !!book.testMode : on('testMode'));
/**
 * เครื่องยนต์การเขียนมีสองบริบท และเอามาปนกันไม่ได้
 *
 *   งานของ "เล่มที่กำลังทำ"  → ใช้ค่าที่ล็อกไว้กับเล่มนั้น ห้ามสลับกลางเล่ม
 *   งานบนหน้าเริ่มต้น         → ใช้ค่าที่ผู้ใช้เพิ่งเลือกไว้บนหน้าจอ
 *
 * ที่ต้องแยกเพราะหน้าเริ่มต้นมักมี "เล่มค้าง" ถูกโหลดไว้ในหน่วยความจำอยู่แล้ว
 * ถ้าอ่านจากเล่มเสมอ ผู้ใช้ที่สลับเป็น API แล้วกดปุ่มคิดชื่อ/เสนอสารบัญ
 * จะถูกพาไปหน้าเว็บตามค่าของเล่มเก่าที่ไม่เกี่ยวอะไรกับสิ่งที่เขากำลังจะทำเลย
 */
const bookUsesApi = (b) => (b?.textSource || 'web') === 'api';
/**
 * งานภาพของเล่มนี้ต้องใช้แท็บ ChatGPT หรือไม่ — คนละเรื่องกับเครื่องยนต์เขียนข้อความ
 * เล่มที่เขียนด้วย API แต่วาดภาพในแท็บ ยังต้องเรียกแท็บขึ้นมาตอน Phase 2 อยู่ดี
 */
const bookDrawsInTab = (b) =>
  (b?.imageSource || 'web') !== 'api' && !['none', 'upload'].includes(b?.coverMode || 'prompt');
const uiUsesApi = () => val('textSource', 'web') === 'api';
const useTextApi = (forBook = null) => !testing() && (forBook ? bookUsesApi(forBook) : uiUsesApi());
const transportKind = (forBook = null) =>
  testing() ? 'fake' : useTextApi(forBook) ? 'openai_api' : 'chatgpt_tab';

/**
 * ตัวเลือกที่ transport ต้องใช้ รวมไว้ที่เดียว
 *
 * ทุกจุดในหน้านี้สร้าง transport ด้วยมือของตัวเอง (มีสิบกว่าจุด) ถ้าปล่อยให้แต่ละจุด
 * ประกอบคีย์กับชื่อโมเดลเอง จะมีจุดที่ลืมส่งเสมอ แล้วโหมด API จะพังเป็นบางปุ่ม
 * ซึ่งเป็นอาการที่หาสาเหตุยากที่สุดแบบหนึ่ง
 */
const transportOpts = (extra = {}, forBook = null) => ({
  timeoutMs: 300000,
  onProgress: handleGptMessage,
  latencyMs: 60,
  apiKey: apiKeyValue,
  model: forBook?.textApiModel || textApiModel(),
  ...extra,
});

/** โหมดทดสอบไม่ต้องไปยุ่งกับแท็บ ChatGPT เลย */
const focusChat = async (forBook = null) => {
  // ทาง API ไม่มีแท็บ ChatGPT ให้ต้องเรียกขึ้นมา การสลับหน้าต่างตอนนั้นมีแต่จะรบกวนคนใช้งาน
  if (testing() || useTextApi(forBook)) return;
  await chrome.runtime.sendMessage({ type: 'sw.focusChat' }).catch(() => {});
};

/**
 * ยอดที่จ่ายไปแล้วของเล่มนี้ คิดจาก token จริงที่สะสมไว้ใน book.apiUsage
 * ไม่ใช่การประเมิน จึงเป็นตัวเลขที่เอาไปตั้งราคาขายหนังสือได้จริง
 */
function showRunningCost() {
  const u = book?.apiUsage;
  const el = $('runningCost');
  if (!el) return;
  /**
   * เล่มที่เขียนด้วยหน้าเว็บไม่มีค่าใช้จ่ายให้แสดง แต่ยังต้องบอกว่ากำลังใช้ทางไหนอยู่
   * ไม่งั้นผู้ใช้ที่ตั้งค่าบนหน้าจอเป็น API แล้วเห็นระบบเปิดแท็บ ChatGPT
   * จะไม่มีทางรู้เลยว่าเป็นเพราะเล่มนี้ถูกล็อกไว้เป็นหน้าเว็บตั้งแต่วันที่สร้าง
   */
  if (book && !bookUsesApi(book)) {
    el.classList.remove('hidden');
    el.textContent = 'เขียนด้วยหน้าเว็บ ChatGPT — ใช้โควตาข้อความของแพ็กเกจ ไม่มีค่าใช้จ่ายเป็นเงิน';
    return;
  }
  if (!u?.turns) {
    el.classList.remove('hidden');
    el.textContent = `เขียนด้วย OpenAI API · ${book?.textApiModel || textApiModel()} — ยังไม่มีเทิร์นที่คิดเงิน`;
    return;
  }
  const price = priceFor(u.model || textApiModel(), customPrice);
  const usd = costOf({ promptTokens: u.promptTokens, completionTokens: u.completionTokens, price }) || 0;
  // ค่าภาพที่จ่ายไปแล้วต้องรวมอยู่ในยอดเดียวกัน ไม่งั้นตัวเลขนี้บอกความจริงแค่ครึ่งเดียว
  const im = u.image;
  const imgUsd = im ? costOfImages({ inputTokens: im.inputTokens, outputTokens: im.outputTokens, model: im.model }) : 0;
  el.classList.remove('hidden');
  el.textContent =
    `เขียนด้วย OpenAI API · ${u.model || book?.textApiModel || textApiModel()} — ${u.turns} เทิร์น · ${formatCost(usd, usdThb)}` +
    (im?.images ? ` · ภาพ ${im.images} รูป ${formatCost(imgUsd, usdThb)}` : '') +
    ` · รวมเล่มนี้ ${formatCost(usd + imgUsd, usdThb)}` +
    (u.charsPerToken ? ` · ไทย ${u.charsPerToken} ตัวอักษรต่อ token` : '');
}

function makeMachine() {
  const transport = makeTransport(transportKind(book), transportOpts({}, book));
  /**
   * สายสำหรับเทิร์นสร้างภาพ แยกจากสายเขียนข้อความเสมอ
   *
   * ภาพที่ให้ ChatGPT วาดในแท็บ ต้องออกทางแท็บ ไม่ว่าเนื้อหาจะเขียนด้วยทางไหน
   * (โหมดภาพแบบ API ไม่ผ่านสายนี้เลย มันเรียก Images API ตรงจาก core/imageApi.js)
   */
  const imageTransport = testing()
    ? transport
    : makeTransport('chatgpt_tab', { timeoutMs: 300000, onProgress: handleGptMessage, latencyMs: 60 });
  machine = new Machine({ book, transport, imageTransport, onEvent: logMachine });
}

/**
 * ทดสอบระบบทั้งสายด้วยการกดครั้งเดียว
 *
 * ของจริงกินเวลาเป็นชั่วโมงและเผาโควตา ทำให้ไม่มีใครกล้าทดสอบหลังแก้โค้ด
 * ตัวนี้ตั้งเล่มจิ๋วที่เปิดครบทุกแผนก (มีปก มีภาพในเล่ม) แล้วเดินให้จบเอง
 * ใช้ดูว่าทั้ง 7 แผนกต่อกันติดไหม ก่อนจะเอาของจริงเดิน
 */
/** ระหว่างทดสอบระบบ ให้ผ่านประตูที่รอคนกดไปเองจนจบสาย */
let systemTestRunning = false;

/**
 * โหมดอัตโนมัติเต็มรูปแบบ — กดครั้งเดียวแล้วเดินยาวจนจบเล่ม
 *
 * ต่างจากโหมดทดสอบตรงที่ใช้ ChatGPT จริงและค่าที่ผู้ใช้ตั้งไว้จริงทุกช่อง
 * แต่ใช้จุดผ่านประตูชุดเดียวกัน เพราะสิ่งที่ต้องการเหมือนกันคือ "ห้ามหยุดรอคนกด"
 * ทุกจุดที่ปกติค้างรอการตัดสินใจ (เลือกชื่อ · เลือกสารบัญ · ตรวจงาน · เริ่ม Phase 2 · ส่งออก)
 * จะถูกเลือกให้ด้วยตัวเลือกแรกที่ระบบเสนอ ซึ่งเป็นตัวที่ ChatGPT จัดว่าเหมาะที่สุดอยู่แล้ว
 */
let fullAutoRunning = false;
const autoPilot = () => systemTestRunning || fullAutoRunning;

async function runFullAuto() {
  if (fullAutoRunning) return;
  const pages = Number($('pages').value) || 120;
  if (!confirm(
    'เริ่มสร้างทั้งเล่มแบบอัตโนมัติ\n\n' +
      `· ${pages} หน้า · ${$('audience').value.trim() || 'ผู้อ่านทั่วไป'}\n` +
      '· ระบบจะตัดสินใจแทนทุกจุด โดยเลือกตัวเลือกแรกที่ ChatGPT เสนอ\n' +
      '· ใช้โควตาข้อความ ChatGPT จริงตามที่ประเมินไว้ด้านล่าง\n' +
      '· เปิดแท็บ ChatGPT ค้างไว้ตลอด ห้ามปิดหรือเปลี่ยนห้องแชตเอง\n\n' +
      'เริ่มเลยไหม',
  )) return;

  fullAutoRunning = true;
  const button = $('fullAuto');
  button.disabled = true;
  button.textContent = '🤖 กำลังทำทั้งเล่ม...';
  try {
    // 1) ยังไม่มีหัวข้อ → ให้ ChatGPT คิดให้ แล้วใช้ชื่อแรก
    if (!$('title').value.trim()) {
      status('อัตโนมัติ: กำลังให้ ChatGPT คิดชื่อหนังสือ');
      await generateTitleIdeas();
      // อ่านค่าจากตัวเลือกแรกตรง ๆ ไม่กดปุ่ม เพราะปุ่มนั้นสั่งวางสารบัญต่อทันที
      // ซึ่งจะซ้ำกับขั้นถัดไปของเราเอง แล้วเปลืองข้อความ ChatGPT ไปฟรีหนึ่งรอบ
      const first = $('titleIdeas')?.querySelector('[data-book-title]');
      if (first?.dataset.bookTitle) {
        $('title').value = first.dataset.bookTitle;
        $('titleIdeas').classList.add('hidden');
      }
      if (!$('title').value.trim()) throw new Error('คิดชื่อหนังสือไม่สำเร็จ — ใส่หัวข้อเองแล้วกดใหม่');
      addEvent('system', 'อัตโนมัติ: ได้ชื่อหนังสือ', $('title').value.trim());
    }

    // 2) เสนอสารบัญแล้วเลือกทางแรก
    status('อัตโนมัติ: กำลังวางสารบัญ');
    resetOutlineDirection();
    await generateOutlineDirections();
    const pick = $('outlineDirections')?.querySelector('[data-outline-index="0"]');
    if (!pick) throw new Error('วางสารบัญไม่สำเร็จ — ลองกด “เสนอสารบัญ 3 ทาง” เองอีกครั้ง');
    pick.click();
    addEvent('system', 'อัตโนมัติ: เลือกสารบัญ', outlineDirection?.name || '-');

    // 3) เดินยาว ประตูทุกบานถูกผ่านให้เองด้วยธง fullAutoRunning
    await create();
  } catch (e) {
    fullAutoRunning = false;
    status('อัตโนมัติหยุด: ' + (e?.message || e));
    addEvent('system', 'อัตโนมัติหยุดกลางทาง', e?.message || String(e));
  } finally {
    button.disabled = false;
    button.textContent = '🚀 เริ่มอัตโนมัติทั้งเล่ม';
  }
}

async function runSystemTest() {
  if (
    !confirm(
      'ทดสอบระบบทั้งสายด้วยข้อมูลปลอม\n\n' +
        '· ไม่ยิง ChatGPT และไม่เปลืองโควตาเลย\n' +
        '· สร้างเล่มจิ๋ว 12 หน้า เปิดครบทุกแผนก (ปก + ภาพในเล่ม)\n' +
        '· เนื้อหาที่ได้เป็นข้อความสุ่มสำหรับทดสอบเท่านั้น\n\n' +
        'เริ่มเลยไหม',
    )
  )
    return;

  systemTestRunning = true;
  $('testMode').checked = true;
  $('title').value = 'เล่มทดสอบระบบ';
  if (!$('audience').value.trim()) $('audience').value = 'ผู้อ่านทั่วไป';
  $('pages').value = 12;
  $('contentMode').value = 'prose';
  $('coverMode').value = 'auto';
  $('figureMode').value = 'auto';
  $('illus').value = 'light';
  syncMode();
  updateEstimate();

  resetOutlineDirection();
  status('ทดสอบระบบ: กำลังขอสารบัญ');
  await generateOutlineDirections();

  // เลือกทางแรกให้เอง เพราะการทดสอบไม่ควรค้างรอคนกด
  const first = $('outlineDirections')?.querySelector('[data-outline-index="0"]');
  if (!first) {
    status('ทดสอบระบบ: ขอสารบัญไม่สำเร็จ');
    return;
  }
  first.click();
  await create();
}

async function create() {
  const topic = $('title').value.trim();
  if (!topic) return $('title').focus();
  if (outlineDirection?.titleBase && outlineDirection.titleBase !== topic) resetOutlineDirection();
  if (!outlineDirection) {
    const box = $('outlineDirections');
    // ต้องมองเห็นอยู่จริงเท่านั้นถึงจะนับว่า "รอผู้ใช้เลือก"
    // กล่องที่ซ่อนอยู่แล้วยังมีธง ready ค้าง จะทำให้ปุ่มนี้กดแล้วไม่มีอะไรเกิดขึ้นเลย
    if (box?.dataset.ready === '1' && !box.classList.contains('hidden')) {
      status('กรุณาเลือกสารบัญ 1 ทางก่อนเริ่มสร้าง Ebook');
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    await generateOutlineDirections();
    return;
  }
  /**
   * ติ๊กแนบรูปผู้เขียนไว้แต่ไม่มีรูป ต้องทักตั้งแต่ตรงนี้ ไม่ใช่ไปทักตอนก่อนส่งออก
   *
   * โหมดอัตโนมัติผ่านประตูทุกบานให้เอง ไม่มีจังหวะไหนหยุดรอให้อัปโหลดเลย
   * ถ้าปล่อยผ่าน ภาพทุกใบที่ควรเป็นหน้าเจ้าของเล่มจะกลายเป็นหน้าที่โมเดลแต่งขึ้นเอง
   * แล้วกว่าจะรู้ก็ตอนภาพสร้างเสร็จหมดแล้ว ซึ่งจ่ายค่าสร้างภาพไปครบทุกใบแล้ว
   */
  const refTargets = pickedAuthorRefTargets();
  if (refTargets.length && !setupAuthorPhoto) {
    const go = confirm(
      [
        'เลือกให้แนบรูปผู้เขียนไปกับการสร้างภาพไว้ แต่ยังไม่ได้ใส่รูป',
        '',
        'ถ้าไปต่อตอนนี้ หน้าคนในภาพจะเป็นหน้าที่โมเดลแต่งขึ้นเอง',
        'โหมดอัตโนมัติจะไม่หยุดถามอีกเลยจนกว่าจะสร้างภาพเสร็จทั้งเล่ม',
        '',
        'กดยกเลิกเพื่อกลับไปใส่รูปก่อน · กดตกลงเพื่อไปต่อโดยไม่มีรูป',
      ].join('\n'),
    );
    if (!go) {
      $('authorPhotoSetupPick').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }

  await saveCreatorDefaults();

  $('error').classList.add('hidden');
  $('done').classList.add('hidden');
  $('editor').classList.add('hidden');
  $('start').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('create').disabled = true;
  eventCount = 0;
  renderSteps();
  setMacroStage('write');

  book = readForm();
  await db.saveBook(book);
  // เล่มเพิ่งมี id — บันทึกรูปผู้เขียนที่อุ้มมาจากหน้าตั้งค่าเดี๋ยวนี้ ก่อนที่ขั้นสร้างภาพจะไปหามัน
  await saveSetupAuthorPhoto();
  await syncSharedProject(book.id);
  addEvent('system', 'เริ่มงาน', `${book.topic}\n${book.targetPages} หน้า · ${TRIM_PRESETS[book.trim.preset].label}`);
  status('กำลังเริ่มงาน');

  await focusChat();
  showRunningCost();
  makeMachine();
  try {
    await runMachine();
  } catch (e) {
    fail(e);
  }
}

async function runMachine() {
  const r = await machine.runUntilGate();
  book = await db.loadBook(book.id);

  if (r?.gate === 'gate_outline') {
    // สารบัญผ่านการตรวจ schema แล้ว เดินต่อได้เลย แต่ต้องให้เห็นว่าได้อะไรมา
    const o = book.outline;
    const isItems = book.contentMode === 'items' || (o?.themes?.length && !o?.chapters?.length);
    const isFiction = book.contentMode === 'fiction';
    const outlineText = isItems
      ? (o.themes || [])
          .map((t) => `${t.n}. ${t.title} — ${t.count || book.itemPlan?.perTheme || 0} ชิ้น${t.angle ? `\n    ${t.angle}` : ''}`)
          .join('\n')
      : (o.chapters || [])
          .map(
            (c) =>
              `${c.n}. ${c.title}\n` +
              (c.sections || [])
                .map((s) => `    ${s.id} ${s.title} — ${s.quota.toLocaleString()} หน่วย`)
                .join('\n'),
          )
          .join('\n');
    const outlineMeta = isItems
      ? `${(o.themes || []).length} หมวด · ${book.itemPlan?.total || 0} ชิ้น`
      : `${(o.chapters || []).length} บท · ${(o.chapters || []).reduce((n, c) => n + (c.sections || []).length, 0)} ${isFiction ? 'ฉาก' : 'ตอน'}`;
    addEvent(
      'system',
      isItems ? 'ได้โครงหมวดแล้ว' : isFiction ? 'ได้โครงเรื่องและ Story Bible แล้ว' : 'ได้สารบัญแล้ว',
      outlineText,
      outlineMeta,
    );
    book.job.step = 'write';
    await db.saveBook(book);
    makeMachine();
    return runMachine();
  }

  if (r?.gate === 'gate_edit') {
    await openEditor();
    return;
  }

  if (r?.gate === 'gate_images') {
    await openImagePhaseGate();
    return;
  }

  if (r?.stopped && r.stopped !== 'done') {
    if (r.stopped === 'rate_limited' || r.stopped === 'paused') return halted();
    return fail(new Error(book.job?.error || `งานหยุด: ${r.stopped}`));
  }
  await finish();
}

/** หยุดแบบตั้งใจ ไม่ใช่พัง — งานอยู่ครบ กดทำต่อได้ */
async function halted() {
  $('create').disabled = false;

  // Phase 2 ห้ามจบที่หน้า Progress เปล่า: ถ้าหยุด/สะดุดระหว่าง images
  // ให้ย้อนกลับมาที่ gate ซึ่งแสดงจำนวนภาพที่มี/ขาดและปุ่มเริ่มต่อทันที
  if (book?.job?.step === 'images') {
    // ต้องบันทึกว่าหยุดเพราะอะไรและเมื่อไร ก่อนจะเขียนทับสถานะเป็น paused
    // ไม่งั้นประตูจะโชว์ความล้มเหลวเก่าค้างไว้ แล้วผู้ใช้แยกไม่ออกระหว่าง
    // "กดแล้วไม่มีอะไรเกิดขึ้น" กับ "กดแล้วหยุดกลางทางเพราะเหตุนี้"
    const why =
      book.job.error ||
      (book.job.status === 'rate_limited' ? 'ชนลิมิตข้อความของ ChatGPT' : 'หยุดกลางคัน');
    book.job.step = 'gate_images';
    book.job.status = 'paused';
    book.job.imageThreadStarted = false;
    book.imagePhase = { ...(book.imagePhase || {}), stoppedAt: Date.now(), stoppedReason: why };
    await db.saveBook(book);
    await openImagePhaseGate();
    return;
  }

  status('หยุดไว้ก่อน');
  showResume(book);
  addEvent('system', 'หยุดไว้ก่อน', `ใช้ไป ${book.job?.turnNo || 0} ข้อความ · อยู่ที่ขั้น ${STEP_NAMES[book.job?.step] || book.job?.step} · งานถูกบันทึกไว้ครบ`);
  $('resume').scrollIntoView({ behavior: 'smooth' });
}

/**
 * แปลข้อความผิดพลาดที่ค้างอยู่ในโครงการให้เป็นภาษาที่ทำอะไรต่อได้
 *
 * ข้อความใน job.error คือบันทึกของ "การรันครั้งที่แล้ว" ไม่ใช่สภาพปัจจุบัน
 * แต่การ์ดงานค้างเอามาแสดงดิบ ๆ ต่อท้ายสถานะ ผู้ใช้จึงอ่านว่าระบบยังพังอยู่ตอนนี้
 * และเมื่อกดทำต่อแล้วข้อความไม่เปลี่ยน (เพราะยังไม่มีการรันใหม่มาเขียนทับ)
 * ก็สรุปว่า "แก้แล้วยังเหมือนเดิม" ทั้งที่ยังไม่ได้ลองอะไรเลย
 *
 * ข้อความบางอย่างเป็นคำบ่นของเบราว์เซอร์ที่ผู้ใช้ทำอะไรกับมันไม่ได้ ต้องแปลให้เป็นทางออก
 */
function explainJobError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/unsafe-eval|Content Security Policy/i.test(text)) {
    return 'ครั้งที่แล้วหยุดเพราะห้องเรียงพิมพ์ไม่ได้ทำงานในโหมด sandbox ' +
      '(เกิดเมื่อส่วนขยายถูกรีโหลดขณะหน้า Studio เปิดค้างอยู่) — ปิดหน้านี้แล้วเปิดใหม่จากไอคอนส่วนขยาย แล้วกดทำต่อได้เลย';
  }
  return `ครั้งที่แล้วหยุดเพราะ ${text}`;
}

// ---------- ทำต่อจากที่ค้าง ----------
function showResume(b) {
  const done = b.job?.status === 'done';
  if (!b || done) {
    setMacroStage('start');
    return $('resume').classList.add('hidden');
  }
  $('resume').classList.remove('hidden');
  /**
   * การ์ดงานค้าง = ยืนอยู่หน้าเริ่มต้น ไม่ได้อยู่ในงานนั้น
   *
   * เดิมตั้งแถบขั้นตอนตามขั้นของงานที่ค้าง หัวจอเลยขึ้นว่า "สร้างภาพ · Phase 2"
   * ทั้งที่หน้าจอเป็นฟอร์มเปล่ารอสร้างเล่มใหม่ ดูแล้วเหมือนระบบยังติดอยู่กับโครงการเก่า
   * ขั้นของงานที่ค้างมีบอกอยู่ในการ์ดอยู่แล้ว ไม่ต้องเอามาครองหัวจอ
   */
  setMacroStage('start');
  /**
   * ผูกรหัสโครงการไว้กับการ์ดเอง ไม่ใช่ฝากไว้กับตัวแปรรวมของหน้า
   *
   * ปุ่มบนการ์ดอ่านค่าจากตัวแปร book ซึ่งเป็นสถานะรวมของทั้งหน้า และมีหลายเส้นทาง
   * ที่ล้างมันเป็น null ได้ระหว่างที่การ์ดยังแสดงอยู่ พอกดปุ่มจึงพังด้วย
   * "Cannot read properties of null (reading 'job')" แล้วทั้งหน้าหยุดตอบสนอง
   * การ์ดที่จำได้ว่าตัวเองพูดถึงโครงการไหน จะโหลดกลับมาเองได้โดยไม่ต้องพึ่งตัวแปรนั้น
   */
  $('resume').dataset.bookId = b.id || '';
  $('resumeTitle').textContent = b.outline?.title || b.topic || '(ยังไม่มีชื่อ)';
  const why =
    b.job?.status === 'rate_limited'
      ? 'หยุดเพราะชนลิมิตข้อความของ ChatGPT'
      : explainJobError(b.job?.error) || (b.job?.status === 'paused' ? 'หยุดไว้' : '');
  const seen = Math.max(b.updatedAt || 0, b.imagePhase?.stoppedAt || 0, b.imagePhase?.lastAttemptAt || 0);
  /**
   * บอกด้วยว่าเล่มนี้เขียนด้วยเครื่องยนต์ไหน
   * เพราะค่านี้ถูกล็อกไว้กับเล่ม ไม่ได้ตามตัวเลือกบนหน้าจอ ณ ตอนนี้
   * ถ้าไม่บอก ผู้ใช้ที่สลับตัวเลือกไปแล้วจะงงว่าทำไมกดทำต่อแล้วไม่ตรงกับที่ตั้งไว้
   */
  const engine = (b.textSource || 'web') === 'api' ? `API · ${b.textApiModel || 'ค่าเริ่มต้น'}` : 'หน้าเว็บ ChatGPT';
  $('resumeInfo').textContent =
    `${b.targetPages} หน้า · เขียนด้วย ${engine} · ใช้ไป ${b.job?.turnNo || 0} ${(b.textSource || 'web') === 'api' ? 'เทิร์น' : 'ข้อความ'} · ค้างที่ขั้น ${STEP_NAMES[b.job?.step] || b.job?.step || '-'}` +
    (seen ? ` · แตะล่าสุด${sinceText(seen)}` : '') +
    (why ? ` — ${why}` : '');
  setBtn('resumeGo', ['gate_images', 'images'].includes(b.job?.step) ? 'image' : 'play', ['gate_images', 'images'].includes(b.job?.step) ? 'เปิด Image Phase 2' : 'ทำต่อจากที่ค้าง');
  /**
   * ถ้าผู้ใช้ตั้งค่าบนหน้าจอไว้อย่างหนึ่ง แต่เล่มนี้ล็อกไว้อีกอย่าง ต้องบอกและให้ทางเลือก
   * ไม่ใช่เงียบแล้วทำตามเล่ม จนผู้ใช้สงสัยว่าทำไมเลือก API แล้วยังไปหน้าเว็บอยู่
   */
  const bookApi = (b.textSource || 'web') === 'api';
  const mismatch = bookApi !== uiUsesApi();
  const sw = $('resumeSwitchEngine');
  sw.classList.toggle('hidden', !mismatch);
  if (mismatch) {
    setBtn('resumeSwitchEngine', 'refresh', `เปลี่ยนเป็น ${uiUsesApi() ? 'OpenAI API' : 'หน้าเว็บ ChatGPT'}`);
  }

  const canAcceptPages =
    b.job?.step === 'fit' &&
    Number(b.lastCompile?.pages) > 0 &&
    String(b.job?.error || '').includes('ต่างจากเป้า');
  $('acceptPages').classList.toggle('hidden', !canAcceptPages);
}

async function acceptCurrentPages() {
  const pages = Number(book?.lastCompile?.pages);
  if (!pages) return;
  book.targetPages = pages;
  book.job.error = null;
  book.job.status = 'paused';
  await db.saveBook(book);
  addEvent('system', 'ยอมรับจำนวนหน้าปัจจุบัน', `${pages} หน้า${pages % 2 ? ' · ระบบจะเติมหน้าว่างเป็น ' + (pages + 1) + ' หน้า' : ''}`);
  return resumeGo();
}


/**
 * เปลี่ยนแหล่งเขียนของเล่มที่ทำค้างไว้
 *
 * ปกติค่านี้ถูกล็อกไว้กับเล่มเพื่อไม่ให้สำนวนเปลี่ยนกลางเล่ม แต่บางครั้งผู้ใช้ตั้งใจเปลี่ยนจริง
 * เช่นเจอว่าหน้าเว็บชนลิมิตแล้วอยากจ่ายเงินเดินต่อให้จบ จึงต้องมีทางออกที่บอกผลกระทบตรง ๆ
 */
async function switchBookEngine() {
  if (!book?.id) return;
  const toApi = uiUsesApi();
  const label = toApi ? `OpenAI API (${textApiModel()})` : 'หน้าเว็บ ChatGPT';
  if (!confirm(
    `เปลี่ยนแหล่งเขียนของเล่มนี้เป็น ${label} หรือไม่?

` +
    'ตอนที่เขียนไปแล้วจะไม่ถูกแตะ แต่ตอนที่เหลือจะถูกเขียนด้วยโมเดลใหม่ ' +
    'สำนวนอาจไม่ต่อเนื่องกับของเดิม ถ้ารับได้ให้กดตกลง'
  )) return;
  book.textSource = toApi ? 'api' : 'web';
  book.textApiModel = textApiModel();
  await db.saveBook(book);
  await syncSharedProject(book.id);
  showResume(book);
  status(`เล่มนี้จะเขียนต่อด้วย ${label}`);
}

async function resumeGo() {
  /**
   * กู้เล่มกลับมาจากรหัสบนการ์ด ถ้าตัวแปรรวมของหน้าถูกล้างไปแล้ว
   *
   * ของเดิมอ่าน book.job ตรง ๆ พอ book เป็น null ก็โยน TypeError ออกมากลางทาง
   * ปุ่มอื่นบนหน้าที่รอผลอยู่จึงค้างตามไปด้วย ผู้ใช้เห็นเป็น "กดอะไรก็ไม่ได้"
   * ทั้งที่งานยังอยู่ครบใน IndexedDB และแค่โหลดกลับมาก็ทำต่อได้ทันที
   */
  if (!book?.job) {
    const id = $('resume').dataset.bookId;
    if (id) book = await db.loadBook(id).catch(() => null);
  }
  if (!book?.job) {
    $('resume').classList.add('hidden');
    status('ไม่พบงานค้างที่จะทำต่อ — เลือกจาก “ดูประวัติโครงการ” ด้านล่างได้เลย');
    await loadProjectHistory();
    $('projectList')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  $('resume').classList.add('hidden');
  $('start').classList.add('hidden');
  if (['gate_images', 'images'].includes(book?.job?.step)) {
    if (book.job.step === 'images') {
      book.job.step = 'gate_images';
      book.job.status = 'paused';
      book.job.error = 'กู้คืน Phase 2 หลังหน้าต่าง Studio/ChatGPT ถูกสลับหรือรีโหลด';
      book.job.imageThreadStarted = false;
      await db.saveBook(book);
    }
    await openImagePhaseGate();
    return;
  }
  $('progress').classList.remove('hidden');
  renderSteps();
  setMacroStage(macroStageForJobStep(book.job.step));
  await db.saveBook(book);
  addEvent('system', 'ทำต่อ', `จากขั้น ${STEP_NAMES[book.job.step] || book.job.step}`);
  // ประตูที่รอคนตัดสินใจไม่ต้องคุยกับ ChatGPT ถ้าดึงโฟกัสไปตอนนี้ หน้าจอจะกระโดดออกจาก Studio
  // ทั้งที่ยังไม่มีอะไรต้องส่ง ผู้ใช้จะรู้สึกว่า "กดทำต่อแล้วหลุดไปไหนก็ไม่รู้"
  if (!String(book.job.step || '').startsWith('gate_')) {
    await focusChat();
  }
  showRunningCost();
  makeMachine();
  try {
    await runMachine();
  } catch (e) {
    fail(e);
  }
}

/**
 * ทางออกฉุกเฉินกลับไปหน้าเริ่มต้นจากทุกจุดของ flow (progress/editor/imagePhase/done)
 * ไม่มีปุ่มแบบนี้มาก่อน ทำให้ผู้ที่อยากทดสอบเล่มใหม่ระหว่างเล่มเก่ายังไม่จบต้อง reload หน้าทั้งหน้าเอง
 * ไม่ลบข้อมูลอะไร — เล่มปัจจุบันถูกบันทึกไว้ในระบบแล้วตลอด กลับมาทำต่อได้ทาง "ดูประวัติโครงการ"
 */
async function startNewBook() {
  const busy = machine && book?.job?.status === 'running';
  if (!confirm(busy
    ? 'หยุดงานที่กำลังทำอยู่แล้วเริ่มเล่มใหม่หรือไม่? เล่มเดิมถูกบันทึกไว้แล้ว กลับมาทำต่อได้ภายหลังจาก "ดูประวัติโครงการ"'
    : 'เริ่มเล่มใหม่หรือไม่? เล่มปัจจุบันถูกบันทึกไว้แล้ว กลับมาทำต่อได้ภายหลังจาก "ดูประวัติโครงการ"')) return;

  try { machine?.stop(); } catch {}
  systemTestRunning = false;
  setMode('');
  book = null;
  machine = null;
  sections = [];
  assetNames = [];
  selected = null;
  phase2Running = false;
  phase2Stage = null;

  /**
   * ต้องล้างของที่ค้างจากเล่มเก่าให้หมด ไม่ใช่แค่ตัวแปร
   *
   * เดิมตั้ง outlineDirection = null อย่างเดียว แต่ dataset.ready ของกล่องสารบัญยังเป็น '1'
   * พอกด "เริ่มสร้าง Ebook" ของเล่มใหม่ create() จะคิดว่ากำลังรอผู้ใช้เลือกสารบัญที่มีอยู่แล้ว
   * แล้วสั่ง scrollIntoView ไปที่กล่องที่ถูกซ่อนอยู่ — จอไม่ขยับ ไม่มีข้อความ ไม่มีอะไรเกิดขึ้น
   * นี่คือที่มาของอาการ "ทำเล่มใหม่ก็เงียบ"
   */
  resetOutlineDirection();
  inspirePolishRound = 0; // เล่มใหม่ = เริ่มนับรอบตกแต่งสารบัญใหม่ ไม่ใช่นับต่อจากเล่มก่อน
  if ($('outlineDirections')) $('outlineDirections').innerHTML = '';
  trendSeed = null;
  trendPool = [];
  ['titleIdeas', 'trendIdeas'].forEach((id) => {
    if ($(id)) {
      $(id).innerHTML = '';
      $(id).classList.add('hidden');
    }
  });

  ['progress', 'editor', 'imagePhase', 'done', 'error', 'resume'].forEach((id) => $(id).classList.add('hidden'));
  $('start').classList.remove('hidden');
  $('create').disabled = false;
  setBtn('create', 'rocket', 'เริ่มสร้าง Ebook');
  setMacroStage('start');
  status('พร้อม');
  $('start').scrollIntoView({ behavior: 'smooth' });
  await loadProjectHistory();
}

async function loadUnfinished() {
  const [books, sharedMetas] = await Promise.all([
    db.listBooks(),
    W.listProjects().catch(() => []),
  ]);
  const localById = new Map(books.map((b) => [b.id, b]));
  const sharedById = new Map(sharedMetas.map((m) => [m.id, m]));
  const candidates = [...new Set([...localById.keys(), ...sharedById.keys()])]
    .map((id) => {
      const local = localById.get(id) || null;
      const shared = sharedById.get(id) || null;
      const useShared = !!shared && (!local || (shared.updatedAt || 0) > (local.updatedAt || 0));
      const latest = useShared ? shared : local;
      return { id, latest, useShared };
    })
    .filter(({ latest }) => latest?.job && latest.job.status !== 'done' && latest.job.step !== 'done')
    .sort((a, b) => (b.latest.updatedAt || 0) - (a.latest.updatedAt || 0));

  const pick = candidates[0];
  if (!pick) return;
  if (pick.useShared) await W.importProject(pick.id);
  book = await db.loadBook(pick.id);
  if (!book) return;
  // ย้ายงานที่สร้างด้วยค่าจัดหน้าเดิมซึ่งกรอบบรรทัดไทยแน่นเกินไป
  if (book.language === 'th' && (book.typography?.standardVersion || 0) < 2) {
    book.typography ||= {};
    book.typography.standardVersion = 2;
    book.typography.bodyFont ||= 'Sarabun';
    book.typography.headFont ||= 'IBM Plex Sans Thai';
    book.typography.sizePt = 14;
    book.typography.lineHeight = 1.55;
    book.typography.justify = false;
    book.typography.marginsMm = { ...MARGIN_PRESETS.normal };
    await db.saveBook(book);
  }
  sections = await db.loadSections(book.id);

  /**
   * เปิดหน้าไหนตอนเข้ามาใหม่
   *
   * เดิมมีสองพฤติกรรมที่ผิดทั้งคู่ ตอนแรกไม่พาไปไหนเลยจนหางานค้างไม่เจอ
   * แก้แล้วกลายเป็นเด้งเข้างานเก่าทุกครั้ง งานที่ทิ้งไว้ตั้งแต่เมื่อวานก็ยังยึดหน้าจอ
   *
   * เกณฑ์ที่ถูกคือ "นี่คือการทำงานต่อเนื่องจริงไหม" — ถ้าเพิ่งแตะงานนี้ไม่นาน
   * (รีเฟรชหน้า เผลอปิดแท็บ ส่วนขยายรีโหลด) พากลับเข้าที่เดิมคือสิ่งที่ควรทำ
   * แต่ถ้าห่างเป็นชั่วโมง มันคือ "งานค้างที่รอตัดสินใจ" ไม่ใช่ "สิ่งที่กำลังทำอยู่"
   * ต้องเปิดหน้าเริ่มต้นแล้ววางการ์ดงานค้างไว้ให้เลือกเอง
   */
  const touched = Math.max(
    book.updatedAt || 0,
    book.imagePhase?.lastAttemptAt || 0,
    book.imagePhase?.lastSavedAt || 0,
    book.imagePhase?.stoppedAt || 0,
    book.imagePhase?.verifiedAt || 0,
  );
  const continuing = touched > 0 && Date.now() - touched < 30 * 60 * 1000;

  // งานที่อยู่ใน Phase 2 ต้องกลับเข้าหน้า Phase 2 ทันที
  // ถ้า Studio ถูกปิด/รีโหลดระหว่าง step=images ให้ถือว่าเทิร์นที่กำลังวิ่งขาดการเชื่อมต่อ
  // และย้อนเป็น gate_images อย่างปลอดภัย เพราะ asset ที่บันทึกแล้วจะถูก skip ตอนเริ่มใหม่
  if (continuing && ['gate_images', 'images'].includes(book.job?.step)) {
    if (book.job.step === 'images') {
      book.job.step = 'gate_images';
      book.job.status = 'paused';
      book.job.error = 'กู้คืน Phase 2 หลังหน้าต่าง Studio/ChatGPT ถูกสลับหรือรีโหลด';
      book.job.imageThreadStarted = false;
      await db.saveBook(book);
    }
    $('resume').classList.add('hidden');
    await openImagePhaseGate();
    return;
  }

  // ประตูตรวจงานก็ต้องพากลับเข้าหน้าเดิมทันทีเหมือน Phase 2
  // ไม่ใช่โยนไปหน้าเริ่มต้นแล้วให้กด "ทำต่อ" ซึ่งเป็นที่มาของอาการ "รีโหลดแล้วกลับไปไหนไม่ได้"
  if (continuing && book.job?.step === 'gate_edit') {
    $('resume').classList.add('hidden');
    await openEditor();
    return;
  }

  showResume(book);
}

async function loadProjectHistory() {
  const [localBooks, sharedMetas] = await Promise.all([
    db.listBooks(),
    W.listProjects().catch(() => []),
  ]);

  const localById = new Map(localBooks.map((b) => [b.id, b]));
  const sharedById = new Map(sharedMetas.map((m) => [m.id, m]));
  const ids = [...new Set([...localById.keys(), ...sharedById.keys()])].sort((a, b) => {
    const aa = Math.max(localById.get(a)?.updatedAt || 0, sharedById.get(a)?.updatedAt || 0);
    const bb = Math.max(localById.get(b)?.updatedAt || 0, sharedById.get(b)?.updatedAt || 0);
    return bb - aa;
  });

  const rows = await Promise.all(
    ids.map(async (id) => {
      const local = localById.get(id) || null;
      const shared = sharedById.get(id) || null;
      const useShared = !!shared && (!local || (shared.updatedAt || 0) > (local.updatedAt || 0));

      if (useShared) {
        const isPhase2 = ['gate_images', 'images'].includes(shared.job?.step);
        return {
          id,
          title: shared.title || shared.topic || '(ยังไม่มีชื่อ)',
          updatedAt: shared.updatedAt || 0,
          stateDone: shared.job?.status === 'done' || shared.job?.step === 'done',
          step: shared.job?.step,
          sectionCount: shared.sectionCount || 0,
          targetPages: shared.targetPages || '-',
          isPhase2,
          phase2Total: shared.imagePhase?.total || 0,
          phase2Missing: shared.imagePhase?.remaining || 0,
          shared: true,
        };
      }

      const b = local;
      const sectionCount = b ? (await db.loadSections(b.id)).length : 0;
      const isPhase2 = !!b && ['gate_images', 'images'].includes(b.job?.step);
      const assets = isPhase2 ? await db.loadAssets(b.id) : [];
      const required = isPhase2 ? phase2RequiredNames(b) : [];
      const missing = isPhase2 ? phase2MissingNames(b, assets) : [];
      return {
        id,
        title: b?.outline?.title || b?.topic || '(ยังไม่มีชื่อ)',
        updatedAt: b?.updatedAt || 0,
        stateDone: b?.job?.status === 'done' || b?.job?.step === 'done',
        step: b?.job?.step,
        sectionCount,
        targetPages: b?.targetPages || '-',
        isPhase2,
        phase2Total: required.length,
        phase2Missing: missing.length,
        shared: !!shared,
      };
    }),
  );

  if (!rows.length) {
    $('projectList').innerHTML = '<div class="muted">ยังไม่มีโครงการที่บันทึกไว้</div>';
    return;
  }

  $('projectList').innerHTML = rows
    .map((r) => {
      const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString('th-TH') : 'ไม่ทราบเวลา';
      const state = r.stateDone
        ? 'เสร็จแล้ว'
        : r.isPhase2
          ? r.phase2Missing > 0
            ? `รอ Image Phase 2 · ยังขาด ${r.phase2Missing}/${r.phase2Total} รูป`
            : 'Image Phase 2 ภาพครบแล้ว · รอตรวจและประกอบ PDF'
          : `ค้างที่ ${STEP_NAMES[r.step] || r.step || '-'}`;
      const buttonLabel = r.isPhase2 ? 'เปิด Phase 2' : 'เปิดโครงการ';
      const sharedNote = r.shared ? ' · Shared Workspace' : '';
      return `<div class="projectItem${r.isPhase2 ? ' projectPhase2' : ''}"><div class="projectMeta"><div class="projectTitle">${esc(r.title)}</div><div class="projectInfo">${when} · ${state} · ${r.sectionCount} ตอน · ${r.targetPages} หน้า${sharedNote}</div></div><div class="projectActions"><button data-open-project="${esc(r.id)}">${buttonLabel}</button><button class="projectEdit" data-rename-project="${esc(r.id)}" title="เปลี่ยนชื่อโครงการ">แก้ชื่อ</button><button class="danger projectEdit" data-drop-project="${esc(r.id)}" title="ลบโครงการนี้ถาวร">ลบ</button></div></div>`;
    })
    .join('');

  $('projectList').querySelectorAll('[data-open-project]').forEach((btn) => {
    btn.onclick = () => openSavedProject(btn.dataset.openProject);
  });
  $('projectList').querySelectorAll('[data-rename-project]').forEach((btn) => {
    btn.onclick = () => renameSavedProject(btn.dataset.renameProject);
  });
  $('projectList').querySelectorAll('[data-drop-project]').forEach((btn) => {
    btn.onclick = () => deleteSavedProject(btn.dataset.dropProject);
  });
}

/**
 * แก้ชื่อโครงการที่บันทึกไว้
 *
 * ชื่อที่โชว์ในประวัติมาจาก outline.title ก่อน แล้วค่อยถอยไป topic
 * ถ้าแก้แค่ตัวเดียวจะได้ผลไม่เหมือนกันในแต่ละเล่ม จึงต้องเขียนทั้งสองที่ให้ตรงกัน
 */
async function renameSavedProject(id) {
  let saved = await db.loadBook(id);
  if (!saved) {
    // เล่มที่มีแต่ใน Shared Workspace ต้องดึงเข้ามาก่อนถึงจะแก้ได้
    await W.importProject(id).catch(() => null);
    saved = await db.loadBook(id);
  }
  if (!saved) return alert('เปิดไฟล์โครงการนี้ไม่ได้ จึงยังแก้ชื่อไม่ได้');

  const current = saved.outline?.title || saved.topic || '';
  const next = prompt('ชื่อใหม่ของโครงการนี้', current);
  if (next === null) return;
  const title = next.trim();
  if (!title || title === current) return;

  saved.topic = title;
  if (saved.outline) saved.outline.title = title;
  await db.saveBook(saved);
  await W.syncProject(id).catch(() => null);
  if (book?.id === id) book = await db.loadBook(id);
  await loadProjectHistory();
  status(`เปลี่ยนชื่อโครงการเป็น “${title}”`);
}

/**
 * ลบโครงการถาวร
 *
 * ต้องลบทั้งสองที่: IndexedDB ของ Chrome profile นี้ และไฟล์ใน Shared Workspace
 * ถ้าลบแค่ในเครื่อง รายการจะเด้งกลับมาทันทีที่รีเฟรช เพราะประวัติอ่านจากโฟลเดอร์ที่แชร์ด้วย
 */
async function deleteSavedProject(id) {
  const saved = await db.loadBook(id).catch(() => null);
  const name = saved?.outline?.title || saved?.topic || id;
  if (!confirm(`ลบโครงการ “${name}” ถาวรหรือไม่?
เนื้อหา ภาพ และประวัติทั้งหมดของเล่มนี้จะหายไป กู้คืนไม่ได้`)) return;

  await db.deleteBook(id).catch(() => null);
  const shared = await W.deleteProject(id).catch(() => null);

  if (book?.id === id) {
    book = null;
    sections = [];
    selected = null;
    $('resume').classList.add('hidden');
  }
  await loadProjectHistory();
  status(
    shared && shared.ok === false && shared.reason === 'workspace_unavailable'
      ? `ลบ “${name}” ในเครื่องนี้แล้ว (ยังไม่ได้ต่อ Shared Workspace จึงลบไฟล์ที่แชร์ไม่ได้)`
      : `ลบโครงการ “${name}” แล้ว`,
  );
}

async function openSavedProject(id) {
  const sharedMeta = await W.getSharedMeta(id).catch(() => null);
  let saved = await db.loadBook(id);

  // ถ้าอีก Chrome profile เขียน project snapshot ใหม่กว่า ให้ดึงจาก Shared Workspace
  // เข้ามาเป็น local cache ก่อนเปิด เพื่อให้ประวัติ/Phase 2/ภาพตรงกันจริง
  if (sharedMeta && (!saved || (sharedMeta.updatedAt || 0) > (saved.updatedAt || 0))) {
    await W.importProject(id);
    saved = await db.loadBook(id);
  }

  if (!saved) return;
  book = saved;
  sections = (await db.loadSections(id)).sort((a, b) => cmpId(a.id, b.id));
  selected = null;
  $('error').classList.add('hidden');
  $('done').classList.add('hidden');
  $('progress').classList.add('hidden');
  if (['gate_images', 'images'].includes(saved.job?.step)) {
    if (saved.job.step === 'images') {
      saved.job.step = 'gate_images';
      saved.job.status = 'paused';
      saved.job.error = 'กู้คืน Phase 2 หลังเปิดโครงการใหม่';
      saved.job.imageThreadStarted = false;
      await db.saveBook(saved);
      book = saved;
    }
    await openImagePhaseGate();
  } else if (sections.length) {
    await openEditor();
  } else {
    showResume(book);
    $('resume').scrollIntoView({ behavior: 'smooth' });
  }
}

const fail = (e) => {
  setMode(currentMode); // คงชื่อโหมดไว้ให้รู้ว่าพลาดตอนทำอะไร แต่เลิกแสดงว่ากำลังทำงาน
  $('error').textContent = 'เกิดข้อผิดพลาด: ' + (e?.message || e);
  $('error').classList.remove('hidden');
  status('งานหยุด');
  addEvent('system', 'ERROR', e?.stack || e?.message || String(e));
  $('create').disabled = false;
};

// ---------- ประตูที่ 2: แก้ก่อนส่งออก ----------
async function openEditor() {
  $('start').classList.add('hidden');
  $('resume').classList.add('hidden');
  sections = (await db.loadSections(book.id)).sort((a, b) => cmpId(a.id, b.id));
  assetNames = (await db.loadAssets(book.id)).map((a) => a.name);
  await renderImages();
  setPhase('fit', 'ถึงจุดที่คนต้องดูแล้ว');
  status('รอคุณตรวจงาน');
  setMacroStage('edit');
  $('editor').classList.remove('hidden');
  $('secReview').classList.add('hidden');
  renderReviewPanel();
  renderSecList();
  if (sections.length && !sections.some((s) => s.id === selected)) selectSection(sections[0].id);
  $('editPages').textContent = `${book.lastCompile?.pages ?? '?'} / ${book.targetPages} หน้า`;
  const flagged = bookIssues(book?.review);
  addEvent(
    'system',
    'ถึงขั้นตอนแก้ไข',
    flagged.total
      ? `แก้ตอนไหนก็ได้ แล้วกดนับหน้าใหม่ · บรรณาธิการทำเครื่องหมายไว้ ${flagged.totalCounted} ประเด็นใน ${flagged.chapters.length} บท เปิดดูได้ที่กล่องผลตรวจ`
      : 'แก้ตอนไหนก็ได้ แล้วกดนับหน้าใหม่ เมื่อพอใจจึงไปต่อ',
  );
  if (autoPilot()) {
    addEvent('system', fullAutoRunning ? 'อัตโนมัติ' : 'ทดสอบระบบ', 'ผ่านประตูตรวจงานอัตโนมัติ');
    setTimeout(() => proceed(), 400);
    return;
  }
  $('editor').scrollIntoView({ behavior: 'smooth' });
}

const cmpId = (a, b) => {
  const [a1, a2] = String(a).split('.').map(Number);
  const [b1, b2] = String(b).split('.').map(Number);
  return a1 - b1 || a2 - b2;
};

function renderSecList() {
  // ตอนที่บรรณาธิการทำเครื่องหมายไว้ ต้องเห็นได้จากรายการ ไม่ใช่ต้องเปิดทีละตอนหา
  const flagged = issuesBySection(book?.review);
  $('secList').innerHTML = sections
    .map((s) => {
      const off = s.quota ? Math.round(((s.chars - s.quota) / s.quota) * 100) : 0;
      const bad = Math.abs(off) > 25 ? ' off' : '';
      const flags = (flagged.get(s.id) || []).length;
      /**
       * สถานะของตอนต้องอ่านออกก่อนอ่านตัวหนังสือ
       * รายการยาวหลายสิบตอน การไล่อ่านคำว่า blocked/draft ทีละบรรทัดคือการค้นหา ไม่ใช่การเห็น
       */
      const mark = !(s.md || '').trim()
        ? s.status === 'blocked'
          ? 'error'
          : 'clock'
        : Math.abs(off) > 25
          ? 'alert'
          : flags
            ? 'doc-check'
            : 'check-circle';
      return `<button class="secItem${bad}${flags ? ' flag' : ''}${s.id === selected ? ' sel' : ''}" data-id="${s.id}"><svg class="i" aria-hidden="true"><use href="#i-${mark}"/></svg><span class="t">${esc(s.id)} ${esc(s.title)}<span class="n">${s.chars.toLocaleString()} หน่วย · ${off >= 0 ? '+' : ''}${off}% · ${s.status}${flags ? ` · บรรณาธิการทำเครื่องหมาย ${flags}` : ''} · ประวัติ ${(s.history || []).length}</span></span></button>`;
    })
    .join('');
  $('secList')
    .querySelectorAll('.secItem')
    .forEach((b) => (b.onclick = () => selectSection(b.dataset.id)));
  refreshEmptySectionButton();
}

function selectSection(id) {
  selected = id;
  const s = sections.find((x) => x.id === id);
  $('secTitle').textContent = `${s.id} ${s.title}`;
  $('secBody').value = s.md || '';
  $('secStat').textContent = `โควตา ${s.quota?.toLocaleString() ?? '-'} · ตอนนี้ ${s.chars.toLocaleString()} หน่วย`;
  $('secHistory').textContent = `ประวัติตอน (${(s.history || []).length})`;
  $('historyPanel').classList.add('hidden');
  renderSecReview(id);
  renderSecList();
}

/**
 * ประเด็นที่บรรณาธิการทำเครื่องหมายไว้กับตอนที่กำลังเปิดอยู่
 * วางไว้ใต้ช่องแก้ข้อความ เพราะจุดที่คนแก้คือจุดที่ต้องเห็นว่าจะแก้อะไร
 */
function renderSecReview(id) {
  const box = $('secReview');
  const { mine, chapterWide } = issuesForSection(book?.review, id);
  if (!mine.length && !chapterWide.length) return box.classList.add('hidden');
  box.classList.remove('hidden');
  box.innerHTML =
    `<b>บรรณาธิการทำเครื่องหมายไว้ ${mine.length + chapterWide.length} ประเด็น</b>` +
    mine.map((i) => issueHtml(i, false)).join('') +
    chapterWide.map((i) => issueHtml(i, false, `ทั้งบทที่ ${i.chapter}`)).join('');
}

/** ประเด็นหนึ่งข้อ — ถ้าผูกกับตอนได้ ทำเป็นปุ่มกดกระโดดไปตอนนั้น */
function issueHtml(i, clickable, at = '') {
  const tag = clickable && i.section ? 'button' : 'div';
  const attr = clickable && i.section ? ` type="button" data-review-go="${esc(i.section)}"` : '';
  const where = at || (clickable && i.section ? `ตอน ${esc(i.section)}` : '');
  return (
    `<${tag} class="reviewIssue${i.counted ? '' : ' hint'}"${attr}>` +
    `<span class="k">${esc(i.label)}</span>` +
    `<span class="b">${esc(i.text)}` +
    (i.fix ? `<span class="fix">แนวทางแก้: ${esc(i.fix)}</span>` : '') +
    (where ? `<span class="at">${esc(where)}</span>` : '') +
    `</span></${tag}>`
  );
}

/**
 * ผลตรวจทั้งเล่ม — เดิมถูกเก็บลง book.review แล้วไม่มีหน้าจอไหนอ่านกลับมาเลย
 * ผู้ใช้จ่ายค่าตรวจไปหนึ่งเทิร์นต่อบท เห็นแค่ "พบ 13 ประเด็นที่ควรดู" วิ่งผ่านในบันทึกงาน
 * แล้วไม่มีทางรู้ว่าคืออะไร ประตูตรวจงานจึงต้องเปิดผลตรวจนั้นให้ดูได้
 */
function renderReviewPanel() {
  const panel = $('reviewPanel');
  const { chapters, total, totalCounted } = bookIssues(book?.review);
  if (!total) return panel.classList.add('hidden');
  panel.classList.remove('hidden');
  $('reviewSummary').textContent =
    `${totalCounted} ประเด็นที่ควรดู จาก ${chapters.length} บท` +
    (total > totalCounted ? ` · ข้อเสนอเรื่องลำดับอีก ${total - totalCounted} ข้อ` : '') +
    ' — กดเพื่อดูรายละเอียด แล้วคลิกแต่ละข้อเพื่อไปยังตอนนั้น';
  $('reviewList').innerHTML = chapters
    .map(
      (c) =>
        `<div class="reviewChapter"><b>บทที่ ${esc(c.n)} · ${c.counted} ประเด็น</b>` +
        (c.summary ? `<div class="sum">${esc(c.summary)}</div>` : '') +
        c.issues.map((i) => issueHtml(i, true)).join('') +
        `</div>`,
    )
    .join('');
  $('reviewList')
    .querySelectorAll('[data-review-go]')
    .forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.reviewGo;
        if (!sections.some((x) => x.id === id)) return;
        selectSection(id);
        $('secBody').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
}

async function saveSection() {
  if (!selected) return;
  const s = sections.find((x) => x.id === selected);
  const nextMd = $('secBody').value;
  if (nextMd === (s.md || '')) return ($('secStat').textContent = 'เนื้อหาไม่เปลี่ยน ไม่ต้องบันทึก');
  s.history = [
    ...(s.history || []),
    { md: s.md || '', chars: s.chars || countUnits(s.md || '', book.language), at: Date.now(), reason: 'ก่อนแก้ด้วยมือ' },
  ].slice(-20);
  s.md = nextMd;
  s.chars = countUnits(s.md, book.language);
  s.status = 'edited';
  await db.saveSection(book.id, s);
  renderSecList();
  $('secStat').textContent = `บันทึกแล้ว · ${s.chars.toLocaleString()} หน่วย`;
  $('secHistory').textContent = `ประวัติตอน (${s.history.length})`;
}

/**
 * สั่งเขียนตอนที่เลือกใหม่ทีละตอน
 *
 * ตอนที่ extract ไม่ผ่านถูกบันทึกเป็น blocked แล้วเครื่องเดินหน้าต่อ (machine.js)
 * ซึ่งถูกแล้วสำหรับการรันยาว ๆ — แต่พอมาถึงหน้าตรวจงาน ผู้ใช้เจอตอนว่างที่แก้อะไรไม่ได้เลย
 * นอกจากพิมพ์เองทั้งตอน หรือรันเล่มใหม่ทั้งเล่ม ทั้งที่ขาดอยู่ตอนเดียว
 *
 * ใช้ prompt ตัวเดียวกับที่เครื่องใช้เขียนทีละตอน จึงได้เนื้อหาที่เข้ากับเล่มเดิม
 * ทั้งเสียง โควตาความยาว จังหวะ (beats) และบริบทของตอนก่อนหน้า
 */
async function regenerateSection() {
  if (!book?.id || !selected) return;
  const rec = sections.find((x) => x.id === selected);
  const had = (rec?.md || '').trim();
  if (!confirm(had
    ? `ให้ AI เขียนตอน ${selected} ใหม่ทั้งตอนหรือไม่?

เนื้อหาปัจจุบันจะถูกเก็บไว้ในประวัติตอน กู้กลับได้`
    : `ให้ AI เขียนตอน ${selected} หรือไม่?

ตอนนี้ยังไม่มีเนื้อหา`)) return;

  const btn = $('secRegen');
  btn.disabled = true;
  try {
    const out = await writeSectionWithAi(selected, (msg) => ($('secStat').textContent = msg));
    if (!out.ok) {
      $('secStat').textContent = `เขียนตอน ${selected} ไม่สำเร็จ — ${out.error}`;
      status(`เขียนตอน ${selected} ไม่สำเร็จ`);
      return;
    }
    const now = sections.find((x) => x.id === selected);
    $('secBody').value = now.md;
    $('secStat').textContent = `เขียนใหม่แล้ว · ${now.chars.toLocaleString()} หน่วย · กดนับหน้าใหม่ก่อนส่งออก`;
    $('secHistory').textContent = `ประวัติตอน (${(now.history || []).length})`;
    status(`เขียนตอน ${selected} ใหม่เรียบร้อย`);
  } finally {
    btn.disabled = false;
    renderSecList();
    refreshEmptySectionButton();
  }
}

/** ตอนที่ยังไม่มีเนื้อหาใช้ได้จริง — ตอนที่ extract ไม่ผ่านจะถูกบันทึกเป็น blocked พร้อม md ว่าง */
const emptySections = () => sections.filter((s) => !(s.md || '').trim());

function refreshEmptySectionButton() {
  const btn = $('fillEmptySections');
  if (!btn) return;
  const n = emptySections().length;
  btn.classList.toggle('hidden', n === 0);
  btn.textContent = `เขียนตอนที่ยังว่าง (${n})`;
}

/**
 * ไล่เขียนทุกตอนที่ยังว่างในครั้งเดียว
 *
 * ตอนที่พลาดมักไม่ได้มาตอนเดียว การให้กดทีละตอนจึงเป็นงานซ้ำที่ไม่มีเหตุผล
 */
async function fillEmptySections() {
  if (!book?.id) return;
  const todo = emptySections();
  if (!todo.length) return;
  const list = todo.map((s) => `${s.id} ${s.title}`).join('\n');
  if (!confirm(`ให้ AI เขียน ${todo.length} ตอนที่ยังว่างหรือไม่?

${list}`)) return;

  const btn = $('fillEmptySections');
  btn.disabled = true;
  let done = 0;
  try {
    for (const [i, s] of todo.entries()) {
      const out = await writeSectionWithAi(s.id, (msg) => status(`(${i + 1}/${todo.length}) ${msg}`));
      if (out.ok) done++;
      else addEvent('system', `เขียนตอน ${s.id} ไม่สำเร็จ`, out.error);
      renderSecList();
    }
    status(`เขียนตอนที่ว่างแล้ว ${done}/${todo.length} ตอน${done < todo.length ? ' — ที่เหลือลองกดซ้ำอีกครั้ง' : ' · กดนับหน้าใหม่ก่อนส่งออก'}`);
  } finally {
    btn.disabled = false;
    refreshEmptySectionButton();
  }
}

/**
 * สั่งเขียนตอนเดียวด้วย AI แล้วบันทึกลงเล่ม
 *
 * ตอนที่ extract ไม่ผ่านถูกบันทึกเป็น blocked แล้วเครื่องเดินหน้าต่อ (machine.js)
 * ซึ่งถูกแล้วสำหรับการรันยาว ๆ — แต่พอมาถึงหน้าตรวจงาน ผู้ใช้เจอตอนว่างที่แก้อะไรไม่ได้เลย
 * นอกจากพิมพ์เองทั้งตอน หรือรันเล่มใหม่ทั้งเล่ม ทั้งที่ขาดอยู่ตอนเดียว
 *
 * ใช้ prompt ตัวเดียวกับที่เครื่องใช้เขียนทีละตอน จึงได้เนื้อหาที่เข้ากับเล่มเดิม
 * ทั้งเสียง โควตาความยาว จังหวะ (beats) และบริบทของตอนก่อนหน้า
 */
async function writeSectionWithAi(id, report = () => {}) {
  const rec = sections.find((x) => x.id === id);
  const outline = book.outline;
  const chapter = (outline?.chapters || []).find((c) => (c.sections || []).some((x) => x.id === id));
  const section = (chapter?.sections || []).find((x) => x.id === id);
  if (!rec || !chapter || !section) return { ok: false, error: 'ตอนนี้ไม่มีอยู่ในสารบัญแล้ว จึงสั่งเขียนใหม่ไม่ได้' };

  const flat = (outline.chapters || []).flatMap((c) => c.sections || []);
  const next = flat[flat.findIndex((x) => x.id === id) + 1] || null;

  try {
    report(`กำลังให้ ChatGPT เขียนตอน ${id}...`);
    await focusChat(book);
    const res = await sendTurn(
      makeTransport(transportKind(book), transportOpts({}, book)),
      sectionPrompt({
        book,
        outline,
        chapter,
        section,
        prevSummaries: B.prevSummaries(book.bible || B.emptyBible(), outline, id),
        nextSection: next,
      }),
      { label: `เขียนตอน ${id} ใหม่` },
      {
        onRetry: (n, max, r) => report(`เขียนตอน ${id} ยังไม่สำเร็จ กำลังลองใหม่ ${n + 1}/${max}${r?.error ? ` — ${r.error}` : ''}`),
        parse: (r) => {
          const ex = extractSection(r.text, id);
          return ex.status === 'ok'
            ? { data: ex }
            : { error: `คำตอบยังไม่ใช่เนื้อหาตอน ${id} (${ex.status}) ${answerEvidence(r.text, null)}` };
        },
      },
    );
    const ex = res?.data;
    if (!ex) return { ok: false, error: res?.error || 'ไม่ทราบสาเหตุ' };

    rec.history = [
      ...(rec.history || []),
      { md: rec.md || '', chars: rec.chars || 0, at: Date.now(), reason: 'ก่อนให้ AI เขียนใหม่' },
    ].slice(-20);
    rec.md = ex.body;
    rec.chars = countUnits(ex.body, book.language);
    rec.status = 'generated';
    rec.reason = '';
    await db.saveSection(book.id, rec);

    // ความจำของเล่มต้องรู้จักเนื้อหาใหม่ด้วย ไม่งั้นตอนถัด ๆ ไปจะอ้างของที่ถูกเขียนทับไปแล้ว
    book.bible ||= B.emptyBible();
    B.absorb(book.bible, id, ex.meta);
    await db.saveBook(book);
    await syncSharedProject(book.id);
    addEvent('system', `เขียนตอน ${id} ใหม่`, `${rec.chars.toLocaleString()} หน่วย`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function renderHistory() {
  if (!selected) return;
  const s = sections.find((x) => x.id === selected);
  const panel = $('historyPanel');
  const history = (s?.history || []).map((h) => ({ ...h, source: 'revision' }));
  // งานรุ่นเก่าอาจยังไม่มี history แต่คำตอบดิบทุก Turn ถูกเก็บไว้ตั้งแต่แรก
  // แกะตอนที่เลือกกลับออกมาเพื่อให้กู้เนื้อหาที่เคยเขียนทับไปแล้วได้
  const turns = await db.loadTurns(book.id);
  const turnHistory = turns
    .map((turn) => {
      const id = String(selected).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = String(turn.raw || '').match(new RegExp(`<<<SEC ${id} BEGIN>>>([\\s\\S]*?)<<<SEC ${id} END>>>`));
      if (!match) return null;
      const md = match[1]
        .replace(/^\s*```[\w]*\s*$/gm, '')
        .replace(/<<<META[\s\S]*$/, '')
        .trim();
      return md ? { md, chars: countUnits(md, book.language), at: turn.at, reason: `คำตอบดิบ Turn ${turn.n}`, source: 'turn' } : null;
    })
    .filter(Boolean);
  const versions = [...history, ...turnHistory]
    .filter((v, i, all) => all.findIndex((x) => x.md === v.md) === i)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!versions.length) {
    panel.innerHTML = '<div class="muted">ตอนนี้ยังไม่มีฉบับก่อนหน้า</div>';
  } else {
    panel.innerHTML = versions
      .map((h, i) => ({ h, i }))
      .reverse()
      .map(({ h, i }) => {
        const when = h.at ? new Date(h.at).toLocaleString('th-TH') : 'ไม่ทราบเวลา';
        const preview = String(h.md || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(ฉบับว่าง)';
        return `<div class="historyItem"><div class="meta"><b>${esc(when)}</b> · ${(h.chars || 0).toLocaleString()} หน่วย${h.reason ? ` · ${esc(h.reason)}` : ''}<div class="preview">${esc(preview)}</div></div><button data-restore="${i}">กู้คืนฉบับนี้</button></div>`;
      })
      .join('');
    panel.querySelectorAll('[data-restore]').forEach((btn) => (btn.onclick = () => restoreVersion(versions[Number(btn.dataset.restore)])));
  }
  panel.classList.toggle('hidden');
}

async function restoreVersion(old) {
  const s = sections.find((x) => x.id === selected);
  if (!old || !confirm('กู้คืนเนื้อหาฉบับนี้หรือไม่? ฉบับปัจจุบันจะถูกเก็บไว้ในประวัติ ไม่สูญหาย')) return;
  s.history = [
    ...(s.history || []),
    { md: s.md || '', chars: s.chars || 0, at: Date.now(), reason: 'ก่อนกู้คืน' },
  ].slice(-20);
  s.md = old.md || '';
  s.chars = countUnits(s.md, book.language);
  s.status = 'restored';
  await db.saveSection(book.id, s);
  $('secBody').value = s.md;
  $('secStat').textContent = `กู้คืนแล้ว · ${s.chars.toLocaleString()} หน่วย · กดนับหน้าใหม่ก่อนส่งออก`;
  $('secHistory').textContent = `ประวัติตอน (${s.history.length})`;
  renderSecList();
  $('historyPanel').classList.add('hidden');
}

async function recount() {
  status('กำลังนับหน้าใหม่');
  $('recount').disabled = true;
  try {
    const assets = await db.loadAssets(book.id);
    const { pages, ms } = await compileBook({ book, outline: book.outline, sections, assets });
    book.padPages = pages.physical % 2 === 1 ? 1 : 0;
    book.finalPages = pages.physical + book.padPages;
    book.lastCompile = { pages: pages.physical, ms, at: Date.now() };
    await db.saveBook(book);
    $('editPages').textContent = `${pages.physical} / ${expectedPhysicalPages(book)} หน้ารวม · เนื้อหา ${book.targetPages} หน้า (${ms} ms)`;
    showPages(pages.physical, expectedPhysicalPages(book), book.pageTolerance ?? 2);
    addEvent('system', 'นับหน้าใหม่', `ได้ ${pages.physical} หน้า คอมไพล์ ${ms} มิลลิวินาที`);
  } catch (e) {
    fail(e);
  } finally {
    $('recount').disabled = false;
    status('รอคุณตรวจงาน');
  }
}

async function proceed() {
  $('editor').classList.add('hidden');
  book = await db.loadBook(book.id);
  if (book.job?.step === 'gate_images') {
    await openImagePhaseGate();
    return;
  }
  book.job.step = 'style';
  await db.saveBook(book);
  showRunningCost();
  makeMachine();
  try {
    await runMachine();
  } catch (e) {
    fail(e);
  }
}

/** "เมื่อกี้" กับ "เมื่อวาน" ต้องแยกออกจากกันได้ ไม่งั้นข้อความเก่าจะดูเหมือนเพิ่งเกิดขึ้น */
function sinceText(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return ` · ${sec} วินาทีที่แล้ว`;
  const min = Math.round(sec / 60);
  if (min < 60) return ` · ${min} นาทีที่แล้ว`;
  const hr = Math.round(min / 60);
  return hr < 24 ? ` · ${hr} ชั่วโมงที่แล้ว` : ` · ${Math.round(hr / 24)} วันที่แล้ว`;
}

// ---------- Phase 2: หน้าจอเดียวจบ ----------
/**
 * หน้านี้เคยเป็นย่อหน้ายาวประโยคเดียวที่ยัดทุกอย่างไว้ด้วยกัน — จำนวนรูป คำเตือน
 * เหตุผลที่รอบก่อนพัง และวิธีใช้งาน — อ่านแล้วไม่รู้ว่าขาดรูปไหนและต้องทำอะไรต่อ
 * ส่วนความคืบหน้าตอนรันอยู่คนละการ์ดซึ่งถูกซ่อนทุกครั้งที่เด้งกลับมา
 *
 * เขียนใหม่เป็น "หน้าจอเดียวจบ": รายการรูปทีละแถวพร้อมสถานะจริงและปุ่มของแถวนั้น
 * กล่องแจ้งเหตุแยกออกมาชัด ๆ และตอนรันก็อัปเดตในหน้าเดิม ไม่กระโดดไปไหน
 */
let phase2Running = false;
let phase2Stage = null; // { name, text } ของรูปที่กำลังทำอยู่
let phase2Rendering = false;

const PHASE2_STATE = {
  done: { mark: '✓', cls: 'ok' },
  failed: { mark: '✕', cls: 'bad' },
  running: { mark: '⟳', cls: 'running' },
  todo: { mark: '○', cls: 'todo' },
};

/**
 * จับไฟล์เข้าช่องด้วยชื่อ — รองรับชื่อที่ระบบปฏิบัติการเติมท้ายให้
 * เช่น "cover-front (1).png" หรือ "fig-6.1-1 copy.png" ก็ยังเข้าช่องเดิมถูก
 */
function matchImageSlot(fileName, slots) {
  const norm = (v) =>
    String(v)
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9.]+/g, '');
  const f = norm(fileName);
  if (!f) return null;
  return slots.find((s) => norm(s) === f) || slots.find((s) => f.includes(norm(s))) || null;
}

/** ชื่อไฟล์ที่ pickImage ต้องการ: ปกกับรูปผู้เขียนส่งชื่อแบบไม่มีนามสกุล */
const uploadSlotFor = (name) =>
  name === 'cover-front.png' || name === 'cover-back.png' || name === 'author-photo.png'
    ? name.replace(/\.png$/, '')
    : name;

/**
 * บอก "ทำอะไรต่อ" ไม่ใช่แค่บอกว่าพัง
 *
 * ความล้มเหลวของ Phase 2 มีอยู่ไม่กี่แบบ และแต่ละแบบมีทางแก้คนละทางสิ้นเชิง
 * ถ้าโชว์แต่ข้อความดิบที่ ChatGPT พ่นมา ผู้ใช้จะกด "สร้างใหม่" ซ้ำ ๆ กับปัญหาที่กดซ้ำไม่มีวันหาย
 */
function phase2Advice(reason) {
  const r = String(reason || '');
  if (/ตีความว่าเป็นงานแก้ภาพ|แก้ไขภาพ|ขอไฟล์ต้นฉบับ|source image|edit/i.test(r))
    return 'ทางแก้: ตรวจว่าโมเดลที่เลือกอยู่ในแท็บ ChatGPT สร้างภาพได้จริง (โมเดลสายคิดก่อนตอบบางตัวปิดเครื่องมือสร้างภาพไว้) แล้วกดสร้างใหม่ · ถ้ายังไม่ได้ ใช้ “คัดลอก Prompt” ไปสร้างที่อื่นแล้วกดอัปโหลด';
  if (/prompt_not_sent|ค้างอยู่ในช่อง|กดส่งไม่ติด/i.test(r))
    return 'ทางแก้: Prompt ถูกวางในช่องพิมพ์แล้วแต่กดส่งไม่ติด — ไปที่แท็บ ChatGPT กด Enter ส่งเองหนึ่งครั้ง แล้วกลับมากด “ภาพเสร็จแล้ว → ดึงมาเลย” หรือกด “สร้างใหม่” ให้ระบบส่งใหม่';
  if (/เปิดห้องแชตใหม่|ห้องเดิม|ห้องแชตใหม่|new_thread/i.test(r))
    return 'ทางแก้: เปิดแท็บ chatgpt.com ค้างไว้ที่หน้าแชต (ไม่ใช่หน้าอื่นของเว็บ) แล้วกดสร้างใหม่';
  if (/ดึง bytes ไม่ได้|0 byte|ไฟล์ภาพว่าง/i.test(r))
    return 'ทางแก้: ภาพวาดเสร็จแล้วแต่ดึงไฟล์ไม่ได้ — กด “ภาพเสร็จแล้ว → ดึงมาเลย” ที่แถวนี้';
  if (/Thinking|กำลังคิด/i.test(r))
    return 'ทางแก้: อ่านคำตอบตอนยังคิดไม่จบ — กดสร้างใหม่ได้เลย';
  if (/เครื่องมือสร้างภาพของตัวเองล้มเหลว|ชนลิมิตการสร้างภาพ/i.test(r))
    return 'ทางแก้: เป็นฝั่ง ChatGPT ไม่ใช่คำสั่งของเรา — ลองพิมพ์ “วาดรูปแมว” ในแท็บนั้นเอง ถ้าก็ล้มเหมือนกันแปลว่าชนลิมิตสร้างภาพ ต้องรอสักพักหรือเปลี่ยนบัญชี ระหว่างนี้ใช้ “คัดลอก Prompt” ไปสร้างที่อื่นแล้วอัปโหลดได้';
  if (/ภาพที่เห็นในคำตอบ/i.test(r))
    return 'ทางแก้: ระบบเห็นภาพในหน้าแล้วแต่ไม่นับว่าเป็นภาพใหม่ของรูปนี้ — กด “ภาพเสร็จแล้ว → ดึงมาเลย” ที่แถวนี้เพื่อเก็บภาพล่าสุดเข้าช่องทันที';
  return 'ทางแก้: กด “สร้างใหม่” อีกครั้ง หรือใช้ “คัดลอก Prompt” ไปสร้างที่อื่นแล้วกดอัปโหลด';
}

function phase2Rows(assets) {
  const have = new Map(assets.map((a) => [a.name, a]));
  const missing = new Set(phase2MissingNames(book, assets));
  const failures = new Map((book.imagePhase?.failures || []).map((f) => [f.name, f.reason]));
  const rows = plannedImageJobs(book).map((j) => {
    const running = phase2Running && phase2Stage?.name === j.name;
    const state = running ? 'running' : !missing.has(j.name) ? 'done' : failures.has(j.name) ? 'failed' : 'todo';
    // ปกที่ควรเป็นสีแต่ไฟล์ไม่มีสีเลย ต้องเห็นตั้งแต่ตรงนี้ ไม่ใช่ไปเจอตอนเปิด PDF
    const asset = have.get(j.name);
    // ลวดลายพื้นหลังถูกลดความเข้มเหลือไม่กี่เปอร์เซ็นต์ตั้งแต่ตอนบันทึก
    // ตัวตรวจ "มีสีไหม" จึงอ่านว่าไม่มีสีเป็นเรื่องปกติของมัน ไม่ใช่ความผิดพลาดที่ต้องเตือน
    const wantsColour = (j.kind === 'cover' || !j.grayscale) && j.kind !== 'pattern';
    const colourWarn = wantsColour && asset?.meta && asset.meta.hasColour === false ? ' · ⚠ ไฟล์นี้ไม่มีสีเลย' : '';
    const note = running
      ? phase2Stage.text
      : state === 'done'
        ? `บันทึกแล้ว · ${j.name}${colourWarn}`
        : state === 'failed'
          ? `ล้มเหลว: ${failures.get(j.name)} — ${phase2Advice(failures.get(j.name))}`
          : `ยังไม่มีไฟล์ · ${j.name}`;
    return {
      name: j.name,
      what: j.what,
      state,
      note,
      // ตำแหน่งในเล่มกับสเปกไฟล์ ต้องเห็นได้ตลอด ไม่ใช่เห็นเฉพาะตอนพัง
      // คนที่จะไปสร้างภาพเองต้องรู้ทั้งสองอย่างพร้อมกันถึงจะวางถูกที่ตั้งแต่ครั้งแรก
      where: j.where || '',
      spec: j.spec || '',
      caption: j.caption || '',
      canRegen: true,
    };
  });

  /**
   * รูปผู้เขียนไม่ได้สร้างด้วย ChatGPT แต่มีสองอย่างที่รอมันอยู่ จึงต้องอยู่ในรายการเดียวกัน
   * ปกหลังรอไว้แปะ และตอนนี้ยังมีการแนบไปให้โมเดลดูตอนสร้างภาพด้วย
   * ถ้านับแค่กรณีแรก คนที่เลือกแนบอย่างเดียวจะไม่เห็นช่องอัปโหลดเลย แล้วภาพจะออกมาเป็นหน้าคนอื่น
   */
  const refWhere = authorRefSummary(book);
  if (book.authorPhotoOnCover || refWhere) {
    const ok = have.has('author-photo.png');
    const waiting = [book.authorPhotoOnCover && 'ปกหลังรอไว้แปะ', refWhere && `แนบไปให้โมเดลดูตอนสร้าง ${refWhere}`]
      .filter(Boolean)
      .join(' · ');
    rows.push({
      name: 'author-photo.png',
      what: 'รูปผู้เขียน (อัปโหลดเอง)',
      state: ok ? 'done' : 'todo',
      note: ok ? `บันทึกแล้ว · ${waiting}` : `${waiting} — ต้องอัปโหลดเอง ระบบสร้างให้ไม่ได้`,
      canRegen: false,
    });
  }
  return rows;
}

function phase2AlertHtml() {
  const ip = book.imagePhase || {};
  if (phase2Running) return '';
  if (ip.status === 'skipped')
    return `<div class="p2Alert"><b>เล่มนี้ข้าม Phase 2 ไว้</b>ตำแหน่งภาพยังเป็นช่องว่าง กดเริ่มเมื่อไรก็สร้างต่อได้</div>`;

  const stoppedNewer = (ip.stoppedAt || 0) >= (ip.verifiedAt || 0);
  const at = Math.max(ip.lastAttemptAt || 0, ip.verifiedAt || 0, ip.stoppedAt || 0, ip.lastSavedAt || 0);
  if (!at) return '';
  const what = stoppedNewer ? ip.currentWhat || ip.failedWhat : ip.failedWhat;
  const why = stoppedNewer ? ip.stoppedReason || ip.failedReason : ip.failedReason;
  if (!what && !why) return '';
  // ทางตันที่พบบ่อยที่สุด: ยังไม่มี Prompt ปก เพราะ Art Director ตอบไม่ครบ
  // ต้องมีปุ่มแก้อยู่ในกล่องแจ้งเหตุเลย ไม่ใช่ให้ไปหาปุ่มเองว่าอันไหนคือทางออก
  const needsCover = book.coverMode === 'auto' && !book.coverPrompts?.front;
  return (
    `<div class="p2Alert bad"><b>รอบที่แล้ว${sinceText(at)} — ${esc(what || 'หยุดกลางคัน')}</b>` +
    `${esc(why || 'ไม่มีรายละเอียดเพิ่มเติม')}` +
    (needsCover
      ? '<br><br>เล่มนี้ยังไม่มี Prompt ปกเลย จึงสร้างปกต่อไม่ได้ — กดปุ่มนี้ให้ GPT ออกแบบปกใหม่ทั้งชุดก่อน' +
        '<br><button type="button" data-p2-recover class="primary inline">ให้ GPT ออกแบบปกใหม่</button>'
      : '') +
    '</div>'
  );
}

function phase2Notice(html, bad = false) {
  const box = $('phase2Alert');
  if (!box) return;
  box.classList.remove('hidden');
  box.classList.toggle('bad', !!bad);
  box.innerHTML = html;
}

/**
 * ทางมือ 1: ผู้ใช้เห็นกับตาว่า ChatGPT วาดเสร็จแล้ว แล้วกดให้ไปดึงมาใส่ช่องนี้เดี๋ยวนี้
 * ไม่ต้องรอตัวตรวจจับอัตโนมัติ ซึ่งเป็นจุดที่พังบ่อยที่สุด
 */
async function grabImageFromChat(name) {
  if (!book?.id) return;
  phase2Notice('<b>กำลังดึงภาพล่าสุดจากแท็บ ChatGPT...</b>');
  status('กำลังดึงภาพจาก ChatGPT');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'sw.grabImage' });
    if (!res?.ok) {
      const seen = res?.seen?.length ? `<br>ภาพที่เห็นในหน้านั้น: ${esc(res.seen.join(' | '))}` : '';
      throw new Error(`${res?.error || 'ดึงภาพไม่สำเร็จ'}${seen}`);
    }
    book = await db.loadBook(book.id);
    const meta = await ingestImageDataUrl(book, name, res.dataUrl);
    book.imagePhase = {
      ...(book.imagePhase || {}),
      failures: (book.imagePhase?.failures || []).filter((f) => f.name !== name),
    };
    await db.saveBook(book);
    await syncSharedProject(book.id);
    addEvent('system', 'ดึงภาพจาก ChatGPT ด้วยมือ', `${name} · ${meta.widthPx || '?'}×${meta.heightPx || '?'}px`);
    const busyOnThis = phase2Running && phase2Stage?.name === name;
    phase2Notice(
      `<b>ใส่ภาพลงช่อง ${esc(name)} แล้ว</b>` +
        `${meta.widthPx ? `${meta.widthPx}×${meta.heightPx}px` : ''}` +
        (busyOnThis ? '<br>ระบบยังรอเทิร์นของรูปนี้อยู่ — กด “หยุด” แล้ว “ทำต่อ” เพื่อข้ามไปรูปถัดไปได้เลย' : ''),
    );
    await renderPhase2();
    await renderCoverPreview();
    status('ดึงภาพสำเร็จ');
  } catch (e) {
    phase2Notice(`<b>ดึงภาพไม่สำเร็จ</b>${e?.message || e}`, true);
    status('ดึงภาพไม่สำเร็จ');
  }
}

/**
 * ทางมือ 3: สร้างครบทุกรูปที่ไหนก็ได้ ตั้งชื่อไฟล์ตามช่อง แล้วโยนเข้ามาทีเดียว
 * เหมาะกับการนั่งสร้างรวดเดียวแล้วค่อยกลับมาประกอบ ไม่ต้องมาทีละรูป
 */
async function bulkUploadImages(files) {
  if (!book?.id || !files.length) return;
  const jobs = plannedImageJobs(book);
  const slots = jobs.map((j) => j.name).concat(needsAuthorPhoto(book) ? ['author-photo.png'] : []);
  const done = [];
  const skipped = [];

  phase2Notice(`<b>กำลังใส่ ${files.length} ไฟล์...</b>`);
  for (const file of files) {
    const slot = matchImageSlot(file.name, slots);
    if (!slot) {
      skipped.push(file.name);
      continue;
    }
    try {
      if (jobs.some((j) => j.name === slot)) {
        await ingestImageDataUrl(book, slot, await db.blobToDataUrl(file));
      } else {
        const { blob, w, h } = await normalizeImage(file, { grayscale: false });
        await db.saveAsset(book.id, slot, blob, { w, h, from: file.name });
      }
      done.push(slot);
    } catch (e) {
      skipped.push(`${file.name} (${e?.message || e})`);
    }
  }

  book = await db.loadBook(book.id);
  book.imagePhase = {
    ...(book.imagePhase || {}),
    autoInteriorExportedAt: null,
    autoBookExportedAt: null,
    autoCoverExportedAt: null,
    failures: (book.imagePhase?.failures || []).filter((f) => !done.includes(f.name)),
  };
  await db.saveBook(book);
  await syncSharedProject(book.id);
  assetNames = (await db.loadAssets(book.id)).map((a) => a.name);
  await renderPhase2();
  await renderCoverPreview();
  addEvent('system', 'อัปโหลดหลายรูป', `ใส่แล้ว ${done.length} รูป${skipped.length ? ` · ข้าม ${skipped.length}` : ''}`);
  phase2Notice(
    `<b>ใส่ภาพแล้ว ${done.length} รูป${skipped.length ? ` · ใส่ไม่ได้ ${skipped.length} ไฟล์` : ''}</b>` +
      (done.length ? `เข้าช่อง: ${esc(done.join(', '))}` : '') +
      (skipped.length ? `<br>ไม่รู้จักชื่อหรือไม่ผ่านตรวจ: ${esc(skipped.join(' · '))}` : ''),
    !done.length,
  );
  status(`ใส่ภาพแล้ว ${done.length} รูป`);
}

/**
 * ทางมือ 4: วางไฟล์ไว้ในโฟลเดอร์โครงการ แล้วให้ระบบมาเก็บเอง
 *
 * ต่างจากการคว้าภาพจากหน้าแชตตรงที่ไม่มีเงื่อนเวลา — ภาพในแชตหายไปพร้อมห้องที่ถูกเปลี่ยน
 * แต่ไฟล์ในโฟลเดอร์อยู่ได้ตลอด จะสร้างที่ไหน เมื่อไร ด้วยเครื่องมืออะไรก็ได้
 * ตั้งชื่อไฟล์ให้ตรงช่อง (cover-front.png, fig-1.1-1.png ฯลฯ) แล้วโยนลงโฟลเดอร์
 */
async function pullImagesFromFolder() {
  if (!book?.id) return;
  const jobs = plannedImageJobs(book);
  const slots = new Map(jobs.map((j) => [j.name, j]));
  if (needsAuthorPhoto(book)) slots.set('author-photo.png', { name: 'author-photo.png' });

  phase2Notice('<b>กำลังอ่านโฟลเดอร์รับรูปของโครงการ...</b>');
  let files = [];
  try {
    files = await W.readDroppedImages(book.id);
  } catch (e) {
    return phase2Notice(`<b>อ่านโฟลเดอร์ไม่ได้</b>${esc(e?.message || e)}`, true);
  }

  if (!files.length) {
    const dirHint = `_EbookAuto/images/${String(book.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    return phase2Notice(
      '<b>ยังไม่มีไฟล์ในโฟลเดอร์รับรูป</b>' +
        `วางไฟล์ไว้ที่ <b>${esc(dirHint)}</b> ในโฟลเดอร์ Shared Workspace แล้วกดปุ่มนี้อีกครั้ง<br>` +
        'ตั้งชื่อไฟล์ให้ตรงกับชื่อที่กำกับไว้ในแต่ละแถว เช่น cover-front.png หรือ fig-1.1-1.png',
      true,
    );
  }

  const done = [];
  const skipped = [];
  for (const f of files) {
    if (!slots.has(f.name)) {
      skipped.push(`${f.name} (ไม่ตรงกับช่องไหน)`);
      continue;
    }
    try {
      const dataUrl = await db.blobToDataUrl(f.blob);
      book = await db.loadBook(book.id);
      const meta = await ingestImageDataUrl(book, f.name, dataUrl);
      book.imagePhase = {
        ...(book.imagePhase || {}),
        failures: (book.imagePhase?.failures || []).filter((x) => x.name !== f.name),
      };
      await db.saveBook(book);
      done.push(`${f.name} (${meta.widthPx || '?'}×${meta.heightPx || '?'}px)`);
      await W.removeDroppedImage(book.id, f.name).catch(() => {});
    } catch (e) {
      skipped.push(`${f.name} (${e?.message || e})`);
    }
  }

  if (done.length) {
    await syncSharedProject(book.id);
    addEvent('system', 'ดึงรูปจากโฟลเดอร์โครงการ', done.join('\n'));
  }
  phase2Notice(
    `<b>ดึงจากโฟลเดอร์แล้ว ${done.length} รูป</b>` +
      (done.length ? `เข้าช่อง: ${esc(done.join(', '))}` : '') +
      (skipped.length ? `<br>ข้ามไป: ${esc(skipped.join(' · '))}` : ''),
    !done.length,
  );
  await renderPhase2();
  await renderCoverPreview();
  status(`ดึงรูปจากโฟลเดอร์ ${done.length} รูป`);
}

/** ทางมือ 2: เอา Prompt ไปสร้างที่ไหนก็ได้ แล้วกลับมาอัปโหลดเอง */
async function copyImagePrompt(name) {
  const prompt = promptForImage(book, name);
  if (!prompt) return phase2Notice('<b>ยังไม่มี Prompt ของช่องนี้</b>ต้องให้ระบบเตรียม Prompt ก่อน', true);
  try {
    await navigator.clipboard.writeText(prompt);
    phase2Notice(
      `<b>คัดลอก Prompt ของ ${esc(name)} แล้ว</b>` +
        `เอาไปวางในเครื่องมือสร้างภาพไหนก็ได้ แล้ว<b>ตั้งชื่อไฟล์ว่า ${esc(name)}</b> ` +
        'จะกดอัปโหลดทีละรูป หรือสร้างครบทุกรูปแล้วกด “อัปโหลดหลายรูปพร้อมกัน” ทีเดียวก็ได้',
    );
  } catch (e) {
    phase2Notice(`<b>คัดลอกไม่สำเร็จ</b>${esc(e?.message || e)}`, true);
  }
}

async function renderPhase2() {
  if (!book?.id || phase2Rendering) return;
  phase2Rendering = true;
  try {
    const assets = await db.loadAssets(book.id);
    assetNames = assets.map((a) => a.name);
    const rows = phase2Rows(assets);
    const total = rows.length;
    const done = rows.filter((r) => r.state === 'done').length;
    const left = total - done;

    $('phase2Count').textContent = total
      ? `ผ่านแล้ว ${done} จาก ${total} รูป · ยังขาด ${left}`
      : 'เล่มนี้ไม่ได้ตั้งค่าให้สร้างภาพอัตโนมัติ';
    $('phase2Bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';

    const alertHtml = phase2AlertHtml();
    $('phase2Alert').innerHTML = alertHtml;
    $('phase2Alert').classList.toggle('hidden', !alertHtml);
    $('phase2Alert').querySelector('[data-p2-recover]')?.addEventListener('click', rethinkCoverWithGpt);

    $('phase2Live').classList.toggle('hidden', !phase2Running);
    if (phase2Running)
      $('phase2Live').textContent = phase2Stage?.text || 'กำลังเชื่อมต่อหน้าต่าง ChatGPT...';

    $('phase2List').innerHTML = rows
      .map((r) => {
        const st = PHASE2_STATE[r.state];
        /**
         * ปุ่มทางมือต้องอยู่ตลอด รวมถึงตอนที่ระบบกำลังเดินเครื่องอยู่
         *
         * เดิมซ่อนทั้งแถวเมื่อ phase2Running ซึ่งกลับหัวกลับหางกับความจริง
         * เพราะจังหวะที่ผู้ใช้ต้องใช้ปุ่มพวกนี้มากที่สุด คือตอนที่ระบบค้างรอภาพที่ ChatGPT
         * วาดเสร็จไปแล้วบนจอตรงหน้า มีแต่ "สร้างใหม่" ที่ต้องซ่อน เพราะมันสั่งเริ่ม Phase 2 ซ้อน
         */
        const acts =
          `<div class="acts">` +
          (r.canRegen && r.state !== 'done'
            ? `<button data-p2-grab="${esc(r.name)}" title="ถ้าเห็นว่า ChatGPT วาดเสร็จแล้ว กดปุ่มนี้เพื่อดึงภาพล่าสุดมาใส่ช่องนี้เลย">ภาพเสร็จแล้ว → ดึงมาเลย</button>`
            : '') +
          (r.canRegen ? `<button data-p2-prompt="${esc(r.name)}">คัดลอก Prompt</button>` : '') +
          (r.canRegen && !phase2Running ? `<button data-p2-regen="${esc(r.name)}">สร้างใหม่</button>` : '') +
          `<button data-p2-upload="${esc(r.name)}">อัปโหลด</button></div>`;
        return (
          `<div class="p2Row ${st.cls}" data-p2-row="${esc(r.name)}"><div class="mark">${st.mark}</div>` +
          `<div class="who"><b>${esc(r.what)}</b>` +
          (r.where ? `<span class="p2Where">📍 ${esc(r.where)}</span>` : '') +
          (r.caption ? `<span class="p2Cap">ภาพนี้เล่าเรื่อง: ${esc(r.caption)}</span>` : '') +
          `<span class="p2Spec">📄 ตั้งชื่อไฟล์ว่า <b>${esc(r.name)}</b>${r.spec ? ` · ${esc(r.spec)}` : ''}</span>` +
          `<span class="p2Note">${esc(r.note)}</span></div>${acts}</div>`
        );
      })
      .join('');

    $('phase2List')
      .querySelectorAll('[data-p2-regen]')
      .forEach((b) => (b.onclick = () => regenerateImageAsset(b.dataset.p2Regen)));
    $('phase2List')
      .querySelectorAll('[data-p2-upload]')
      .forEach((b) => (b.onclick = () => pickImage(uploadSlotFor(b.dataset.p2Upload))));
    /**
     * หน้านี้คือที่ที่ผู้ใช้ยืนอยู่จริงตอนใส่รูป ไม่ใช่การ์ดภาพในหน้าแก้ไข
     * ถ้าเล็งช่องได้เฉพาะที่นั่น การวางด้วย Ctrl+V จะใช้ไม่ได้เลยในทางปฏิบัติ
     */
    $('phase2List')
      .querySelectorAll('[data-p2-row]')
      .forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('button') || e.target.closest('details')) return;
          aimSlot(uploadSlotFor(row.dataset.p2Row), row);
        });
      });
    $('phase2List')
      .querySelectorAll('[data-p2-grab]')
      .forEach((b) => (b.onclick = () => grabImageFromChat(b.dataset.p2Grab)));
    $('phase2List')
      .querySelectorAll('[data-p2-prompt]')
      .forEach((b) => (b.onclick = () => copyImagePrompt(b.dataset.p2Prompt)));

    renderCoverDirections();
    $('phase2Stop').classList.toggle('hidden', !phase2Running);
    $('phase2Skip').classList.toggle('hidden', phase2Running);
    $('phase2Edit').classList.toggle('hidden', phase2Running);
    const start = $('phase2Start');
    start.disabled = phase2Running;
    start.textContent = phase2Running
      ? 'กำลังทำงาน...'
      : !left
        ? 'ภาพครบแล้ว — ตรวจและประกอบ PDF'
        : book.imagePhase?.startedAt
          ? `ทำต่อ — เหลือ ${left} รูป`
          : `เริ่มสร้างภาพ ${left} รูป`;
  } finally {
    phase2Rendering = false;
  }
}

/**
 * ให้เลือกแนวปกเองได้
 *
 * GPT Art Director เสนอมา 3 ทางและเก็บไว้ครบใน book.coverConsultation.directions
 * แต่ระบบหยิบทางที่ GPT แนะนำมาใช้เองเงียบ ๆ (this.book.style = recommended)
 * ผู้ใช้จึงได้ปกแนวเดิมซ้ำ ๆ โดยไม่มีทางรู้ว่ามีอีกสองทางให้เลือก และไม่มีทางเปลี่ยน
 * นอกจากสั่งให้ GPT คิดใหม่ทั้งชุด ซึ่งเปลืองข้อความและอาจได้แนวเดิมกลับมาอีก
 */
function renderCoverDirections() {
  const box = $('coverDirections');
  const dirs = book?.coverConsultation?.directions || [];
  const canPick = !['none', 'upload'].includes(book?.coverMode || 'prompt');
  if (!box) return;
  if (!dirs.length || !canPick || phase2Running) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  const currentId = book.style?.id || book.coverConsultation?.recommended_id;
  const jury = book.coverConsultation?.jury || null;
  const scoreOf = (id) => (jury?.scores || []).find((s) => s?.id === id) || null;
  const digest = book.coverDigest || null;
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="p2DirsHead"><b>แนวปก — เลือกได้ ${dirs.length} ทาง</b>` +
    (digest?.one_line
      ? `<span class="muted">ย่อจากเนื้อในจริง: ${esc(digest.one_line)}${digest.energy?.level ? ` · อารมณ์ ${esc(digest.energy.label || '')} ระดับ ${esc(String(digest.energy.level))}/5` : ''}</span>`
      : '') +
    (jury?.revision_notes ? `<span class="muted">กรรมการสั่งแก้ทางที่ชนะแล้ว: ${esc(jury.revision_notes)}</span>` : '') +
    `<span class="muted">เปลี่ยนแนวแล้วระบบจะเขียน Prompt ปกใหม่และลบภาพปกเดิมให้ เพื่อสร้างใหม่ตามแนวที่เลือก</span></div>` +
    `<div class="p2DirGrid">` +
    dirs
      .map((d, n) => {
        const id = d.id || String.fromCharCode(65 + n);
        const on = id === currentId;
        const swatches = (d.palette || [])
          .filter((c) => /^#[0-9a-f]{3,8}$/i.test(c?.hex || ''))
          .map((c) => `<i style="background:${esc(c.hex)}" title="${esc(c.name || c.hex)}"></i>`)
          .join('');
        const sc = scoreOf(id);
        return (
          `<div class="p2Dir${on ? ' on' : ''}">` +
          `<h4>${esc(id)}. ${esc(d.name || 'ไม่มีชื่อแนว')}${sc?.total != null ? ` <em>· ${esc(String(sc.total))} คะแนน</em>` : ''}${on ? ' <em>· กำลังใช้อยู่</em>' : ''}</h4>` +
          `<div class="sw">${swatches}</div>` +
          (d.sales_angle ? `<p><b>มุมขาย:</b> ${esc(d.sales_angle)}</p>` : '') +
          (d.visual_metaphor ? `<p><b>ภาพที่จะได้:</b> ${esc(d.visual_metaphor)}</p>` : '') +
          (d.human_render_style ? `<p><b>คนบนปก:</b> ${esc(d.human_render_style)}</p>` : '') +
          (sc?.verdict ? `<p><b>กรรมการ:</b> ${esc(sc.verdict)}</p>` : '') +
          (sc?.fatal ? `<p class="muted">จุดตาย: ${esc(sc.fatal)}</p>` : '') +
          (d.mood ? `<p class="muted">${esc(d.mood)}</p>` : '') +
          (on ? '' : `<button data-cover-dir="${esc(id)}">ใช้แนวนี้</button>`) +
          `</div>`
        );
      })
      .join('') +
    `</div>`;

  box.querySelectorAll('[data-cover-dir]').forEach((b) => {
    b.onclick = () => applyCoverDirection(b.dataset.coverDir);
  });
}

async function applyCoverDirection(id) {
  const dirs = book?.coverConsultation?.directions || [];
  const dir = dirs.find((d, n) => (d.id || String.fromCharCode(65 + n)) === id);
  if (!dir) return;
  if (!confirm(`เปลี่ยนไปใช้แนว “${dir.name || id}” หรือไม่?\n\nภาพปกหน้า/ปกหลังเดิมจะถูกลบ แล้วต้องกดสร้างใหม่ตามแนวนี้`)) return;

  book = await db.loadBook(book.id);
  book.style = dir;
  book.coverLayout = dir.typography || book.coverLayout;
  book.coverPrompts = {
    front: frontCoverPrompt(dir, book, book.outline),
    back: backCoverPrompt(dir, book),
  };
  book.coverDesignVersion = 6;
  book.coverConsultation = { ...(book.coverConsultation || {}), chosen_id: dir.id || id, chosenAt: Date.now() };

  // ปกเดิมเป็นของแนวเก่า เก็บไว้ก็ใช้ไม่ได้ ต้องลบเพื่อให้ Phase 2 เห็นว่า "ยังขาด"
  await db.deleteAsset(book.id, 'cover-front.png').catch(() => {});
  await db.deleteAsset(book.id, 'cover-back.png').catch(() => {});
  book.imagePhase = {
    ...(book.imagePhase || {}),
    status: 'ready',
    failedName: null,
    failedWhat: null,
    failedReason: null,
    failures: (book.imagePhase?.failures || []).filter((f) => !String(f.name).startsWith('cover-')),
  };
  book.job ||= {};
  book.job.step = 'gate_images';
  book.job.status = 'paused';
  book.job.error = null;
  book.job.imageThreadStarted = false;

  await db.saveBook(book);
  await syncSharedProject(book.id);
  addEvent('system', 'เปลี่ยนแนวปก', `${dir.id || id}. ${dir.name || ''}\n${dir.visual_metaphor || ''}`);
  await openImagePhaseGate();
}

// ---------- Image Workflow 2 Phase ----------
function phase2RequiredNames(b) {
  const names = [];
  if (b?.coverMode === 'auto' && b.coverPrompts) names.push('cover-front.png', 'cover-back.png');
  if (b?.figureMode === 'auto') {
    for (const f of b.figures || []) if (f.kind === 'image' && f.prompt && f.name) names.push(f.name);
  }
  return names;
}

function phase2MissingNames(b, assets = []) {
  const required = phase2RequiredNames(b);
  const byName = new Map(assets.map((a) => [a.name, a]));
  return required.filter((name) => {
    const asset = byName.get(name);
    if (!asset) return true;
    // ปกจาก workflow รุ่นเก่าอาจมีข้อความฝังหรือขนาดผิด ต้องถือว่ายังขาดจนกว่าจะเป็น artwork รุ่นใหม่
    if ((name === 'cover-front.png' || name === 'cover-back.png') && b?.coverMode === 'auto') {
      // ปกหน้าแบบ baked ตั้งใจให้มีตัวหนังสือ ห้ามเอาเกณฑ์ "artwork เปล่า" ไปตัดสินว่ายังขาด
      const needsCleanArtwork = !(name === 'cover-front.png' && coverTextBaked(b));
      return (needsCleanArtwork && !asset.meta?.artworkOnly) || (asset.meta?.generationVersion || 0) < 5;
    }
    return false;
  });
}

function coverPreviewColor(role) {
  const palette = book?.style?.palette || [];
  const idx = { palette_1: 0, palette_2: 1, palette_3: 2 }[role] ?? 2;
  return palette[idx]?.hex || '#F6F1E7';
}

function applyCoverPreviewZone(el, zone = {}, fallback = {}) {
  const x = Number(zone.x_pct ?? fallback.x_pct ?? 8);
  const y = Number(zone.y_pct ?? fallback.y_pct ?? 8);
  const width = Number(zone.width_pct ?? fallback.width_pct ?? 84);
  const size = Number(zone.size_scale ?? fallback.size_scale ?? 1);
  el.style.left = `${Math.max(0, Math.min(96, x))}%`;
  el.style.top = `${Math.max(0, Math.min(96, y))}%`;
  el.style.width = `${Math.max(20, Math.min(96 - x, width))}%`;
  el.style.textAlign = ['left', 'center', 'right'].includes(zone.align) ? zone.align : (fallback.align || 'center');
  el.style.fontSize = `${Math.max(11, Math.min(58, size * 14))}px`;
  el.style.color = coverPreviewColor(zone.color_role || fallback.color_role || 'palette_3');
}

function fittedCoverTitleScale(text, requested = 2.8) {
  const length = Array.from(String(text || '').replace(/\s+/g, '')).length;
  const cap = length > 55 ? 1.7 : length > 40 ? 1.95 : length > 28 ? 2.25 : length > 18 ? 2.6 : 3.2;
  return Math.min(Number(requested) || 2.8, cap);
}

async function renderCoverPreview() {
  const wrap = $('coverPreviewWrap');
  if (!wrap || !book?.id) return;
  const asset = await db.loadAsset(book.id, 'cover-front.png');
  if (!asset?.blob) {
    wrap.classList.add('hidden');
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = null;
    return;
  }

  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = URL.createObjectURL(asset.blob);

  // ปกที่ ChatGPT วาดตัวหนังสือมาให้แล้ว = ภาพนี้คือปกจริง ห้ามวาดข้อความซ้อนทับในตัวอย่าง
  if (coverTextBaked(book)) {
    $('coverPreviewImg').src = coverPreviewUrl;
    ['coverPreviewTitle', 'coverPreviewSubtitle', 'coverPreviewAuthor'].forEach((id) =>
      $(id).classList.add('hidden'),
    );
    wrap.querySelector('.slotHead').textContent = 'ปกจริงที่จะใช้ในเล่ม';
    wrap.querySelector('.muted').textContent =
      'ChatGPT วาดชื่อเรื่องมาในภาพแล้ว ระบบจะใช้ภาพนี้เป็นปกตรง ๆ ไม่พิมพ์อะไรทับอีก — ถ้าคำสะกดเพี้ยน ให้กดสร้างปกใหม่ หรือสลับไปโหมด “ให้ระบบพิมพ์ทับภาพ”';
    wrap.classList.remove('hidden');
    return;
  }
  $('coverPreviewImg').src = coverPreviewUrl;

  const layout = book.coverLayout || book.style?.typography || {};
  const title = $('coverPreviewTitle');
  const subtitle = $('coverPreviewSubtitle');
  const author = $('coverPreviewAuthor');
  title.textContent = book.outline?.title || '';
  subtitle.textContent = book.outline?.subtitle || '';
  author.textContent = book.author || '';

  wrap.classList.remove('hidden');
  const fittedTitle = {
    ...(layout.title || {}),
    size_scale: fittedCoverTitleScale(title.textContent, layout.title?.size_scale),
  };
  applyCoverPreviewZone(title, fittedTitle, { x_pct: 8, y_pct: 8, width_pct: 84, align: 'center', size_scale: 2.8, color_role: 'palette_3' });
  const requestedSubtitleY = Number(layout.subtitle?.y_pct ?? 24);
  const coverHeight = $('coverMock').clientHeight || 1;
  const titleEndPct = ((title.offsetTop + title.scrollHeight) / coverHeight) * 100;
  const authorY = Number(layout.author?.y_pct ?? 88);
  const fittedSubtitle = { ...(layout.subtitle || {}), y_pct: Math.min(authorY - 14, Math.max(requestedSubtitleY, titleEndPct + 2.5)) };
  applyCoverPreviewZone(subtitle, fittedSubtitle, { x_pct: 12, y_pct: 24, width_pct: 76, align: 'center', size_scale: 1.0, color_role: 'palette_3' });
  applyCoverPreviewZone(author, layout.author, { x_pct: 10, y_pct: 88, width_pct: 80, align: 'center', size_scale: 1.1, color_role: 'palette_3' });
  subtitle.classList.toggle('hidden', !subtitle.textContent.trim());
  author.classList.toggle('hidden', !author.textContent.trim());
}

async function openImagePhaseGate() {
  phase2Running = false;
  phase2Stage = null;
  book = await db.loadBook(book.id);
  sections = (await db.loadSections(book.id)).sort((a, b) => cmpId(a.id, b.id));

  $('start').classList.add('hidden');
  $('editor').classList.add('hidden');
  $('done').classList.add('hidden');
  $('imagePhase').classList.remove('hidden');
  $('phase2Back').classList.add('hidden');
  // บันทึกการทำงานของรอบที่แล้วยังมีค่าอยู่ ถ้ามีของให้ดูก็เก็บไว้ใต้การ์ด
  $('progress').classList.toggle('hidden', eventCount === 0);

  setMacroStage('images');
  setMode(currentMode); // ประตูนี้รอคนตัดสินใจ ไม่ใช่กำลังเดินเครื่อง
  setPhase('gate_images', 'Phase 1 ถูกบันทึกครบแล้ว รอเริ่มสร้างภาพ');
  status('รอเริ่ม Image Phase 2');

  const consult = book.coverConsultation;
  const canConsultCover = !['none', 'upload'].includes(book.coverMode || 'prompt');
  $('coverConsultAgain').classList.toggle('hidden', !canConsultCover);
  $('coverConsultSummary').textContent = consult?.directions?.length
    ? `${consult.jury ? 'GPT ย่อเนื้อหาทั้งเล่ม ออกแบบ ' : 'GPT Art Director เสนอ '}${consult.directions.length} ทาง${consult.jury ? ' แล้วตรวจให้คะแนนก่อนเลือก' : ''} · ใช้ “${book.style?.name || consult.recommended_id || 'แนวที่เลือก'}”${consult.why_recommended ? ` — ${consult.why_recommended}` : ''}`
    : canConsultCover
      ? 'ปกจะถูกส่งให้ GPT Art Director วิเคราะห์ก่อนสร้างภาพ แล้วระบบจะ typeset ชื่อเรื่อง/ผู้เขียนจริงทับตาม layout ที่ GPT กำหนด'
      : '';

  await renderPhase2();
  await renderCoverPreview();
  if (autoPilot() && book.imagePhase?.status !== 'complete') {
    addEvent('system', fullAutoRunning ? 'อัตโนมัติ' : 'ทดสอบระบบ', 'เริ่ม Phase 2 อัตโนมัติ');
    setTimeout(() => startPhase2(), 400);
    return;
  }
  $('imagePhase').scrollIntoView({ behavior: 'smooth' });
  // Phase 1 พร้อมแล้ว: เขียน snapshot ทั้งเล่มลง Shared Workspace ให้ Chrome profile อื่นเปิด Phase 2 ต่อได้
  await syncSharedProject(book.id);
  // อัปเดตประวัติโครงการทันที ไม่ต้องให้ผู้ใช้กดรีเฟรชเอง
  await loadProjectHistory();
}

async function startPhase2() {
  book = await db.loadBook(book.id);
  // อยู่หน้าเดิม แค่สลับเป็นโหมดกำลังทำงาน รายการรูปจะอัปเดตสดตรงนั้นเลย
  phase2Running = true;
  phase2Stage = { name: null, text: 'กำลังเชื่อมต่อหน้าต่าง ChatGPT ที่เลือกไว้...' };
  $('imagePhase').classList.remove('hidden');
  $('progress').classList.remove('hidden');
  $('phase2Back').classList.remove('hidden');
  setMacroStage('images');
  renderSteps();
  await renderPhase2();
  setPhase('images', 'กำลังเชื่อมต่อหน้าต่าง ChatGPT ที่เลือกไว้ และเตรียมสร้างภาพที่ยังขาด');
  status('กำลังเริ่ม Image Phase 2');
  book.job.step = 'images';
  book.job.status = 'paused';
  book.job.error = null;
  await db.saveBook(book);
  await syncSharedProject(book.id);
  addEvent('system', 'เริ่ม Image Phase 2', 'สร้างเฉพาะไฟล์ที่ยังขาด และบันทึกทุกภาพลงโครงการทันที');

  // ไม่ await ตรงนี้ เพราะถ้าการ focus หน้าต่าง ChatGPT ช้าหรือ browser กำลังสลับหน้าต่าง
  // Studio จะไม่ถูกทิ้งไว้ที่หน้า Progress ว่าง ๆ; transport ของเทิร์นแรกจะ ensure/focus ChatGPT ซ้ำให้อีกชั้น
  if (!testing() && bookDrawsInTab(book)) chrome.runtime.sendMessage({ type: 'sw.focusChat' }).catch(() => {});

  showRunningCost();
  makeMachine();
  try {
    await runMachine();
  } catch (e) {
    fail(e);
  }
}

async function recoverPhase2Gate() {
  machine?.stop();
  if (!book?.id) return;
  book = await db.loadBook(book.id);
  book.job ||= {};
  book.job.step = 'gate_images';
  book.job.status = 'paused';
  book.job.error = 'ผู้ใช้กลับหน้า Image Phase 2 เพื่อกู้/เริ่มต่อ';
  book.job.imageThreadStarted = false;
  await db.saveBook(book);
  await syncSharedProject(book.id);
  await openImagePhaseGate();
}

async function skipPhase2() {
  if (!confirm('ข้าม Phase 2 หรือไม่? ภาพที่ยังขาดจะคงเป็นช่องว่าง/Prompt ในเล่ม แต่โครงการและ Prompt ทั้งหมดจะยังอยู่')) return;
  phase2Running = false;
  phase2Stage = null;
  book = await db.loadBook(book.id);
  book.imagePhase = { ...(book.imagePhase || {}), status: 'skipped', skippedAt: Date.now() };
  book.job.step = 'done';
  book.job.status = 'done';
  await db.saveBook(book);
  await syncSharedProject(book.id);
  $('imagePhase').classList.add('hidden');
  await finish();
}

/** ให้ GPT Art Director วิเคราะห์ปกใหม่ทั้งชุด แล้วค่อยกลับมาสร้างภาพจากคำแนะนำใหม่ */
async function rethinkCoverWithGpt() {
  if (!book?.id) return;
  book = await db.loadBook(book.id);
  if (!book || ['none', 'upload'].includes(book.coverMode || 'prompt')) return;
  if (!confirm('ให้ GPT คิดทิศทางปกใหม่หรือไม่? ปกหน้า/ปกหลังเดิมจะถูกลบ แต่ภาพประกอบในเล่มจะไม่ถูกแตะ')) return;

  await db.deleteAsset(book.id, 'cover-front.png').catch(() => {});
  await db.deleteAsset(book.id, 'cover-back.png').catch(() => {});
  book.coverConsultation = null;
  book.coverDigest = null;
  book.coverLayout = null;
  book.coverPrompts = null;
  book.style = null;
  book.coverDesignVersion = 0;
  book.imagePhase = { ...(book.imagePhase || {}), status: 'reconsulting', remaining: [] };
  book.job ||= {};
  book.job.step = 'style';
  book.job.status = 'paused';
  book.job.error = null;
  book.job.imageThreadStarted = false;
  await db.saveBook(book);
  await syncSharedProject(book.id);

  $('imagePhase').classList.add('hidden');
  $('editor').classList.add('hidden');
  $('done').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('phase2Back').classList.remove('hidden');
  setMacroStage('images');
  renderSteps();
  setPhase('style', 'กำลังส่งข้อมูลทั้งเล่มให้ GPT Art Director คิดปกใหม่ 3 ทางและเลือกแนวที่แนะนำ');
  status('กำลังปรึกษา GPT เรื่องปก');
  if (!testing() && bookDrawsInTab(book)) chrome.runtime.sendMessage({ type: 'sw.focusChat' }).catch(() => {});
  showRunningCost();
  makeMachine();
  try {
    await runMachine();
  } catch (e) {
    fail(e);
  }
}

/** สั่งวาดปกใหม่จากหน้าตรวจงาน — ถามก่อนเพราะไฟล์เดิมจะถูกลบและต้องใช้เทิร์นสร้างภาพจริง */
async function confirmRegenerateCover(name, which) {
  const label = which === 'back' ? 'ปกหลัง' : 'ปกหน้า';
  if (!confirm(`สร้าง${label}ใหม่ด้วยแนวปกเดิมหรือไม่?\n\nไฟล์${label}เดิมจะถูกลบ แล้วระบบจะพาไปหน้าสร้างภาพเพื่อวาดใหม่ทันที`)) return;
  await regenerateImageAsset(name);
}

/** ลบเฉพาะปกที่ไม่ชอบ แล้วใช้คำแนะนำ GPT เดิมสร้างใหม่; asset อื่นที่ผ่านแล้วจะถูกข้าม */
async function regenerateImageAsset(name) {
  if (!book?.id) return;
  book = await db.loadBook(book.id);
  if (!book) return;
  const required = phase2RequiredNames(book);
  const isCover = name === 'cover-front.png' || name === 'cover-back.png';
  // บอกเหตุผลเสมอ ปุ่มที่กดแล้วเงียบทำให้ผู้ใช้คิดว่าโปรแกรมค้าง
  if (!required.includes(name)) {
    status(`เล่มนี้ไม่มีช่องภาพ ${name} จึงสร้างใหม่ไม่ได้`);
    return;
  }
  if (isCover && book.coverMode !== 'auto') {
    status('เล่มนี้ตั้งค่าปกเป็นแบบเขียน Prompt ให้เท่านั้น ระบบจึงวาดปกเองไม่ได้ — เปลี่ยนโหมดปกเป็นอัตโนมัติก่อน');
    return;
  }
  if (!isCover && book.figureMode !== 'auto') {
    status('เล่มนี้ตั้งค่าภาพประกอบเป็นแบบเขียน Prompt ให้เท่านั้น ระบบจึงวาดภาพเองไม่ได้');
    return;
  }
  await db.deleteAsset(book.id, name).catch(() => {});
  book.imagePhase = {
    ...(book.imagePhase || {}),
    status: 'ready',
    remaining: [name],
    failedName: null,
    failedWhat: null,
    failedReason: null,
    failures: (book.imagePhase?.failures || []).filter((f) => f.name !== name),
  };
  book.job ||= {};
  book.job.step = 'gate_images';
  book.job.status = 'paused';
  book.job.error = null;
  book.job.imageThreadStarted = false;
  await db.saveBook(book);
  await syncSharedProject(book.id);
  await openImagePhaseGate();
  await startPhase2();
}

/**
 * โหมดอัตโนมัติต้องได้ไฟล์จริงตอนจบ ไม่ใช่จบแล้วค้างรอให้กดส่งออกเอง
 * ถ้าส่งออกไม่ผ่าน ห้ามเงียบ — เล่มอยู่ครบแล้ว ผู้ใช้กดส่งออกเองได้ทันที
 */
async function autoExportFinished() {
  /**
   * โหมดอัตโนมัติข้ามกล่องยืนยันของ runExport ไป จึงต้องมีด่านตรวจของตัวเอง
   * ไม่งั้นเล่มที่ทุกตอนว่างจะถูกส่งออกเป็นไฟล์จริงโดยไม่มีใครทักสักคำ
   */
  const empty = sections.filter((s) => !(s.md || s.text || '').trim());
  if (empty.length) {
    addEvent(
      'system',
      'อัตโนมัติ: ไม่ส่งออกไฟล์',
      `ยังมี ${empty.length} ตอนที่ไม่มีเนื้อหา (${empty.map((s) => s.id).join(', ')}) — ไม่ส่งออกเพื่อไม่ให้ได้ไฟล์ที่หน้าเป็นช่องว่าง`,
    );
    status(`ยังมี ${empty.length} ตอนที่ไม่มีเนื้อหา — ยังไม่ส่งออกไฟล์`);
    return;
  }
  try {
    status('อัตโนมัติ: กำลังส่งออกไฟล์');
    await X.exportBookPdf(book, sections);
    addEvent('system', 'อัตโนมัติ: ส่งออกไฟล์แล้ว', `${book.outline?.title || book.topic}.pdf`);
  } catch (e) {
    addEvent('system', 'อัตโนมัติ: ส่งออกไฟล์ไม่สำเร็จ', `${e?.message || e} — กดส่งออกเองได้จากปุ่มด้านล่าง`);
  }
}

// ---------- เสร็จ ----------
async function finish() {
  const wasFullAuto = fullAutoRunning;
  fullAutoRunning = false;
  if (systemTestRunning) {
    systemTestRunning = false;
    addEvent('system', 'ทดสอบระบบเสร็จ', 'เดินครบทั้ง 7 แผนกแล้ว — ดูกระดานทีมงานว่ามีแผนกไหนขึ้นสีแดงหรือไม่');
  }
  phase2Running = false;
  phase2Stage = null;
  $('imagePhase').classList.add('hidden');
  sections = (await db.loadSections(book.id)).sort((a, b) => cmpId(a.id, b.id));

  /**
   * ห้ามประกอบไฟล์อัตโนมัติเมื่อยังมีตอนที่ไม่มีเนื้อหา
   *
   * เส้นทางนี้ไม่ผ่านกล่องยืนยันของปุ่มส่งออก จึงเคยผลิตไฟล์ PDF ที่ทุกหน้าเป็น
   * "(ยังไม่มีเนื้อหาของตอน 1.1)" ออกมาให้ผู้ใช้โดยไม่มีใครทัก
   */
  const emptySections = sections.filter((s) => !(s.md || s.text || '').trim());
  if (emptySections.length) {
    addEvent(
      'system',
      'ยังไม่ประกอบไฟล์อัตโนมัติ',
      `มี ${emptySections.length} ตอนที่ไม่มีเนื้อหา (${emptySections.map((s) => s.id).join(', ')}) — ต้องเขียนตอนเหล่านี้ให้เสร็จก่อน ไม่งั้นไฟล์ที่ได้จะมีหน้าเป็นช่องว่าง`,
    );
  }

  // Phase 2 ที่ครบแล้วประกอบ PDF ให้อัตโนมัติ โดยแยกสถานะเนื้อใน/ปก
  // ถ้าปกรอรูปผู้เขียน ผู้ใช้กลับมาอัปโหลดทีหลังแล้วสั่งส่งออกปกต่อได้โดยไม่ทำเนื้อในซ้ำ
  if (book.imagePhase?.status === 'complete' && !emptySections.length) {
    if (!book.imagePhase.autoInteriorExportedAt) {
      status('กำลังประกอบ PDF เนื้อในจากภาพ Phase 2');
      try {
        await X.exportInterior(book, sections);
        book.imagePhase.autoInteriorExportedAt = Date.now();
        addEvent('system', 'ประกอบ PDF เนื้อในอัตโนมัติ', 'ภาพจริงถูกแทนลงช่องที่ล็อกไว้แล้ว และบันทึก interior.pdf');
        await db.saveBook(book);
      } catch (e) {
        addEvent('system', 'ประกอบ PDF เนื้อในอัตโนมัติไม่สำเร็จ', e?.message || String(e));
      }
    }

    if (!book.imagePhase.autoBookExportedAt) {
      status('กำลังสร้าง PDF Ebook รวมปกและภาพ');
      try {
        const r = await X.exportBookPdf(book, sections);
        book.imagePhase.autoBookExportedAt = Date.now();
        addEvent(
          'system',
          'สร้าง PDF Ebook อัตโนมัติ',
          r.coverIncluded
            ? 'สร้าง book.pdf แล้ว — ปกหน้าและภาพประกอบถูกใส่ในหนังสือไฟล์เดียว'
            : 'สร้าง book.pdf แล้ว — ภาพประกอบถูกใส่ครบ แต่ยังไม่มีไฟล์ปกหน้าจึงเริ่มจากหน้าชื่อเรื่อง',
        );
        await db.saveBook(book);
      } catch (e) {
        addEvent('system', 'สร้าง PDF Ebook รวมปกและภาพไม่สำเร็จ', e?.message || String(e));
      }
    }

    if (book.coverMode === 'auto' && !book.imagePhase.autoCoverExportedAt) {
      try {
        const front = await db.loadAsset(book.id, 'cover-front.png');
        const back = await db.loadAsset(book.id, 'cover-back.png');
        const authorPhoto = await db.loadAsset(book.id, 'author-photo.png');
        const authorReady = !book.authorPhotoOnCover || !!authorPhoto;
        if (front && back && authorReady) {
          await X.exportCover(book, {
            frontDataUrl: await db.blobToDataUrl(front.blob),
            backDataUrl: await db.blobToDataUrl(back.blob),
            authorDataUrl: authorPhoto ? await db.blobToDataUrl(authorPhoto.blob) : null,
          });
          book.imagePhase.autoCoverExportedAt = Date.now();
          await db.saveBook(book);
          addEvent('system', 'ประกอบ PDF ปกอัตโนมัติ', 'ปกหน้า ปกหลัง สัน และรูปผู้เขียนถูกประกอบเป็น cover.pdf');
        } else if (book.authorPhotoOnCover && !authorPhoto) {
          addEvent('system', 'ปกยังไม่ถูกส่งออกอัตโนมัติ', 'เลือกใช้รูปผู้เขียนบนปกหลัง แต่ยังไม่ได้อัปโหลดรูปผู้เขียน');
        }
      } catch (e) {
        addEvent('system', 'ประกอบ PDF ปกอัตโนมัติไม่สำเร็จ', e?.message || String(e));
      }
    }
  }

  const pages = book.finalPages || book.lastCompile?.pages || book.targetPages;
  // ด่านตรวจก่อนส่งออกดูไฟล์ภาพด้วย จึงต้องอ่านรายชื่อสด ไม่ใช่ของที่ค้างจากตอนเปิดหน้าแก้ไข
  assetNames = (await db.loadAssets(book.id)).map((a) => a.name);
  const pf = preflight({ book, sections, pages, assetNames });

  $('preflight').innerHTML = pf.checks
    .map(
      (c) =>
        `<div class="pf ${c.level}"><svg class="i" aria-hidden="true"><use href="#i-${
          c.level === 'ok' ? 'check-circle' : c.level === 'warn' ? 'alert' : 'error'
        }"/></svg><span>${esc(c.label)}${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</span></div>`,
    )
    .join('');

  // ถ้าตั้งใจให้มีปก/ภาพจริงแต่ยังไม่เสร็จ (ข้าม Phase 2 หรือยังไม่เคยเริ่ม) ต้องเตือนเด่น ๆ
  // ก่อนผู้ใช้กดส่งออก ไม่ใช่ให้ไปเจอเองว่า PDF ที่ได้ไม่มีภาพ แล้วงงว่าทำไมภาพมาสร้างทีหลัง
  /**
   * ใช้ผลจาก preflight ตัวเดียวกัน ห้ามคำนวณซ้ำเอง
   *
   * เดิมสองที่นี้อ่านฟิลด์เดียวกันแต่คนละจังหวะ พอไม่ตรงกันก็ได้หน้าจอที่ขัดแย้งกันเอง
   * (รายการตรวจขึ้น "Image Phase 2 ครบ 4 รูป และผูกกลับเข้าตำแหน่งแล้ว"
   *  แต่แถบเตือนข้างบนบอกว่า "เล่มนี้ยังไม่มีภาพจริง" พร้อมกัน)
   */
  const wantsAutoImages = book.coverMode === 'auto' || book.figureMode === 'auto';
  const imageCheck = pf.checks.find((c) => c.id === 'images');
  const imagesReady = !wantsAutoImages || !imageCheck || imageCheck.level === 'ok';
  $('imagesNotReadyBanner').classList.toggle('hidden', imagesReady);
  $('exportBookBtn').textContent = imagesReady ? 'PDF Ebook รวมปก + ภาพ' : 'PDF Ebook (ยังไม่มีภาพจริง)';
  if (!imagesReady) {
    const missing = (book.imagePhase?.remaining || []).length;
    $('imagesNotReadyDesc').textContent =
      book.imagePhase?.status === 'skipped'
        ? 'เล่มนี้ข้าม Image Phase 2 ไว้ — ตำแหน่งปก/ภาพประกอบยังเป็นช่องว่างหรือ Prompt เท่านั้น PDF ที่ส่งออกตอนนี้จะไม่มีภาพจริง'
        : `ยังสร้างภาพไม่ครบ (เหลือ ${missing || 'บางส่วน'} รูป) — PDF ที่ส่งออกตอนนี้อาจไม่มีปก/ภาพประกอบจริงครบทุกตำแหน่ง`;
  }

  setMacroStage('done');
  setPhase('done', 'พร้อมส่งออก');
  $('bar').style.width = '100%';
  $('done').classList.remove('hidden');
  $('doneText').textContent = `“${book.outline?.title || book.topic}” · ${pages} หน้า · ติดขัด ${pf.blocking} ข้อ, เตือน ${pf.warnings} ข้อ`;
  $('doneCoverRedo').classList.toggle('hidden', ['none', 'upload'].includes(book.coverMode || 'prompt'));
  status('เสร็จแล้ว');
  $('create').disabled = false;
  await syncSharedProject(book.id);
  await loadProjectHistory();

  // โหมดอัตโนมัติต้องได้ไฟล์ตอนจบเสมอ ไม่ใช่จบแล้วค้างรอให้กดส่งออกเอง
  // เล่มที่ผ่าน Phase 2 ครบถูกส่งออกไปแล้วข้างบน ตรงนี้จึงเก็บเฉพาะเล่มที่ไม่ได้ผ่านทางนั้น
  if (wasFullAuto && !book.imagePhase?.autoBookExportedAt) await autoExportFinished();
  if (wasFullAuto) addEvent('system', 'อัตโนมัติ: จบงานทั้งเล่ม', `${pages} หน้า · ติดขัด ${pf.blocking} ข้อ`);
}

// ---------- ส่งออก ----------
async function runExport(kind) {
  setMode(`ส่งออก ${kind}`, { busy: true });
  const log = (m) => ($('exportLog').textContent = m);

  // กันไม่ให้ส่งออกเล่มที่ยังมีตอนว่าง เพราะมันจะกลายเป็นบรรทัด
  // "(ยังไม่มีเนื้อหาของตอน 4.2)" อยู่ในหนังสือจริง
  const empty = sections.filter((s) => !(s.md || s.text || '').trim());
  if (empty.length && kind !== 'project') {
    const ids = empty.map((s) => s.id).join(', ');
    const go = confirm(
      `ยังมี ${empty.length} ตอนที่ไม่มีเนื้อหา: ${ids}\n\n` +
        `ถ้าส่งออกตอนนี้ หนังสือจะมีข้อความ "(ยังไม่มีเนื้อหาของตอน ...)" อยู่ในเล่มจริง\n\n` +
        `แนะนำให้กลับไปเขียนตอนที่ขาดก่อน ยืนยันจะส่งออกเลยหรือไม่`,
    );
    if (!go) return log(`ยกเลิก — ยังขาดตอน ${ids}`);
  }

  try {
    log('กำลังสร้างไฟล์...');
    if (kind === 'interior') await X.exportInterior(book, sections);
    else if (kind === 'book') await X.exportBookPdf(book, sections);
    else if (kind === 'screen') await X.exportScreen(book, sections);
    else if (kind === 'epub') await X.exportEpub(book, sections);
    else if (kind === 'project') await X.exportProjectJson(book.id, book.outline?.title || book.topic);
    else if (kind === 'prompts') await X.exportCoverPrompts(book);
    else if (kind === 'cover') {
      const front = await db.loadAsset(book.id, 'cover-front.png');
      const back = await db.loadAsset(book.id, 'cover-back.png');
      const authorPhoto = await db.loadAsset(book.id, 'author-photo.png');
      await X.exportCover(book, {
        frontDataUrl: front ? await db.blobToDataUrl(front.blob) : null,
        backDataUrl: back ? await db.blobToDataUrl(back.blob) : null,
        authorDataUrl: authorPhoto ? await db.blobToDataUrl(authorPhoto.blob) : null,
      });
    }
    log('บันทึกไฟล์แล้ว');
    addEvent('system', 'ส่งออก', kind);
  } catch (e) {
    log('ส่งออกไม่สำเร็จ: ' + (e?.message || e));
  } finally {
    setMacroStage(macroStageForJobStep(book?.job?.step)); // คืนป้ายให้ตรงกับขั้นที่ยืนอยู่จริง
  }
}

// ---------- Shared Workspace + โฟลเดอร์ปลายทาง ----------
async function chooseFolder() {
  if (!window.showDirectoryPicker) return alert('Chrome รุ่นนี้ไม่รองรับการเลือกโฟลเดอร์จากหน้านี้ ไฟล์จะลงที่ Downloads');
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await W.useDirectoryHandle(dir);
    X.setExportDirectoryHandle(dir);

    // รวม local cache เข้า workspace แบบไม่ทับ snapshot ที่ใหม่กว่าจากอีก Chrome profile
    const merged = await W.mergeLocalProjectsToWorkspace();
    const info = await W.getWorkspaceInfo();
    const shortId = info?.id ? info.id.slice(0, 8) : 'ไม่ทราบ';
    $('folderName').textContent = `${dir.name || 'เลือกแล้ว'} · Shared Workspace ${shortId} · ${merged.shared || 0} โครงการ`;

    await loadProjectHistory();
  } catch (e) {
    if (e.name !== 'AbortError') $('folderName').textContent = 'เลือกไม่สำเร็จ: ' + e.message;
  }
}

// ---------- ทดสอบคอมไพเลอร์ ----------
async function testTypst() {
  const el = $('typstState');
  el.textContent = 'กำลังโหลดคอมไพเลอร์ (ไฟล์ wasm ราว 28 MB ครั้งแรกช้าหน่อย)...';
  try {
    const r = await selfTest();
    el.textContent = r.ok
      ? `ใช้งานได้ · เรียงพิมพ์ไทยและนับหน้าถูกต้อง · ${r.ms} ms`
      : `คอมไพล์ได้แต่ผลไม่ตรงที่คาด (ได้ ${r.pages} หน้า ควรได้ 2)`;
  } catch (e) {
    el.textContent = 'ใช้ไม่ได้: ' + (e?.message || e);
  }
}

// ---------- ผูกปุ่ม ----------
$('figureStyle').innerHTML = Object.entries(FIGURE_STYLES)
  .map(([k, v]) => `<option value="${k}"${k === 'box' ? ' selected' : ''}>${v.label}</option>`)
  .join('');
const showStyleNote = () => ($('figureStyleNote').textContent = FIGURE_STYLES[$('figureStyle').value]?.note || '');
$('figureStyle').addEventListener('change', showStyleNote);
showStyleNote();

$('itemKind').innerHTML = Object.entries(ITEM_KINDS)
  .map(([k, v]) => `<option value="${k}"${k === 'quote' ? ' selected' : ''}>${v.label}</option>`)
  .join('');

function syncMode() {
  const mode = val('contentMode', 'prose');
  const items = mode === 'items';
  const fiction = mode === 'fiction';
  $('itemOpts').hidden = !items;
  $('fictionOpts').hidden = !fiction;
  $('proseOpts').hidden = items;
  document.querySelectorAll('.nonfictionOnly').forEach((el) => (el.hidden = fiction));
  if (items) $('itemOpts').open = true;
  if (fiction) {
    $('fictionOpts').open = true;
    if ($('figureStyle').value === 'box') $('figureStyle').value = 'sketch';
    showStyleNote();
  }
  updateEstimate();
}

function updateItemPlan() {
  const k = ITEM_KINDS[val('itemKind', 'quote')];
  $('itemKindNote').textContent = k ? `${k.brief} · ${k.len}` : '';

  const p = TRIM_PRESETS[val('trim', 'a5')] || TRIM_PRESETS.a5;
  const draft = {
    targetPages: Number($('pages').value) || 100,
    itemsPerPage: Number(val('itemsPerPage')) || 1,
    itemKind: val('itemKind', 'quote'),
    themeCount: Number(val('themeCount')) || 5,
    frontMatter: ['title', 'toc'],
    backMatter: [],
    trim: { preset: val('trim', 'a5'), widthMm: p.w, heightMm: p.h },
  };
  const plan = planItems(draft);
  $('itemSizePt').placeholder = suggestItemSize(draft);
  $('itemPlanNote').innerHTML =
    `ต้องใช้ <span class="big">${plan.total}</span> ชิ้น · ${plan.themes} หมวด หมวดละราว ${plan.perTheme}<br>` +
    `คาดว่าใช้ราว <b>${plan.turns} ข้อความ ChatGPT</b> · จำนวนหน้าคำนวณตรง ๆ ไม่ต้องวนลูปปรับความยาว`;
}

['contentMode'].forEach((id) => $(id).addEventListener('change', () => {
  syncMode();
  markOutlineStale('รูปแบบเนื้อหาเปลี่ยน');
}));
// สารบัญที่ผู้ใช้เลือกไว้ถูกล็อกเข้าไปในสารบัญจริงแบบ "ห้ามเปลี่ยน" (planningSeed())
// ถ้าแก้ audience/tone/pages/genre/ค่านิยายทีหลังโดยไม่รีเซ็ต จะได้สารบัญที่คำสั่งขัดกันเอง
// (เช่น ทิศทางล็อกจำนวนบทจากหน้าเก่า แต่กติกาอื่นให้คำนวณจำนวนบทจากหน้าใหม่)
['pages'].forEach((id) => $(id).addEventListener('input', () => markOutlineStale('จำนวนหน้าเปลี่ยน')));
['audience', 'tone'].forEach((id) =>
  $(id).addEventListener('input', () => markOutlineStale('ผู้อ่าน/โทนเปลี่ยน')),
);
['genre', 'fictionGenre', 'fictionPov', 'fictionEnding', 'fictionRomance'].forEach((id) =>
  $(id).addEventListener('change', () => markOutlineStale('แนวหนังสือเปลี่ยน')),
);
['itemKind', 'itemsPerPage', 'themeCount', 'pages', 'trim'].forEach((id) => {
  if ($(id)) $(id).addEventListener('input', updateItemPlan);
  if ($(id)) $(id).addEventListener('change', updateItemPlan);
});

$('aboutAuthor').addEventListener('input', () => {
  const n = $('aboutAuthor').value.trim().length;
  $('aboutState').textContent = n ? `${n} ตัวอักษร` : 'ยังว่าง — ถ้าเลือกใส่หน้านี้ในเล่ม ต้องกรอกก่อนส่งออก';
});

$('aboutPolish').onclick = async () => {
  const raw = $('aboutAuthor').value.trim();
  if (!raw) return ($('aboutState').textContent = 'พิมพ์ข้อมูลของคุณก่อน ระบบจะไม่แต่งขึ้นเอง');
  $('aboutState').textContent = 'กำลังส่งให้เรียบเรียง...';
  try {
    const tr = makeTransport(transportKind(), transportOpts({ timeoutMs: 180000, onProgress: () => {} }));
    const res = await tr.send(polishAboutPrompt(raw, book?.language || val('lang', 'th')));
    const out = (res.text || '').replace(/^```[\w]*\s*/m, '').replace(/```\s*$/m, '').trim();
    if (out) {
      $('aboutAuthor').value = out;
      $('aboutState').textContent = 'เรียบเรียงแล้ว — ตรวจดูว่าไม่มีข้อมูลที่คุณไม่ได้ให้ไว้';
    } else {
      $('aboutState').textContent = 'ไม่ได้ข้อความกลับมา';
    }
  } catch (e) {
    $('aboutState').textContent = 'ไม่สำเร็จ: ' + (e?.message || e);
  }
};

$('trim').innerHTML = Object.entries(TRIM_PRESETS)
  .map(([k, p]) => `<option value="${k}"${k === 'a5' ? ' selected' : ''}>${p.label} — ${p.w}×${p.h} มม.</option>`)
  .join('');

$('folder').onclick = chooseFolder;
$('typstTest').onclick = testTypst;
$('create').onclick = create;
$('systemTest').onclick = runSystemTest;
$('chat').onclick = () => chrome.runtime.sendMessage({ type: 'sw.focusChat' });
$('stop').onclick = () => {
  machine?.stop();
  status('หยุดแล้ว');
  systemTestRunning = false;
  addEvent('system', 'หยุด', 'ผู้ใช้สั่งหยุดงาน');
  $('create').disabled = false;
};
$('newBook').onclick = startNewBook;
$('secSave').onclick = saveSection;
$('secRegen').onclick = regenerateSection;
$('fillEmptySections').onclick = fillEmptySections;
$('secHistory').onclick = renderHistory;
$('reviewToggle').onclick = () => {
  const open = $('reviewList').classList.toggle('hidden');
  $('reviewToggle').setAttribute('aria-expanded', String(!open));
};
$('openHistory').onclick = openEditor;
$('doneCoverRedo').onclick = async () => {
  if (!book?.id) return;
  book = await db.loadBook(book.id);
  book.job ||= {};
  book.job.step = 'gate_images';
  book.job.status = 'paused';
  book.job.error = null;
  await db.saveBook(book);
  await syncSharedProject(book.id);
  $('done').classList.add('hidden');
  await openImagePhaseGate();
};
$('recount').onclick = recount;
$('proceed').onclick = proceed;
$('phase2Start').onclick = startPhase2;
$('fullAuto').onclick = runFullAuto;
$('phase2Folder').onclick = pullImagesFromFolder;

/**
 * ช่องใส่คีย์โผล่เฉพาะตอนเลือกโหมด API
 * คีย์ถูกเก็บใน IndexedDB ของส่วนขยายเครื่องนี้ ไม่ได้ sync ไปไหน และไม่เคยถูก log
 */
/** ราคาที่ผู้ใช้กรอกทับเอง มาก่อนตารางในโปรแกรมเสมอ */
let customPrice = null;
let usdThb = 36;

/**
 * ตั้งข้อความบนปุ่มที่มีไอคอน
 *
 * การเขียน textContent ทับปุ่มที่มี <svg> อยู่ข้างใน จะลบไอคอนทิ้งอย่างเงียบ ๆ
 * ปุ่มเดียวกันจึงมีไอคอนตอนเปิดหน้ามา แล้วหายไปหลังกดใช้งานครั้งแรก
 * ซึ่งดูเหมือนความผิดพลาดของโปรแกรมมากกว่าการออกแบบ
 */
function setBtn(id, icon, text) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-${icon}"/></svg>${esc(text)}`;
}

function renderModelOptions() {
  const sel = $('textApiModel');
  if (!sel || sel.dataset.filled === '1') return;
  sel.innerHTML = Object.entries(MODEL_PRICES)
    .map(([id, p]) => {
      const label = `${id} — $${p.in}/$${p.out} ต่อ 1M token${p.note ? ` · ${p.note}` : ''}`;
      return `<option value="${esc(id)}">${esc(label)}</option>`;
    })
    .join('');
  sel.value = DEFAULT_TEXT_MODEL;
  sel.dataset.filled = '1';
}

/**
 * บอกราคาก่อนกดเริ่ม ไม่ใช่ให้รู้ตอนบิลมา
 *
 * แสดงสองอย่างแยกกันชัดเจน: ราคาต่อ 1M token ของโมเดลที่เลือก
 * และค่าใช้จ่ายที่คาดว่าจะเกิดกับเล่มขนาดที่ตั้งไว้จริง
 * พร้อมบอกวันที่จดราคาไว้ เพราะราคาของ OpenAI เปลี่ยนบ่อยกว่าที่โปรแกรมนี้จะตามทัน
 */
function renderTextPrice() {
  const box = $('textApiPrice');
  if (!box) return;
  const on = val('textSource', 'web') === 'api';
  box.hidden = !on;
  $('priceEdit').hidden = !on;
  if (!on) return;

  const model = textApiModel();
  const price = priceFor(model, customPrice);
  if (!price) {
    box.textContent = `ไม่มีราคาของ “${model}” ในโปรแกรม — กรอกราคาเองได้ที่หัวข้อด้านล่าง`;
    return;
  }
  const e = currentEstimate;
  const est = e
    ? estimateCost({
        model,
        turns: e.likely,
        budgetChars: e.budget,
        language: val('lang', 'th'),
        measuredCharsPerToken: Number(book?.apiUsage?.charsPerToken) || 0,
        custom: customPrice,
      })
    : null;

  /**
   * ราคาต่อเล่มต้องรวมค่าภาพด้วย ไม่ใช่บอกแต่ค่าข้อความ
   * ในเล่มบาง ๆ ค่าภาพแพงกว่าค่าเขียนทั้งเล่มด้วยซ้ำ ถ้าบอกแค่ครึ่งเดียว
   * ผู้ใช้จะตั้งราคาขายจากตัวเลขที่ผิด
   */
  const imgApi = val('imageSource', 'web') === 'api';
  /**
   * นับภาพให้ตรงกับที่ระบบจะสร้างจริง ไม่ใช่นับแต่ปกสองรูป
   * ที่ลืมง่ายที่สุดคือลวดลายพื้นหลังของทุกหน้า ซึ่งเป็นภาพหนึ่งรูปที่ต้องจ่ายเงินเหมือนกัน
   * และตอนอยู่หน้าตั้งค่ายังไม่มีแผนภาพ จึงต้องประมาณจากความหนาแน่นที่ผู้ใช้เลือกไว้
   */
  const planned = plannedImageCount({
    coverMode: val('coverMode', 'prompt'),
    pagePattern: val('pagePattern', 'none'),
    figureMode: val('figureMode', 'prompt'),
    // ช่องความหนาแน่นภาพชื่อ illus ไม่ใช่ illustrationLevel — และโหมด auto ที่ยังตั้ง "ไม่มี"
    // ถือเป็นระดับพอดี ตรงกับที่ใช้ตอนสร้างเล่มจริง
    illustrationLevel:
      val('figureMode', 'prompt') === 'auto' && val('illus', 'none') === 'none' ? 'light' : val('illus', 'none'),
    sections: (currentEstimate?.chapters || 0) * 4,
    knownFigures: book?.figures ? book.figures.filter((f) => f.kind === 'image').length : null,
  });
  const img = imgApi && planned.total
    ? estimateImageCost({
        covers: planned.covers,
        pattern: planned.pattern,
        figures: planned.figures,
        quality: val('imageApiQuality', 'medium'),
        model: $('imageApiModel')?.value.trim() || 'gpt-image-2',
      })
    : null;
  const total = (est?.usd || 0) + (img?.usd || 0);

  box.innerHTML =
    `<b>${esc(model)}</b> · $${price.in} เข้า / $${price.out} ออก ต่อ 1M token` +
    (price.source === 'custom' ? ' (ราคาที่คุณกรอกเอง)' : ` (จดไว้ ${PRICE_CHECKED_AT})`) +
    (est
      ? `<br>ค่าเขียนทั้งเล่ม ราว <b>${esc(formatCost(est.usd, usdThb))}</b>` +
        ` — ส่งเข้าราว ${Math.round(est.inTokens / 1000).toLocaleString()}K token · เขียนออกราว ${Math.round(est.outTokens / 1000).toLocaleString()}K token`
      : '') +
    (img
      ? `<br>ค่าภาพ ${img.images} รูป (${[
          planned.covers ? `ปก ${planned.covers}` : '',
          planned.pattern ? 'ลายพื้นหลัง 1' : '',
          planned.figures ? `ภาพในเล่ม ${planned.figures}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}) ราว <b>${esc(formatCost(img.usd, usdThb))}</b>` +
        `<br><b>รวมทั้งเล่มราว ${esc(formatCost(total, usdThb))}</b>`
      : est
        ? `<br>ยังไม่รวมค่าภาพ เพราะเล่มนี้ตั้งให้สร้างภาพเอง ไม่ผ่าน API`
        : '') +
    `<br>เป็นการประเมิน ไม่ใช่ราคาที่ตกลงไว้ — ตัวเลขจริงจะขึ้นให้เห็นทุกเทิร์นระหว่างทำงาน`;
}

function syncApiSources() {
  const imageApi = val('imageSource', 'web') === 'api';
  const textApi = val('textSource', 'web') === 'api';
  // คีย์เดียวใช้ได้ทั้งสองงาน ช่องคีย์จึงโผล่เมื่อมีงานใดงานหนึ่งเลือกทาง API
  $('apiKeyField').hidden = !imageApi && !textApi;
  $('textApiRow').hidden = !textApi;
  $('textSourceNote').textContent = textApi
    ? 'เร็วกว่าและไม่มีลิมิตข้อความรายสามชั่วโมง แต่จ่ายตามจำนวน token ที่ใช้จริง และไม่แตะบัญชี ChatGPT ของคุณ'
    : 'ขับหน้าเว็บ ChatGPT ฟรีตามแพ็กเกจที่มีอยู่ แต่ช้ากว่าและมีลิมิตข้อความ';
  renderModelOptions();
  renderTextPrice();
}
$('imageSource').addEventListener('change', async () => {
  syncApiSources();
  await db.setting('imageSource', val('imageSource', 'web'));
});
$('textSource').addEventListener('change', async () => {
  syncApiSources();
  await db.setting('textSource', val('textSource', 'web'));
  updateEstimate();
});
$('textApiModel').addEventListener('change', async () => {
  await db.setting('textApiModel', textApiModel());
  renderTextPrice();
});
const savePriceOverride = async () => {
  const inp = Number($('priceIn').value);
  const outp = Number($('priceOut').value);
  customPrice = inp > 0 && outp > 0 ? { in: inp, out: outp } : null;
  usdThb = Number($('usdThb').value) > 0 ? Number($('usdThb').value) : 36;
  await db.setting('priceOverride', customPrice ? { ...customPrice, usdThb } : null);
  renderTextPrice();
};
['priceIn', 'priceOut', 'usdThb'].forEach((id) => $(id).addEventListener('change', savePriceOverride));
$('priceReset').onclick = async () => {
  customPrice = null;
  $('priceIn').value = '';
  $('priceOut').value = '';
  await db.setting('priceOverride', null);
  renderTextPrice();
};
/** ทดสอบว่าคีย์ใช้ได้และบัญชีมีโมเดลที่เลือกไว้จริง ก่อนเริ่มเล่มที่กินเวลาเป็นชั่วโมง */
$('testTextApi').onclick = async () => {
  const note = $('apiKeyNote');
  const key = $('openaiApiKey').value.trim();
  if (!key) return (note.textContent = 'ใส่คีย์ก่อนแล้วค่อยกดทดสอบ');
  $('testTextApi').disabled = true;
  note.textContent = 'กำลังตรวจคีย์และรายชื่อโมเดล...';
  try {
    apiKeyValue = key;
    await db.setting('openaiApiKey', key);
    await db.setting('textApiModel', textApiModel());
    const r = await makeTransport('openai_api', { apiKey: key, model: textApiModel() }).health();
    note.textContent = r.ok
      ? `✓ ใช้ได้ — บัญชีนี้เรียกโมเดล ${r.model} ได้ พร้อมใช้ API เขียนเนื้อหาแล้ว`
      : `✕ ${r.error}`;
  } catch (e) {
    note.textContent = `✕ ${e?.message || e}`;
  } finally {
    $('testTextApi').disabled = false;
  }
};
/**
 * บันทึกคีย์ทันทีที่พิมพ์ ไม่ต้องรอให้คลิกออกจากช่อง
 *
 * ผู้ใช้ส่วนใหญ่วางคีย์แล้วกดเริ่มงานเลย ถ้ารอเหตุการณ์ change (ซึ่งยิงตอนคลิกออก)
 * คีย์จะยังไม่ถูกบันทึกตอนกดเริ่ม แล้วโหมด API จะล้มด้วยข้อความ "ยังไม่ได้ใส่คีย์"
 * ทั้งที่เห็นคีย์อยู่เต็มช่องตรงหน้า
 */
const maskKey = (k) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : 'บันทึกแล้ว');
let saveKeyTimer = 0;
const saveApiKey = () => {
  clearTimeout(saveKeyTimer);
  saveKeyTimer = setTimeout(async () => {
    const key = $('openaiApiKey').value.trim();
    apiKeyValue = key;
    await db.setting('openaiApiKey', key);
    $('apiKeyNote').textContent = key
      ? `✓ บันทึกคีย์แล้ว (${maskKey(key)}) — กด "ทดสอบคีย์" เพื่อยืนยันว่าสร้างภาพได้จริง`
      : 'คีย์ถูกบันทึกในเบราว์เซอร์เครื่องนี้เท่านั้น ใส่ครั้งเดียวจำไว้ให้ตลอด';
  }, 400);
};
$('openaiApiKey').addEventListener('input', saveApiKey);
$('openaiApiKey').addEventListener('change', saveApiKey);
$('imageApiQuality').addEventListener('change', async () => {
  await db.setting('imageApiQuality', val('imageApiQuality', 'medium'));
});
$('imageApiModel').addEventListener('change', async () => {
  await db.setting('imageApiModel', $('imageApiModel').value.trim() || DEFAULT_IMAGE_MODEL);
});
$('testApiKey').onclick = async () => {
  const key = $('openaiApiKey').value.trim();
  const note = $('apiKeyNote');
  if (!key) return (note.textContent = 'ใส่คีย์ก่อนแล้วค่อยกดทดสอบ');
  $('testApiKey').disabled = true;
  note.textContent = 'กำลังทดสอบด้วยภาพเล็กที่สุด...';
  try {
    await db.setting('openaiApiKey', key);
    const model = $('imageApiModel').value.trim() || DEFAULT_IMAGE_MODEL;
    await db.setting('imageApiModel', model);
    const r = await testImageApiKey(key, model);
    note.textContent = `✓ ใช้ได้ — โมเดล ${r.model} สร้างภาพทดสอบ ${r.size} สำเร็จ พร้อมใช้โหมด API แล้ว`;
  } catch (e) {
    note.textContent = `✕ ${e?.message || e}`;
  } finally {
    $('testApiKey').disabled = false;
  }
};
$('phase2Back').onclick = recoverPhase2Gate;
$('phase2Skip').onclick = skipPhase2;
$('imagesNotReadyGo').onclick = async () => {
  book = await db.loadBook(book.id);
  book.job ||= {};
  book.job.step = 'gate_images';
  book.job.status = 'paused';
  book.job.imageThreadStarted = false;
  await db.saveBook(book);
  await syncSharedProject(book.id);
  $('done').classList.add('hidden');
  await openImagePhaseGate();
};
$('coverConsultAgain').onclick = rethinkCoverWithGpt;
$('phase2Stop').onclick = recoverPhase2Gate;
$('phase2Bulk').onclick = () => $('bulkImgFile').click();
$('bulkImgFile').onchange = async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  try {
    await bulkUploadImages(files);
  } catch (err) {
    phase2Notice(`<b>ใส่ภาพหลายรูปไม่สำเร็จ</b>${esc(err?.message || err)}`, true);
  }
};
$('phase2Edit').onclick = async () => {
  phase2Running = false;
  phase2Stage = null;
  $('imagePhase').classList.add('hidden');
  await openEditor();
};
$('phase2Prompts').onclick = async () => {
  const box = $('phase2Alert');
  try {
    await X.exportFigurePrompts(book);
    box.classList.remove('hidden', 'bad');
    box.innerHTML = '<b>ส่งออกไฟล์ Prompt แล้ว</b>เปิดไฟล์ไปวางในเครื่องมือสร้างภาพอื่นได้เลย';
  } catch (e) {
    box.classList.remove('hidden');
    box.classList.add('bad');
    box.innerHTML = `<b>ส่งออก Prompt ไม่สำเร็จ</b>${esc(e?.message || e)}`;
  }
};
$('figureMode').addEventListener('change', () => {
  // Auto หมายถึงต้องการให้ระบบสร้างภาพจริง หากยังเลือก "ไม่มีภาพ" อยู่ให้ปรับเป็นระดับพอดีทันที
  if ($('figureMode').value === 'auto' && $('illus').value === 'none') $('illus').value = 'light';
});
$('title').addEventListener('keydown', (e) => e.key === 'Enter' && create());
document.querySelectorAll('[data-export]').forEach((b) => (b.onclick = () => runExport(b.dataset.export)));

// ---------- ภาพ: ปกและภาพในเล่ม ----------

/**
 * ทำให้ภาพทุกไฟล์เป็น PNG ขนาดเดียวกันก่อนเก็บ
 * เหตุผล: ชื่อไฟล์ในต้นฉบับถูกกำหนดตั้งแต่ตอนวางแผน จึงต้องรู้นามสกุลล่วงหน้า
 * และเป็นจังหวะเดียวกับที่แปลงเป็นโทนเทาได้ ถ้าเนื้อในพิมพ์ขาวดำ
 */
async function normalizeImage(file, { grayscale = false, maxPx = 2400 } = {}) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);

  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d');
  cx.drawImage(bmp, 0, 0, w, h);

  if (grayscale) {
    const d = cx.getImageData(0, 0, w, h);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    cx.putImageData(d, 0, 0);
  }

  const blob = await cv.convertToBlob({ type: 'image/png' });
  return { blob, w, h };
}

/** เตือนเมื่อภาพเล็กเกินไปสำหรับขนาดที่จะพิมพ์จริง */
function dpiNote(px, printMm) {
  const dpi = Math.round(px / (printMm / 25.4));
  if (dpi >= 300) return { dpi, level: 'ok', text: `${dpi} dpi — ผ่านเกณฑ์งานพิมพ์` };
  if (dpi >= 220) return { dpi, level: 'warn', text: `${dpi} dpi — พอใช้ได้ แต่ต่ำกว่าเกณฑ์ 300` };
  return { dpi, level: 'bad', text: `${dpi} dpi — ต่ำเกินไป จะเห็นความเบลอตอนพิมพ์` };
}

let pendingSlot = null;
let setupAuthorPhotoUrl = null;

/**
 * รูปผู้เขียนที่เลือกไว้ตั้งแต่หน้าตั้งค่า ก่อนที่เล่มจะมีตัวตน
 *
 * ไฟล์ภาพถูกเก็บโดยผูกกับ book.id ซึ่งยังไม่มีจนกว่าจะกดสร้าง
 * จึงต้องอุ้มไฟล์ไว้ในหน่วยความจำก่อน แล้วบันทึกทันทีที่เล่มเกิด
 *
 * ถ้าไม่ทำแบบนี้ โหมดอัตโนมัติจะรับรูปผู้เขียนไม่ได้เลย เพราะมันผ่านประตูทุกบานให้เอง
 * ทั้ง gate_edit และ gate_images ไม่มีจังหวะไหนหยุดรอให้อัปโหลดสักจุดเดียว
 */
let setupAuthorPhoto = null;
let editorPreviewUrls = [];
let imageRenderToken = 0;

async function renderImages() {
  const token = ++imageRenderToken;
  const figs = book?.figures || [];
  const imgs = figs.filter((f) => f.kind === 'image');
  const boxes = figs.length - imgs.length;
  const assets = book?.id ? await db.loadAssets(book.id) : [];
  if (token !== imageRenderToken) return;
  assetNames = assets.map((a) => a.name);
  const have = new Set(assetNames);

  for (const url of editorPreviewUrls) URL.revokeObjectURL(url);
  editorPreviewUrls = [];
  const previewUrls = new Map();
  for (const asset of assets) {
    if (!asset?.blob) continue;
    const url = URL.createObjectURL(asset.blob);
    editorPreviewUrls.push(url);
    previewUrls.set(asset.name, url);
  }

  const setPreview = (name, imgId, buttonId) => {
    const url = previewUrls.get(name);
    const img = $(imgId);
    const button = $(buttonId);
    button.classList.toggle('hidden', !url);
    if (!url) {
      img.removeAttribute('src');
      button.onclick = null;
      return;
    }
    img.src = url;
    button.onclick = () => window.open(url, '_blank', 'noopener');
  };
  setPreview('cover-front.png', 'coverFrontPreview', 'coverFrontPreviewButton');
  setPreview('cover-back.png', 'coverBackPreview', 'coverBackPreviewButton');
  setPreview('author-photo.png', 'authorPhotoPreview', 'authorPhotoPreviewButton');

  $('imgSummary').textContent = figs.length
    ? `กล่องสรุป ${boxes} จุด (ไม่ต้องใช้ไฟล์) · ภาพจริง ${imgs.length} รูป · ใส่แล้ว ${imgs.filter((f) => have.has(f.name)).length}`
    : 'ยังไม่มีการวางแผนภาพ';

  for (const [slot, id] of [
    ['cover-front', 'coverFrontState'],
    ['cover-back', 'coverBackState'],
  ]) {
    const ok = have.has(slot + '.png');
    $(id).textContent = ok ? 'ใส่ไฟล์แล้ว' : 'ยังไม่มีไฟล์';
    $(id).closest('.slot').classList.toggle('filled', ok);
  }
  /**
   * ปุ่มจัดการปกบนหน้า "ตรวจและแก้ก่อนส่งออก"
   *
   * เดิมหน้านี้มีแค่ปุ่มเลือกไฟล์ ผู้ใช้ที่ไม่ชอบปกจึงติดตาย —
   * จะสั่งสร้างใหม่ก็ไม่ได้ จะย้อนกลับไปหน้าสร้างภาพก็ไม่มีทางออก
   * ต้องปิดโปรแกรมแล้วเปิดโครงการใหม่ ทั้งที่ทุกฟังก์ชันมีอยู่แล้วในหน้าอื่น
   */
  const coverAuto = (book?.coverMode || 'prompt') === 'auto';
  const canRethink = !['none', 'upload'].includes(book?.coverMode || 'prompt');
  $('coverRegenFront').classList.toggle('hidden', !coverAuto);
  $('coverRegenBack').classList.toggle('hidden', !coverAuto);
  $('coverRethink').classList.toggle('hidden', !canRethink);
  $('coverActions').classList.toggle('hidden', !coverAuto && !canRethink);
  $('coverActionsHint').textContent = coverAuto
    ? 'สร้างใหม่ = ใช้แนวปกเดิมวาดใหม่อีกครั้ง · คิดแนวใหม่ = ให้ GPT ย่อเนื้อหาทั้งเล่ม ออกแบบใหม่ 3 ทาง ตรวจให้คะแนน แล้วเลือกแนวที่ขายได้จริงกว่า'
    : canRethink
      ? 'เล่มนี้ตั้งค่าให้เขียน Prompt ปกให้เท่านั้น ระบบจึงสร้างภาพเองไม่ได้ — คิดแนวใหม่แล้วนำ Prompt ไปสร้างภาพเอง หรือเปลี่ยนโหมดปกเป็นอัตโนมัติ'
      : '';

  const authorOk = have.has('author-photo.png');
  /**
   * ช่องนี้บอกได้แค่ "จะวางบนปกหลัง" มาตลอด ซึ่งเคยเป็นการใช้งานเดียวที่มี
   * ตอนนี้รูปเดียวกันถูกแนบไปให้โมเดลดูได้ด้วย ต้องบอกให้ครบว่ามันจะถูกใช้ทำอะไรบ้าง
   * ไม่งั้นคนที่เลือกแนบอย่างเดียวจะอ่านว่า "ไม่ได้เลือกใช้บนปก" แล้วนึกว่าไม่ต้องอัปโหลด
   */
  const refWhere = authorRefSummary(book);
  const uses = [book?.authorPhotoOnCover && 'วางบนปกหลัง', refWhere && `แนบไปให้โมเดลดูตอนสร้าง ${refWhere}`]
    .filter(Boolean)
    .join(' · ');
  $('authorPhotoState').textContent = uses
    ? authorOk
      ? `ใส่ไฟล์แล้ว — ${uses}`
      : `ยังไม่มีไฟล์ — เล่มนี้ต้องใช้เพื่อ${uses}`
    : authorOk
      ? 'มีไฟล์แล้ว แต่ยังไม่ได้เลือกใช้ที่ไหน'
      : 'ไม่ได้เลือกใช้';
  $('authorPhotoSlot').classList.toggle('filled', authorOk);

  $('figList').innerHTML = imgs
    .map((f) => {
      const ok = have.has(f.name);
      const preview = previewUrls.get(f.name);
      return `<div class="fig${ok ? ' done' : ''}">
        <div class="top"><b>${esc(f.caption || f.name)}</b>
          <span class="kind">ตอน ${esc(f.section)} · ${Math.round(f.widthMm || 0)}×${Math.round(f.heightMm || 45)} มม. · ${esc(f.aspect || 'เดิม')}</span>
          <button data-fig="${esc(f.name)}">${ok ? 'เปลี่ยนไฟล์' : 'ใส่ไฟล์'}</button>
          ${book.figureMode === 'auto' && ok ? `<button data-regen-fig="${esc(f.name)}">สร้างใหม่เฉพาะรูปนี้</button>` : ''}</div>
        ${preview ? `<button type="button" class="figPreviewButton" data-preview-fig="${esc(f.name)}" title="คลิกเพื่อดูภาพเต็ม"><img class="figPreview" src="${esc(preview)}" alt="${esc(f.caption || f.name)}"></button>` : ''}
        ${f.prompt ? `<details><summary>ดู prompt สำหรับสร้างภาพนี้</summary><pre>${esc(f.prompt)}</pre></details>` : ''}
      </div>`;
    })
    .join('');

  $('figList')
    .querySelectorAll('[data-fig]')
    .forEach((b) => (b.onclick = () => pickImage(b.dataset.fig)));
  $('figList')
    .querySelectorAll('.fig')
    .forEach((row) => {
      const name = row.querySelector('[data-fig]')?.dataset.fig;
      if (!name) return;
      row.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('details')) return;
        aimSlot(name, row);
      });
    });
  $('figList')
    .querySelectorAll('[data-regen-fig]')
    .forEach((b) => (b.onclick = () => regenerateImageAsset(b.dataset.regenFig)));
  $('figList')
    .querySelectorAll('[data-preview-fig]')
    .forEach((b) => (b.onclick = () => {
      const url = previewUrls.get(b.dataset.previewFig);
      if (url) window.open(url, '_blank', 'noopener');
    }));
}

/** แสดงรูปที่เลือกไว้ให้เห็นกับตา ไม่ใช่แค่เชื่อว่าเลือกแล้ว */
function showSetupAuthorPhoto() {
  const img = $('authorPhotoSetupPreview');
  if (setupAuthorPhotoUrl) URL.revokeObjectURL(setupAuthorPhotoUrl);
  setupAuthorPhotoUrl = setupAuthorPhoto ? URL.createObjectURL(setupAuthorPhoto) : null;
  img.classList.toggle('hidden', !setupAuthorPhotoUrl);
  if (setupAuthorPhotoUrl) img.src = setupAuthorPhotoUrl;
  $('authorPhotoSetupState').textContent = setupAuthorPhoto
    ? `เลือกไว้แล้ว · ${setupAuthorPhoto.name || 'รูปที่วางมา'} — จะถูกบันทึกเป็น author-photo.png ตอนเริ่มสร้างเล่ม`
    : 'ยังไม่ได้เลือกรูป';
}

function setSetupAuthorPhoto(file) {
  if (!file?.type?.startsWith('image/')) return;
  setupAuthorPhoto = file;
  showSetupAuthorPhoto();
}

/**
 * ย้ายรูปที่อุ้มไว้ลงเป็นไฟล์จริงของเล่ม
 *
 * ล้มตรงนี้ห้ามล้มทั้งเล่ม — เล่มยังเขียนต่อได้ทั้งหมด เสียแค่รูปอ้างอิงหนึ่งใบ
 * และมีที่ให้อัปโหลดซ้ำอยู่แล้วทั้งที่หน้าแก้ไขและที่ประตู Phase 2
 */
async function saveSetupAuthorPhoto() {
  if (!setupAuthorPhoto || !book?.id) return;
  try {
    const { blob, w, h } = await normalizeImage(setupAuthorPhoto, { grayscale: false });
    await db.saveAsset(book.id, 'author-photo.png', blob, {
      w,
      h,
      dpi: dpiNote(w, 30).dpi,
      from: setupAuthorPhoto.name || 'paste',
    });
    addEvent('system', 'บันทึกรูปผู้เขียน', `author-photo.png · ${w}×${h}`);
  } catch (e) {
    addEvent('system', 'บันทึกรูปผู้เขียนไม่สำเร็จ', `${e?.message || e} — อัปโหลดซ้ำได้ที่หน้าตรวจงานหรือประตู Phase 2`);
  }
}

$('authorPhotoSetupPick').onclick = () => $('authorPhotoSetupFile').click();
$('authorPhotoSetupFile').onchange = (e) => {
  setSetupAuthorPhoto(e.target.files?.[0]);
  e.target.value = '';
};
document.querySelector('.authorRef')?.addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.closest('label')) return;
  document.querySelectorAll('.aimed').forEach((x) => x.classList.remove('aimed'));
  e.currentTarget.classList.add('aimed');
  status('เล็งช่องรูปผู้เขียนไว้แล้ว — กด Ctrl+V วางรูปได้เลย');
});

function pickImage(name) {
  pendingSlot = name;
  $('imgFile').click();
}

$('imgFile').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (file && pendingSlot) await ingestSlotFile(file, pendingSlot);
  pendingSlot = null;
  e.target.value = '';
};

/**
 * รับไฟล์ภาพหนึ่งไฟล์เข้าช่องหนึ่งช่อง
 *
 * แยกออกมาจากตัวจัดการ onchange เพราะตอนนี้ไฟล์มาได้สองทาง
 * ทั้งจากกล่องเลือกไฟล์ และจากการกด Ctrl+V วางรูปที่คัดลอกไว้
 * ทั้งสองทางต้องผ่านสายตรวจ ปรับขนาด และอัปเดตหน้าจอชุดเดียวกันทุกขั้น
 * ไม่งั้นรูปที่วางเข้ามาจะถูกบันทึกด้วย meta คนละชุดแล้วหน้าจอยังบอกว่ายังขาดอยู่
 */
async function ingestSlotFile(file, slot) {
  const isCover = slot.startsWith('cover-');
  const isAuthorPhoto = slot === 'author-photo';
  const name = isCover || isAuthorPhoto ? slot + '.png' : slot;

  /**
   * ผลลัพธ์ต้องไปโผล่บนหน้าจอที่ผู้ใช้ยืนอยู่จริง
   *
   * เดิมรายงานลง #docxReport อย่างเดียว ซึ่งอยู่ในการ์ด "ตรวจ/แก้" ที่ถูกซ่อนตอนอยู่หน้า Phase 2
   * กดอัปโหลดจากหน้า Phase 2 จึงไม่มีอะไรขึ้นเลยแม้ไฟล์จะถูกบันทึกสำเร็จ
   */
  const onPhase2 = !$('imagePhase').classList.contains('hidden');
  const say = (msg, bad = false) => {
    $('docxReport').textContent = msg;
    if (onPhase2) phase2Notice(`<b>${esc(msg)}</b>`, bad);
  };

  try {
    /**
     * ช่องที่เป็นงานของ Phase 2 ต้องผ่านสายตรวจ/ปรับขนาดชุดเดียวกับที่ระบบใช้
     *
     * เดิมบันทึกด้วย meta คนละชุด (ไม่มี generationVersion / artworkOnly)
     * ตัวตรวจของ Phase 2 จึงยังนับว่า "ยังไม่มีไฟล์" ต่อไป แถวไม่เปลี่ยน ตัวอย่างปกไม่ขึ้น
     * ผู้ใช้อัปโหลดสำเร็จแล้วแต่หน้าจอบอกว่ายังขาดอยู่เหมือนเดิม
     */
    const job = plannedImageJobs(book).find((j) => j.name === name);
    let note = '';
    if (job) {
      const meta = await ingestImageDataUrl(book, name, await db.blobToDataUrl(file));
      note = `${meta.widthPx || '?'}×${meta.heightPx || '?'}px`;
      book = await db.loadBook(book.id);
      book.imagePhase = {
        ...(book.imagePhase || {}),
        failures: (book.imagePhase?.failures || []).filter((f) => f.name !== name),
      };
    } else {
      // ปกและรูปผู้เขียนพิมพ์สี เนื้อในส่วนใหญ่พิมพ์ขาวดำ
      const { blob, w, h } = await normalizeImage(file, { grayscale: !isCover && !isAuthorPhoto && book.paper !== 'color' });
      const fig = (book.figures || []).find((f) => f.name === name);
      const printMm = isCover
        ? book.trim.widthMm
        : isAuthorPhoto
          ? 30
          : fig?.widthMm ||
            ((book.trim.widthMm - book.typography.marginsMm.inner - book.typography.marginsMm.outer) *
              (fig?.widthPct || 80)) /
              100;
      const dpi = dpiNote(w, printMm);
      note = `${w}×${h} · ${dpi.text}`;
      await db.saveAsset(book.id, name, blob, { w, h, dpi: dpi.dpi, from: file.name });
    }

    // ถ้า Phase 2/finish() เคยส่งออก interior.pdf/book.pdf/cover.pdf ไปแล้วก่อนหน้านี้
    // (เช่น อัปโหลดรูปผู้เขียนทีหลังหลังจากปกกับภาพประกอบอื่นเสร็จไปแล้ว) ต้องรีเซ็ตธงไว้
    // ไม่งั้น finish() จะเห็นว่า "ส่งออกแล้ว" และไม่สร้างไฟล์ใหม่ให้ ไฟล์เดิมจะขาดรูปนี้ไปถาวร
    if (book.imagePhase) {
      book.imagePhase.autoInteriorExportedAt = null;
      book.imagePhase.autoBookExportedAt = null;
      book.imagePhase.autoCoverExportedAt = null;
    }
    await db.saveBook(book);
    await syncSharedProject(book.id);

    assetNames = (await db.loadAssets(book.id)).map((a) => a.name);
    await renderImages();
    if (onPhase2) {
      await renderPhase2();
      await renderCoverPreview();
    }
    say(`ใส่ภาพ ${name} แล้ว · ${note}`);
    addEvent('system', 'ใส่ภาพ', `${name} — ${note}`);
  } catch (err) {
    say('ใส่ภาพไม่สำเร็จ: ' + (err?.message || err), true);
  }
}

/**
 * เล็งช่องไว้ก่อนวาง
 *
 * การวางรูปต้องรู้ว่าจะวางลงช่องไหน แต่คลิปบอร์ดไม่ได้บอกอะไรเลยนอกจากตัวไฟล์
 * จึงให้คลิกที่ช่องเพื่อเล็งไว้ก่อน แล้วค่อยกด Ctrl+V
 * ช่องที่เล็งไว้ต้องเห็นได้ด้วยตา ไม่ใช่สถานะที่มีอยู่แต่ในหัวโปรแกรม
 */
function aimSlot(name, el) {
  pendingSlot = name;
  document.querySelectorAll('.aimed').forEach((x) => x.classList.remove('aimed'));
  el?.classList.add('aimed');
  const where = name === 'author-photo' ? 'รูปผู้เขียน' : name.replace(/\.png$/, '');
  status(`เล็งช่อง ${where} ไว้แล้ว — กด Ctrl+V วางรูปที่คัดลอกไว้ได้เลย หรือกดปุ่มเลือกไฟล์`);
}

/**
 * วางรูปจากคลิปบอร์ด
 *
 * ทางเดิมมีทางเดียวคือกดปุ่ม แล้วไปหาไฟล์ในเครื่อง ซึ่งแปลว่าภาพที่เพิ่งสร้างจากเว็บอื่น
 * ต้องเซฟลงเครื่องก่อนเสมอ ทั้งที่มันอยู่ในคลิปบอร์ดพร้อมใช้อยู่แล้ว
 *
 * ถ้ายังไม่ได้เล็งช่องไว้ แต่ทั้งเล่มเหลือช่องว่างช่องเดียว ก็ไม่ต้องถาม — ลงช่องนั้นแหละ
 * แต่ถ้าเหลือหลายช่อง ห้ามเดา เพราะเดาผิดคือไปทับไฟล์ที่ผู้ใช้ตั้งใจใส่ไว้แล้ว
 */
async function pasteImageFromClipboard(e) {
  const onSetup = !$('start').classList.contains('hidden');
  const onEditor = !$('editor').classList.contains('hidden');
  const onPhase2 = !$('imagePhase').classList.contains('hidden');
  if (!onSetup && !onEditor && !onPhase2) return;

  /**
   * ห้ามแย่งการวางของช่องพิมพ์
   *
   * หน้าแก้ไขมีช่องแก้เนื้อหาอยู่ในหน้าเดียวกัน ถ้าดักการวางไว้ทั้งหน้าโดยไม่ยกเว้น
   * การวางข้อความลงช่องนั้นจะยังทำงาน แต่การวางรูปจะถูกลากไปเข้าช่องภาพแทน
   * ทั้งที่คนกำลังพิมพ์อยู่ในช่องข้อความ ซึ่งไม่ใช่สิ่งที่เขาสั่ง
   */
  const t = e.target;
  if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;

  const items = [...(e.clipboardData?.items || [])];
  const file = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
  if (!file) return;
  e.preventDefault();

  /**
   * หน้าตั้งค่ามีช่องเดียวที่รับรูปได้ คือรูปผู้เขียน จึงไม่ต้องถามว่าจะวางที่ไหน
   * และเล่มยังไม่มี id ให้บันทึกไฟล์ ต้องอุ้มไว้ก่อนเหมือนการเลือกไฟล์ด้วยมือ
   */
  if (onSetup) {
    setSetupAuthorPhoto(file);
    status('วางรูปผู้เขียนแล้ว — จะถูกบันทึกตอนเริ่มสร้างเล่ม');
    return;
  }

  let slot = pendingSlot;
  if (!slot) {
    const empty = emptyImageSlots();
    if (empty.length === 1) slot = empty[0];
    else {
      const msg = empty.length
        ? `คัดลอกรูปมาแล้ว แต่ยังไม่ได้เลือกว่าจะวางช่องไหน — คลิกที่ช่องที่ต้องการก่อน แล้วกด Ctrl+V อีกครั้ง (ยังว่างอยู่ ${empty.length} ช่อง)`
        : 'คัดลอกรูปมาแล้ว แต่ทุกช่องมีไฟล์ครบแล้ว — คลิกช่องที่ต้องการเปลี่ยนก่อน แล้วกด Ctrl+V อีกครั้ง';
      status(msg);
      if (onPhase2) phase2Notice(`<b>${esc(msg)}</b>`, true);
      else $('docxReport').textContent = msg;
      return;
    }
  }

  status(`กำลังวางรูปลงช่อง ${slot}`);
  await ingestSlotFile(file, slot);
  pendingSlot = null;
  document.querySelectorAll('.aimed').forEach((x) => x.classList.remove('aimed'));
}

/** ช่องภาพที่ยังไม่มีไฟล์ — ใช้ตัดสินว่าวางรูปโดยไม่ต้องถามได้ไหม */
function emptyImageSlots() {
  const have = new Set(assetNames);
  const slots = plannedImageJobs(book).map((j) => j.name);
  if (needsAuthorPhoto(book)) slots.push('author-photo.png');
  return slots.filter((n) => !have.has(n)).map(uploadSlotFor);
}

document.addEventListener('paste', (e) => {
  pasteImageFromClipboard(e).catch((err) => status('วางรูปไม่สำเร็จ: ' + (err?.message || err)));
});

document.querySelectorAll('[data-cover]').forEach((b) => (b.onclick = () => pickImage(b.dataset.cover)));

// คลิกที่ช่อง (ไม่ใช่ที่ปุ่มในช่อง) = เล็งช่องนั้นไว้รอวาง
document.querySelectorAll('.coverSlots .slot').forEach((slot) => {
  const name = slot.querySelector('[data-cover]')?.dataset.cover;
  if (!name) return;
  slot.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    aimSlot(name, slot);
  });
});
$('coverRegenFront').onclick = () => confirmRegenerateCover('cover-front.png', 'front');
$('coverRegenBack').onclick = () => confirmRegenerateCover('cover-back.png', 'back');
$('coverRethink').onclick = () => rethinkCoverWithGpt();
$('editorToPhase2').onclick = () => recoverPhase2Gate();

$('figPrompts').onclick = async () => {
  try {
    await X.exportFigurePrompts(book);
    $('docxReport').textContent = 'ส่งออกไฟล์ prompt แล้ว — เอาไปสร้างภาพที่ไหนก็ได้ แล้วกลับมาใส่ไฟล์';
  } catch (e) {
    $('docxReport').textContent = 'ส่งออกไม่สำเร็จ: ' + (e?.message || e);
  }
};

// ---------- DOCX: แก้ในเวิร์ดก่อนทำ PDF ----------
$('docxOut').onclick = async () => {
  $('docxReport').textContent = 'กำลังสร้าง .docx ...';
  try {
    const size = await X.exportDocx(book, sections);
    $('docxReport').textContent = `ส่งออกแล้ว ${(size / 1024).toFixed(0)} KB — เปิดแก้ในเวิร์ดได้เลย แล้วค่อยนำกลับเข้ามา`;
  } catch (e) {
    $('docxReport').textContent = 'ส่งออกไม่สำเร็จ: ' + (e?.message || e);
  }
};

$('docxIn').onclick = () => $('docxFile').click();

$('docxFile').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $('docxReport').textContent = 'กำลังอ่านไฟล์...';
  try {
    // ดูก่อนว่าจะเปลี่ยนอะไรบ้าง แล้วค่อยยืนยัน ไม่ทับของเดิมทันที
    const preview = await X.importDocx(book, file, { apply: false });
    if (!preview.changes.length) {
      $('docxReport').textContent = `อ่านได้ ${preview.total} ตอน แต่ไม่มีอะไรเปลี่ยนจากของเดิม`;
      return;
    }
    const lines = preview.changes
      .slice(0, 12)
      .map((c) => `  ${c.id} ${c.title}: ${c.before.toLocaleString()} → ${c.after.toLocaleString()} (${c.delta >= 0 ? '+' : ''}${c.delta})`)
      .join('\n');
    const ok = confirm(
      `จะทับเนื้อหา ${preview.changes.length} ตอนจากไฟล์นี้\n\n${lines}` +
        (preview.changes.length > 12 ? `\n  ...และอีก ${preview.changes.length - 12} ตอน` : '') +
        '\n\nของเดิมจะถูกเก็บไว้ย้อนกลับได้ ยืนยันหรือไม่',
    );
    if (!ok) return ($('docxReport').textContent = 'ยกเลิกแล้ว ไม่ได้แก้อะไร');

    const applied = await X.importDocx(book, file, { apply: true });
    sections = (await db.loadSections(book.id)).sort((a, b) => cmpId(a.id, b.id));
    renderSecList();
    $('docxReport').textContent = `นำเข้าแล้ว ${applied.changes.length} ตอน — กดนับหน้าใหม่เพื่อดูว่ากี่หน้า`;
    addEvent('system', 'นำเข้า .docx', `${applied.changes.length} ตอนถูกแทนที่ด้วยฉบับที่แก้ในเวิร์ด`);
  } catch (err) {
    $('docxReport').textContent = 'นำเข้าไม่สำเร็จ: ' + (err?.message || err);
  } finally {
    e.target.value = '';
  }
};

$('resumeGo').onclick = resumeGo;
$('refreshProjects').onclick = loadProjectHistory;
$('resumeHistory').onclick = async () => {
  await loadProjectHistory();
  $('projectList').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
$('acceptPages').onclick = acceptCurrentPages;
$('resumeSwitchEngine').onclick = switchBookEngine;
$('resumeDrop').onclick = async () => {
  if (book?.id) await db.deleteBook(book.id);
  book = null;
  $('resume').classList.add('hidden');
};
$('inspirePolish').onclick = polishUserOutline;
$('start')?.addEventListener('input', renderStepGuide);
$('start')?.addEventListener('change', renderStepGuide);
renderStepGuide();
['pages', 'trim', 'secLen', 'opt_consistency', 'writeMode', 'pageMode'].forEach((id) => {
  if (!$(id)) return;
  $(id).addEventListener('input', updateEstimate);
  $(id).addEventListener('change', updateEstimate);
});
// ภาษาอังกฤษใช้ตัวเล็กกว่าและระยะบรรทัดแคบกว่าไทย ปรับให้อัตโนมัติ
$('lang').addEventListener('change', () => {
  const th = $('lang').value === 'th';
  $('sizePt').value = th ? 14 : 11;
  $('lineHeight').value = th ? 1.55 : 1.45;
  $('justify').value = th ? 'off' : 'on';
  updateEstimate();
});
updateEstimate();
updateItemPlan();
syncMode();
$('audience').addEventListener('change', saveCreatorDefaults);
$('author').addEventListener('change', saveCreatorDefaults);
$('title').addEventListener('input', () => {
  if (outlineDirection?.titleBase && outlineDirection.titleBase !== $('title').value.trim()) resetOutlineDirection();
});
$('trendRandom').onclick = generateTrendIdeas;
$('titleIdeate').onclick = generateTitleIdeas;
$('outlineIdeate').onclick = generateOutlineDirections;

async function initializeStudio() {
  setMacroStage('start');
  await loadCreatorDefaults();
  const sharedDir = await W.restoreDirectoryHandle();
  if (sharedDir) {
    X.setExportDirectoryHandle(sharedDir);
    try {
      // สำคัญสำหรับโปรเจกต์ที่สร้างก่อนเพิ่ม Shared Workspace หรือเลือก Folder ผ่าน Side Panel:
      // เปิด Studio เมื่อใด ให้ publish local-only projects ที่ใหม่กว่าเข้าโฟลเดอร์กลางอัตโนมัติ
      const merged = await W.mergeLocalProjectsToWorkspace();
      const info = await W.getWorkspaceInfo();
      const shortId = info?.id ? info.id.slice(0, 8) : 'ไม่ทราบ';
      $('folderName').textContent = `${sharedDir.name || 'เลือกแล้ว'} · Shared Workspace ${shortId} · ${merged.shared || 0} โครงการ`;
    } catch (e) {
      $('folderName').textContent = `${sharedDir.name || 'เลือกแล้ว'} · Shared Workspace · อ่านไม่สำเร็จ: ${e?.message || e}`;
    }
  }
  await loadUnfinished();
  await loadProjectHistory();
}
initializeStudio();

function handleUiCommand(m) {
  if (m?.type === 'ui.command' && m.command === 'trendRandom') {
    $('title').value = m.title || '';
    if (typeof m.audience === 'string') $('audience').value = m.audience;
    if (typeof m.author === 'string') $('author').value = m.author;
    if (['items', 'prose', 'fiction'].includes(m.contentMode)) {
      $('contentMode').value = m.contentMode;
      syncMode();
    }
    generateTrendIdeas();
    return;
  }
  if (m?.type === 'ui.command' && m.command === 'titleIdeas') {
    $('title').value = m.title || '';
    if (typeof m.audience === 'string') $('audience').value = m.audience;
    if (typeof m.author === 'string') $('author').value = m.author;
    if (['items', 'prose', 'fiction'].includes(m.contentMode)) {
      $('contentMode').value = m.contentMode;
      syncMode();
    }
    generateTitleIdeas();
    return;
  }
  if (m?.type === 'ui.command' && m.command === 'createBook') {
    $('title').value = m.title || '';
    if (typeof m.audience === 'string') $('audience').value = m.audience;
    if (typeof m.author === 'string') $('author').value = m.author;
    if (['items', 'prose', 'fiction'].includes(m.contentMode)) {
      $('contentMode').value = m.contentMode;
      syncMode();
    }
    create();
  }
}

chrome.runtime.onMessage.addListener((m) => {
  handleUiCommand(m);
  handleGptMessage(m);
});
chrome.runtime
  .sendMessage({ type: 'sw.registerStudio', watchdog: true })
  .then((r) => handleUiCommand(r?.pending))
  .catch(() => {});
