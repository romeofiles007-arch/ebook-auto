/**
 * DOCX — ส่งออกไปแก้ในเวิร์ด แล้วนำกลับเข้าระบบก่อนทำ PDF
 *
 * ทำไมต้องมี: Typst ให้งานพิมพ์ที่คุมได้แม่นก็จริง แต่แก้ยากสำหรับคนที่ไม่เขียนโค้ด
 * เวิร์ดคือที่ที่คนไทยส่วนใหญ่ตรวจต้นฉบับกันจริง ๆ วงจรที่ใช้ได้จริงจึงเป็น
 *   ระบบเขียน → ส่งออก .docx → แก้ในเวิร์ด → นำกลับเข้าระบบ → Typst ทำ PDF พร้อมพิมพ์
 *
 * ไม่พึ่งไลบรารีภายนอกเลย เพราะ CSP ของส่วนขยายห้ามโหลดสคริปต์จากที่อื่น
 * เขียน zip เองตอนส่งออก และใช้ DecompressionStream ของเบราว์เซอร์ตอนอ่านกลับ
 */

import { stripZwsp } from './thai.js';

const MM_TO_TWIP = 56.6929;
const tw = (mm) => Math.round(mm * MM_TO_TWIP);
const halfPt = (pt) => Math.round(pt * 2);

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const compareItemId = (a, b) => {
  const aa = String(a).split('.').map(Number);
  const bb = String(b).split('.').map(Number);
  return (aa[0] || 0) - (bb[0] || 0) || (aa[1] || 0) - (bb[1] || 0);
};

// ---------------------------------------------------------------- ส่งออก

export async function buildDocx({ book, outline, sections }) {
  const t = book.typography;
  const font = t.bodyFont || 'Sarabun';
  const head = t.headFont || font;
  const size = t.sizePt || 15;

  const body = [];

  body.push(para(esc(outline.title), { style: 'Title', font: head, size: size * 2, bold: true, align: 'center' }));
  if (outline.subtitle)
    body.push(para(esc(outline.subtitle), { font: head, size: size * 1.1, align: 'center', color: '666666' }));
  if (book.author) body.push(para(esc(book.author), { font: head, size, align: 'center' }));
  body.push(pageBreak());

  const byId = new Map(sections.map((s) => [s.id, s]));
  const figureByName = new Map((book.figures || []).filter((f) => f.name).map((f) => [f.name, f]));

  if (book.contentMode === 'items' || (outline?.themes?.length && !outline?.chapters?.length)) {
    for (const theme of outline.themes || []) {
      body.push(para(`${theme.n}: ${esc(theme.title)}`, { style: 'Heading1', font: head, size: size * 1.7, bold: true, pageBreakBefore: true }));
      const items = sections
        .filter((s) => s.kind === 'item' && String(s.theme ?? s.id).split('.')[0] === String(theme.n))
        .sort((a, b) => compareItemId(a.id, b.id));
      for (const item of items) {
        body.push(para(`${item.id} ${esc(theme.title)}`, { style: 'Heading2', font: head, size: size * 1.1, bold: true }));
        body.push(para(esc(stripZwsp(item.text || item.md || '')), { font, size: book.itemSizePt || size, align: 'center' }));
        if (item.attribution) body.push(para(`— ${esc(item.attribution)}`, { font, size: size * 0.75, align: 'center', color: '666666' }));
      }
    }
  } else for (const ch of outline.chapters || []) {
    body.push(para(`บทที่ ${ch.n}: ${esc(ch.title)}`, { style: 'Heading1', font: head, size: size * 1.7, bold: true, pageBreakBefore: true }));

    for (const s of ch.sections) {
      // ใส่เลขตอนไว้หน้าชื่อ เพื่อให้จับคู่กลับได้ตอนนำเข้า และตัดออกก่อนทำ PDF
      body.push(para(`${s.id} ${esc(s.title)}`, { style: 'Heading2', font: head, size: size * 1.25, bold: true }));
      const md = stripZwsp(byId.get(s.id)?.md || '');
      if (!md.trim()) {
        body.push(para('(ยังไม่มีเนื้อหา)', { font, size, color: '999999' }));
        continue;
      }
      for (const block of mdBlocks(md, figureByName, book.figureMode === 'prompt'))
        body.push(blockToXml(block, { font, head, size }));
    }
  }

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join('\n')}
${sectPr(book)}
</w:body>
</w:document>`;

  const files = new Map();
  files.set('[Content_Types].xml', CONTENT_TYPES);
  files.set('_rels/.rels', RELS);
  files.set('word/_rels/document.xml.rels', DOC_RELS);
  files.set('word/styles.xml', styles(font, head, size));
  files.set('word/document.xml', doc);

  return zipStore(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

function sectPr(book) {
  const m = book.typography.marginsMm;
  return `<w:sectPr>
