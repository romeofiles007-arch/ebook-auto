/**
 * ส่งออกไฟล์ทั้งหมด
 * ดาวน์โหลดผ่าน service worker เพราะ chrome.downloads เรียกจากหน้าเว็บของส่วนขยายได้
 * แต่ต้องจำ revokeObjectURL ไม่งั้น PDF หลายสิบเมกะไบต์จะค้างใน memory ทั้ง session
 */

import * as db from './db.js';
import { stripZwsp } from './thai.js';
import { coverTextBaked } from './prompts.js';
import { authorRefSummary } from './imageRef.js';
import { coverGeometry } from './budget.js';
import { packAssets, toPdf } from '../typeset/compiler.js';
import { buildDocument, buildItemsDocument } from '../typeset/template.js';
import { buildDocx, readDocx } from './docx.js';
import { countUnits } from './thai.js';

let exportDirectoryHandle = null;

export function setExportDirectoryHandle(handle) {
  exportDirectoryHandle = handle || null;
}

async function writeToFolder(blob, filename) {
  if (!exportDirectoryHandle) return false;
  const parts = filename.split('/').filter(Boolean);
  let dir = exportDirectoryHandle;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(parts.at(-1), { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

/**
 * บันทึกไฟล์ให้ได้ "ชื่อหนังสือ" เสมอ ไม่ใช่รหัส blob ของเบราว์เซอร์
 *
 * เส้นทางเดิมส่ง blob: URL ข้ามไปให้ service worker เรียก chrome.downloads
 * ซึ่งบางครั้งเบราว์เซอร์ไม่รับชื่อที่ส่งไป แล้วตั้งชื่อไฟล์เป็น UUID ของ blob แทน
 * (เจอจริง: ไฟล์ที่ได้ชื่อ 737f96e2-3535-4e22-b9b9-038642b9ef5b.pdf)
 * แท็ก a[download] ในหน้าส่วนขยายตั้งชื่อได้แน่นอนกว่า จึงใช้เป็นทางหลัก
 * แต่มันสร้างโฟลเดอร์ย่อยไม่ได้ จึงยุบเส้นทางให้เหลือชื่อไฟล์เดียว
 */
async function download(blob, filename) {
  if (await writeToFolder(blob, filename)) return;

  const flat = String(filename).split('/').filter(Boolean).pop() || 'book';
  const url = URL.createObjectURL(blob);
  try {
    if (typeof document !== 'undefined') {
      const a = document.createElement('a');
      a.href = url;
      a.download = flat;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    await chrome.runtime.sendMessage({ type: 'sw.download', url, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

const safe = (s) => String(s || 'book').replace(/[\\/:*?"<>|]/g, '').slice(0, 60).trim() || 'book';

/**
 * ชื่อไฟล์ต้องบอกได้เองว่าเป็นหนังสือเล่มไหนและเป็นไฟล์อะไร
 *
 * เดิมทุกเล่มส่งออกเป็น interior.pdf / book.pdf เหมือนกันหมด ต่างกันแค่ชื่อโฟลเดอร์
 * พอลากไฟล์ออกมาจากโฟลเดอร์หรือส่งต่อให้คนอื่น ก็ไม่มีทางรู้ว่าเป็นเล่มไหน
 * และเห็นสองไฟล์ชื่อคล้ายกันโดยไม่รู้ว่าต่างกันตรงไหน
 */
const outFile = (book, suffix, ext) => {
  const name = safe(book?.outline?.title || book?.topic);
  return `${name}/${name}${suffix ? ` - ${suffix}` : ''}.${ext}`;
};

/**
 * ไฟล์ที่ต้องแพ็กไปให้เครื่องเรียงพิมพ์สำหรับ "เนื้อใน"
 *
 * ลวดลายพื้นหลังถูกลืมตรงนี้ทั้งที่สร้างเสร็จและบันทึกแล้ว — ตัวกรองรับแต่ไฟล์ fig-*
 * พอ page-pattern.png ไม่ถูกแพ็ก assetNames ก็ไม่มีชื่อมัน เครื่องเรียงพิมพ์เลยไม่วางพื้นหลังให้
 * ผลคือ Phase 2 ขึ้นว่า "บันทึกแล้ว" แต่เปิดเล่มจริงไม่มีลายสักหน้า
 */
const interiorAsset = (a) => !!a?.blob && (a.name?.startsWith('fig-') || a.name === 'page-pattern.png');

export async function exportInterior(book, sections, { withBleed = true } = {}) {
  const assets = (await db.loadAssets(book.id)).filter(interiorAsset);
  const src = buildInteriorSource(book, sections, {
    withBleed,
    padPages: book.padPages || 0,
    assetNames: assets.map((a) => a.name),
  });
  const files = await packAssets(assets);
  const blob = await toPdf(src, files);
  await download(blob, outFile(book, 'เนื้อใน สำหรับโรงพิมพ์', 'pdf'));
  return blob.size;
}

/** ฉบับให้คนอ่านตรวจ — ไม่มีตัดตก มีลายน้ำ */
export async function exportScreen(book, sections) {
  const b = structuredClone(book);
  b.watermark = 'DRAFT';
  const assets = (await db.loadAssets(book.id)).filter(interiorAsset);
  const src = buildInteriorSource(b, sections, {
    withBleed: false,
    padPages: 0,
    watermark: 'DRAFT',
    assetNames: assets.map((a) => a.name),
  });
  const files = await packAssets(assets);
  const blob = await toPdf(src, files);
  await download(blob, outFile(book, 'ฉบับตรวจงาน', 'pdf'));
  return blob.size;
}

/**
 * PDF อ่านจริง/ส่งลูกค้า — รวมปกหน้า + เนื้อหา + ภาพประกอบ + ปกหลังในไฟล์เดียว
 * งานพิมพ์ยังใช้ interior.pdf + cover.pdf แยกเหมือนเดิม เพราะโรงพิมพ์ต้องการปกกางเต็ม
 */
export async function exportBookPdf(book, sections) {
  const all = await db.loadAssets(book.id);
  const assets = all.filter(
    (a) =>
      a?.blob &&
      (a.name?.startsWith('fig-') ||
        a.name === 'page-pattern.png' ||
        a.name === 'cover-front.png' ||
        a.name === 'cover-back.png' ||
        a.name === 'author-photo.png'),
  );
  const names = assets.map((a) => a.name);
  const haveFrontCover = names.includes('cover-front.png');
  const haveBackCover = names.includes('cover-back.png');
  const src = buildInteriorSource(book, sections, {
    withBleed: false,
    padPages: 0,
    assetNames: names,
    includeFrontCover: haveFrontCover,
    coverFrontName: 'cover-front.png',
    includeBackCover: haveBackCover,
    coverBackName: 'cover-back.png',
    authorPhotoName: 'author-photo.png',
  });
  const files = await packAssets(assets);
  const blob = await toPdf(src, files);
  await download(blob, outFile(book, '', 'pdf'));
  return {
    size: blob.size,
    coverIncluded: haveFrontCover,
    frontCoverIncluded: haveFrontCover,
    backCoverIncluded: haveBackCover,
  };
}

/** ปกกางเต็ม — ความกว้างคำนวณจากจำนวนหน้าสุดท้าย ไม่ใช่จำนวนหน้าเป้าหมาย */
export async function exportCover(book, { frontDataUrl, backDataUrl, authorDataUrl } = {}) {
  const pages = book.finalPages || book.lastCompile?.pages || book.targetPages;
  const geo = coverGeometry({
    trimWmm: book.trim.widthMm,
    trimHmm: book.trim.heightMm,
    pages,
    paper: book.paper || 'white',
    bleedMm: book.trim.bleedMm || 3,
  });
  const src = coverTypst(book, geo, { frontDataUrl, backDataUrl, authorDataUrl });
  const blob = await toPdf(src);
  await download(blob, outFile(book, 'ปกกางเต็ม', 'pdf'));
  return { size: blob.size, geo };
}

function coverTypst(book, geo, { frontDataUrl, backDataUrl, authorDataUrl }) {
  const baked = coverTextBaked(book);
  const bleed = book.trim.bleedMm || 3;
  const t = book.typography;
  const titleText = book.outline?.title || '';
  const title = JSON.stringify(titleText);
  const subtitle = JSON.stringify(book.outline?.subtitle || '');
  const author = JSON.stringify(book.author || '');
  const accent = book.style?.palette?.[0]?.hex || '#1B2B36';
  const paperCol = book.style?.palette?.[2]?.hex || '#F2EFE9';
  // สีหมึกสำหรับตัวอักษรที่วางบนพื้นทึบ ต้องเป็นสีเข้มเสมอ ไม่ใช่สีเน้นของปก
  const inkCol = book.style?.palette?.[0]?.hex || '#14243A';
  const palette = book.style?.palette || [];
  const layout = book.coverLayout || book.style?.typography || {};
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const zone = (name, fallback) => {
    const z = layout?.[name] || {};
    const x = clamp(z.x_pct, 4, 92, fallback.x);
    const y = clamp(z.y_pct, 4, 94, fallback.y);
    const width = Math.min(clamp(z.width_pct, 30, 92, fallback.width), 96 - x);
    const align = ['left', 'center', 'right'].includes(z.align) ? z.align : fallback.align;
    const size = clamp(z.size_scale, fallback.min, fallback.max, fallback.size);
    const roleIndex = { palette_1: 0, palette_2: 1, palette_3: 2 }[z.color_role];
    const color = palette?.[roleIndex]?.hex || fallback.color || paperCol;
    return { x, y, width, align, size, color };
  };
  const titleZone = zone('title', { x: 8, y: 10, width: 84, align: 'center', min: 1.6, max: 3.6, size: 2.6, color: paperCol });
  const subtitleZone = zone('subtitle', { x: 12, y: 26, width: 76, align: 'center', min: 0.8, max: 1.4, size: 1.1, color: paperCol });
  const authorZone = zone('author', { x: 10, y: 88, width: 80, align: 'center', min: 0.9, max: 1.5, size: 1.2, color: paperCol });

  // Art director ไม่รู้การตัดบรรทัดจริงของชื่อภาษาไทย จึงต้อง fit จากชื่อจริงอีกชั้น
  const titleLength = Array.from(String(titleText).replace(/\s+/g, '')).length;
  const titleScaleCap = titleLength > 55 ? 1.7 : titleLength > 40 ? 1.95 : titleLength > 28 ? 2.25 : titleLength > 18 ? 2.6 : 3.2;
  titleZone.size = Math.min(titleZone.size, titleScaleCap);
  const titleWidthPt = ((Number(book.trim.widthMm) || 148) * titleZone.width / 100) / 25.4 * 72;
  const charsPerLine = Math.max(6, Math.floor(titleWidthPt / (t.sizePt * titleZone.size * 0.7)));
  const estimatedTitleLines = Math.max(1, Math.ceil(Math.max(1, titleLength) / charsPerLine));
  const titleHeightPct = (estimatedTitleLines * t.sizePt * titleZone.size * 1.12 / 72 * 25.4) / (Number(book.trim.heightMm) || 210) * 100;
  subtitleZone.y = Math.min(authorZone.y - 14, Math.max(subtitleZone.y, titleZone.y + titleHeightPct + 2.5));

  const img = (dataUrl, w, h) =>
    dataUrl
      ? `#image.decode(${JSON.stringify(dataUrl)}, width: ${w}mm, height: ${h}mm, fit: "cover")`
      : `#rect(width: ${w}mm, height: ${h}mm, fill: rgb("${accent}"))`;

  const fullW = geo.widthMm;
  const fullH = geo.heightMm;
  const panelW = book.trim.widthMm;
  const panelH = book.trim.heightMm;
  const showAuthorPhoto = !!(book.authorPhotoOnCover && authorDataUrl);
  const backTextY = bleed + (showAuthorPhoto ? 66 : 30);
  const authorPhotoBlock = showAuthorPhoto
    ? `#place(top + left, dx: ${bleed + 12}mm, dy: ${bleed + 14}mm)[\n        #image.decode(${JSON.stringify(authorDataUrl)}, width: 30mm, height: 38mm, fit: \"cover\")\n      ]`
    : '';

  return `
#set page(width: ${fullW}mm, height: ${fullH}mm, margin: 0pt)
#set text(font: ${JSON.stringify(t.headFont || t.bodyFont)}, lang: "th")

#place(top + left, dx: 0mm, dy: 0mm)[
  #stack(dir: ltr,
    // ---- ปกหลัง ----
    box(width: ${panelW + bleed}mm, height: ${fullH}mm)[
      ${img(backDataUrl, panelW + bleed, fullH)}
      ${authorPhotoBlock}
      // คำโปรยต้องมีพื้นทึบรอง ไม่งั้นตัวอักษรจะจมไปกับลายของภาพปกหลัง
      // ถ้าภาพปกหลังวาดตัวอักษรมาให้แล้ว ก็ไม่ต้องวางซ้ำ
      ${book.backCoverTextBaked ? '' : `#place(top + left, dx: ${bleed + 12}mm, dy: ${backTextY}mm)[
        #block(width: ${panelW - 24}mm, fill: rgb("${paperCol}F0"), inset: (x: 7mm, y: 6mm), radius: 3mm)[
          #set par(leading: 0.62em, spacing: 0.7em, first-line-indent: 0pt)
          #text(size: ${t.sizePt}pt, fill: rgb("${inkCol}"))[${JSON.stringify(book.blurb || '')}]
        ]
      ]`}
      // เขตบาร์โค้ด ต้องว่างและสว่างเสมอ
      #place(bottom + right, dx: -${bleed + 8}mm, dy: -${bleed + 8}mm)[
        #rect(width: 50mm, height: 30mm, fill: white, stroke: none)
      ]
    ],
    // ---- สัน ----
    box(width: ${geo.spineMm}mm, height: ${fullH}mm, fill: rgb("${accent}"))[
      ${
        geo.spineTextAllowed
          ? `#place(center + horizon)[#rotate(-90deg, reflow: false)[
          #text(size: ${Math.min(t.sizePt, geo.spineMm * 1.6)}pt, fill: rgb("${paperCol}"))[${title} · ${author}]
        ]]`
          : ''
      }
    ],
    // ---- ปกหน้า ----
    // ปกที่ ChatGPT วาดตัวหนังสือมาให้แล้ว วางแค่ภาพ ไม่งั้นชื่อเรื่องจะซ้อนกันสองชั้น
    box(width: ${panelW + bleed}mm, height: ${fullH}mm)[
      ${img(frontDataUrl, panelW + bleed, fullH)}
      ${baked ? '' : `#place(top + left, dx: ${panelW * titleZone.x / 100}mm, dy: ${bleed + panelH * titleZone.y / 100}mm)[
        #box(width: ${panelW * titleZone.width / 100}mm)[
          #align(${titleZone.align})[
            #text(size: ${t.sizePt * titleZone.size}pt, weight: 700, fill: rgb("${titleZone.color}"))[${title}]
          ]
        ]
      ]`}
      ${subtitle !== '""' && !baked ? `#place(top + left, dx: ${panelW * subtitleZone.x / 100}mm, dy: ${bleed + panelH * subtitleZone.y / 100}mm)[
        #box(width: ${panelW * subtitleZone.width / 100}mm)[
          #align(${subtitleZone.align})[
            #text(size: ${t.sizePt * subtitleZone.size}pt, fill: rgb("${subtitleZone.color}"))[${subtitle}]
          ]
        ]
      ]` : ''}
      ${baked ? '' : `#place(top + left, dx: ${panelW * authorZone.x / 100}mm, dy: ${bleed + panelH * authorZone.y / 100}mm)[
        #box(width: ${panelW * authorZone.width / 100}mm)[
          #align(${authorZone.align})[
            #text(size: ${t.sizePt * authorZone.size}pt, fill: rgb("${authorZone.color}"))[${author}]
          ]
        ]
      ]`}
    ],
  )
]
`.trim();
}

