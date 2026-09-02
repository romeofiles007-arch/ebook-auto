/*
 * สร้างภาพผ่าน OpenAI Images API — ทางเลือกแทนการขับหน้าเว็บ ChatGPT
 *
 * ทำไมถึงต้องมีทางนี้:
 * การขับหน้าเว็บต้องพึ่งช่องพิมพ์ ปุ่มส่ง ตัวตรวจจับว่าตอบจบ และการคว้าภาพจาก DOM
 * ทุกชิ้นเป็นการเดาจากหน้าตาเว็บที่ OpenAI เปลี่ยนเมื่อไรก็ได้ และเป็นต้นเหตุของ
 * อาการค้าง ส่งไม่ออก เก็บภาพไม่ทัน ที่ไล่แก้กันไม่จบ
 *
 * ทางนี้ไม่มีหน้าเว็บมาเกี่ยวข้องเลย ส่ง HTTP ไปแล้วได้ไฟล์ภาพกลับมาเป็น base64
 * ตรง ๆ สำเร็จหรือล้มเหลวรู้ผลทันทีพร้อมเหตุผลจากเซิร์ฟเวอร์
 *
 * ใช้เฉพาะกับภาพ ส่วนการเขียนเนื้อหายังใช้หน้าเว็บเหมือนเดิม เพราะข้อความคือส่วนที่
 * กินโควตาจริงและเป็นเหตุผลทั้งหมดที่โปรเจกต์นี้เลือกขับหน้าเว็บตั้งแต่แรก
 */

const ENDPOINT = 'https://api.openai.com/v1/images/generations';

/**
 * ขนาดที่ gpt-image-1 วาดได้จริงมีสามแบบเท่านั้น
 * เลือกแบบที่ใกล้กับช่องจริงที่สุด แล้วปล่อยให้ขั้นปรับขนาดครอปให้พอดีทีหลัง
 */
export function pickApiSize(widthMm, heightMm) {
  const ratio = (Number(widthMm) || 1) / (Number(heightMm) || 1);
  if (ratio < 0.9) return '1024x1536'; // แนวตั้ง เช่นปก
  if (ratio > 1.1) return '1536x1024'; // แนวนอน เช่นภาพในเล่ม
  return '1024x1024';
}

/** ชื่อโมเดลที่ตั้งเป็นค่าเริ่มต้น เปลี่ยนได้จากหน้าจอ */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

/** อ่านข้อความบอกเหตุจากเซิร์ฟเวอร์ให้ตรงที่สุดเท่าที่มันส่งมา */
function apiErrorMessage(status, body) {
  const detail = body?.error?.message || body?.message || '';
  /**
   * ชื่อโมเดลผิดเป็นความผิดพลาดที่แก้ง่ายที่สุดแต่หาเจอยากที่สุด
   * ถ้าปล่อยข้อความดิบของเซิร์ฟเวอร์ไป ผู้ใช้จะไปนั่งเช็คคีย์กับเครดิตแทน
   */
  if (/model/i.test(detail) && /not (found|exist)|does not exist|unknown|invalid/i.test(detail))
    return `ไม่มีโมเดลชื่อนี้ในบัญชี — เปลี่ยนชื่อโมเดลในช่องข้าง ๆ คีย์ (${detail})`;
  if (status === 401) return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจคีย์ในหน้าตั้งค่า';
  if (status === 403) return `บัญชีนี้ยังไม่ได้รับสิทธิ์สร้างภาพ${detail ? ` (${detail})` : ''}`;
  if (status === 429) return `ยิงถี่เกินไปหรือเครดิตหมด — ${detail || 'ลองใหม่อีกครั้งในอีกสักครู่'}`;
  if (status >= 500) return `เซิร์ฟเวอร์ OpenAI ขัดข้อง (${status})${detail ? ` — ${detail}` : ''}`;
  return detail || `เรียก API ไม่สำเร็จ (HTTP ${status})`;
}

/**
 * @returns {Promise<{dataUrl:string, size:string, bytes:number}>}
 * โยน Error พร้อมข้อความภาษาคนเมื่อไม่สำเร็จ
 */
export async function generateImage({
  apiKey,
  prompt,
  widthMm,
  heightMm,
  quality = 'medium',
  model = DEFAULT_IMAGE_MODEL,
  timeoutMs = 180000,
}) {
  if (!apiKey) throw new Error('ยังไม่ได้ใส่ OpenAI API key');
  if (!String(prompt || '').trim()) throw new Error('ไม่มีคำสั่งภาพให้ส่ง');

  const size = pickApiSize(widthMm, heightMm);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, prompt: String(prompt), size, quality, n: 1 }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') throw new Error(`สร้างภาพนานเกิน ${Math.round(timeoutMs / 1000)} วินาที`);
    throw new Error(`ต่อ API ไม่ได้: ${e?.message || e}`);
  }
  clearTimeout(timer);

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* บางกรณีเซิร์ฟเวอร์คืน HTML มา ปล่อยให้ตัวจัดข้อความข้างล่างจัดการ */
  }
  if (!res.ok) throw new Error(apiErrorMessage(res.status, body));

  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('API ตอบกลับมาแต่ไม่มีไฟล์ภาพอยู่ในคำตอบ');

  return {
    dataUrl: `data:image/png;base64,${b64}`,
    size,
    model,
    quality,
    // ประมาณขนาดไฟล์จากความยาว base64 พอให้รายงานได้ ไม่ต้องถอดรหัสทั้งก้อน
    bytes: Math.round((b64.length * 3) / 4),
    /**
     * จำนวน token ที่เซิร์ฟเวอร์คิดเงินจริงของภาพนี้
     *
     * ราคาภาพคิดเป็น token ไม่ใช่ต่อรูป และจำนวนขึ้นกับขนาดกับคุณภาพ
     * การเดาจากตารางจึงคลาดเคลื่อนเสมอ ถ้าเซิร์ฟเวอร์บอกมาก็ใช้ของจริงไปเลย
     */
    usage: body?.usage
      ? {
          inputTokens: body.usage.input_tokens ?? null,
          outputTokens: body.usage.output_tokens ?? null,
        }
      : null,
  };
}

/** ทดสอบว่าคีย์กับชื่อโมเดลใช้ได้จริงด้วยภาพเล็กที่สุด ก่อนปล่อยให้รันทั้งเล่ม */
export async function testKey(apiKey, model = DEFAULT_IMAGE_MODEL) {
  const r = await generateImage({
    apiKey,
    model,
    prompt: 'a plain light grey square, flat, no text',
    widthMm: 100,
    heightMm: 100,
    quality: 'low',
    timeoutMs: 90000,
  });
  return { ok: true, size: r.size, bytes: r.bytes, model };
}