<w:pgSz w:w="${tw(book.trim.widthMm)}" w:h="${tw(book.trim.heightMm)}"/>
<w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.outer)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.inner)}" w:header="708" w:footer="708" w:gutter="0"/>
<w:bidi w:val="0"/>
</w:sectPr>`;
}

function runProps({ font, size, bold, italic, color }) {
  // ไทยเป็น complex script ในสายตาเวิร์ด ต้องตั้ง w:cs และ w:szCs ด้วย
  // ไม่งั้นขนาดตัวอักษรไทยจะไม่เปลี่ยนตามที่ตั้ง
  return `<w:rPr>
<w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:cs="${esc(font)}"/>
${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}
<w:sz w:val="${halfPt(size)}"/><w:szCs w:val="${halfPt(size)}"/>
${color ? `<w:color w:val="${color}"/>` : ''}
<w:lang w:bidi="th-TH"/>
</w:rPr>`;
}

function para(text, o = {}) {
  const { style, align, pageBreakBefore, indent } = o;
  return `<w:p>
<w:pPr>
${style ? `<w:pStyle w:val="${style}"/>` : ''}
${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}
${align ? `<w:jc w:val="${align}"/>` : ''}
${indent ? `<w:ind w:left="${tw(indent)}"/>` : ''}
<w:spacing w:line="${Math.round((o.lineHeight || 1.6) * 240)}" w:lineRule="auto" w:after="120"/>
</w:pPr>
${text ? `<w:r>${runProps(o)}<w:t xml:space="preserve">${text}</w:t></w:r>` : ''}
</w:p>`;
}

function richPara(parts, o = {}) {
  const runs = parts
    .map((p) => `<w:r>${runProps({ ...o, bold: p.bold, italic: p.italic })}<w:t xml:space="preserve">${esc(p.text)}</w:t></w:r>`)
    .join('');
  return `<w:p>
<w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>' : ''}
<w:spacing w:line="${Math.round((o.lineHeight || 1.6) * 240)}" w:lineRule="auto" w:after="120"/></w:pPr>
${runs}
</w:p>`;
}

/** ย่อหน้าในกล่องสรุป: พื้นอ่อน มีเส้นคาดหัวและท้ายกล่อง */
function boxPara(parts, o = {}) {
  const runs = parts
    .map((p) => `<w:r>${runProps({ ...o, bold: o.bold || p.bold, italic: p.italic })}<w:t xml:space="preserve">${esc(p.text)}</w:t></w:r>`)
    .join('');
  const border = (side) => `<w:${side} w:val="single" w:sz="6" w:space="6" w:color="B4B4B4"/>`;
  return `<w:p>
