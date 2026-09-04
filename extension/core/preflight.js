/**
 * Preflight — ตรวจก่อนออกไฟล์ ข้อที่ไม่ผ่านต้องบล็อกการส่งออก ไม่ใช่แค่เตือน
 */

import { minInnerMargin, coverGeometry, targetPhysicalPages } from './budget.js';
import { planItems } from './items.js';
import { ZWSP } from './thai.js';
import { findUndrawable } from './glyphs.js';
import { authorRefSummary } from './imageRef.js';

const KDP_MIN_PAGES = 24;

export function preflight({ book, sections, pages, assetNames = [] }) {
  const r = [];
  const ok = (id, label) => r.push({ id, label, level: 'ok' });
  const fail = (id, label, detail) => r.push({ id, label, level: 'fail', detail });
  const warn = (id, label, detail) => r.push({ id, label, level: 'warn', detail });

  const tol = book.pageTolerance ?? 2;
  const target =
    book.contentMode === 'items' || book.outline?.themes?.length
      ? Math.round(book.itemPlan?.breakdown?.targetPhysical || planItems(book).breakdown.targetPhysical)
      : targetPhysicalPages(book, book.outline);
  const err = pages - target;
  if (Math.abs(err) <= tol)
    ok('pages', `เนื้อหา ${book.targetPages} หน้า · รวมหน้าต้น/ท้าย ${pages} หน้า อยู่ในช่วงเป้าหมาย ±${tol}`);
  else
    warn(
      'pages',
      `รวม ${pages} หน้า ห่างจากเป้ารวม ${target} อยู่ ${err > 0 ? '+' : ''}${err}`,
      `เป้าหมายเนื้อหาหลักคือ ${book.targetPages} หน้า หน้าต้นและท้ายไม่นับรวม`,
    );

  if (pages % 2 === 0) ok('even', 'จำนวนหน้าเป็นเลขคู่');
  else fail('even', 'จำนวนหน้าเป็นเลขคี่', 'โรงพิมพ์ต้องการเลขคู่ ระบบควรเติมหน้าว่างท้ายเล่ม');

  if (pages >= KDP_MIN_PAGES) ok('minpages', `หนาพอสำหรับงานพิมพ์ (≥ ${KDP_MIN_PAGES} หน้า)`);
  else fail('minpages', `บางเกินไป ${pages} หน้า`, `โรงพิมพ์ส่วนใหญ่รับขั้นต่ำ ${KDP_MIN_PAGES} หน้า`);

  const needInner = minInnerMargin(pages);
  if (book.typography.marginsMm.inner >= needInner)
    ok('inner', `ขอบใน ${book.typography.marginsMm.inner} มม. ผ่านเกณฑ์ที่ ${pages} หน้า`);
  else
    fail(
      'inner',
      `ขอบใน ${book.typography.marginsMm.inner} มม. น้อยเกินไป`,
      `เล่มหนา ${pages} หน้า ต้องมีขอบในอย่างน้อย ${needInner} มม. ไม่งั้นตัวหนังสือจะจมเข้าไปในสัน`,
    );

  /**
   * ตัวอักษรที่ฟอนต์วาดไม่ได้ จะกลายเป็นกล่องสี่เหลี่ยมในไฟล์จริง
   *
   * ระบบแปลงให้อัตโนมัติตอนเรียงพิมพ์อยู่แล้ว แต่ผู้ใช้ควรรู้ว่าเนื้อหาถูกแตะตรงไหน
   * โดยเฉพาะตัวที่แทนด้วยอะไรไม่ได้เลยและต้องถอดทิ้ง — เจ้าของเล่มควรได้ตัดสินใจเอง
   * ว่าจะเขียนใหม่หรือปล่อย ไม่ใช่มารู้ตอนเปิดไฟล์ที่พิมพ์ไปแล้ว
   */
  const glyphHits = new Map();
  for (const sec of sections) {
    for (const hit of findUndrawable(sec.md || sec.text || '')) {
      const rec = glyphHits.get(hit.ch) || { ...hit, n: 0, ids: [] };
      rec.n += hit.n;
      if (rec.ids.length < 4 && !rec.ids.includes(sec.id)) rec.ids.push(sec.id);
      glyphHits.set(hit.ch, rec);
    }
  }
  if (!glyphHits.size) ok('glyphs', 'ทุกตัวอักษรในเล่มพิมพ์ออกมาเห็นได้จริง');
  else {
    const list = [...glyphHits.values()].sort((a, b) => b.n - a.n);
    const dropped = list.filter((h) => !h.replaceable);
    warn(
      'glyphs',
      `มีตัวอักษรที่ฟอนต์ไม่มี ${list.length} แบบ รวม ${list.reduce((n, h) => n + h.n, 0)} ตัว`,
      list
        .slice(0, 6)
        .map((h) => `${h.ch} (${h.n} จุด · ${h.ids.join(', ')}) ${h.replaceable ? 'แปลงให้แล้ว' : 'ถอดทิ้ง'}`)
        .join(' · ') + (dropped.length ? ' — ตัวที่ถอดทิ้งควรกลับไปเขียนใหม่ให้เป็นคำ' : ''),
    );
  }

  const blocked = sections.filter((s) => s.status === 'blocked');
  const draft = sections.filter((s) => !s.md?.trim());
  if (!blocked.length && !draft.length) ok('sections', `ทุกตอนมีเนื้อหาครบ ${sections.length} ตอน`);
  else
    fail(
      'sections',
      `ยังมี ${blocked.length + draft.length} ตอนที่ไม่พร้อม`,
      [
        blocked.length ? `ติดปัญหา: ${blocked.map((s) => s.id).join(', ')}` : '',
        draft.length ? `ยังว่าง: ${draft.map((s) => s.id).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );

  if (book.contentMode === 'fiction') {
    const cast = book.bible?.characters || book.outline?.cast || [];
    if (cast.length) ok('story_bible', `Story Bible มีตัวละคร canon ${cast.length} คน`);
    else fail('story_bible', 'นิยายยังไม่มี Story Bible ตัวละคร', 'ควรสร้างโครงเรื่องใหม่ก่อนเขียน เพื่อกันชื่อ บุคลิก และความสัมพันธ์หลุด');

    if (!book.runConsistency) {
      warn('fiction_continuity', 'ปิดการตรวจ continuity รายบทอยู่', 'นิยายยาวควรเปิดการตรวจเพื่อจับ POV เวลา กฎโลก ความสัมพันธ์ และ setup/payoff ที่ขัดกัน');
    } else {
      const reviews = Object.values(book.review || {});
      const issues = reviews.reduce(
        (n, r) => n + (r?.continuity_issues?.length || 0) + (r?.unpaid_promises?.length || 0),
        0,
      );
      if (issues) warn('fiction_continuity', `พบ continuity/ปมค้าง ${issues} ประเด็นจากการตรวจรายบท`, 'เปิดดูผลตรวจของบทที่เกี่ยวข้องก่อนส่งออกฉบับสุดท้าย');
      else ok('fiction_continuity', 'ตรวจ continuity รายบทแล้ว ไม่พบประเด็นที่ระบบทำเครื่องหมายค้างไว้');
    }
  }

  /**
   * เลือกแนบรูปผู้เขียนไว้ แต่ไม่มีไฟล์ = ภาพทุกใบที่ควรมีหน้าผู้เขียน จะเป็นหน้าที่โมเดลแต่งขึ้นเอง
   * ซึ่งดูผ่านตาแล้วเหมือนใช้ได้ กว่าจะรู้ตัวก็ตอนเปิดเล่มจริง จึงต้องทักตั้งแต่ก่อนส่งออก
   */
  const refWhere = authorRefSummary(book);
  if (refWhere) {
    const hasPhoto = assetNames.includes('author-photo.png');
    if (book.authorPhotoOnCover && (book.authorRefTargets || []).includes('cover-back'))
      warn(
        'author_ref_double',
        'ปกหลังทั้งให้โมเดลวาดผู้เขียนลงไปในภาพ และให้ระบบแปะรูปจริงทับอีกชั้น',
        'ปกหลังจะมีผู้เขียนสองคน — เลือกอย่างใดอย่างหนึ่ง ระหว่างติ๊ก "เพิ่มรูปผู้เขียนบนปกหลัง" กับ "แนบรูปผู้เขียน · ปกหลัง"',
      );
    if (hasPhoto) ok('author_ref', `แนบรูปผู้เขียนไปให้โมเดลดูตอนสร้าง ${refWhere}`);
    else
      warn(
        'author_ref',
        `เลือกแนบรูปผู้เขียนไปกับ ${refWhere} แต่ยังไม่มีไฟล์ author-photo.png`,
        'ภาพที่สร้างไปแล้วจะเป็นหน้าคนที่โมเดลแต่งขึ้นเอง — อัปโหลดรูปแล้วสั่งสร้างภาพนั้นใหม่',
      );
  }

  const zwsp = sections.filter((s) => (s.md || '').includes(ZWSP));
  if (!zwsp.length) ok('zwsp', 'ไม่มีตัวคั่นคำหลงเหลือในต้นฉบับ');
  else
    fail(
      'zwsp',
      `พบตัวคั่นคำ ZWSP ค้างในต้นฉบับ ${zwsp.length} ตอน`,
      'ZWSP ต้องอยู่เฉพาะในสายที่ป้อนเข้าคอมไพเลอร์ ไม่ใช่ในต้นฉบับที่เก็บไว้',
    );

  const off = sections.filter((s) => s.quota && Math.abs(s.chars - s.quota) / s.quota > 0.45);
  if (!off.length) ok('length', 'ทุกตอนอยู่ในกรอบความยาวที่ตั้งไว้');
  else
    warn(
      'length',
      `${off.length} ตอนห่างจากโควตาเกิน 45%`,
      off.slice(0, 6).map((s) => s.id).join(', '),
    );

  if (book.imagePhase?.total > 0) {
    if (book.imagePhase.status === 'complete') ok('images', `Image Phase 2 ครบ ${book.imagePhase.total} รูป และผูกกลับเข้าตำแหน่งแล้ว`);
    else if (book.imagePhase.status === 'skipped')
      warn('images', 'ข้าม Image Phase 2', 'ตำแหน่งภาพที่ยังไม่มีไฟล์จะคงเป็นช่องว่าง/Prompt ใน PDF');
    else
      fail(
        'images',
        `Image Phase 2 ยังไม่ครบ เหลือ ${(book.imagePhase.remaining || []).length} รูป`,
        (book.imagePhase.remaining || []).slice(0, 8).join(', '),
      );
  }

  if (book.style?.palette?.length === 3 && book.coverPrompts?.front)
    ok('cover', 'มี prompt ปกหน้าและปกหลังพร้อมใช้');
  else warn('cover', 'ยังไม่มี prompt ปก', 'สั่งสร้างทิศทางภาพได้ในแท็บปก');

  const geo = coverGeometry({
    trimWmm: book.trim.widthMm,
    trimHmm: book.trim.heightMm,
    pages,
    paper: book.paper || 'white',
    bleedMm: book.trim.bleedMm || 3,
  });
  if (geo.spineTextAllowed) ok('spine', `สันกว้าง ${geo.spineMm.toFixed(1)} มม. ใส่ตัวหนังสือบนสันได้`);
  else
    warn(
      'spine',
      `สันกว้างเพียง ${geo.spineMm.toFixed(1)} มม.`,
      'บางเกินกว่าจะใส่ตัวหนังสือบนสัน เพราะการเข้าเล่มคลาดได้ราว 1.6 มม.',
    );

  if ((book.backMatter || []).includes('about_author')) {
    const bio = (book.aboutAuthor || '').trim();
    if (bio.length >= 40)
      ok('about', `หน้าเกี่ยวกับผู้เขียนมีข้อมูลที่คุณกรอกเอง ${bio.length} ตัวอักษร`);
    else
      fail(
        'about',
        'เลือกใส่หน้าเกี่ยวกับผู้เขียน แต่ยังไม่ได้กรอกข้อมูล',
        'ระบบไม่แต่งประวัติคนจริงให้เอง เพราะจะได้วุฒิ รางวัล และตำแหน่งที่ไม่มีอยู่จริง — กรอกเองในหน้าตั้งค่า หรือเอาหน้านี้ออก',
      );
  }

  if (book.language === 'th') {
    warn(
      'textlayer',
      'ไฟล์ PDF จะคัดลอกและค้นหาข้อความภาษาไทยไม่ได้',
      'ภาพที่พิมพ์ออกมาถูกต้องทุกตัวอักษร แต่ชั้นข้อความข้างในเพี้ยน เป็นข้อจำกัดของ Typst กับภาษาไทย ' +
        '(เจอทั้งรุ่น 0.13 และ 0.14) กระทบเฉพาะการคัดลอก ค้นหาในไฟล์ และโปรแกรมอ่านออกเสียง ' +
        'ถ้าผู้อ่านต้องค้นหาข้อความได้ ให้แจก EPUB ควบคู่ไปด้วย ซึ่งเป็นข้อความจริงทั้งหมด',
    );
  }

  if (book.outline?.title && book.author) ok('meta', 'เมทาดาทาครบ');
  else warn('meta', 'เมทาดาทายังไม่ครบ', 'ควรใส่ชื่อผู้เขียนก่อนส่งออก');

  return {
    checks: r,
    blocking: r.filter((x) => x.level === 'fail').length,
    warnings: r.filter((x) => x.level === 'warn').length,
    geo,
  };
}
