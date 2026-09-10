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
    // ขั้นล่าสุดที่ไปถึง = หลักฐานว่าคำสั่งออกจากเครื่องเราไปแล้วหรือยัง ตอนหมดเวลาต้องใช้ตัวนี้ตัดสิน
    if (msg.phase) p.lastPhase = msg.phase;
    // Reply time starts after acceptance, not while loading or uploading.
    if (msg.phase === 'waiting' && !p.answerStarted) {
      p.answerStarted = true;
      clearTimeout(p.timer);
      p.timer = setTimeout(p.expire, p.answerBudget);
    }
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

/**
 * หมดเวลาแล้วเกิดอะไรขึ้นจริง — ถามหน้าเว็บ ไม่ใช่เดาจากขั้นล่าสุดที่ได้ยิน
 *
 * เคยคิดว่าขั้นล่าสุดตอบได้ว่าส่งไปหรือยัง (ค้างที่ "พิมพ์ Prompt" = ยังไม่ส่ง) แต่ผิด:
 * ช่องทางส่งข้อความความคืบหน้าขาดได้เอง พอขาดแล้วขั้นล่าสุดจะค้างอยู่ที่ก่อนส่งตลอด
 * ทั้งที่ ChatGPT รับงานไปทำจนจบแล้ว — เห็นจริงจากคำตอบเต็ม ๆ ที่อยู่บนจอ
 * ขณะที่บันทึกบอกว่ายังค้างที่ขั้นพิมพ์มา 590 วินาที การเดาจากขั้นจึงพาไปส่งซ้ำได้
 *
 * ตัวหน้าเว็บรู้แน่นอนทั้งสามข้อ: เก็บผลไว้แล้วหรือเปล่า · ยังทำอยู่ไหม · ข้อความของเราขึ้นไปหรือยัง
 * ถามมันแล้วค่อยตัดสิน ถามไม่ได้ = ตอบไม่ได้ ต้องระวังไว้ก่อน
 */
async function probeTurn(turnId, prompt) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({ type: 'sw.recoverTurn', turnId, prompt }),
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ]);
  } catch {
    return null;
  }
}