<w:pPr>
<w:pBdr>${o.first ? border('top') : ''}${border('left')}${border('right')}${o.last ? border('bottom') : ''}</w:pBdr>
<w:shd w:val="clear" w:color="auto" w:fill="F7F7F7"/>
<w:ind w:left="${tw(6)}" w:right="${tw(6)}"/>
<w:spacing w:line="${Math.round((o.lineHeight || 1.6) * 240)}" w:lineRule="auto" w:before="${o.first ? 160 : 0}" w:after="${o.last ? 160 : 40}"/>
</w:pPr>
${runs}
</w:p>`;
}

const pageBreak = () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** แตก markdown เป็นบล็อกแบบง่าย ๆ เท่าที่ prompt อนุญาตให้โมเดลใช้ */
function mdBlocks(md, figureByName = new Map(), showPrompts = false) {
  const out = [];
  for (const raw of String(md).split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;

    /**
     * กล่องสรุป :::box — Typst วาดเป็นกล่องจริง แต่ฝั่ง .docx ไม่เคยรู้จัก
     * บล็อกนี้จึงตกไปเป็นย่อหน้าธรรมดา แล้วเครื่องหมาย ::: ก็ถูกพิมพ์ลงไฟล์เวิร์ดตรง ๆ
     * (ในไฟล์ที่ส่งมาตรวจพบ 15 จุด) ผู้ใช้เห็นโค้ดกำกับปนอยู่ในเนื้อหนังสือ
     */
    const boxOpen = block.match(/^:::box[ \t]*(.*)$/m);
    if (boxOpen && block.startsWith(':::box')) {
      const lines = block.split('\n');
      const title = (lines[0].replace(/^:::box[ \t]*/, '') || '').trim();
      const items = lines
        .slice(1)
        .filter((l) => !/^:::\s*$/.test(l.trim()))
        .map((l) => l.trim())
        .filter(Boolean);
      out.push({ kind: 'box', title, items });
      continue;
    }
    const fig = block.match(/^!\[([^\]]*)\]\(fig:([A-Za-z0-9._-]+)(?:\s+(\d{1,3})%)?(?:\s+(\d+(?:\.\d+)?)mm)?\)$/);
    if (fig) {
      const data = figureByName.get(fig[2]);
      out.push({
        kind: 'figure',
        // ใต้ภาพเหลือแต่คำบรรยายจริง ไม่มีเลข "รูปที่ N" เหมือนฝั่ง PDF
        caption: (fig[1] || '').replace(/^\s*(?:รูป|ภาพ|แผนภาพ|Fig(?:ure)?)\s*(?:ที่)?\s*\d+\s*[:.\-–]\s*/i, '').trim(),
        name: fig[2],
        prompt: showPrompts ? data?.prompt || data?.subject || data?.caption || '' : '',
      });
      continue;
    }
    const h = block.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push({ kind: 'h', level: h[1].length, text: h[2] });
      continue;
    }
    if (/^\s*[-*+]\s/.test(block)) {
      out.push({ kind: 'ul', items: block.split('\n').map((l) => l.replace(/^\s*[-*+]\s/, '')) });
      continue;
    }
    if (/^\s*\d+[.)]\s/.test(block)) {
      out.push({ kind: 'ol', items: block.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s/, '')) });
      continue;
    }
    if (/^\s*>/.test(block)) {
      out.push({ kind: 'quote', text: block.replace(/^\s*>\s?/gm, '') });
      continue;
    }
    out.push({ kind: 'p', text: block.replace(/\n/g, ' ') });
  }
  return out;
}

function blockToXml(b, { font, head, size }) {
  switch (b.kind) {
    case 'h':
      return richPara(inlineParts(b.text), {
        style: 'Heading3',
        font: head,
        size: size * 1.08,
        bold: true,
      });
    case 'ul':
      return b.items.map((i) => richPara(inlineParts('• ' + i), { font, size, indent: 6 })).join('\n');
    case 'ol':
      return b.items.map((i, n) => richPara(inlineParts(`${n + 1}. ${i}`), { font, size, indent: 6 })).join('\n');
    case 'quote':
      return richPara(inlineParts(b.text), { font, size, italic: true, indent: 8 });
    case 'box':
      // เวิร์ดไม่มีกล่องแบบ Typst จึงใช้เส้นคาดบนล่าง + พื้นอ่อน ให้อ่านออกว่าเป็นกล่องสรุป
      return [
        b.title ? boxPara(inlineParts(b.title), { font: head, size, bold: true, first: true, last: !b.items.length }) : '',
        ...b.items.map((it, i) =>
          boxPara(inlineParts(it.replace(/^\s*[-*+]\s*/, '• ')), {
            font,
            size,
            first: !b.title && i === 0,
            last: i === b.items.length - 1,
          }),
        ),
      ]
        .filter(Boolean)
        .join('\n');
    case 'figure':
      return [
        richPara(inlineParts(b.prompt ? `<Prompt : ${b.prompt}>` : `[พื้นที่วางภาพ: ${b.name}]`), {
          font,
          size: size * 0.72,
          italic: true,
          color: '666666',
        }),
        b.caption ? richPara(inlineParts(b.caption), { font, size: size * 0.78, italic: true }) : '',
      ].join('\n');
    default:
      return richPara(inlineParts(b.text), { font, size });
  }
}

/** แยกตัวหนา/ตัวเอียงออกเป็นรัน */
function inlineParts(text) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(`[^`]+`)/g;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    if (m[1]) parts.push({ text: m[1].slice(2, -2), bold: true });
    else if (m[2]) parts.push({ text: m[2].slice(1, -1), italic: true });
    else if (m[3]) parts.push({ text: m[3].slice(1, -1) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length ? parts : [{ text }];
}

// ---------------------------------------------------------------- นำเข้า

/**
 * อ่าน .docx ที่แก้มาแล้ว กลับเข้าเป็นเนื้อหารายตอน
 * จับคู่ตอนจากหัวข้อระดับ 2 ที่ขึ้นต้นด้วยเลขตอน เช่น "1.2 ชื่อตอน"
 * ถ้าผู้ใช้ลบเลขออก จะถอยไปจับคู่ตามลำดับที่ปรากฏแทน
 */
export async function readDocx(file, outline) {
  const entries = await unzip(await file.arrayBuffer());
  const xml = entries.get('word/document.xml');
  if (!xml) throw new Error('ไม่ใช่ไฟล์ .docx ที่อ่านได้ — หา word/document.xml ไม่เจอ');

  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [...doc.getElementsByTagNameNS(W, 'p')];

  const expected = outline.chapters
    ? outline.chapters.flatMap((c) => (c.sections || []).map((s) => s.id))
    : (outline.themes || []).flatMap((t) =>
        Array.from({ length: Number(t.count) || 0 }, (_, i) => `${t.n}.${i + 1}`),
      );
  const found = [];
  let current = null;

  for (const p of paras) {
    const styleEl = p.getElementsByTagNameNS(W, 'pStyle')[0];
    const style = styleEl?.getAttributeNS(W, 'val') || styleEl?.getAttribute('w:val') || '';
    const plain = [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('').trim();

    if (style === 'Heading1') {
      current = null; // ชื่อบท ไม่ใช่เนื้อหา
      continue;
    }
    if (style === 'Heading2') {
      const m = plain.match(/^(\d+\.\d+)\s+(.*)$/);
      current = { id: m ? m[1] : null, title: m ? m[2] : plain, lines: [] };
      found.push(current);
      continue;
    }
    if (!current || !plain) continue;

    if (style === 'Heading3') {
      current.lines.push('### ' + plain);
      continue;
    }

    // เก็บตัวหนา/ตัวเอียงกลับมาเป็น markdown ไม่ให้การจัดรูปที่ผู้ใช้แก้ในเวิร์ดหายไป
    let text = runsToMarkdown(p, W).trim();
    if (!text) continue;

    // เวิร์ดเก็บหัวข้อย่อยเป็นย่อหน้าที่ขึ้นต้นด้วยจุด แปลงกลับเป็น markdown
    text = text.replace(/^[•‧·]\s*/, '- ');
    current.lines.push(text);
  }

  // ตอนที่ไม่มีเลขกำกับ ให้เดาจากลำดับ
  let cursor = 0;
  for (const f of found) {
    if (f.id) {
      cursor = Math.max(cursor, expected.indexOf(f.id) + 1);
      continue;
    }
    f.id = expected[cursor] || null;
    cursor++;
  }

  return found
    .filter((f) => f.id)
    .map((f) => ({ id: f.id, title: f.title, md: joinLines(f.lines) }));
}

/** อ่านรันในย่อหน้าแล้วแปลงตัวหนา/ตัวเอียงกลับเป็น markdown */
function runsToMarkdown(p, W) {
  let out = '';
  for (const r of p.getElementsByTagNameNS(W, 'r')) {
    const t = [...r.getElementsByTagNameNS(W, 't')].map((x) => x.textContent).join('');
    if (!t) continue;
    const rPr = r.getElementsByTagNameNS(W, 'rPr')[0];
    const bold = !!rPr?.getElementsByTagNameNS(W, 'b').length;
    const italic = !!rPr?.getElementsByTagNameNS(W, 'i').length;
    const core = t.replace(/^(\s*)([\s\S]*?)(\s*)$/, '$2');
    const lead = t.match(/^\s*/)[0];
    const tail = t.match(/\s*$/)[0];
    if (!core) {
      out += t;
      continue;
    }
    out += lead + (bold ? `**${core}**` : italic ? `_${core}_` : core) + tail;
  }
  return out;
}

/** หัวข้อย่อยที่ติดกันควรอยู่ในบล็อกเดียว ไม่ใช่คั่นบรรทัดว่างทีละข้อ */
function joinLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const isList = /^[-*+]\s|^\d+[.)]\s/.test(line);
    if (isList && prev && /^[-*+]\s|^\d+[.)]\s/.test(prev.split('\n').pop())) {
      out[out.length - 1] = prev + '\n' + line;
    } else {
      out.push(line);
    }
  }
  return out.join('\n\n').trim();
}

