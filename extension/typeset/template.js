/**
 * ประกอบต้นฉบับเป็นเอกสาร Typst
 *
 * Typst ไม่อ่าน markdown เราจึงต้องแปลงเอง
 * ตัวแปลงนี้ตั้งใจให้เล็กและคาดเดาได้ รองรับเท่าที่ prompt อนุญาตให้โมเดลใช้จริง
 * (หัวข้อ ###, ตัวหนา, ตัวเอียง, โค้ดในบรรทัด, ลิสต์, ตาราง, คำพูดอ้าง, เส้นคั่น)
 */

import { prepareForTypeset, THAI_GAP } from '../core/thai.js';
import { coverTextBaked } from '../core/prompts.js';

const mm = (v) => `${round(v)}mm`;
const pt = (v) => `${round(v)}pt`;
const round = (v) => Math.round(v * 1000) / 1000;

// ---------- inline ----------
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function esc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/([#$@<>*_`~\[\]])/g, '\\$1');
}

function inline(text) {
  let out = '';
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out += '`' + tok.slice(1, -1) + '`';
    else if (m[2]) out += '*' + esc(tok.slice(2, -2)) + '*';
    else if (m[3]) out += '_' + esc(tok.slice(1, -1)) + '_';
    else if (m[4]) {
      const label = tok.slice(1, tok.indexOf(']'));
      const url = tok.slice(tok.indexOf('(') + 1, -1);
      out += `#link("${url}")[${esc(label)}]`;
    }
    last = m.index + tok.length;
  }
  out += esc(text.slice(last));
  // ช่องว่างคั่นวรรคไทย → ระยะแบบ weak ที่ Typst ยุบทิ้งเองเมื่ออยู่ต้น/ท้ายบรรทัด
  return out.split(THAI_GAP).join('#h(0.42em, weak: true)');
}

/**
 * ภาพประกอบ — เขียนในต้นฉบับเป็น ![คำบรรยาย](fig:ชื่อภาพ)
 *
 * เก็บภาพไว้ในต้นฉบับแบบนี้เพราะย้ายตำแหน่งได้ด้วยการแก้ข้อความธรรมดา
 * ผู้ใช้จึงเลื่อนภาพขึ้นลงเองได้ในโหมดแก้ไข โดยไม่ต้องมีตัวจัดการภาพแยก
 *
 * ถ้ายังไม่มีไฟล์ภาพ จะวาดเป็นกรอบว่างที่กินพื้นที่เท่าของจริง
 * เพื่อให้จำนวนหน้าที่นับได้ตรงกับตอนที่ใส่ภาพจริงแล้ว
 */
const FIG_RE = /^!\[([^\]]*)\]\(fig:([A-Za-z0-9._-]+)(?:\s+(\d{1,3})%)?(?:\s+(\d+(?:\.\d+)?)mm)?\)$/;

function figureToTypst(m, have, prompts = new Map()) {
  const [, rawCaption, name, pct, heightRaw] = m;
  // เผื่อกรณีที่โมเดลเขียน "รูปที่ 2:" มาในคำบรรยายเอง ใต้ภาพต้องเหลือแต่คำบรรยายจริง
  const caption = (rawCaption || '').replace(/^\s*(?:รูป|ภาพ|แผนภาพ|Fig(?:ure)?)\s*(?:ที่)?\s*\d+\s*[:.\-–]\s*/i, '').trim();
  const width = `${Math.min(100, Number(pct) || 80)}%`;
  // งานเก่าไม่มีค่าความสูง ให้ fallback 45mm เพื่อ backward compatible
  const heightMm = Math.max(20, Math.min(120, Number(heightRaw) || 45));
  const prompt = prompts.get(name) || '';
  const inner = have.has(name)
    ? `image("/img/${name}", width: ${width}, height: ${heightMm}mm, fit: "cover")`
    : `box(width: ${width}, height: ${heightMm}mm, stroke: 0.7pt + luma(145), inset: 8pt, clip: true)[
        #align(center + horizon)[
          #text(size: 7pt, fill: luma(95))[
            ${prompt ? `<Prompt : ${esc(prompt)}>` : `ยังไม่ได้ใส่ภาพ: ${esc(name)}`}
          ]
        ]
      ]`;
  // ภาพที่ไม่มีคำบรรยาย ต้องไม่เหลือช่องคำบรรยายว่าง ๆ ใต้ภาพ
  return `#figure(
  ${inner},${caption ? `\n  caption: [${inline(caption)}],` : ''}
) <fig-${name}>`;
}

