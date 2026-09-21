/**
 * ส่วนต้นเล่ม — ปกใน ลิขสิทธิ์ คำนำ สารบัญ
 *
 * ของพวกนี้เคยมีอยู่ที่เดียวคือในตัวเรียงพิมพ์ Typst หน้าอ่านกับไฟล์ EPUB จึงเริ่มที่บทที่ 1 เลย
 * ผู้ใช้เปิดอ่านแล้วไม่เจอคำนำที่ตัวเองสั่งให้เขียน ไม่เจอสารบัญ ทั้งที่มันอยู่ในเล่มที่พิมพ์ออกมา
 *
 * ย้ายมาไว้ตรงกลางเพื่อให้ทั้งสามปลายทางประกอบเล่มจากรายการเดียวกัน
 * และเคารพช่องที่ผู้ใช้ติ๊กไว้ (book.frontMatter) เหมือนกันหมด
 * เล่มที่ไม่ได้ติ๊กคำนำก็ต้องไม่มีคำนำทั้งในไฟล์ PDF และบนหน้าอ่าน
 */

const has = (book, key) => (book?.frontMatter || []).includes(key);

/** ข้อความคำนำ — ถ้าไม่มีที่เขียนไว้จริง ใช้ตัวสำรองชุดเดียวกับที่ Typst ใช้ */
export function forewordText(book) {
  const o = book?.outline || {};
  if (String(o.foreword || '').trim()) return String(o.foreword).trim();
  // นิยายที่ไม่มีคำนำจริง ไม่ต้องมีคำนำสำรอง เพราะตัวสำรองเป็นประโยคของหนังสือสารคดี
  if (book?.contentMode === 'fiction') return '';
  return `หนังสือเล่มนี้จัดทำขึ้นเพื่อช่วยให้ผู้อ่านเข้าใจ ${o.title || ''} อย่างเป็นขั้นตอนและนำไปใช้ได้จริง\n\n${
    o.subtitle || o.thesis || ''
  }`.trim();
}

/** บรรทัดในหน้าลิขสิทธิ์ ตรงกับที่พิมพ์ในเล่มจริง */
export function copyrightLines(book) {
  const o = book?.outline || {};
  return [
    o.title || book?.topic || '',
    book?.author || '',
    `พิมพ์ครั้งแรก ${new Date().getFullYear() + 543}`,
    'สงวนลิขสิทธิ์ตามพระราชบัญญัติ',
  ].filter(Boolean);
}

/**
 * รายการในหน้าสารบัญ
 *
 * ความลึกต้องตรงกับเล่มจริง: สารคดีลงถึงชื่อตอน นิยายหยุดที่ชื่อบท
 * เล่มแบบรายชิ้นไม่มีบท ใช้ธีมเป็นรายการแทน
 */
export function tocEntries(book) {
  const o = book?.outline || {};
  if (o.themes?.length && !o.chapters?.length) {
    return o.themes.map((t) => ({ depth: 1, text: t.title || '', theme: t.n }));
  }
  const fiction = book?.contentMode === 'fiction';
  const out = [];
  for (const ch of o.chapters || []) {
    const label = fiction
      ? `${book?.language === 'th' ? 'บทที่' : 'Chapter'} ${ch.n}${ch.title ? ` · ${ch.title}` : ''}`
      : `บทที่ ${ch.n} · ${ch.title || ''}`;
    // ติดหมายเลขบท/รหัสตอนไปด้วย เพื่อให้ปลายทางที่กดได้ (หน้าอ่าน, EPUB) ชี้ไปถูกที่
    out.push({ depth: 1, text: label, chapter: ch.n });
    if (!fiction) for (const s of ch.sections || []) out.push({ depth: 2, text: s.title || '', chapter: ch.n, section: s.id });
  }
  return out;
}

/**
 * หน้าต้นเล่มทั้งหมดตามลำดับจริง (ไม่รวมภาพปก ซึ่งแต่ละปลายทางจัดการเอง)
 *
 * หน้าปกในไม่มีช่องให้ติ๊ก เพราะเล่มทุกเล่มมีเสมอ — ตัวเรียงพิมพ์ก็ไม่ได้ถามเหมือนกัน
 */
export function frontMatterPages(book) {
  const o = book?.outline || {};
  const pages = [
    {
      kind: 'titlepage',
      key: 'title',
      label: 'หน้าปกใน',
      title: o.title || book?.topic || '',
      subtitle: o.subtitle || '',
      author: book?.author || '',
    },
  ];

  if (has(book, 'copyright')) {
    pages.push({ kind: 'lines', key: 'copyright', label: 'ลิขสิทธิ์', lines: copyrightLines(book) });
  }

  const foreword = has(book, 'foreword') ? forewordText(book) : '';
  if (foreword) pages.push({ kind: 'prose', key: 'foreword', label: 'คำนำ', md: foreword });

  if (has(book, 'toc')) {
    const entries = tocEntries(book);
    if (entries.length) pages.push({ kind: 'toc', key: 'toc', label: 'สารบัญ', entries });
  }

  return pages;
}