/**
 * DOCX สำหรับตรวจแก้ในเวิร์ด ก่อนทำ PDF จริง
 * ขนาดหน้าและขอบตรงกับที่ตั้งไว้ เพื่อให้เห็นการแบ่งหน้าใกล้เคียงของจริง
 * แต่ตัวเลขจำนวนหน้าที่เชื่อถือได้ยังต้องมาจาก Typst เพราะเวิร์ดจัดบรรทัดต่างกัน
 */
export async function exportDocx(book, sections) {
  const blob = await buildDocx({ book, outline: book.outline, sections });
  await download(blob, outFile(book, 'ต้นฉบับแก้ในเวิร์ด', 'docx'));
  return blob.size;
}

/**
 * นำ .docx ที่แก้แล้วกลับเข้าระบบ
 * คืนสรุปว่าตอนไหนเปลี่ยนไปเท่าไร ให้ผู้ใช้เห็นก่อนยืนยัน
 */
export async function importDocx(book, file, { apply = false } = {}) {
  const parsed = await readDocx(file, book.outline);
  const changes = [];

  for (const p of parsed) {
    const rec = await db.loadSection(book.id, p.id);
    if (!rec) continue;
    const chars = countUnits(p.md, book.language);
    const delta = chars - (rec.chars || 0);
    if (Math.abs(delta) === 0 && p.md.trim() === (rec.md || '').trim()) continue;

    changes.push({ id: p.id, title: p.title, before: rec.chars || 0, after: chars, delta });

    if (apply) {
      await db.saveSection(book.id, {
        ...rec,
        title: p.title || rec.title,
        md: p.md,
        chars,
        status: 'edited',
        history: [...(rec.history || []).slice(-19), { md: rec.md, chars: rec.chars, at: Date.now(), reason: 'ก่อนนำ DOCX กลับเข้า' }],
      });
    }
  }
  return { total: parsed.length, changes };
}