/**
 * กล่องสรุปที่ Typst วาดเอง เขียนในต้นฉบับเป็น
 *   :::box หัวข้อกล่อง
 *   - บรรทัด
 *   :::
 * คมทุกความละเอียด ไม่ต้องสร้างภาพ ไม่มีปัญหา dpi
 * เป็นคำตอบที่ถูกกว่าสำหรับ "ภาพ" ที่จริง ๆ เป็นขั้นตอนหรือตารางเทียบ
 */
function boxToTypst(title, lines, t) {
  const items = lines.map((l) => `  #text[${inline(l.replace(/^\s*[-*+]\s*/, ''))}]`).join('\n  #v(0.35em)\n');
  return `#block(
  width: 100%, inset: 10pt, radius: 3pt,
  stroke: 0.6pt + luma(150), fill: luma(247),
  breakable: false,
)[
  ${title ? `#text(weight: 600, size: ${pt(t.sizePt * 0.98)})[${inline(title)}] #v(0.5em)` : ''}
  #set par(first-line-indent: 0pt)
${items}
]`;
}

// ตาราง Markdown: | หัว | หัว | ตามด้วยแถว --- และข้อมูล
// ยอมรับทั้งขีดสั้นและขีดยาว เพราะโมเดลบางครั้งแทน --- ด้วย — ตอนเขียนภาษาไทย
function splitTableRow(line) {
  const s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?[\-–—]{1,}:?$/.test(cell.replace(/\s/g, '')));
}

function tableToTypst(rows, t) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const columnSpec = Array.from({ length: cols }, () => '1fr').join(', ');
  const normalized = rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] || ''));
  const header = normalized[0]
    .map((cell) => `    [#text(weight: 600)[${inline(cell)}]]`)
    .join(',\n');
  const body = normalized
    .slice(1)
    .flatMap((row) => row.map((cell) => `  [${inline(cell)}]`))
    .join(',\n');
  const fontSize = Math.max(7, Math.min(10, (t.sizePt || 14) * (cols >= 6 ? 0.58 : cols >= 4 ? 0.68 : 0.78)));
  return `#block(width: 100%)[
  #set text(size: ${pt(fontSize)})
  #set par(first-line-indent: 0pt, leading: 0.3em)
  #table(
    columns: (${columnSpec}),
    inset: 3.5pt,
    align: left + top,
    stroke: 0.4pt + luma(175),
    table.header(
${header}
    )${body ? `,\n${body}` : ''}
  )
]`;
}

