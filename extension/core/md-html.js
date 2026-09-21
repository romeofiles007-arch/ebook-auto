/**
 * แปลงต้นฉบับหนึ่งตอนเป็น HTML — ใช้ร่วมกันระหว่างหน้าอ่านกับไฟล์ EPUB
 *
 * ต้องเป็นตัวแปลงตัวเดียวกันทั้งสองทาง ไม่งั้นสิ่งที่คนอ่านบนหน้าจอ
 * กับสิ่งที่อยู่ในไฟล์ที่ส่งให้คนอื่นจะค่อย ๆ เพี้ยนออกจากกันโดยไม่มีใครรู้
 * ต่างกันแค่ "ภาพ" เท่านั้น หน้าอ่านจองที่ว่างไว้แล้วค่อยเอาไฟล์จาก IndexedDB มาใส่
 * ส่วน EPUB ชี้ไปที่ไฟล์ภาพที่แพ็กอยู่ในตัวมันเอง จึงเปิดให้ส่งฟังก์ชันวาดภาพเข้ามาแทนได้
 *
 * และแยกจาก reader.js เพราะไฟล์นั้นแตะ DOM ตั้งแต่บรรทัดแรก ทดสอบตรง ๆ ไม่ได้
 */

import { readTable } from './md-table.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ESC[c]);

/** ตัวหนา/ตัวเอน/โค้ด — เท่าที่ต้นฉบับในเล่มใช้จริง ไม่ต้องรู้จัก markdown ครบชุด */
export const inlineHtml = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/** ต้องตรงกับที่ machine.js แทรกไว้ และที่ template.js / docx.js อ่าน */
export const FIG_RE = /^!\[([^\]]*)\]\(fig:([A-Za-z0-9._-]+)(?:\s+(\d{1,3})%)?(?:\s+(\d+(?:\.\d+)?)mm)?\)$/;
const CAPTION_NUM = /^\s*(?:รูป|ภาพ|แผนภาพ|Fig(?:ure)?)\s*(?:ที่)?\s*\d+\s*[:.\-–]\s*/i;

export const isItemsBook = (b) =>
  b?.contentMode === 'items' || (!!b?.outline?.themes?.length && !b?.outline?.chapters?.length);

export const compareItemId = (a, b) => {
  const aa = String(a).split('.').map(Number);
  const bb = String(b).split('.').map(Number);
  return (aa[0] || 0) - (bb[0] || 0) || (aa[1] || 0) - (bb[1] || 0);
};

/**
 * ที่ว่างของภาพบนหน้าอ่าน — จองพื้นที่ด้วยความสูงที่บันทึกไว้ตอนวางแผน
 * แล้วภาพจริงค่อยไหลเข้าทับทีหลัง ถ้าไม่จอง ตัวหนังสือจะกระโดดทุกครั้งที่ภาพโหลดเสร็จ
 * ซึ่งกวนที่สุดตอนกำลังอ่านค้างอยู่กลางหน้า
 */
const readerFigure = ({ name, caption, widthPct, heightMm }) =>
  `<figure data-fig="${esc(name)}" data-w="${widthPct}">` +
  `<div class="slot" style="min-height:${heightMm ? Math.round(heightMm * 3.78) : 160}px">กำลังหาไฟล์ภาพ…</div>` +
  `${caption ? `<figcaption>${inlineHtml(caption)}</figcaption>` : ''}</figure>`;

/**
 * ต้นฉบับหนึ่งตอน → HTML
 *
 * ต้องรู้จักเครื่องหมายสองอย่างที่เครื่องแทรกไว้ตั้งแต่ตอนวางแผนภาพ
 * คือ ![คำบรรยาย](fig:ชื่อไฟล์ 80% 42mm) กับกล่อง :::box … :::
 * ถ้าไม่รู้จัก มันจะถูกพิมพ์เป็นข้อความดิบกลางหน้าหนังสือ
 *
 * opts.figure — ฟังก์ชันวาดภาพของฝั่งที่เรียกใช้ (ไม่ส่งมา = แบบหน้าอ่าน)
 * opts.xhtml  — EPUB เป็น XHTML แท็กเดี่ยวต้องปิดตัวเอง ไม่งั้นโปรแกรมอ่านบางตัวไม่เปิดไฟล์ให้เลย
 */
