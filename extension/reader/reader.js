/**
 * หน้าอ่าน — อ่านเล่มที่ทำไว้ได้ทันที โดยไม่ต้องดาวน์โหลดไฟล์ก่อน
 *
 * ทำไมไม่อ่านผ่าน EPUB ที่ส่งออกอยู่แล้ว: EPUB เป็นของแปลงปลายทาง
 * ความจริงต้นทางคือ md ของแต่ละตอนใน IndexedDB การอ่านจากต้นทางจึงตรงกว่า
 * และไม่ต้องบีบเป็น zip แล้วแกะกลับในหน้าเว็บ ซึ่ง CSP ของส่วนขยายก็ไม่ให้โหลดไลบรารีมาแกะอยู่ดี
 *
 * หน้านี้อ่านอย่างเดียว ไม่เขียนอะไรลงฐานข้อมูลเลย
 * จึงเปิดค้างไว้ขณะที่ Studio กำลังเดินงานอยู่อีกแท็บได้ โดยไม่ชนกัน
 */
import * as db from '../core/db.js';
import { stripZwsp } from '../core/thai.js';
import { stripEchoedHeading } from '../core/extract.js';
import { backMatterSections } from '../core/references.js';
import { frontMatterPages } from '../core/book-parts.js';
import { esc, mdToHtml, isItemsBook, compareItemId } from '../core/md-html.js';

const $ = (id) => document.getElementById(id);

// ---------- สถานะของหน้า ----------

const state = { book: null, byId: new Map(), pages: [], at: 0, urls: [], col: 0, cols: 1, flipping: false };

/**
 * โหมดแบ่งหน้า — จัดเนื้อหาของบทที่เปิดอยู่เป็นคอลัมน์กว้างเท่าจอ แล้วเลื่อนทีละคอลัมน์
 *
 * ต้องคำนวณใหม่ทุกครั้งที่อะไรเปลี่ยนขนาด: เปลี่ยนบท ปรับขนาดตัวอักษร ย่อ/ขยายหน้าต่าง
 * และหลังภาพโหลดเสร็จด้วย เพราะภาพที่เพิ่งมามีความสูงจริงแล้ว จำนวนหน้าจึงขยับ
 */
const COL_GAP = 56;

function layoutPaged() {
  const vp = $('viewport');
  const p = $('page');
  if (!prefs.paged) {
    vp.classList.remove('paged');
    for (const k of ['width', 'columnWidth', 'columnGap', 'height', 'transform']) p.style[k] = '';
    state.cols = 1;
    state.col = 0;
    return;
  }
  vp.classList.add('paged');
  const w = Math.max(240, vp.clientWidth);
  // ความสูงที่เหลือจริงหลังหักแถบบนกับแถบเลื่อนหน้าด้านล่าง
  const h = Math.max(280, Math.round(window.innerHeight - vp.getBoundingClientRect().top - 96));
  p.style.width = `${w}px`;
  p.style.columnWidth = `${w}px`;
  p.style.columnGap = `${COL_GAP}px`;
  p.style.height = `${h}px`;
  state.cols = Math.max(1, Math.round(p.scrollWidth / (w + COL_GAP)));
  state.col = Math.min(state.col, state.cols - 1);
  applyCol();
}

function applyCol() {
  const p = $('page');
  if (!prefs.paged) return;
  p.style.transform = `translateX(-${state.col * (p.clientWidth + COL_GAP)}px)`;
  updatePos();
}

/**
 * ตัวเลขบอกตำแหน่ง — ต้องบอกด้วยว่านับอะไรอยู่
 *
 * เดิมเขียนแค่ "1 / 7" ซึ่งอ่านได้เป็น "เล่มนี้มี 7 หน้า" ทั้งที่เล่มจริงเกือบร้อยหน้า
 * เลข 7 คือจำนวนหัวข้อในสารบัญ (ปก + บท + ท้ายเล่ม) ไม่ใช่จำนวนหน้ากระดาษ
 * ส่วนเลขหน้าในโหมดแบ่งหน้าก็นับเฉพาะหัวข้อที่เปิดอยู่ ไม่ใช่ทั้งเล่ม เพราะจอแต่ละขนาดแบ่งหน้าไม่เท่ากัน
 */
