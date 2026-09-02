/**
 * ห้องแยกสำหรับรัน Typst (sandboxed page)
 *
 * ข้อจำกัดของห้องนี้: เรียก chrome.* ไม่ได้ และ fetch ไปยังไฟล์ในส่วนขยายไม่ได้
 * (origin เป็น opaque) ดังนั้นหน้าแม่ต้องส่งไบต์ทุกอย่างเข้ามาให้ — ทั้งตัวไลบรารี
 * ไฟล์ wasm และไฟล์ฟอนต์ แล้วที่นี่จะประกอบทุกอย่างขึ้นมาเอง
 *
 * โปรโตคอล: หน้าแม่ส่ง {id, op, ...} เข้ามา ที่นี่ตอบ {id, ok, result} หรือ {id, ok:false, error}
 */
(() => {
  'use strict';

  let typst = null; // โมดูลที่ import เข้ามาแล้ว
  let started = null; // promise ของการ init
  const fontBytes = new Map(); // ชื่อไฟล์ฟอนต์ -> Uint8Array

  function reply(id, ok, payload) {
    parent.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) }, '*');
  }

  /**
   * โหลดไลบรารีจากซอร์สที่หน้าแม่ส่งมา ผ่าน blob URL
   * ใช้ blob เพราะโมดูล ES ถูกดึงแบบ CORS เสมอ และ origin ของห้องนี้เป็น opaque
   * การ import จาก chrome-extension:// ตรง ๆ จึงถูกบล็อก ส่วน blob เป็น same-origin กับหน้านี้
   */
  async function loadLibrary(sourceText) {
    const url = URL.createObjectURL(new Blob([sourceText], { type: 'text/javascript' }));
    try {
      return await import(url);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  async function init({ librarySource, compilerWasm, rendererWasm, fonts }) {
    typst = await loadLibrary(librarySource);
    const { $typst, loadFonts } = typst;

    for (const f of fonts) fontBytes.set(f.name, new Uint8Array(f.bytes));

    // ตัวดึงฟอนต์ของเราเอง — คืนไบต์ที่หน้าแม่ส่งมา ไม่ยิงเครือข่ายเลย
    // สำคัญ: ต้องตั้ง fetcher ไว้ ไม่งั้นไลบรารีจะพยายามโหลดฟอนต์จาก CDN
    const fetcher = async (input) => {
      const bytes = fontBytes.get(String(input));
      if (!bytes) throw new Error('ไม่ได้ส่งไฟล์ฟอนต์มาให้: ' + input);
      return { arrayBuffer: async () => bytes.buffer };
    };

    $typst.setCompilerInitOptions({
      getModule: () => compilerWasm,
      beforeBuild: [loadFonts([...fontBytes.keys()], { assets: false, fetcher })],
    });
    if (rendererWasm) {
      $typst.setRendererInitOptions({ getModule: () => rendererWasm });
    }

    // บังคับให้สร้างคอมไพเลอร์เดี๋ยวนี้ จะได้รู้ตั้งแต่ตอนเปิดหน้าว่าโหลดผ่านไหม
    await $typst.getCompiler();
    return { ok: true, fonts: [...fontBytes.keys()] };
  }

  /**
   * ถามข้อมูลจากเอกสารที่เรียงพิมพ์แล้ว
   *
   * ไม่ใช้ $typst.query() ของไลบรารีตรง ๆ เพราะมันสร้าง world แล้วถามเลย
   * โดยไม่ได้สั่งให้ประมวลผลเอกสารก่อน ฝั่ง Rust จึงตอบว่า "document is not compiled"
   * ที่นี่จึงลงไปใช้ runWithWorld เองแล้วเรียก compile() ก่อนถาม
   */
  async function query($typst, src, selector, field) {
    const compiler = await $typst.getCompilerReset();
    const opts = await $typst.getCompileOptions({ mainContent: src });
    try {
      return await compiler.runWithWorld(opts, async (world) => {
        await world.compile();
        return world.query({ selector, field });
      });
    } finally {
      await $typst.removeTmp(opts);
    }
  }

  async function handle(msg) {
    const { id, op } = msg;

    if (op === 'init') {
      started ||= init(msg);
      return reply(id, true, await started);
    }

    if (!started) return reply(id, false, 'ยังไม่ได้ init');
    await started;
    const { $typst } = typst;

    // ป้อนไฟล์ภาพเข้าระบบไฟล์เสมือนของ Typst ก่อนคอมไพล์ทุกครั้ง
    // ทำใหม่ทุกคำสั่งเพราะการคอมไพล์แต่ละครั้ง reset ตัวคอมไพเลอร์
    if (msg.files?.length) {
      for (const f of msg.files) await $typst.mapShadow(f.path, new Uint8Array(f.bytes));
    }

    switch (op) {
      case 'pagecount': {
        const res = await query($typst, msg.src, '<pagecount>', 'value');
        const v = Array.isArray(res) ? res[0] : res;
        if (!v || typeof v.physical !== 'number') throw new Error('อ่านจำนวนหน้าจากเอกสารไม่ได้');
        return reply(id, true, { physical: v.physical, numbered: v.numbered });
      }
      case 'pdf': {
        const bytes = await $typst.pdf({ mainContent: msg.src });
        const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
        return parent.postMessage({ id, ok: true, result: { pdf: buf } }, '*', [buf]);
      }
      case 'svg': {
        return reply(id, true, await $typst.svg({ mainContent: msg.src }));
      }
      default:
        return reply(id, false, 'ไม่รู้จักคำสั่ง ' + op);
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg.id !== 'number') return;
    handle(msg).catch((err) => reply(msg.id, false, err?.message || err));
  });

  parent.postMessage({ ready: true }, '*');
})();
