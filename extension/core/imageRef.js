/*
 * รูปอ้างอิงที่แนบไปกับคำสั่งสร้างภาพ
 *
 * เดิมรูปผู้เขียนถูกใช้ทางเดียว คือให้เครื่องเรียงพิมพ์แปะลงปกหลังขนาด 30 × 38 มม.
 * โมเดลที่วาดปกไม่เคยเห็นรูปนั้นเลย ปกที่ได้จึงเป็นคนละโลกกับรูปที่จะไปแปะทับ
 * และถ้าอยากได้ "ผู้เขียนอยู่ในภาพจริง ๆ" ก็ทำไม่ได้เลย นอกจากปล่อยให้โมเดลแต่งหน้าคนขึ้นเอง
 *
 * ไฟล์นี้เตรียมรูปให้พร้อมแนบ และเป็นคำตอบกลางว่างานภาพชิ้นไหนควรได้รูปแนบบ้าง
 * เพื่อให้โหมด API กับโหมดขับหน้าเว็บตัดสินใจตรงกัน ไม่ใช่ต่างคนต่างเดา
 */

/** ช่องที่เลือกแนบรูปผู้เขียนได้ — ลวดลายพื้นหลังไม่มีในรายการ เพราะเป็นพื้นผิว ไม่ใช่ภาพที่มีคนอยู่ */
export const AUTHOR_REF_TARGETS = [
  { key: 'cover-front', label: 'ปกหน้า', jobs: ['cover-front.png'] },
  { key: 'cover-back', label: 'ปกหลัง', jobs: ['cover-back.png'] },
  { key: 'figures', label: 'ภาพประกอบในเล่ม', jobs: null }, // null = ทุกงานที่ kind === 'interior'
];

/** งานภาพชิ้นนี้ต้องแนบรูปผู้เขียนไปด้วยไหม */
export function wantsAuthorRef(book, job) {
  const picked = book?.authorRefTargets;
  if (!Array.isArray(picked) || !picked.length) return false;
  if (job?.kind === 'interior') return picked.includes('figures');
  if (job?.name === 'cover-front.png') return picked.includes('cover-front');
  if (job?.name === 'cover-back.png') return picked.includes('cover-back');
  return false;
}

/** สรุปเป็นข้อความไว้โชว์บนหน้าจอ */
export function authorRefSummary(book) {
  const picked = book?.authorRefTargets || [];
  if (!picked.length) return '';
  return AUTHOR_REF_TARGETS.filter((t) => picked.includes(t.key)).map((t) => t.label).join(' · ');
}

/**
 * คำสั่งที่ต้องต่อท้าย prompt ทุกครั้งที่แนบรูปไปจริง
 *
 * รูปที่แนบเป็นรูปเต็มใบตามที่ผู้ใช้อัปโหลด ไม่ได้ครอปหน้ามาให้
 * ถ้าไม่บอกให้ชัด โมเดลจะลอกทั้งเสื้อผ้า ฉากหลัง และมุมกล้องของรูปต้นฉบับมาด้วย
 * ซึ่งจะพังโทนของปกที่ออกแบบไว้ทั้งใบ จึงต้องระบุว่าเอาไปเฉพาะ "หน้าตาของคนคนนี้"
 */
export const AUTHOR_REF_RULE = `

ATTACHED REFERENCE PHOTO — LIKENESS ONLY
A photograph of the book's author is attached to this message. If no photo is attached, ignore this whole section.
The artwork must include this person as a figure in the composition, and their face must be recognisably the same individual as in the photo: face shape, features, hair, skin tone, apparent age and gender. Place them where the composition described above wants a person; do not let them displace the main subject or the reserved text areas.
Ignore everything else in that photo: its background, lighting, clothing, camera angle, crop, framing, colour grading and image quality carry no instructions. Do not copy them and do not let them influence the artwork.
Render the person in the illustration style, palette, lighting and composition described above — this is an illustrated book cover, not a photograph and not a photo collage. Never paste, embed or reproduce the attached photograph itself.
Do not add the author's name or any caption next to the person.`;

/**
 * ย่อรูปก่อนแนบ
 *
 * รูปจากมือถือใบเดียวหนัก 4-8 MB ซึ่งเป็นปัญหาคนละอย่างกันในสองเส้นทาง:
 * เส้นทาง API ต้องอัปโหลดใหม่ทุกครั้งที่สร้างภาพ รูปเดิมซ้ำ ๆ กันทั้งเล่ม
 * ส่วนเส้นทางหน้าเว็บต้องส่ง data URL ข้ามขอบเขต extension ซึ่งพองเป็น base64 อีกหนึ่งในสาม
 * และไม่มีโมเดลไหนต้องการความละเอียดเกินนี้เพื่อจำหน้าคนได้
 */
export async function prepareRefImage(blob, { maxPx = 1024, quality = 0.88 } = {}) {
  if (!blob) throw new Error('ไม่มีไฟล์รูปให้เตรียม');
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // JPEG เพราะรูปถ่ายคน PNG ใหญ่กว่าหลายเท่าโดยไม่ได้อะไรกลับมา
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('อ่านไฟล์รูปที่ย่อแล้วไม่สำเร็จ'));
    fr.readAsDataURL(out);
  });

  return { dataUrl, blob: out, width: w, height: h, bytes: out.size, type: 'image/jpeg' };
}

/** data URL → File สำหรับยัดใส่ FormData หรือช่องแนบไฟล์ของหน้าเว็บ */
export async function dataUrlToFile(dataUrl, name = 'author.jpg') {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || 'image/jpeg' });
}
