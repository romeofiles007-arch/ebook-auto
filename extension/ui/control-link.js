/**
 * ท่อคุมจากเครื่องตัวเอง — ให้คนที่นั่งอยู่หน้า terminal กดปุ่มของ Studio ได้
 *
 * ทำไมต้องมี: ปุ่มที่ต้องกดตอนงานสะดุดอยู่ใน Chrome ทั้งหมด ทั้งปุ่ม "ทำต่อ" ในหน้า Studio
 * และปุ่มรีโหลดส่วนขยายในหน้า chrome://extensions ซึ่งเป็นหน้าที่สคริปต์อะไรก็แตะไม่ได้
 * เวลาเล่มค้างกลางดึกจึงไม่มีทางอื่นเลยนอกจากรอให้คนมานั่งกดเอง — ซึ่งขัดกับทั้งระบบนี้
 * ที่ออกแบบมาให้เดินตอนไม่มีคนเฝ้า
 *
 * ท่อนี้กลับด้านการกด: Studio เป็นฝ่ายถามออกไปเองว่ามีคำสั่งอะไรค้างอยู่ไหม
 * จึงไม่ต้องเปิดพอร์ตอะไรในเบราว์เซอร์ และไม่ต้องให้ใครเข้ามาถึงหน้านี้ได้
 *
 * การเปิดใช้งานคือการ "สั่งให้เซิร์ฟเวอร์ตัวเล็กทำงาน" ไม่ใช่สวิตช์ในหน้าจอ:
 * ไม่มีอะไรฟังอยู่ที่ 127.0.0.1 = ไม่มีท่อ = ไม่มีใครสั่งอะไรได้ ซึ่งเป็นสภาพปกติของเครื่อง
 * เราจึงถามช้าลงมากเมื่อไม่มีใครรับสาย เพื่อไม่ให้เครื่องต้องทำงานเปล่าทั้งวัน
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';
/** มีคนรับสายอยู่ = ถามถี่ ๆ เพราะคำสั่งควรถึงภายในไม่กี่วินาที */
const FAST_MS = 3000;
/** ไม่มีใครรับสาย = เครื่องนี้ไม่ได้เปิดท่อไว้ ถามนาน ๆ ครั้งพอ */
const SLOW_MS = 30000;

export function startControlLink({ actions = {}, snapshot = () => ({}), endpoint = DEFAULT_ENDPOINT, onNote = () => {} } = {}) {
  let stopped = false;
  let busy = false;
  let online = false;
  /** ผลของคำสั่งล่าสุด ส่งติดไปกับการถามรอบถัดไป คนสั่งจะได้รู้ว่าที่สั่งไปเกิดอะไรขึ้นจริง */
  let pendingResult = null;

  const read = () => {
    try {
      return snapshot() || {};
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  };

  const tick = async () => {
    if (stopped) return;
    let nextDelay = online ? FAST_MS : SLOW_MS;
    try {
      const res = await fetch(`${endpoint}/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at: Date.now(), state: read(), result: pendingResult }),
      });
      pendingResult = null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      online = true;
      nextDelay = FAST_MS;
      const job = await res.json();
      /**
       * คำสั่งเดิมยังทำไม่เสร็จ ห้ามรับตัวใหม่ทับ
       * ปุ่มพวกนี้สั่งงานที่กินเวลาเป็นนาที การกดซ้ำระหว่างทางคือการมีเครื่องผลิตสองตัวทำเล่มเดียวกัน
       */
      if (job?.cmd && !busy) {
        busy = true;
        const started = Date.now();
        try {
          const run = actions[job.cmd];
          if (!run) throw new Error(`ไม่รู้จักคำสั่ง "${job.cmd}"`);
          onNote(`ท่อคุม: ${job.cmd}`);
          const detail = await run(job.args || {});
          pendingResult = { id: job.id, cmd: job.cmd, ok: true, detail: detail ?? '', ms: Date.now() - started };
        } catch (e) {
          pendingResult = { id: job.id, cmd: job.cmd, ok: false, detail: String(e?.message || e), ms: Date.now() - started };
        } finally {
          busy = false;
        }
      } else if (job?.cmd) {
        pendingResult = { id: job.id, cmd: job.cmd, ok: false, detail: 'คำสั่งก่อนหน้ายังทำไม่เสร็จ — ไม่รับซ้อน' };
      }
    } catch (_) {
      // ไม่มีใครรับสายคือสภาพปกติ ไม่ใช่ข้อผิดพลาดที่ต้องรายงาน
      online = false;
      nextDelay = SLOW_MS;
    }
    if (!stopped) setTimeout(tick, nextDelay);
  };

  tick();
  return () => {
    stopped = true;
  };
}