const PHASE_LABEL = {
  waiting_ready: 'รอหน้า ChatGPT พร้อม',
  new_thread: 'เปิดห้องแชตใหม่',
  new_thread_failed: 'เปิดห้องแชตใหม่ไม่สำเร็จ',
  waiting_idle: 'รอเทิร์นก่อนหน้าจบ',
  attaching: 'แนบไฟล์',
  typing: 'พิมพ์ Prompt ลงช่อง',
};

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
    this.lastTurnId = turnId;
    const answerTimeoutMs = opts.timeoutMs ?? this.timeoutMs;
    // เทิร์นที่ขอภาพต้องรอ "ตอบข้อความ" จบก่อน แล้วค่อยรอภาพเรนเดอร์ต่อ (adapter รอสองช่วงต่อกัน)
    // เดิม timer รอบนอกนี้ใช้ answerTimeoutMs อย่างเดียว จึงตัดจบก่อน adapter จะรอภาพเสร็จ
    // ทำให้เทิร์นสร้างภาพ (โดยเฉพาะภาพที่ 2 เป็นต้นไปในแชทเดียวกัน เช่นปกหลัง) ถูกนับว่า timeout ทั้งที่ยังทำงานอยู่จริง
    const imageTimeoutMs = opts.wantImages ? (opts.imageTimeoutMs ?? 240000) : 0;
    // แนบไฟล์คือการอัปโหลดจริงผ่านหน้าเว็บ ต้องเผื่อเวลาให้ ไม่งั้นเทิร์นที่แนบรูปจะถูกตัดจบทั้งที่กำลังอัปโหลดอยู่
    const attachMs = opts.attachments?.length ? 45000 : 0;
    // เปิดให้ตั้งค่าได้ เพื่อให้ทดสอบพฤติกรรมตอนหมดเวลาได้จริงโดยไม่ต้องรอสิบนาที
    const outerTimeoutMs = (opts.outerTimeoutMs ?? 600000) + attachMs; // bounded preparation, including an existing busy turn
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const complete = (result) => resolve({...result, meta:{...result.meta, elapsedMs:Date.now()-startedAt}});
      const expire = () => {
        const p = pending.get(turnId);
        pending.delete(turnId);
        /**
         * หมดเวลาแล้ว "ส่งไปหรือยัง" — คำตอบอยู่ที่ขั้นล่าสุดที่ไปถึง ไม่ใช่คำถามที่ตอบไม่ได้
         *
         * เดิมเหมาว่าไม่รู้ทั้งหมด แล้วติดรหัส outcome_unknown ซึ่งเป็นรหัสเดียวในระบบที่
         * ห้ามลองใหม่เด็ดขาด (อาจส่งไปแล้ว การส่งซ้ำจะได้งานซ้อน) ทุกตัวกู้จึงถูกกันหมด
         * ทั้งการเปิดห้องใหม่ การโหลดแท็บใหม่ และผู้คุมกระบวนการ — งานหยุดตรงนั้นเสมอ
         *
         * แต่ขั้นอย่าง "พิมพ์ Prompt ลงช่อง" เกิดก่อนกดส่งทั้งหมด ค้างตรงนั้นแปลว่า
         * ข้อความยังอยู่ในช่องพิมพ์ ไม่เคยออกไปไหน ไม่มีอะไรกำกวมให้ต้องระวังเลย
         * เหมารวมจึงเป็นการทิ้งหลักฐานที่เรามีอยู่ในมือ แล้วหยุดงานทั้งที่กู้ได้ปลอดภัย
         *
         * ไม่เคยได้ยินอะไรเลย (ไม่มีขั้นล่าสุด) ยังถือว่าไม่รู้ตามเดิม เพราะอาจเป็นได้ว่า
         * เทิร์นเดินไปแล้วแต่ข้อความความคืบหน้าหายระหว่างทาง — ตรงนั้นต้องระวังไว้ก่อน
         */
        const phase = p?.lastPhase || '';
        const where = PHASE_LABEL[phase] || phase || 'ไม่ทราบขั้น';
        probeTurn(turnId, prompt).then((found) => {
          /**
           * ผลอยู่ที่แท็บอยู่แล้ว แค่ข้อความแจ้งผลหายระหว่างทาง — เอากลับมาใช้ ไม่ต้องสั่งใหม่
           * นี่คือเทิร์นที่จ่ายโควตาไปแล้วและทำงานสำเร็จแล้ว การทิ้งมันคือการจ่ายซ้ำเปล่า ๆ
           */
          if (found?.state === 'done' && found.result) {
            complete({ ...found.result, meta: { ...found.result.meta, recoveredAfterTimeout: true } });
            return;
          }
          if (found?.state === 'not_sent') {
            complete({ turnId, status: 'error', text: '', meta: {
              error: 'prompt_not_sent',
              stuckPhase: phase,
              detail: `ค้างที่ขั้น "${where}" จนหมดเวลา · ถามแท็บแล้วไม่มีข้อความของเราบนหน้าเลย — ยังไม่เคยส่ง ลองใหม่ได้โดยไม่มีงานซ้อน`,
            } });
            return;
          }
          const why = found?.state === 'running'
            ? 'แท็บบอกว่ายังทำเทิร์นนี้อยู่'
            : found?.state === 'sent_unknown'
              ? 'ข้อความของเราขึ้นไปบนหน้าแล้วแต่ยังไม่ได้ผลกลับมา'
              : 'ถามแท็บไม่ได้';
          complete({ turnId, status: 'timeout', text: '', meta: {
            error: 'outcome_unknown',
            stuckPhase: phase,
            detail: `ค้างที่ขั้น "${where}" จนหมดเวลา · ${why} — ยังไม่ส่งซ้ำเพื่อป้องกันงานซ้อน`,
          } });
        });
      };
      const timer = setTimeout(expire, outerTimeoutMs);

      pending.set(turnId, { resolve:complete, timer, expire, answerBudget:(opts.wantImages ? imageTimeoutMs : answerTimeoutMs)+attachMs+30000, onProgress: this.onProgress });

      chrome.runtime
        .sendMessage({
          type: 'sw.runTurn',
          turnId,
          prompt,
          opts: {
            newThread: !!opts.newThread,
            wantImages: !!opts.wantImages,
            expectedJsonKeys: opts.expectedJsonKeys,
            recoverCompletedSetup: !opts.wantImages && opts.recoverCompletedSetup !== false,
            expectModel: opts.expectModel ?? this.expectModel,
            timeoutMs: answerTimeoutMs,
            imageTimeoutMs: opts.wantImages ? imageTimeoutMs : undefined,
            // รูปอ้างอิงที่ต้องแนบเข้าช่องพิมพ์ก่อนส่ง — ส่งเป็น data URL เพราะ Blob ข้ามขอบเขต extension ไม่ได้
            attachments: opts.attachments?.length ? opts.attachments : undefined,
          },
        })
        .then((ack) => {
          if (!ack?.ok) {
            clearTimeout(pending.get(turnId)?.timer);
            pending.delete(turnId);
            resolve({ turnId, status: 'error', text: '', meta: { error: ack?.error } });
          }
        })
        .catch((e) => {
          clearTimeout(pending.get(turnId)?.timer);
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