// ---------- block ----------
export function mdToTypst(md, baseLevel = 3, have = new Set(), t = { sizePt: 15 }, prompts = new Map()) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let fenceBuf = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      if (inFence) {
        out.push('#raw(block: true, "' + fenceBuf.join('\\n').replace(/"/g, '\\"') + '")', '');
        fenceBuf = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line.replace(/\\/g, '\\\\'));
      continue;
    }

    if (!line.trim()) {
      out.push('');
      continue;
    }

    // ต้องตรวจตารางก่อนตรวจเส้นคั่น มิฉะนั้นแถว |---|---| จะถูกมองเป็นข้อความธรรมดา
    if (line.includes('|') && idx + 1 < lines.length && isTableDivider(lines[idx + 1])) {
      const rows = [splitTableRow(line)];
      idx += 2; // ข้ามแถวแบ่งหัวตาราง
      while (idx < lines.length && lines[idx].includes('|') && lines[idx].trim()) {
        rows.push(splitTableRow(lines[idx]));
        idx++;
      }
      idx--; // คืนหนึ่งตำแหน่งให้ for-loop
      out.push(tableToTypst(rows, t), '');
      continue;
    }

    const boxOpen = line.match(/^:::box\s*(.*)$/);
    if (boxOpen) {
      const title = boxOpen[1].trim();
      const buf = [];
      // อ่านต่อจนเจอ ::: ปิด
      while (++idx < lines.length && !/^:::\s*$/.test(lines[idx].trim())) buf.push(lines[idx]);
      out.push(boxToTypst(title, buf.filter((x) => x.trim()), t), '');
      continue;
    }

    const fig = line.trim().match(FIG_RE);
    if (fig) {
      out.push(figureToTypst(fig, have, prompts), '');
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, baseLevel + h[1].length - 3 > 0 ? baseLevel + h[1].length - 3 : baseLevel);
      out.push('='.repeat(level) + ' ' + inline(h[2]), '');
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('#align(center)[#v(0.6em) --- #v(0.6em)]', '');
      continue;
    }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      out.push('#quote(block: true)[' + inline(q[1]) + ']');
      continue;
    }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      out.push(ul[1] + '- ' + inline(ul[2]));
      continue;
    }

    const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ol) {
      out.push(ol[1] + '+ ' + inline(ol[2]));
      continue;
    }

    out.push(inline(line));
  }

  if (inFence && fenceBuf.length) {
    out.push('#raw(block: true, "' + fenceBuf.join('\\n').replace(/"/g, '\\"') + '")');
  }

  return out.join('\n');
}

// ---------- เอกสารทั้งเล่ม ----------
export function buildDocument({ book, outline, sections, opts = {} }) {
  // ชื่อภาพที่มีไฟล์จริงแล้ว ใช้ตัดสินว่าจะวาดภาพหรือวาดกรอบว่างแทน
  const have = new Set(opts.assetNames || []);
  // ในโหมด prompt ให้พิมพ์คำสั่งสร้างภาพลงในกรอบว่าง ณ ตำแหน่งที่ AI เลือกไว้
  // เมื่อมีไฟล์ภาพชื่อเดียวกัน กรอบและ prompt จะถูกแทนด้วยภาพจริงโดยอัตโนมัติ
  const figurePrompts = new Map(
    book.figureMode === 'prompt'
      ? (book.figures || []).filter((f) => f.kind === 'image' && f.name).map((f) => [f.name, f.prompt || f.subject || f.caption || ''])
      : [],
  );
  const t = book.typography;
  const trim = book.trim;
  const lang = book.language || 'th';
  const bleed = opts.withBleed ? trim.bleedMm || 0 : 0;

  // Typst leading คือระยะ "ระหว่าง" บรรทัด ไม่ใช่ line-height ทั้งก้อน
  // ค่าปริยาย 0.65em ให้ผลราว 1.65 เท่า จึงประมาณด้วย (lineHeight - 1)
  const leading = Math.max(0.35, (t.lineHeight || 1.6) - 1);

  const secById = new Map(sections.map((s) => [s.id, s]));
  const body = [];
  const isFiction = book.contentMode === 'fiction';

  for (const ch of outline.chapters) {
    const chapterTitle = isFiction
      ? `${lang === 'th' ? 'บทที่' : 'Chapter'} ${ch.n}${ch.title ? ` · ${ch.title}` : ''}`
      : ch.title;
    body.push(`= ${inline(prepareForTypeset(chapterTitle, lang))}`, '');
    for (let sceneIndex = 0; sceneIndex < ch.sections.length; sceneIndex++) {
      const s = ch.sections[sceneIndex];
      const rec = secById.get(s.id);
      const md = rec?.md?.trim();
      if (!isFiction) body.push(`== ${inline(prepareForTypeset(s.title, lang))}`, '');
      else if (sceneIndex > 0) body.push('#align(center)[• • •]', '');
      if (md) {
        body.push(mdToTypst(prepareForTypeset(md, lang), 3, have, t, figurePrompts), '');
      } else {
        body.push(`#text(fill: rgb("#999999"))[(ยังไม่มีเนื้อหาของ${isFiction ? 'ฉาก' : 'ตอน'} ${s.id})]`, '');
      }
    }
  }

  const fm = frontMatter(book, outline, opts);
  const bm = backMatter(book, outline);

  return `
#set document(title: ${str(outline.title)}, author: ${str(book.author || '')})

#set page(
  width: ${mm(trim.widthMm + bleed * 2)},
  height: ${mm(trim.heightMm + bleed * 2)},
  margin: (
    inside: ${mm(t.marginsMm.inner + bleed)},
    outside: ${mm(t.marginsMm.outer + bleed)},
    top: ${mm(t.marginsMm.top + bleed)},
    bottom: ${mm(t.marginsMm.bottom + bleed)},
  ),
  binding: left,
  numbering: none,${pageBackground(opts)}
)

#set text(
  font: ${str(t.bodyFont)},
  size: ${pt(t.sizePt)},
  lang: ${str(lang)},
  // ใช้ขอบ ascender/descender ของฟอนต์จริงเพื่อเผื่อสระและวรรณยุกต์ไทย
  top-edge: "ascender",
  bottom-edge: "descender",
)
#set par(
  justify: ${t.justify ? 'true' : 'false'},
  leading: ${round(leading)}em,
  spacing: ${round(leading)}em,
  first-line-indent: 1.5em,
  // ไล่หาจุดตัดบรรทัดที่ดีที่สุดของทั้งย่อหน้า ไม่ใช่ตัดไปเรื่อย ๆ ทีละบรรทัด
  // ทำให้ขอบขวาสม่ำเสมอขึ้นมากโดยไม่ต้องจัดชิดสองข้าง ซึ่งภาษาไทยทำแล้วเกิดช่องว่างพาดกลางหน้า
  linebreaks: "optimized",
)
#show heading: set text(font: ${str(t.headFont || t.bodyFont)})
#show heading: set block(above: 1.4em, below: 0.8em)

// ภาพประกอบ: คำบรรยายอยู่ใต้ภาพและห้ามพรากจากกัน
#show figure: set block(breakable: false, above: 1.4em, below: 1.4em)
#show figure.caption: set text(size: ${pt(t.sizePt * 0.82)}, fill: luma(90))
// ไม่มีเลข "รูปที่ N" — ในเล่มไม่มีข้อความอ้างถึงเลขรูปอยู่แล้ว
// เลขที่ไม่มีใครอ้างถึงจึงเป็นแค่คำรกหน้ากระดาษ ใต้ภาพเหลือเฉพาะคำบรรยายจริงถ้ามี
#set figure(numbering: none, supplement: none, gap: 0.8em)

// บทใหม่ขึ้นหน้าขวาเสมอ และเว้นช่วงนำสายตาโดยไม่ดันหัวข้อให้ต่ำเกินไป
#show heading.where(level: 1): it => {
  pagebreak(to: "odd", weak: true)
  v(${round((trim.heightMm - t.marginsMm.top - t.marginsMm.bottom) * 0.16)}mm)
  block(text(size: ${pt(t.sizePt * 1.6)}, weight: 600, it.body))
  v(1em)
}
#show heading.where(level: 2): it => block(text(size: ${pt(t.sizePt * 1.2)}, weight: 600, it.body))
#show heading.where(level: 3): it => block(text(size: ${pt(t.sizePt * 1.08)}, weight: 600, it.body))

// ---------- หน้าต้นเล่ม ----------
${fm}

// ---------- เนื้อหา ----------
#set page(
  numbering: "1",
  number-align: center,
  header: context {
    let p = counter(page).get().first()
    let opens = query(heading.where(level: 1)).any(h => h.location().page() == p)
    if opens { return }
    let here = query(selector(heading.where(level: 1)).before(here()))
    let ch = if here.len() > 0 { here.last().body } else { [] }
    set text(size: ${pt(t.sizePt * 0.72)}, fill: luma(90))
    if calc.odd(p) [#h(1fr) #ch] else [${str(outline.title)} #h(1fr)]
  },
)
#counter(page).update(1)

${body.join('\n')}

${bm}

${backCoverPage(book, outline, opts)}

${'#pagebreak()\n'.repeat(opts.padPages || 0)}
// ป้ายบอกจำนวนหน้า — ระบบอ่านค่านี้ด้วย query แทนการเดา
// ต้องแยกสองค่าให้ชัด เพราะเรารีเซ็ตเลขหน้าหลังหน้าต้นเล่ม
//   physical = จำนวนแผ่นที่โรงพิมพ์ต้องพิมพ์จริง  ← ลูปนับหน้าใช้ค่านี้
//   numbered = เลขหน้าที่พิมพ์อยู่บนหน้าสุดท้าย
#context [#metadata((physical: here().page(), numbered: counter(page).final().first())) <pagecount>]
`.trim();
}

/**
 * เอกสารโหมดรายชิ้น — คำคม กลอน บทกวีสั้น
 *
 * ต่างจากร้อยแก้วทั้งหมด: ไม่มีย่อหน้าไหล ไม่มีหัวข้อย่อย
 * แต่ละชิ้นวางกลางหน้าในกรอบของตัวเอง จำนวนหน้าจึงเป็นเลขคณิตตรง ๆ
 * ชิ้นต่อหน้า x จำนวนหน้า = จำนวนชิ้น ไม่ต้องมีลูปปรับความยาว
 */
export function buildItemsDocument({ book, outline, items, opts = {} }) {
  const t = book.typography;
  const trim = book.trim;
  const lang = book.language || 'th';
  const bleed = opts.withBleed ? trim.bleedMm || 0 : 0;
  const perPage = Math.max(1, book.itemsPerPage || 1);
  const size = book.itemSizePt || 24;
  const align = book.itemAlign === 'top' ? 'top + center' : 'horizon + center';

  const byTheme = new Map();
  for (const it of items) {
    const n = String(it.id).split('.')[0];
    if (!byTheme.has(n)) byTheme.set(n, []);
    byTheme.get(n).push(it);
  }

  // ต้องเป็น markup ที่ขึ้นต้นด้วย # เพราะอยู่ใน [...] ไม่ใช่ในวงเล็บของฟังก์ชัน
  // (เคยใส่ไว้เป็นอาร์กิวเมนต์ของ #stack แล้ว Typst ฟ้องว่า # ใช้ใน code ไม่ได้)
  const one = (it) => `#block(width: 100%, breakable: false)[
      #align(center)[
        #text(size: ${pt(size)}, weight: 500)[${itemText(it.text, lang)}]
        ${it.attribution ? `\n        #v(0.6em)\n        #text(size: ${pt(size * 0.55)}, fill: luma(110))[— ${inline(it.attribution)}]` : ''}
      ]
    ]`;

  const body = [];
  const multiTheme = byTheme.size > 1;

  for (const [n, list] of byTheme) {
    const theme = (outline.themes || []).find((x) => String(x.n) === String(n));
    if (multiTheme && theme) {
      body.push(`#pagebreak(to: "odd", weak: true)
