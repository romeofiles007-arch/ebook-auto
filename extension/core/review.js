/**
 * แปลผลตรวจของบรรณาธิการให้เป็นรายการที่ "เปิดดูได้" และ "คลิกไปแก้ได้"
 *
 * ขั้น consistency จ่ายไปหนึ่งเทิร์นต่อหนึ่งบท ได้ผลตรวจกลับมาเป็น JSON ครบ
 * แล้วเก็บลง book.review[บท] — แต่เดิมไม่มีหน้าจอไหนอ่านกลับมาแสดงเลย
 * ผู้ใช้จึงเห็นแค่บรรทัด "บทที่ 8: พบ 13 ประเด็นที่ควรดู" วิ่งผ่านไปในบันทึกงาน
 * แล้วไม่มีทางรู้ว่า 13 ประเด็นนั้นคืออะไร อยู่ตอนไหน ต้องแก้ยังไง
 * เท่ากับจ่ายค่าตรวจครบทุกบท แต่ไม่ได้ผลตรวจไปใช้จริง
 *
 * ไฟล์นี้ไม่ยุ่งกับ DOM และไม่ยุ่งกับฐานข้อมูล เพื่อให้หน้าจอไหนก็หยิบไปแสดงได้
 */

/** โมเดลตอบกลับมาเป็นข้อความบ้าง เป็นอ็อบเจกต์บ้าง — ต้องอ่านออกทั้งสองแบบ ไม่ใช่โชว์ [object Object] */
const asText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v !== 'object') return String(v);
  const parts = [v.what, v.problem, v.why, v.text, v.detail, v.note].filter((x) => typeof x === 'string' && x.trim());
  return parts.length ? parts.join(' · ') : JSON.stringify(v);
};

/** id ตอนเขียนเป็น "8.4" เสมอ — บทคือตัวเลขหน้าจุด */
const chapterOf = (sectionId) => String(sectionId || '').split('.')[0] || '';

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * สี่ประเภทที่ machine.js นับเป็น "ประเด็นที่ควรดู"
 * ต้องตรงกับที่นับไว้ตอน log ไม่งั้นตัวเลขบนหน้าจอกับในบันทึกงานจะไม่ตรงกัน
 */
const COUNTED = ['duplicates', 'term_conflicts', 'continuity_issues', 'unpaid_promises'];

/**
 * แผ่ผลตรวจของหนึ่งบทเป็นรายการประเด็นเรียงเดี่ยว
 * @returns {{kind:string,label:string,section:string,text:string,fix:string,counted:boolean}[]}
 */
export function chapterIssues(review, chapterN) {
  if (!review) return [];
  const out = [];
  const push = (kind, label, section, text, fix = '') => {
    if (!text) return;
    out.push({ kind, label, section: section ? String(section) : '', text, fix, counted: COUNTED.includes(kind), chapter: String(chapterN ?? '') });
  };

  for (const d of list(review.duplicates)) {
    const other = d?.with ? `ซ้ำกับ ${d.with}` : 'ซ้ำกับที่อื่น';
    push('duplicates', 'เนื้อหาซ้ำ', d?.section, `${other} — ${asText(d) || 'ไม่ได้ระบุรายละเอียด'}`);
  }
  for (const t of list(review.term_conflicts)) {
    const term = typeof t === 'object' && t?.term ? `“${t.term}” ` : '';
    push('term_conflicts', 'ศัพท์ใช้ไม่ตรงกัน', '', `${term}${asText(t)}`);
  }
  for (const c of list(review.continuity_issues)) {
    const type = typeof c === 'object' && c?.type ? ` (${c.type})` : '';
    push('continuity_issues', `ความต่อเนื่อง${type}`, c?.section, asText(c), typeof c === 'object' ? asText(c?.fix) : '');
  }
  for (const p of list(review.unpaid_promises)) {
    push('unpaid_promises', 'ปมค้าง / คำสัญญาที่ยังไม่จ่ายคืน', typeof p === 'object' ? p?.section : '', asText(p));
  }

  // ข้อเสนอให้สลับลำดับไม่ถูกนับเป็นปัญหา เพราะเป็นความเห็นเรื่องการเรียบเรียง ไม่ใช่ข้อผิดพลาด
  // แต่ต้องแสดง เพราะจ่ายค่าถามไปแล้วเหมือนกัน
  for (const r of list(review.reorder)) {
    const move = r?.move ? `ย้าย ${r.move}` : 'สลับลำดับ';
    const before = r?.before ? ` ไปก่อน ${r.before}` : '';
    push('reorder', 'ข้อเสนอให้สลับลำดับ', r?.move, `${move}${before} — ${asText(r) || 'ไม่ได้ระบุเหตุผล'}`);
  }

  return out;
}

/**
 * รวมผลตรวจทั้งเล่ม เรียงตามเลขบท
 * @returns {{chapters:{n:string,issues:any[],counted:number,summary:string}[],total:number,totalCounted:number}}
 */
export function bookIssues(bookReview) {
  const chapters = Object.keys(bookReview || {})
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => {
      const issues = chapterIssues(bookReview[n], n);
      return {
        n: String(n),
        issues,
        counted: issues.filter((i) => i.counted).length,
        summary: asText(bookReview[n]?.chapter_summary),
      };
    })
    .filter((c) => c.issues.length);

  return {
    chapters,
    total: chapters.reduce((n, c) => n + c.issues.length, 0),
    totalCounted: chapters.reduce((n, c) => n + c.counted, 0),
  };
}

/**
 * ประเด็นที่ผูกกับตอนหนึ่ง ๆ โดยตรง — ใช้ติดป้ายในรายการตอน
 * @returns {Map<string, any[]>}
 */
export function issuesBySection(bookReview) {
  const map = new Map();
  for (const c of bookIssues(bookReview).chapters) {
    for (const i of c.issues) {
      if (!i.section) continue;
      if (!map.has(i.section)) map.set(i.section, []);
      map.get(i.section).push(i);
    }
  }
  return map;
}

/**
 * ประเด็นที่ควรเห็นตอนแก้ตอนนี้ = ของตอนนี้เอง บวกของทั้งบทที่ไม่ได้ระบุตอน
 * ศัพท์ที่ใช้ไม่ตรงกันมักไม่มีเลขตอนติดมา แต่คนที่กำลังแก้ตอนในบทนั้นคือคนที่ควรเห็น
 */
export function issuesForSection(bookReview, sectionId) {
  const ch = chapterOf(sectionId);
  const mine = [];
  const chapterWide = [];
  for (const c of bookIssues(bookReview).chapters) {
    if (c.n !== ch) continue;
    for (const i of c.issues) {
      if (i.section === String(sectionId)) mine.push(i);
      else if (!i.section) chapterWide.push(i);
    }
  }
  return { mine, chapterWide };
}