/** EPUB ขั้นต่ำที่เปิดได้จริง — ไม่มี ZWSP ไม่มีการจัดหน้า */
export async function exportEpub(book, sections) {
  const title = book.outline?.title || 'book';
  const files = new Map();

  files.set('mimetype', 'application/epub+zip');
  files.set(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );

  const chapters = isItemsBook(book)
    ? (book.outline.themes || []).map((theme, i) => {
        const body = sections
          .filter((s) => s.kind === 'item' && String(s.theme ?? s.id).split('.')[0] === String(theme.n))
          .sort((a, b) => compareItemId(a.id, b.id))
          .map((item) => {
            const attribution = item.attribution ? `<footer>— ${esc(item.attribution)}</footer>` : '';
            return `<blockquote>${mdToHtml(stripZwsp(item.text || item.md || ''))}${attribution}</blockquote>`;
          })
          .join('\n');
        return {
          file: `ch${i + 1}.xhtml`,
          title: theme.title,
          html: xhtml(theme.title, `<h1>${esc(theme.title)}</h1>\n${body}`),
        };
      })
    : (book.outline.chapters || []).map((ch, i) => {
        const fiction = book.contentMode === 'fiction';
        const chapterTitle = fiction
          ? `${book.language === 'th' ? 'บทที่' : 'Chapter'} ${ch.n}${ch.title ? ` · ${ch.title}` : ''}`
          : ch.title;
        const body = (ch.sections || [])
          .map((s, sceneIndex) => {
            const rec = sections.find((x) => x.id === s.id);
            const text = mdToHtml(stripZwsp(rec?.md || ''));
            if (fiction) return `${sceneIndex ? '<div class="scene-break">* * *</div>\n' : ''}${text}`;
            return `<h2>${esc(s.title)}</h2>\n${text}`;
          })
          .join('\n');
        return { file: `ch${i + 1}.xhtml`, title: chapterTitle, html: xhtml(chapterTitle, `<h1>${esc(chapterTitle)}</h1>\n${body}`) };
      });

  for (const c of chapters) files.set(`OEBPS/${c.file}`, c.html);

  files.set(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:${book.id}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:creator>${esc(book.author || '')}</dc:creator>
<dc:language>${book.language || 'th'}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapters.map((c, i) => `<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>
${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('\n')}
</spine>
</package>`,
  );

  files.set(
    'OEBPS/nav.xhtml',
    xhtml(
      'สารบัญ',
      `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><h1>สารบัญ</h1><ol>${chapters
        .map((c) => `<li><a href="${c.file}">${esc(c.title)}</a></li>`)
        .join('')}</ol></nav>`,
    ),
  );

  const blob = await zipStore(files);
  await download(blob, `${safe(title)}/${safe(title)}.epub`);
  return blob.size;
}

export async function exportProjectJson(bookId, title) {
  const payload = await db.exportProject(bookId);
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  await download(blob, `${safe(title)}/${safe(title)} - โครงการ.json`);
  return blob.size;
}

/**
 * ไฟล์รวม prompt ทุกภาพในเล่ม — หัวใจของการทำงานแบบ "เนื้อหาจากบัญชีฟรี ภาพจากที่อื่น"
 * เอาไฟล์นี้ไปเปิดในบัญชีที่สร้างภาพได้ สร้างทีละรูป เซฟตามชื่อที่กำกับไว้ แล้วกลับมาใส่
 */
/**
 * ตำแหน่งจริงในเล่มของภาพหนึ่งรูป เขียนให้คนอ่านแล้วรู้ทันทีว่าต้องวางตรงไหน
 *
 * ไฟล์นี้คือสิ่งที่ผู้ใช้ถือไปสร้างภาพเองที่อื่น ชื่อไฟล์อย่างเดียวไม่พอ
 * ต้องบอกด้วยว่าเป็นภาพของบทไหน ตอนชื่ออะไร และวางช่วงไหนของตอน
 */
function figurePlacementText(book, f) {
  const label = { top: 'ต้นตอน', middle: 'กลางตอน', bottom: 'ท้ายตอน' }[f.placement] || 'กลางตอน';
  let chapter = null;
  let section = null;
  for (const c of book.outline?.chapters || []) {
    const hit = (c.sections || []).find((x) => String(x.id) === String(f.section));
    if (hit) {
      chapter = c;
      section = hit;
      break;
    }
  }
  const nth = String(f.id || '').split('-').pop();
  return [
    chapter ? `บทที่ ${chapter.n} “${chapter.title}”` : null,
    section ? `ตอน ${f.section} “${section.title}”` : `ตอน ${f.section}`,
    `${label}${nth && nth !== '1' ? ` · ภาพที่ ${nth} ของตอนนี้` : ''}`,
  ]
    .filter(Boolean)
    .join(' › ');
}

export async function exportFigurePrompts(book) {
  const figs = book.figures || [];
  const placeOf = (f) => figurePlacementText(book, f);
  const imgs = figs.filter((f) => f.kind === 'image');
  const boxes = figs.length - imgs.length;
  const pages = book.finalPages || book.targetPages;
  const g = coverGeometry({
    trimWmm: book.trim.widthMm,
    trimHmm: book.trim.heightMm,
    pages,
    paper: book.paper || 'white',
    bleedMm: book.trim.bleedMm || 3,
  });
  const textWidthMm =
    book.trim.widthMm - book.typography.marginsMm.inner - book.typography.marginsMm.outer;

  const md = `# ภาพทั้งหมดของ "${book.outline?.title || book.topic}"

สร้างภาพที่ไหนก็ได้ แล้วกลับมาใส่ในส่วนขยายตามชื่อไฟล์ที่กำกับไว้
**ชื่อไฟล์คือสิ่งที่บอกระบบว่าภาพไปอยู่ตรงไหน** ตั้งชื่อให้ตรงแล้วกด "อัปโหลดหลายรูปพร้อมกัน" ทีเดียวได้เลย
ระบบจะย่อและแปลงเป็นขาวดำให้เองตอนใส่ ไม่ต้องจัดการเอง

- กล่องสรุปที่ Typst วาดเอง: **${boxes} จุด** ไม่ต้องสร้างภาพ
- ภาพที่ต้องสร้าง: **${imgs.length} รูป**

---

## ปก

ปกกางเต็มขนาด ${g.widthMm.toFixed(1)} × ${g.heightMm.toFixed(1)} มม.
ที่ 300 dpi = **${g.pxAt300dpi.w} × ${g.pxAt300dpi.h} พิกเซล** (สันกว้าง ${g.spineMm.toFixed(2)} มม. จาก ${pages} หน้า)

ปกหน้าและปกหลังสร้างแยกกัน อัตราส่วน 2:3 แล้วระบบจะประกอบให้เอง
ตัวหนังสือบนปกทั้งหมดเรียงพิมพ์ทับด้วย Typst ห้ามให้โมเดลภาพวาดตัวอักษร

### ปกหน้า → บันทึกเป็น \`cover-front.png\`

\`\`\`
${book.coverPrompts?.front || '(ยังไม่ได้สร้างทิศทางภาพ — เดินขั้น "ทิศทางภาพปก" ก่อน)'}
\`\`\`

### ปกหลัง → บันทึกเป็น \`cover-back.png\`

\`\`\`
${book.coverPrompts?.back || '(ยังไม่ได้สร้าง)'}
\`\`\`

${book.authorPhotoOnCover ? '### รูปผู้เขียน → บันทึกเป็น `author-photo.png`\n\nใช้รูปจริงของผู้เขียน ระบบจะวางขนาดประมาณ 30 × 38 มม. บนปกหลังโดยไม่ให้โมเดลสร้างหน้าคนขึ้นใหม่\n' : ''}${authorRefSummary(book)
    ? `### ต้องแนบรูปผู้เขียนไปกับคำสั่งด้วย\n\nเล่มนี้เลือกให้ ${authorRefSummary(book)} ใช้หน้าจริงของผู้เขียน\nคำสั่งของช่องเหล่านั้นมีหัวข้อ ATTACHED REFERENCE PHOTO ต่อท้ายอยู่แล้ว — ตอนสั่งวาด ให้แนบไฟล์รูปผู้เขียนไปในข้อความเดียวกันด้วย ไม่งั้นจะได้หน้าคนที่โมเดลแต่งขึ้นเอง\n`
    : ''}
---

## ภาพในเล่ม

เนื้อในพิมพ์ขาวดำ ภาพต้องอ่านออกในโทนเทา ไม่ใช่แค่ลดสีทีหลัง

${
  imgs.length
    ? imgs
        .map((f, i) => {
          const w = Math.round(f.widthMm || (textWidthMm * f.widthPct) / 100);
          const h = Math.round(f.heightMm || 45);
          const pxW = Math.round((w / 25.4) * 300);
          const pxH = Math.round((h / 25.4) * 300);
          return `### ${i + 1}. ${f.caption || f.name}

- **ตำแหน่งในเล่ม:** ${placeOf(f)}
- อยู่ในตอน ${f.section} · ช่องจริง ${w} × ${h} มม. · aspect ${f.aspect || '4:3'}
- ที่ 300 dpi ควรได้อย่างน้อย **${pxW} × ${pxH} พิกเซล**
- ระบบจะ crop แบบ cover ลงช่องนี้ จึงไม่ทำให้ตำแหน่งหรือจำนวนหน้าหลุด
- บันทึกเป็นชื่อ \`${f.name}\`

\`\`\`
${f.prompt || '(ไม่มี prompt)'}
\`\`\`
`;
        })
        .join('\n')
    : '_เล่มนี้ไม่มีภาพที่ต้องสร้าง_'
}
`;

  await download(new Blob([md], { type: 'text/markdown' }), `${safe(book.outline?.title)}/figure-prompts.md`);
}

export async function exportCoverPrompts(book) {
  const p = book.coverPrompts || {};
  const md = `# Prompt ภาพปก — ${book.outline?.title || ''}

## ทิศทางภาพของเล่ม
\`\`\`json
${JSON.stringify(book.style || {}, null, 2)}
\`\`\`

## ปกหน้า
\`\`\`
${p.front || '(ยังไม่ได้สร้าง)'}
\`\`\`

## ปกหลัง
\`\`\`
${p.back || '(ยังไม่ได้สร้าง)'}
\`\`\`

${book.authorPhotoOnCover ? '## รูปผู้เขียนบนปกหลัง\nอัปโหลดรูปจริงเป็น `author-photo.png` ระบบจะวางประมาณ 30 × 38 มม. และจะไม่ให้โมเดลสร้างใบหน้าผู้เขียนขึ้นใหม่\n\n' : ''}## ขนาดไฟล์ที่ต้องได้
${(() => {
  const pages = book.finalPages || book.targetPages;
  const g = coverGeometry({
    trimWmm: book.trim.widthMm,
    trimHmm: book.trim.heightMm,
    pages,
    paper: book.paper || 'white',
    bleedMm: book.trim.bleedMm || 3,
  });
  return `- จำนวนหน้าสุดท้าย ${pages} หน้า
- สันกว้าง ${g.spineMm.toFixed(2)} มม.
- ปกกางเต็ม ${g.widthMm.toFixed(1)} x ${g.heightMm.toFixed(1)} มม.
- ที่ 300 dpi = ${g.pxAt300dpi.w} x ${g.pxAt300dpi.h} พิกเซล
- ${g.spineTextAllowed ? 'สันกว้างพอใส่ตัวหนังสือได้' : 'สันบางเกินกว่าจะใส่ตัวหนังสือ'}`;
})()}

> ตัวหนังสือบนปกทั้งหมดเรียงพิมพ์ด้วย Typst ทับลงบนภาพ ไม่ให้โมเดลภาพวาดตัวอักษร
> เพราะตัวอักษรที่โมเดลวาดยังสะกดผิดและไม่คมพอสำหรับงานพิมพ์
`;
  await download(new Blob([md], { type: 'text/markdown' }), `${safe(book.outline?.title)}/cover-prompts.md`);
}