#page(numbering: none)[
  #align(center + horizon)[
    #text(size: ${pt(size * 1.15)}, weight: 600)[${inline(prepareForTypeset(theme.title, lang))}]
  ]
]`);
    }

    for (let i = 0; i < list.length; i += perPage) {
      const group = list.slice(i, i + perPage);
      body.push(`#page[
  #align(${align})[
    ${group.map(one).join(`\n    #v(${round(2.4 / perPage + 0.8)}em)\n    `)}
  ]
]`);
    }
  }

  return `
#set document(title: ${str(outline.title)}, author: ${str(book.author || '')})

#set page(
  width: ${mm(trim.widthMm + bleed * 2)},
  height: ${mm(trim.heightMm + bleed * 2)},
  margin: (
    inside: ${mm(t.marginsMm.inner + bleed)},
    outside: ${mm(t.marginsMm.outer + bleed)},
    top: ${mm(t.marginsMm.top + bleed)},
    bottom: ${mm(t.marginsMm.bottom + bleed)},
  ),
  binding: left,
  numbering: none,${pageBackground(opts)}
)
#set text(
  font: ${str(t.bodyFont)}, size: ${pt(size)}, lang: ${str(lang)},
  top-edge: "ascender", bottom-edge: "descender",
)
#set par(
  justify: false,
  leading: ${round(Math.max(0.5, (t.lineHeight || 1.7) - 1))}em,
  spacing: ${round(Math.max(0.5, (t.lineHeight || 1.7) - 1))}em,
  first-line-indent: 0pt,
)