function updatePos() {
  const page = state.pages[state.at];
  const where = `หัวข้อ ${state.at + 1} / ${state.pages.length}`;
  $('pos').textContent =
    prefs.paged && state.cols > 1 ? `${where} · หน้า ${state.col + 1}/${state.cols} ในหัวข้อนี้` : where;
  $('prev').disabled = state.at === 0 && (!prefs.paged || state.col === 0);
  $('next').disabled = state.at === state.pages.length - 1 && (!prefs.paged || state.col === state.cols - 1);
  $('barSub').textContent = page ? page.label : '';
}

/**
 * พลิกหน้ากระดาษ — ถ่ายสำเนาหน้าที่กำลังจะผ่านไปทับไว้ก่อน แล้วค่อยเปลี่ยนของจริงข้างใต้
 *
 * ต้องถ่ายสำเนาก่อนเปลี่ยน เพราะของจริงต้องกลายเป็นหน้าใหม่ทันทีเพื่อให้โผล่อยู่ข้างใต้
 * ไปข้างหน้าหมุนรอบขอบซ้ายเหมือนพลิกไปหน้าถัดไป ถอยหลังหมุนรอบขอบขวา
 *
 * คนที่ตั้งค่าเครื่องว่าไม่เอาภาพเคลื่อนไหว (prefers-reduced-motion) ต้องได้หน้าใหม่ทันที
 * ไม่ใช่ได้ภาพหมุนที่ช้ากว่าเดิม — การ์ดใบนี้เป็นเรื่องอาการเวียนหัวจริง ไม่ใช่รสนิยม
 */
const FLIP_MS = 460;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;

async function turn(dir, apply) {
  if (state.flipping) return;
  const vp = $('viewport');
  const p = $('page');
  if (!prefs.paged || reduceMotion() || typeof p.animate !== 'function') return apply();

  const clip = document.createElement('div');
  clip.className = `flipClip ${dir > 0 ? 'fwd' : 'back'}`;
  clip.style.width = `${p.clientWidth}px`;
  const copy = p.cloneNode(true);
  copy.removeAttribute('id');
  const shade = document.createElement('i');
  shade.className = 'flipShade';
  clip.append(copy, shade);
  vp.appendChild(clip);

  state.flipping = true;
  try {
    await apply();
    const spin = clip.animate(
      [
        { transform: 'rotateY(0deg)' },
        { transform: `rotateY(${dir > 0 ? -118 : 118}deg)` },
      ],
      { duration: FLIP_MS, easing: 'cubic-bezier(.4,0,.35,1)', fill: 'forwards' },
    );
    shade.animate([{ opacity: 0 }, { opacity: 0.55 }], { duration: FLIP_MS, easing: 'ease-in', fill: 'forwards' });
    /**
     * ห้ามรอ finished อย่างเดียว
     * แท็บที่ถูกซ่อนอยู่ (หรือถูกเบราว์เซอร์หรี่การวาดทิ้ง) จะไม่เดินแอนิเมชันเลย
     * แล้ว finished จะไม่ถูกเรียกสักที สำเนาหน้ากระดาษก็จะค้างทับจออยู่อย่างนั้น
     */
    await Promise.race([spin.finished.catch(() => null), new Promise((r) => setTimeout(r, FLIP_MS + 250))]);
  } finally {
    clip.remove();
    state.flipping = false;
  }
}

/** เดินหน้า/ถอยหลัง — ในโหมดแบ่งหน้าต้องไล่คอลัมน์ให้หมดบทก่อนค่อยข้ามบท */
function step(dir) {
  if (state.flipping) return;
  if (!prefs.paged) return show(state.at + dir);

  const next = state.col + dir;
  if (next >= 0 && next < state.cols) {
    return turn(dir, () => {
      state.col = next;
      applyCol();
    });
  }
  if (dir > 0 ? state.at >= state.pages.length - 1 : state.at <= 0) return;
  // ถอยกลับเข้าบทก่อนหน้า ต้องไปโผล่หน้าสุดท้ายของบทนั้น ไม่ใช่หน้าแรก
  return turn(dir, () => show(state.at + dir, { col: dir < 0 ? 'last' : 0 }));
}

