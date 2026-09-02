// อ่านตาราง cmap จากไฟล์ TTF ตรง ๆ เพื่อรู้ว่าฟอนต์รองรับ codepoint ไหนบ้าง
import { readFile } from 'node:fs/promises';

export async function supportedCodepoints(path) {
  const buf = await readFile(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = dv.getUint16(4);
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    if (tag === 'cmap') cmapOff = dv.getUint32(p + 8);
  }
  if (!cmapOff) throw new Error('ไม่พบตาราง cmap');

  const n = dv.getUint16(cmapOff + 2);
  let best = 0;
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    const plat = dv.getUint16(rec), enc = dv.getUint16(rec + 2), off = dv.getUint32(rec + 4);
    if ((plat === 3 && (enc === 1 || enc === 10)) || plat === 0) best = cmapOff + off;
  }
  const set = new Set();
  const fmt = dv.getUint16(best);
  if (fmt === 4) {
    const segX2 = dv.getUint16(best + 6);
    const seg = segX2 / 2;
    const endO = best + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let i = 0; i < seg; i++) {
      const end = dv.getUint16(endO + i * 2), start = dv.getUint16(startO + i * 2);
      const delta = dv.getInt16(deltaO + i * 2), ro = dv.getUint16(rangeO + i * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else {
          const gi = rangeO + i * 2 + ro + (c - start) * 2;
          if (gi + 1 >= buf.length) continue;
          g = dv.getUint16(gi);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) set.add(c);
      }
    }
  } else if (fmt === 12) {
    const groups = dv.getUint32(best + 12);
    for (let i = 0; i < groups; i++) {
      const g = best + 16 + i * 12;
      const s = dv.getUint32(g), e = dv.getUint32(g + 4);
      for (let c = s; c <= e && c - s < 70000; c++) set.add(c);
    }
  } else throw new Error('รูปแบบ cmap ที่ยังไม่รองรับ: ' + fmt);
  return set;
}