${frontMatter(book, outline, opts)}

#set page(numbering: ${book.itemPageNumbers === false ? 'none' : '"1"'}, number-align: center)
#counter(page).update(1)

${body.join('\n\n')}

${backMatter(book, outline)}

${backCoverPage(book, outline, opts)}

${'#pagebreak()\n'.repeat(opts.padPages || 0)}
#context [#metadata((physical: here().page(), numbered: counter(page).final().first())) <pagecount>]
`.trim();
}

/** ข้อความของชิ้น — ขึ้นบรรทัดใหม่ตามฉันทลักษณ์ ห้ามให้ไหลรวมกัน */
function itemText(text, lang) {
  return String(text)
    .split('\n')
    .map((l) => inline(prepareForTypeset(l.trim(), lang)))
    .join(' \\\n');
}

/**
 * เอกสาร calibration — เนื้อความล้วน ไม่มีหน้าต้นเล่ม ไม่มีหัวบท
 * ใช้หาว่าโปรไฟล์นี้จุได้กี่อักษรต่อหน้า ต้องใช้ค่าจากงานจริง ไม่ใช่ lorem ละติน
 * เพราะความยาวคำและความถี่ของช่องว่างมีผลต่อการตัดบรรทัด
 */
export function buildCalibrationDoc({ book, sampleText }) {
  const t = book.typography;
  const trim = book.trim;
  const lang = book.language || 'th';
  const leading = Math.max(0.35, (t.lineHeight || 1.6) - 1);

  return `