/**
 * ObjectURL ของภาพในบทก่อนต้องถูกคืน ไม่งั้นอ่านไปสิบบทก็ถือภาพไว้ทั้งสิบบท
 *
 * แต่ระหว่างพลิกหน้า สำเนาของหน้าเดิมยังแสดงอยู่บนจอและยังชี้ไป URL ชุดนี้
 * ถ้าคืนทันทีตามเดิม ภาพในหน้าที่กำลังหมุนจะกลายเป็นรูปเสียให้เห็นเต็ม ๆ
 * จึงต้องรอให้หมุนจบก่อนค่อยคืน
 */
function releaseUrls() {
  const urls = state.urls;
  state.urls = [];
  if (!state.flipping) return urls.forEach((u) => URL.revokeObjectURL(u));
  setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), FLIP_MS + 120);
}

const bodyOf = (sec) => stripZwsp(stripEchoedHeading(sec?.md || '', sec || {}));

/** คำอธิบายใต้ชื่อหน้าในสารบัญด้านซ้าย — บอกว่าหน้านั้นมีอะไรอยู่จริง */
const frontSub = (p) =>
  ({
    titlepage: p.author || '',
    copyright: `${p.lines?.length || 0} บรรทัด`,
    foreword: 'ก่อนเข้าเนื้อหา',
    toc: `${p.entries?.length || 0} รายการ`,
  })[p.key] || '';

/**
 * สารบัญจริงของเล่ม — ปก ตามด้วยเนื้อใน แล้วปิดท้ายด้วยส่วนท้ายเล่ม
 * เล่มแบบรายชิ้น (กลอน/เคล็ดลับ) ไม่มี "บท" จึงใช้ธีมเป็นหน่วยแทน
 */
function buildPages(book, sections) {
  const pages = [{ kind: 'cover', label: 'ปก', sub: book.author || '' }];
  // ปกใน ลิขสิทธิ์ คำนำ สารบัญ — ชุดเดียวกับที่ตัวเรียงพิมพ์ใส่ในเล่มจริง
  for (const part of frontMatterPages(book)) pages.push({ ...part, sub: frontSub(part) });

  if (isItemsBook(book)) {
    for (const theme of book.outline.themes || []) {
      const items = sections
        .filter((s) => (s.kind === 'item' || s.text) && String(s.theme ?? s.id).split('.')[0] === String(theme.n))
        .sort((a, b) => compareItemId(a.id, b.id));
      pages.push({ kind: 'items', label: theme.title, sub: `${items.length} ชิ้น`, items, theme: theme.n });
    }
  } else {
    for (const ch of book.outline?.chapters || []) {
      const secs = ch.sections || [];
      const written = secs.filter((s) => (state.byId.get(s.id)?.md || '').trim()).length;
      pages.push({
        kind: 'chapter',
        label:
          book.contentMode === 'fiction'
            ? `${book.language === 'th' ? 'บทที่' : 'Chapter'} ${ch.n}${ch.title ? ` · ${ch.title}` : ''}`
            : ch.title,
        sub: written < secs.length ? `เขียนแล้ว ${written}/${secs.length} ตอน` : `${secs.length} ตอน`,
        chapter: ch,
      });
    }
  }

  for (const s of backMatterSections(book)) {
    pages.push({ kind: 'back', label: s.title, sub: `${s.lines.length} รายการ`, lines: s.lines });
  }
  return pages;
}

function coverHtml(book) {
  const o = book.outline || {};
  const inner = `<div class="inner"><div class="t">${esc(o.title || book.topic || '')}</div>${
    book.author ? `<div class="a">${esc(book.author)}</div>` : ''
  }</div>`;
  const facts = [
    o.subtitle ? esc(o.subtitle) : '',
    book.finalPages || book.targetPages ? `${esc(String(book.finalPages || book.targetPages))} หน้า` : '',
    book.updatedAt ? `แก้ไขล่าสุด ${new Date(book.updatedAt).toLocaleDateString('th-TH')}` : '',
  ].filter(Boolean);
  return `<div class="cover" data-cover>${inner}</div><div class="coverMeta">${facts.join('<br>')}</div>`;
}