export function mdToHtml(md, opts = {}) {
  const out = [];
  // ตารางต้องถูกแยกออกก่อนตัดย่อหน้า เพราะแถวของมันคั่นด้วยบรรทัดว่างได้
  for (const chunk of chunkByTables(String(md))) {
    if (chunk.rows) out.push(tableHtml(chunk, opts));
    else out.push(blocksToHtml(chunk.text, opts));
  }
  return out.filter(Boolean).join('\n');
}

/** แบ่งต้นฉบับเป็นช่วง ๆ สลับกันระหว่าง "ตาราง" กับ "ข้อความธรรมดา" */
function chunkByTables(md) {
  const lines = md.split('\n');
  const chunks = [];
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const table = readTable(lines, i);
    if (!table) {
      buf.push(lines[i]);
      continue;
    }
    if (buf.length) chunks.push({ text: buf.join('\n') });
    buf = [];
    chunks.push(table);
    i = table.next - 1;
  }
  if (buf.length) chunks.push({ text: buf.join('\n') });
  return chunks;
}

/**
 * ตารางบนหน้าอ่านกับในไฟล์ EPUB
 *
 * EPUB ไม่มีไฟล์สไตล์ของตัวเอง เส้นตารางจึงต้องติดไปกับแท็กเลย
 * ไม่งั้นได้ตารางไร้เส้นที่อ่านไม่ออกว่าช่องไหนเป็นของแถวไหน
 */
const CELL_STYLE = 'border:1px solid #ccc;padding:5px 9px;vertical-align:top';

function tableHtml({ rows, align }, opts = {}) {
  const inlineStyle = !!opts.xhtml;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const at = (i) => align?.[i] || 'left';
  const cell = (tag, text, i) =>
    `<${tag}${inlineStyle ? ` style="${CELL_STYLE};text-align:${at(i)}${tag === 'th' ? ';font-weight:700' : ''}"` : ` style="text-align:${at(i)}"`}>${inlineHtml(text)}</${tag}>`;
  const row = (cells, tag) =>
    `<tr>${Array.from({ length: cols }, (_, i) => cell(tag, cells[i] || '', i)).join('')}</tr>`;
  const body = rows.slice(1).map((r) => row(r, 'td')).join('');
  return (
    `<table${inlineStyle ? ' style="border-collapse:collapse;width:100%"' : ''}>` +
    `<thead>${row(rows[0], 'th')}</thead>` +
    `${body ? `<tbody>${body}</tbody>` : ''}</table>`
  );
}

function blocksToHtml(md, opts = {}) {
  const figureHtml = opts.figure || readerFigure;
  const br = opts.xhtml ? '<br/>' : '<br>';
  const out = [];
  for (const raw of String(md).split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;

    if (block.startsWith(':::box')) {
      const lines = block.split('\n');
      const title = lines[0].replace(/^:::box[ \t]*/, '').trim();
      const items = lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l && !/^:::$/.test(l));
      out.push(
        `<div class="box">${title ? `<b>${inlineHtml(title)}</b>` : ''}<ul>${items
          .map((l) => `<li>${inlineHtml(l.replace(/^[-*+]\s*/, ''))}</li>`)
          .join('')}</ul></div>`,
      );
      continue;
    }

    const fig = block.match(FIG_RE);
    if (fig) {
      out.push(
        figureHtml({
          name: fig[2],
          caption: (fig[1] || '').replace(CAPTION_NUM, '').trim(),
          widthPct: Math.min(100, Number(fig[3]) || 80),
          heightMm: Number(fig[4]) || 0,
        }),
      );
      continue;
    }

    const h = block.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1].length);
      out.push(`<h${level}>${inlineHtml(h[2])}</h${level}>`);
      continue;
    }
    if (/^\s*[-*+]\s/.test(block)) {
      out.push(
        `<ul>${block
          .split('\n')
          .map((l) => `<li>${inlineHtml(l.replace(/^\s*[-*+]\s/, ''))}</li>`)
          .join('')}</ul>`,
      );
      continue;
    }
    if (/^\s*\d+[.)]\s/.test(block)) {
      out.push(
        `<ol>${block
          .split('\n')
          .map((l) => `<li>${inlineHtml(l.replace(/^\s*\d+[.)]\s/, ''))}</li>`)
          .join('')}</ol>`,
      );
      continue;
    }
    out.push(`<p>${inlineHtml(block).replace(/\n/g, br)}</p>`);
  }
  return out.join('\n');
}