#set page(
  width: ${mm(trim.widthMm)},
  height: ${mm(trim.heightMm)},
  margin: (
    inside: ${mm(t.marginsMm.inner)},
    outside: ${mm(t.marginsMm.outer)},
    top: ${mm(t.marginsMm.top)},
    bottom: ${mm(t.marginsMm.bottom)},
  ),
  binding: left,
  numbering: "1",
)
#set text(
  font: ${str(t.bodyFont)}, size: ${pt(t.sizePt)}, lang: ${str(lang)},
  top-edge: "ascender", bottom-edge: "descender",
)
#set par(
  justify: ${t.justify ? 'true' : 'false'},
  leading: ${round(leading)}em,
  spacing: ${round(leading)}em,
  first-line-indent: 1.5em,
  // ไล่หาจุดตัดบรรทัดที่ดีที่สุดของทั้งย่อหน้า ไม่ใช่ตัดไปเรื่อย ๆ ทีละบรรทัด
  // ทำให้ขอบขวาสม่ำเสมอขึ้นมากโดยไม่ต้องจัดชิดสองข้าง ซึ่งภาษาไทยทำแล้วเกิดช่องว่างพาดกลางหน้า
  linebreaks: "optimized",
)

${mdToTypst(prepareForTypeset(sampleText, lang))}