function pageHtml(page, book) {
  if (page.kind === 'cover') return coverHtml(book);

  /**
   * หน้าปกใน — หน้าแรกที่เป็นตัวหนังสือจริงของเล่ม
   * จัดกึ่งกลางกับเว้นที่โล่งรอบตัว เหมือนหน้าเดียวกันในไฟล์ที่พิมพ์
   */
  if (page.kind === 'titlepage') {
    return (
      `<div class="titleLeaf"><div class="t">${esc(page.title)}</div>` +
      `${page.subtitle ? `<div class="s">${esc(page.subtitle)}</div>` : ''}` +
      `${page.author ? `<div class="a">${esc(page.author)}</div>` : ''}</div>`
    );
  }

  if (page.kind === 'lines') {
    return `<div class="colophon">${page.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
  }

  if (page.kind === 'prose') {
    return `<h1>${esc(page.label)}</h1>${mdToHtml(stripZwsp(page.md))}`;
  }

  /**
   * หน้าสารบัญของเล่ม — คนละอย่างกับแถบสารบัญด้านซ้ายของหน้าอ่าน
   * แถบซ้ายคือเครื่องมือเดินเรื่องของหน้าเว็บ ส่วนหน้านี้คือหน้ากระดาษที่มีอยู่จริงในเล่ม
   * กดที่รายการแล้วต้องกระโดดไปหัวข้อนั้นได้ เพราะบนจอมันทำได้ และไม่ทำก็ดูเหมือนเสีย
   */
  if (page.kind === 'toc') {
    return (
      `<h1>${esc(page.label)}</h1><div class="tocPage">` +
      page.entries
        .map(
          (e, i) => `<button type="button" class="d${e.depth}" data-goto="${i}">${esc(e.text)}</button>`,
        )
        .join('') +
      '</div>'
    );
  }

  if (page.kind === 'back') {
    return `<h1>${esc(page.label)}</h1>${page.lines.map((l) => `<p>${esc(l)}</p>`).join('')}`;
  }

  if (page.kind === 'items') {
    if (!page.items.length) return `<h1>${esc(page.label)}</h1><div class="note">ธีมนี้ยังไม่มีชิ้นงานที่เขียนเสร็จ</div>`;
    return (
      `<h1>${esc(page.label)}</h1>` +
      page.items
        .map((item) => {
          const text = mdToHtml(stripZwsp(item.md ?? item.text ?? ''));
          const by = item.attribution ? `<footer>— ${esc(item.attribution)}</footer>` : '';
          return `<blockquote>${text}${by}</blockquote><div class="rule"></div>`;
        })
        .join('')
    );
  }

  const ch = page.chapter;
  const fiction = book.contentMode === 'fiction';
  const secs = ch.sections || [];
  const written = secs.filter((s) => (state.byId.get(s.id)?.md || '').trim());
  const head = `${fiction ? '' : `<div class="chapterHead">บทที่ ${esc(String(ch.n))}</div>`}<h1>${esc(page.label)}</h1>`;
  if (!written.length) return `${head}<div class="note">บทนี้ยังไม่ได้เขียน — เปิดใน Studio แล้วสั่งเขียนต่อได้</div>`;

  const body = secs
    .map((s, i) => {
      const md = bodyOf(state.byId.get(s.id));
      if (!md.trim()) return fiction ? '' : `<h2>${esc(s.title)}</h2><div class="note">ตอนนี้ยังไม่ได้เขียน</div>`;
      if (fiction) return `${i ? '<div class="scene">* * *</div>' : ''}${mdToHtml(md)}`;
      return `<h2>${esc(s.title)}</h2>${mdToHtml(md)}`;
    })
    .join('\n');

  const missing = secs.length - written.length;
  const note = missing ? `<div class="note"><b>ยังเขียนไม่จบ</b> — บทนี้ขาดอีก ${missing} ตอน</div>` : '';
  return `${head}${note}${body}`;
}

/** ไฟล์ภาพของบทที่กำลังอ่านเท่านั้น ไม่ดึงภาพทั้งเล่มมากองไว้ */
async function fillFigures(root) {
  for (const fig of root.querySelectorAll('figure[data-fig]')) {
    const name = fig.dataset.fig;
    const asset = await db.loadAsset(state.book.id, name).catch(() => null);
    const slot = fig.querySelector('.slot');
    if (!asset?.blob?.size) {
      if (slot) slot.textContent = `ยังไม่มีไฟล์ภาพ ${name}`;
      continue;
    }
    const url = URL.createObjectURL(asset.blob);
    state.urls.push(url);
    const img = new Image();
    img.src = url;
    img.alt = fig.querySelector('figcaption')?.textContent || name;
    img.style.width = `${fig.dataset.w || 80}%`;
    slot?.replaceWith(img);
  }
}

async function fillCover(root) {
  const box = root.querySelector('[data-cover]');
  if (!box) return;
  const asset = await db.loadAsset(state.book.id, 'cover-front.png').catch(() => null);
  if (!asset?.blob?.size) return;
  const url = URL.createObjectURL(asset.blob);
  state.urls.push(url);
  const img = new Image();
  img.src = url;
  img.alt = `ปกของ ${state.book.outline?.title || ''}`;
  box.replaceChildren(img);
}

/** กดรายการในหน้าสารบัญแล้วต้องไปถึงบทนั้นจริง ชี้ด้วยเลขบท ไม่ใช่เทียบชื่อซึ่งซ้ำกันได้ */
function wireTocPage(root, page) {
  root.querySelectorAll('[data-goto]').forEach((el) => {
    el.onclick = () => {
      const e = page.entries[Number(el.dataset.goto)];
      const at = state.pages.findIndex((p) =>
        e.theme != null ? p.theme === e.theme : p.chapter && String(p.chapter.n) === String(e.chapter),
      );
      if (at >= 0) show(at);
    };
  });
}

/**
 * จอแคบ พอเลือกบทแล้วต้องปิดสารบัญเอง
 * ไม่งั้นผู้ใช้ต้องเลื่อนผ่านสารบัญทั้งชุดทุกครั้งกว่าจะถึงตัวหนังสือ
 */
function closeTocOnNarrow() {
  if (window.matchMedia('(max-width:900px)').matches) document.querySelector('.shell').classList.remove('tocOn');
}

function renderToc() {
  const toc = $('toc');
  toc.innerHTML =
    '<div class="grp">สารบัญ</div>' +
    state.pages
      .map(
        (p, i) =>
          `<button data-at="${i}" class="${i === state.at ? 'sel' : ''}">${esc(p.label)}${
            p.sub ? `<span class="n">${esc(p.sub)}</span>` : ''
          }</button>`,
      )
      .join('');
  toc.querySelectorAll('[data-at]').forEach((el) => {
    el.onclick = () => {
      closeTocOnNarrow();
      show(Number(el.dataset.at));
    };
  });
}

async function show(at, { col = 0 } = {}) {
  releaseUrls();
  state.at = Math.max(0, Math.min(state.pages.length - 1, at));
  const page = state.pages[state.at];
  const root = $('page');
  root.style.transform = '';
  root.innerHTML = pageHtml(page, state.book);
  window.scrollTo({ top: 0 });

  state.col = 0;
  layoutPaged();
  if (col === 'last') state.col = state.cols - 1;
  applyCol();
  updatePos();
  $('toc')
    .querySelectorAll('[data-at]')
    .forEach((el) => el.classList.toggle('sel', Number(el.dataset.at) === state.at));

  if (page.kind === 'cover') await fillCover(root);
  else if (page.kind === 'toc') wireTocPage(root, page);
  else await fillFigures(root);
  // ภาพเพิ่งมาถึง ความสูงจริงเปลี่ยน จำนวนหน้าจึงต้องนับใหม่
  const keep = col === 'last';
  layoutPaged();
  if (keep) {
    state.col = state.cols - 1;
    applyCol();
  }
}

// ---------- ความสบายตาของผู้อ่าน จำไว้ในเครื่อง ไม่ยุ่งกับข้อมูลเล่ม ----------

const PREF = 'reader.prefs';
const prefs = (() => {
  try {
    return { size: 18, theme: 'day', paged: false, ...JSON.parse(localStorage.getItem(PREF) || '{}') };
  } catch {
    return { size: 18, theme: 'day', paged: false };
  }
})();

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.style.setProperty('--fs', `${prefs.size}px`);
  $('modeBtn').textContent = prefs.paged ? 'เลื่อนยาว' : 'แบ่งหน้า';
  layoutPaged();
  try {
    localStorage.setItem(PREF, JSON.stringify(prefs));
  } catch {
    /* โหมดส่วนตัวของเบราว์เซอร์ห้ามเขียน — อ่านต่อได้ แค่ไม่จำค่าไว้ */
  }
}

/**
 * ทางกลับ — หน้านี้เปิดเป็นแท็บใหม่ ประวัติของแท็บจึงว่างเปล่า ปุ่ม Back ของเบราว์เซอร์พาไปไหนไม่ได้
 * ต้องพากลับไปที่แท็บ Studio เดิมถ้ายังเปิดอยู่ ไม่ใช่เปิด Studio ซ้ำอีกหน้าหนึ่ง
 */
async function backToShelf() {
  const studio = chrome.runtime.getURL('ui/studio.html');
  const [open] = await chrome.tabs.query({ url: studio }).catch(() => []);
  if (open) await chrome.tabs.update(open.id, { active: true }).catch(() => null);
  else await chrome.tabs.create({ url: studio }).catch(() => null);
  const me = await chrome.tabs.getCurrent().catch(() => null);
  if (me) chrome.tabs.remove(me.id).catch(() => null);
}

/**
 * แก้ไขเล่มนี้ — ส่งเล่มกลับเข้า Studio แล้วย้ายตัวเองไปที่นั่น
 *
 * คลิกปกบนชั้นหนังสือพาคนมาที่หน้าอ่าน ซึ่งถูกแล้วสำหรับคนที่จะอ่าน
 * แต่คนที่เปิดมาเพื่อจะแก้ ต้องมีทางเดินต่อจากตรงนี้ ไม่ใช่ต้องย้อนกลับไปหาการ์ดแล้วกดให้ถูกจุด
 */
async function editInStudio() {
  const btn = $('editBtn');
  btn.disabled = true;
  try {
    const sent = await chrome.runtime
      .sendMessage({ type: 'ui.command', command: 'openProject', bookId: state.book.id })
      .catch(() => null);
    if (!sent?.ok) {
      note('<b>เปิดใน Studio ไม่สำเร็จ</b> — เปิดหน้า Studio เองแล้วกดเล่มนี้จากชั้นหนังสือ', true);
      return;
    }
    const me = await chrome.tabs.getCurrent().catch(() => null);
    if (me) chrome.tabs.remove(me.id).catch(() => null);
  } finally {
    btn.disabled = false;
  }
}

const note = (html, bad = false) => {
  const box = $('saveNote');
  box.className = `saveNote${bad ? ' bad' : ''}`;
  box.innerHTML = html;
};

const FORMATS = {
  pdf: {
    btn: 'savePdf',
    ext: 'pdf',
    busy: 'กำลังเรียงพิมพ์ด้วย Typst — ครั้งแรกของแต่ละหน้าต่างจะช้าหน่อยเพราะต้องโหลดตัวเรียงพิมพ์ก่อน',
    run: (X, book, sections) => X.exportBookPdf(book, sections),
  },
  epub: {
    btn: 'saveEpub',
    ext: 'epub',
    busy: 'กำลังแพ็กเป็นไฟล์ EPUB',
    run: (X, book, sections) => X.exportEpub(book, sections),
  },
};

/**
 * บันทึกเล่มนี้เป็นไฟล์ แล้วบอกให้ชัดว่าไฟล์ไปอยู่ที่ไหน
 *
 * ใช้ท่อเดียวกับปุ่มส่งออกใน Studio จึงได้ไฟล์หน้าตาเดียวกันเป๊ะ
 * PDF เรียงพิมพ์ด้วย Typst (ปกหน้า + เนื้อใน + ภาพ + ปกหลัง) ไม่ใช่ภาพพิมพ์จากหน้าจอ
 *
 * โหลดแบบ dynamic เพราะท่อนั้นลาก wasm ของ Typst ตามมาด้วย
 * คนที่เข้ามาอ่านเฉย ๆ ไม่ควรต้องจ่ายค่าโหลดก้อนนั้นตั้งแต่เปิดหน้า
 */
async function saveFile(kind) {
  const f = FORMATS[kind];
  const btn = $(f.btn);
  btn.disabled = true;
  note(f.busy);
  try {
    const [X, W] = await Promise.all([import('../core/export.js'), import('../core/workspace.js')]);
    const dir = await W.restoreDirectoryHandle().catch(() => null);
    if (dir) X.setExportDirectoryHandle(dir);

    const sections = await db.loadSections(state.book.id);
    const out = await f.run(X, state.book, sections);

    const name = state.book.outline?.title || state.book.topic || 'book';
    const size = typeof out === 'number' ? out : out.size;
    const mb = (size / 1048576).toFixed(1);
    const where = dir
      ? `โฟลเดอร์ที่เลือกไว้ใน Studio <code>${esc(dir.name)} › ${esc(name)} › ${esc(name)}.${f.ext}</code>`
      : `โฟลเดอร์ดาวน์โหลดของเบราว์เซอร์ <code>${esc(name)}.${f.ext}</code>`;
    note(
      `<b>บันทึกแล้ว ${mb} MB</b> → ${where}` +
        (out?.coverIncluded === false ? ' · เล่มนี้ยังไม่มีไฟล์ปก ไฟล์ที่ได้จึงเริ่มที่เนื้อในเลย' : ''),
    );
  } catch (e) {
    note(`<b>บันทึกไม่สำเร็จ</b> — ${esc(e?.message || e)}`, true);
  } finally {
    btn.disabled = false;
  }
}

function wireControls() {
  $('back').onclick = backToShelf;
  $('editBtn').onclick = editInStudio;
  $('savePdf').onclick = () => saveFile('pdf');
  $('saveEpub').onclick = () => saveFile('epub');
  $('modeBtn').onclick = () => {
    prefs.paged = !prefs.paged;
    applyPrefs();
  };
  $('prev').onclick = () => step(-1);
  $('next').onclick = () => step(1);
  $('tocToggle').onclick = () => {
    const shell = document.querySelector('.shell');
    shell.classList.toggle('tocOff');
    shell.classList.toggle('tocOn');
  };
  $('sizeUp').onclick = () => {
    prefs.size = Math.min(26, prefs.size + 1);
    applyPrefs();
  };
  $('sizeDown').onclick = () => {
    prefs.size = Math.max(14, prefs.size - 1);
    applyPrefs();
  };
  $('themeBtn').onclick = () => {
    prefs.theme = prefs.theme === 'day' ? 'night' : 'day';
    applyPrefs();
  };
  document.addEventListener('keydown', (ev) => {
    if (ev.target?.closest?.('input,textarea')) return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') step(1);
    if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') step(-1);
  });
  // ย่อ/ขยายหน้าต่างแล้วจำนวนหน้าเปลี่ยน ต้องนับใหม่ แต่ไม่ต้องนับทุกพิกเซลระหว่างลาก
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutPaged, 150);
  });
  window.addEventListener('pagehide', releaseUrls);
}

function fail(title, detail) {
  // ไม่มีเล่มให้อ่าน ก็ไม่มีอะไรให้บันทึก ปุ่มที่กดแล้วพังไม่ควรกดได้ตั้งแต่แรก
  $('savePdf').disabled = true;
  $('saveEpub').disabled = true;
  $('editBtn').disabled = true;
  $('barTitle').textContent = title;
  $('page').innerHTML = `<h1>${esc(title)}</h1><div class="note">${esc(detail)}</div>`;
}

async function boot() {
  applyPrefs();
  wireControls();

  const id = new URLSearchParams(location.search).get('book');
  if (!id) return fail('ไม่รู้ว่าจะเปิดเล่มไหน', 'เปิดหน้านี้จากปุ่ม “อ่าน” ในชั้นหนังสือของ Studio');

  const book = await db.loadBook(id).catch(() => null);
  if (!book) {
    return fail(
      'ยังไม่มีเล่มนี้ในเครื่อง',
      'ถ้าเล่มนี้อยู่ใน Shared Workspace ให้กด “เปิดและแก้ไข” ใน Studio หนึ่งครั้งก่อน เพื่อดึงเข้ามาไว้ในเครื่องนี้ แล้วค่อยกลับมาอ่าน',
    );
  }

  state.book = book;
  const sections = await db.loadSections(id).catch(() => []);
  state.byId = new Map(sections.map((s) => [s.id, s]));
  state.pages = buildPages(book, sections);

  const title = book.outline?.title || book.topic || 'ไม่มีชื่อ';
  document.title = `${title} — อ่าน`;
  $('barTitle').textContent = title;
  renderToc();
  await show(0);
}

boot();
