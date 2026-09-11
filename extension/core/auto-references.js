// Bounded search expansion; a model can select only DOI records actually retrieved.
export async function collectReferences({query,selected=[],minimum=5,search,choose,onProgress=()=>{},maxSearches=6}) {
  const accepted=new Map(selected.map(s=>[s.doi,s]));
  const seen=new Set(accepted.keys()), searched=new Set(), queue=[query];
  let searches=0;
  while(accepted.size<minimum && queue.length && searches<maxSearches) {
    const next=queue.shift().trim();
    if(!next || searched.has(next.toLowerCase())) continue;
    searched.add(next.toLowerCase()); searches++;
    onProgress([...accepted.values()],`ค้นเพิ่มรอบ ${searches}/${maxSearches}: ${next} · ได้ ${accepted.size}/${minimum} แหล่ง`);
    /**
     * ค้นรอบหนึ่งล้ม ต้องข้ามไปคำค้นถัดไป ไม่ใช่ล้มทั้งงาน
     *
     * ตัวค้นคุยกับบริการภายนอก (Crossref) ซึ่งช้าและล่มได้เป็นปกติ
     * เดิมข้อผิดพลาดของรอบเดียวถูกโยนขึ้นไปจนหยุดการสร้างหนังสือทั้งเล่มกลางทาง
     * ทั้งที่บรรณานุกรมเป็นของเสริม และแหล่งที่คัดได้ก่อนหน้านั้นยังอยู่ครบ
     * (เห็นจริง: หยุดที่วินาทีที่ 26 หลังได้คำค้นใหม่มา ตรงกับเพดานเวลา 25 วินาทีพอดี)
     */
    let found;
    try {
      found=(await search(next)).filter(s=>s.abstract?.length>=100 && !seen.has(s.doi));
    } catch (e) {
      onProgress([...accepted.values()],`ค้นรอบ ${searches} ไม่สำเร็จ (${e?.message || e}) — ข้ามไปคำค้นถัดไป · เก็บ ${accepted.size}/${minimum} แหล่งที่คัดได้แล้วไว้`);
      continue;
    }
    found.forEach(s=>seen.add(s.doi));
    const result=await choose(found,{selected:[...accepted.keys()],remaining:minimum-accepted.size,queries:[...searched]});
    const dois=Array.isArray(result?.dois)?result.dois:[];
    for(const s of found) if(dois.includes(s.doi)) accepted.set(s.doi,{...s,reviewed:true,reviewedBy:'automatic-abstract-review'});
    onProgress([...accepted.values()],`เก็บแหล่งที่คัดแล้ว ${accepted.size}/${minimum} แหล่ง`);
    let moreQueries=Array.isArray(result?.queries)?result.queries:[];
    if(accepted.size<minimum && !moreQueries.length && !queue.length && searches<maxSearches) {
      // Older responses sometimes contain only DOI selections. Keep those selections
      // and ask for search terms separately rather than aborting the run.
      const expansion=await choose([],{selected:[...accepted.keys()],remaining:minimum-accepted.size,queries:[...searched],searchOnly:true});
      moreQueries=Array.isArray(expansion?.queries)?expansion.queries:[];
    }
    for(const q of moreQueries.slice(0,3)) {
      if(typeof q==='string' && q.trim() && !searched.has(q.trim().toLowerCase())) queue.push(q.trim().slice(0,200));
    }
    onProgress([...accepted.values()],`คัดจากบทคัดย่อแล้ว ${accepted.size}/${minimum} แหล่ง${accepted.size<minimum?' · กำลังค้นต่อ':''}`);
  }
  return {sources:[...accepted.values()],searches};
}