#context [#metadata((physical: here().page(), numbered: counter(page).final().first())) <pagecount>]
`.trim();
}

/**
 * ลวดลายพื้นหลังที่พิมพ์ใต้ตัวหนังสือทุกหน้า
 *
 * ไฟล์ถูกลดความเข้มมาแล้วตั้งแต่ตอนบันทึก จึงวางเต็มหน้าได้เลยโดยไม่ต้องลดความทึบซ้ำ
 * ใส่เฉพาะตอนที่มีไฟล์จริง ไม่งั้นคอมไพเลอร์จะล้มทั้งเล่มเพราะหาไฟล์ไม่เจอ
 */
function pageBackground(opts) {
  return (opts?.assetNames || []).includes('page-pattern.png')
    ? `\n  background: image("/img/page-pattern.png", width: 100%, height: 100%, fit: "cover"),`
    : '';
}

function frontMatter(book, outline, opts = {}) {
  const has = (k) => (book.frontMatter || []).includes(k);
  const lang = book.language || 'th';
  const T = (v) => inline(prepareForTypeset(v || '', lang));
  const parts = [];

  const coverName = opts.coverFrontName || 'cover-front.png';
  const haveCover = !!opts.includeFrontCover && (opts.assetNames || []).includes(coverName);
  if (haveCover) {
    const coverPalette = book.style?.palette || [];
    const coverText = coverPalette?.[2]?.hex || '#F6F1E7';
    const coverLayout = book.coverLayout || book.style?.typography || {};
    const clampCover = (v, lo, hi, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    const coverZone = (name, fallback) => {
      const z = coverLayout?.[name] || {};
      const x = clampCover(z.x_pct, 4, 92, fallback.x);
      const y = clampCover(z.y_pct, 4, 94, fallback.y);
      const width = Math.min(clampCover(z.width_pct, 30, 92, fallback.width), 96 - x);
      const align = ['left', 'center', 'right'].includes(z.align) ? z.align : fallback.align;
      const size = clampCover(z.size_scale, fallback.min, fallback.max, fallback.size);
      const roleIndex = { palette_1: 0, palette_2: 1, palette_3: 2 }[z.color_role];
      const color = coverPalette?.[roleIndex]?.hex || fallback.color || coverText;
      return { x, y, width, align, size, color };
    };
    const czTitle = coverZone('title', { x: 8, y: 10, width: 84, align: 'center', min: 2.0, max: 3.6, size: 2.5, color: coverText });
    const czSubtitle = coverZone('subtitle', { x: 12, y: 26, width: 76, align: 'center', min: 0.8, max: 1.4, size: 1.0, color: coverText });
    const czAuthor = coverZone('author', { x: 10, y: 88, width: 80, align: 'center', min: 0.9, max: 1.5, size: 1.05, color: coverText });
    const coverW = book.trim?.widthMm || 148;
    const coverH = book.trim?.heightMm || 210;

    // ปกที่ ChatGPT วาดตัวหนังสือมาให้แล้ว ห้ามพิมพ์ทับซ้ำ ไม่งั้นจะได้ชื่อเรื่องสองชั้น
    if (coverTextBaked(book)) {
      parts.push(`#page(margin: 0pt)[
  #image("/img/${coverName}", width: 100%, height: 100%, fit: "cover")
]`);
    } else {
    parts.push(`#page(margin: 0pt)[
  #image("/img/${coverName}", width: 100%, height: 100%, fit: "cover")
  #place(top + left, dx: ${round(coverW * czTitle.x / 100)}mm, dy: ${round(coverH * czTitle.y / 100)}mm)[
    #box(width: ${round(coverW * czTitle.width / 100)}mm)[
      #align(${czTitle.align})[
        #text(font: ${str(book.typography.headFont || book.typography.bodyFont)}, size: ${pt(book.typography.sizePt * czTitle.size)}, weight: 700, fill: rgb("${czTitle.color}"))[${T(outline.title)}]
      ]
    ]
  ]
  ${outline.subtitle ? `#place(top + left, dx: ${round(coverW * czSubtitle.x / 100)}mm, dy: ${round(coverH * czSubtitle.y / 100)}mm)[
    #box(width: ${round(coverW * czSubtitle.width / 100)}mm)[
      #align(${czSubtitle.align})[#text(size: ${pt(book.typography.sizePt * czSubtitle.size)}, fill: rgb("${czSubtitle.color}"))[${T(outline.subtitle)}]]
    ]
  ]` : ''}
  ${book.author ? `#place(top + left, dx: ${round(coverW * czAuthor.x / 100)}mm, dy: ${round(coverH * czAuthor.y / 100)}mm)[
    #box(width: ${round(coverW * czAuthor.width / 100)}mm)[
      #align(${czAuthor.align})[#text(size: ${pt(book.typography.sizePt * czAuthor.size)}, fill: rgb("${czAuthor.color}"))[${T(book.author)}]]
    ]
  ]` : ''}
]`);
    }
  }

  parts.push(`#page[
  #v(1fr)
  #align(center)[#text(size: ${pt(book.typography.sizePt * 2.4)}, weight: 600)[${T(outline.title)}]]
  ${outline.subtitle ? `#align(center)[#v(0.8em) #text(size: ${pt(book.typography.sizePt * 1.1)}, fill: luma(80))[${T(outline.subtitle)}]]` : ''}
  #v(2fr)
  ${book.author ? `#align(center)[#text(size: ${pt(book.typography.sizePt)})[${inline(book.author)}]]` : ''}
  #v(1fr)
]`);

  if (has('copyright')) {
    parts.push(`#page[
  #v(1fr)
  #text(size: ${pt(book.typography.sizePt * 0.82)}, fill: luma(70))[
    ${inline(outline.title)} \\
    ${book.author ? inline(book.author) + ' \\\\' : ''}
    พิมพ์ครั้งแรก ${new Date().getFullYear() + 543} \\\\
    สงวนลิขสิทธิ์ตามพระราชบัญญัติ
  ]
]`);
  }

  if (has('foreword') && (book.contentMode !== 'fiction' || String(outline.foreword || '').trim())) {
    const foreword = outline.foreword ||
      `หนังสือเล่มนี้จัดทำขึ้นเพื่อช่วยให้ผู้อ่านเข้าใจ ${outline.title} อย่างเป็นขั้นตอนและนำไปใช้ได้จริง\n\n${outline.subtitle || outline.thesis || ''}`;
    parts.push(`#page[
  #text(size: ${pt(book.typography.sizePt * 1.6)}, weight: 600)[คำนำ]
  #v(1.2em)
  ${mdToTypst(prepareForTypeset(foreword, lang), 2, new Set(), book.typography)}
]`);
  }

  if (has('toc')) {
    parts.push(`#page[
  #text(size: ${pt(book.typography.sizePt * 1.6)}, weight: 600)[สารบัญ]
  #v(0.7em)
  #block[
    #set text(size: ${pt(book.typography.sizePt * 0.82)})
    #set par(leading: 0.42em, spacing: 0.42em, first-line-indent: 0pt)
    #outline(title: none, depth: ${book.contentMode === 'fiction' ? 1 : 2}, indent: auto)
  ]
]`);
  }

  return parts.join('\n\n');
}

function backCoverPage(book, outline, opts = {}) {
  const backName = opts.coverBackName || 'cover-back.png';
  const haveBack = !!opts.includeBackCover && (opts.assetNames || []).includes(backName);
  if (!haveBack) return '';

  const lang = book.language || 'th';
  const T = (v) => inline(prepareForTypeset(v || '', lang));
  const palette = book.style?.palette || [];

  /**
   * ข้อความบนปกหลังต้องมีกรอบรองเสมอ
   *
   * ภาพปกหลังเป็นงานออกแบบที่มีลาย เงา และบ่อยครั้งมีตัวอักษรที่โมเดลวาดเองอยู่ด้วย
   * การวางคำโปรยทับลงไปตรง ๆ ทำให้สองชั้นตัวอักษรซ้อนกันจนอ่านไม่ออกทั้งคู่
   * (เห็นในเล่มจริง: คำโปรยทับกับป้ายกระดาษบนผนังที่เขียนว่า "ทำสไลด์รายงาน")
   * ต่อให้เลือกสีตัวอักษรเก่งแค่ไหนก็ไม่ชนะพื้นหลังที่คุมไม่ได้ ต้องมีพื้นทึบรองเท่านั้น
   */
  const inkColor = palette?.[0]?.hex || '#14243A';
  const paperColor = palette?.[2]?.hex || '#F6F1E7';
  const textColor = inkColor;
  const panelFill = `${paperColor}F0`; // ทึบ 94% พอให้เห็นเนื้อภาพจาง ๆ แต่อ่านออกแน่นอน
  const coverW = book.trim?.widthMm || 148;
  const coverH = book.trim?.heightMm || 210;
  const authorPhotoName = opts.authorPhotoName || 'author-photo.png';
  const showAuthorPhoto = !!book.authorPhotoOnCover && (opts.assetNames || []).includes(authorPhotoName);

  const photoBlock = showAuthorPhoto
    ? `#place(top + left, dx: 12mm, dy: 14mm)[
      #image("/img/${authorPhotoName}", width: 30mm, height: 38mm, fit: "cover")
    ]`
    : '';
  const authorBlock = book.author && !book.backCoverTextBaked
    ? `#place(bottom + left, dx: 12mm, dy: -12mm)[
      #block(fill: rgb("${panelFill}"), inset: (x: 5mm, y: 3mm), radius: 2mm)[
        #text(size: ${pt(book.typography.sizePt * 0.95)}, fill: rgb("${textColor}"))[${T(book.author)}]
      ]
    ]`
    : '';
  /**
   * ปกหลังที่ ChatGPT วาดตัวอักษรมาในภาพแล้ว ห้ามวางคำโปรยทับซ้ำ
   * ไม่งั้นจะได้ข้อความสองชุดซ้อนกันบนปกเดียว ซึ่งแย่กว่าไม่มีเลย
   */
  const blurbBlock = book.blurb && !book.backCoverTextBaked
    ? `#place(top + left, dx: ${round(coverW * 0.1)}mm, dy: ${round(coverH * (showAuthorPhoto ? 0.34 : 0.16))}mm)[
      #block(width: ${round(coverW * 0.8)}mm, fill: rgb("${panelFill}"), inset: (x: 7mm, y: 6mm), radius: 3mm)[
        #set par(leading: 0.62em, spacing: 0.7em, first-line-indent: 0pt)
        #text(size: ${pt(book.typography.sizePt * 0.95)}, fill: rgb("${textColor}"))[${T(book.blurb)}]
      ]
    ]`
    : '';

  return `#page(margin: 0pt)[
  #image("/img/${backName}", width: 100%, height: 100%, fit: "cover")
  ${photoBlock}
  ${blurbBlock}
  ${authorBlock}
]`;
}

function backMatter(book, outline) {
  const has = (k) => (book.backMatter || []).includes(k);
  const lang = book.language || 'th';
  const T = (v) => inline(prepareForTypeset(v || '', lang));
  const parts = [];

  if (has('references')) {
    const refs = [
      ...(book.references || []),
      ...(book.trendSeed?.sources || []),
    ];
    const seen = new Set();
    const unique = refs.filter((r) => {
      const key = String(r?.url || r?.title || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length) {
      const title = book.trendSeed?.trend ? 'แหล่งข้อมูลตั้งต้นและอ้างอิง' : 'บรรณานุกรม';
      const lines = unique.map((r) => {
        const label = [r.publisher, r.title, r.date].filter(Boolean).join(' · ');
        const url = r.url ? ` \\\ ${T(r.url)}` : '';
        return `- ${T(label || r.url || 'แหล่งข้อมูล')}${url}`;
      }).join('\n');
      parts.push(`#pagebreak(to: "odd", weak: true)
= ${title}

${book.trendSeed?.trend ? `${T(`กระแสตั้งต้น: ${book.trendSeed.trend}`)}\n\n` : ''}${lines}`);
    }
  }

  if (has('about_author') && book.author) {
    parts.push(`#pagebreak(to: "odd", weak: true)
= เกี่ยวกับผู้เขียน

${T(book.aboutAuthor || book.author)}`);
  }
  return parts.join('\n\n');
}

function str(s) {
  return JSON.stringify(String(s ?? ''));
}
