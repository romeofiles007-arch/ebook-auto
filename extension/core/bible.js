/**
 * Book Bible — ความจำที่เราถือเอง ไม่ใช่ความจำของเธรด ChatGPT
 *
 * เพราะเราสลับเธรดทุกบท (เธรดยาวจะช้าลงและ drift) ความจริงทั้งหมดจึงต้องอยู่ฝั่งเรา
 * นี่คือสิ่งเดียวที่ทำให้หนังสือ 48 ตอนเป็นเล่มเดียวกัน ไม่ใช่บทความ 48 ชิ้น
 */

export function emptyBible() {
  return {
    voiceCard: '',
    glossary: [], // {term, def, firstSeenIn}
    usedExamples: [], // string
    openPromises: [], // string
    sectionSummaries: {}, // id -> string
    chapterSummaries: [], // index = chapter n-1
    // Story Bible สำหรับโหมดนิยาย — โหมด non-fiction ปล่อยว่างได้โดยไม่กระทบของเดิม
    characters: [],
    worldFacts: [],
    timeline: [],
    openThreads: [],
    relationships: [],
  };
}

/** ดูดข้อมูลจากบล็อก META ที่โมเดลส่งกลับมาพร้อมเนื้อหา */
export function absorb(bible, sectionId, meta) {
  if (!meta) return bible;
  bible.characters ||= [];
  bible.worldFacts ||= [];
  bible.timeline ||= [];
  bible.openThreads ||= [];
  bible.relationships ||= [];
  bible.sectionSummaries ||= {};

  if (meta.summary) bible.sectionSummaries[sectionId] = String(meta.summary).trim();

  for (const t of meta.new_terms || []) {
    const term = typeof t === 'string' ? t : t.term;
    const def = typeof t === 'string' ? '' : t.def || '';
    if (!term) continue;
    if (!bible.glossary.some((g) => g.term === term)) {
      bible.glossary.push({ term, def, firstSeenIn: sectionId });
    }
  }

  for (const e of meta.examples || []) {
    const s = String(e).trim();
    if (s && !bible.usedExamples.includes(s)) bible.usedExamples.push(s);
  }

  for (const p of meta.promises || []) {
    const s = String(p).trim();
    if (s && !bible.openPromises.includes(s)) bible.openPromises.push(s);
  }

  // คำสัญญาที่เพิ่งจ่ายคืน ให้ตัดออกจากรายการค้าง
  for (const p of meta.paid || []) {
    const s = String(p).trim().toLowerCase();
    bible.openPromises = bible.openPromises.filter((x) => x.trim().toLowerCase() !== s);
  }

  // Story Bible: อัปเดต canon ของนิยายจาก META โดยยัง backward-compatible กับ non-fiction
  for (const upd of meta.character_updates || []) {
    if (!upd) continue;
    if (typeof upd === 'string') {
      if (!bible.characters.some((c) => (typeof c === 'string' ? c : c?.name) === upd)) bible.characters.push(upd);
      continue;
    }
    const name = String(upd.name || '').trim();
    if (!name) continue;
    const at = bible.characters.findIndex((c) => typeof c === 'object' && String(c?.name || '').trim() === name);
    if (at >= 0) bible.characters[at] = { ...bible.characters[at], ...upd };
    else bible.characters.push(upd);
  }

  const addUnique = (arr, values) => {
    for (const value of values || []) {
      const key = typeof value === 'string' ? value.trim() : JSON.stringify(value);
      if (!key) continue;
      if (!arr.some((x) => (typeof x === 'string' ? x.trim() : JSON.stringify(x)) === key)) arr.push(value);
    }
  };
  addUnique(bible.worldFacts, meta.world_facts);
  addUnique(bible.timeline, meta.timeline);
  addUnique(bible.openThreads, meta.open_threads);
  addUnique(bible.relationships, meta.relationship_updates);

  for (const resolved of meta.resolved_threads || []) {
    const key = typeof resolved === 'string' ? resolved.trim().toLowerCase() : JSON.stringify(resolved).toLowerCase();
    bible.openThreads = bible.openThreads.filter((x) => {
      const xKey = typeof x === 'string' ? x.trim().toLowerCase() : JSON.stringify(x).toLowerCase();
      return xKey !== key;
    });
  }

  // กันไม่ให้ primer บวมจนกินเทิร์น — เก็บของใหม่ล่าสุดไว้
  bible.usedExamples = bible.usedExamples.slice(-40);
  bible.glossary = bible.glossary.slice(-60);
  bible.openPromises = bible.openPromises.slice(-20);
  bible.characters = bible.characters.slice(-40);
  bible.worldFacts = bible.worldFacts.slice(-80);
  bible.timeline = bible.timeline.slice(-80);
  bible.openThreads = bible.openThreads.slice(-50);
  bible.relationships = bible.relationships.slice(-50);

  return bible;
}

/** สรุปสามตอนก่อนหน้า สำหรับใส่ในคำสั่งเขียนตอนถัดไป */
export function prevSummaries(bible, outline, sectionId, n = 3) {
  const flat = outline.chapters.flatMap((c) => c.sections.map((s) => s.id));
  const at = flat.indexOf(sectionId);
  if (at <= 0) return [];
  return flat
    .slice(Math.max(0, at - n), at)
    .map((id) => bible.sectionSummaries[id])
    .filter(Boolean);
}

/** คำสัญญาที่ควรจ่ายคืนในบทนี้ */
export function promisesDue(bible, chapter) {
  if (!bible.openPromises.length) return [];
  const key = String(chapter.n);
  return bible.openPromises.filter((p) => p.includes(key) || p.includes(chapter.title));
}

export function setChapterSummary(bible, n, summary) {
  bible.chapterSummaries[n - 1] = summary;
  return bible;
}