// ---------------------------------------------------------------- zip

async function zipStore(files, mime) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const nameBytes = enc.encode(name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.size, true);
  ev.setUint16(10, files.size, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: mime });
}

/** อ่าน zip โดยใช้ DecompressionStream ของเบราว์เซอร์ ไม่ต้องมีไลบรารี */
async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // หา End of Central Directory จากท้ายไฟล์
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ไฟล์ zip เสียหาย');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);

    out.set(name, method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- ชิ้นส่วนคงที่

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function styles(font, head, size) {
  const S = (id, name, f, sz, bold, outline) => `<w:style w:type="paragraph" w:styleId="${id}">
<w:name w:val="${name}"/>
<w:qFormat/>
<w:pPr>${outline != null ? `<w:outlineLvl w:val="${outline}"/>` : ''}<w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${halfPt(sz)}"/><w:szCs w:val="${halfPt(sz)}"/></w:rPr>
</w:style>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>
<w:sz w:val="${halfPt(size)}"/><w:szCs w:val="${halfPt(size)}"/>
<w:lang w:bidi="th-TH"/>
</w:rPr></w:rPrDefault></w:docDefaults>
${S('Title', 'Title', head, size * 2, true, null)}
${S('Heading1', 'heading 1', head, size * 1.7, true, 0)}
${S('Heading2', 'heading 2', head, size * 1.25, true, 1)}
${S('Heading3', 'heading 3', head, size * 1.08, true, 2)}
</w:styles>`;
}