// ---------- helpers ----------

function isItemsBook(book) {
  return book?.contentMode === 'items' || (!!book?.outline?.themes?.length && !book?.outline?.chapters?.length);
}

function buildInteriorSource(book, sections, opts) {
  if (isItemsBook(book)) {
    const items = sections
      .filter((s) => s.kind === 'item' || s.text)
      .sort((a, b) => compareItemId(a.id, b.id));
    return buildItemsDocument({ book, outline: book.outline, items, opts });
  }
  return buildDocument({ book, outline: book.outline, sections, opts });
}

function esc(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function compareItemId(a, b) {
  const aa = String(a).split('.').map(Number);
  const bb = String(b).split('.').map(Number);
  return (aa[0] || 0) - (bb[0] || 0) || (aa[1] || 0) - (bb[1] || 0);
}

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="th"><head><meta charset="utf-8"/><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

function mdToHtml(md) {
  return String(md)
    .split(/\n{2,}/)
    .map((block) => {
      const h = block.match(/^(#{1,6})\s+(.*)$/);
      if (h) return `<h${Math.min(6, h[1].length)}>${esc(h[2])}</h${Math.min(6, h[1].length)}>`;
      if (/^\s*[-*+]\s/.test(block))
        return `<ul>${block
          .split('\n')
          .map((l) => `<li>${inlineHtml(l.replace(/^\s*[-*+]\s/, ''))}</li>`)
          .join('')}</ul>`;
      return `<p>${inlineHtml(block).replace(/\n/g, '<br/>')}</p>`;
    })
    .join('\n');
}

function inlineHtml(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * ZIP แบบไม่บีบอัด (store) — พอสำหรับ EPUB และไม่ต้องพึ่งไลบรารีภายนอก
 * ซึ่งสำคัญ เพราะ CSP ของส่วนขยายห้ามโหลดสคริปต์จากที่อื่น
 */
async function zipStore(files) {
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
    lv.setUint16(8, 0, true); // store
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

  return new Blob([...chunks, ...central, end], { type: 'application/epub+zip' });
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

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
