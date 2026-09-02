/**
 * ขับ ChatGPT ผ่านแท็บจริง
 *
 * ออกแบบให้ทุกเทิร์นเป็นหน่วยที่ทำซ้ำได้และไม่มีผลข้างเคียง
 * เราไม่รอ promise ค้างยาวข้าม service worker (มันตายได้)
 * แต่ยิงคำสั่งไป แล้วรอข้อความ gpt.result วิ่งกลับมา พร้อมนาฬิกาจับตายของตัวเอง
 */

let seq = 0;

/**
 * ทะเบียนเทิร์นที่รอผลอยู่ ใช้ร่วมทั้งโมดูล
 *
 * เดิม constructor ของทุก instance ติด listener ใหม่อีกอันหนึ่งโดยไม่เคยถอดออก
 * หน้า Studio สร้าง transport ใหม่ทุกครั้งที่กดปุ่ม listener จึงพอกขึ้นเรื่อย ๆ จนเต็มหน้า
 */
const pending = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  const p = msg?.turnId ? pending.get(msg.turnId) : null;
  if (!p) return false;
  if (msg.type === 'gpt.result') {
    pending.delete(msg.turnId);
    clearTimeout(p.timer);
    p.resolve(msg);
  } else if (msg.type === 'gpt.progress') {
    p.onProgress(msg);
  }
  return false;
});

/**
 * มีเทิร์นไหนกำลังรอผลอยู่หรือเปล่า
 *
 * ใช้กันไม่ให้ข้อความความคืบหน้าที่มาช้ากว่าเทิร์นที่จบไปแล้ว ไปทับสถานะบนหน้าจอ
 * (อาการที่เจอ: อยู่หน้า "ตรวจ/แก้" รอคนตรวจอยู่ แต่แถบสถานะค้างว่า "กำลังรอ ChatGPT ตอบ")
 */
export const hasPendingTurn = () => pending.size > 0;

export class ChatGptTabTransport {
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 300000; // 5 นาทีต่อเทิร์น
    this.expectModel = opts.expectModel || '';
    this.onProgress = opts.onProgress || (() => {});
  }

  get kind() {
    return 'chatgpt_tab';
  }

  /**
   * @returns {Promise<{status:string,text:string,images?:string[],meta?:object}>}
   *  status: ok | empty | truncated | rate_limited | wrong_model | error | timeout
   */
  send(prompt, opts = {}) {
    const turnId = `t${Date.now().toString(36)}-${++seq}`;
    const answerTimeoutMs = opts.timeoutMs ?? this.timeoutMs;
    // เทิร์นที่ขอภาพต้องรอ "ตอบข้อความ" จบก่อน แล้วค่อยรอภาพเรนเดอร์ต่อ (adapter รอสองช่วงต่อกัน)
    // เดิม timer รอบนอกนี้ใช้ answerTimeoutMs อย่างเดียว จึงตัดจบก่อน adapter จะรอภาพเสร็จ
    // ทำให้เทิร์นสร้างภาพ (โดยเฉพาะภาพที่ 2 เป็นต้นไปในแชทเดียวกัน เช่นปกหลัง) ถูกนับว่า timeout ทั้งที่ยังทำงานอยู่จริง
    const imageTimeoutMs = opts.wantImages ? (opts.imageTimeoutMs ?? 240000) : 0;
    /**
     * เผื่อเวลาให้ด่าน "รอผู้ใช้กด Enter" ด้วย
     *
     * เมื่อกดส่งอัตโนมัติไม่ติด adapter จะค้าง Prompt ไว้แล้วรอคนกดเองสูงสุดสามนาที
     * ถ้า timer รอบนอกไม่เผื่อช่วงนี้ มันจะตัดจบก่อนที่ผู้ใช้จะทันได้กด
     * แล้วงานที่รอดได้กลายเป็น timeout ทั้งที่คนกำลังเดินไปกดอยู่พอดี
     */
    const handoffMs = opts.handoffMs ?? 180000;
    const outerTimeoutMs = answerTimeoutMs + imageTimeoutMs + handoffMs + 30000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(turnId);
        resolve({ turnId, status: 'timeout', text: '' });
      }, outerTimeoutMs);

      pending.set(turnId, { resolve, timer, onProgress: this.onProgress });

      chrome.runtime
        .sendMessage({
          type: 'sw.runTurn',
          turnId,
          prompt,
          opts: {
            newThread: !!opts.newThread,
            wantImages: !!opts.wantImages,
            expectModel: opts.expectModel ?? this.expectModel,
            timeoutMs: answerTimeoutMs,
            imageTimeoutMs: opts.wantImages ? imageTimeoutMs : undefined,
            handoffMs,
          },
        })
        .then((ack) => {
          if (!ack?.ok) {
            clearTimeout(timer);
            pending.delete(turnId);
            resolve({ turnId, status: 'error', text: '', meta: { error: ack?.error } });
          }
        })
        .catch((e) => {
          clearTimeout(timer);
          pending.delete(turnId);
          resolve({ turnId, status: 'error', text: '', meta: { error: String(e) } });
        });
    });
  }

  async health() {
    const result = await chrome.runtime.sendMessage({ type: 'sw.healthChat' }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
    return result?.ok ? result : { ok: false, error: result?.error || 'เชื่อมต่อ ChatGPT ไม่สำเร็จ' };
  }
}
