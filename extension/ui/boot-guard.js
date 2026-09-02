/**
 * ยามเฝ้าการบูตของ Studio — ทำให้ "เงียบ" เป็นไปไม่ได้
 *
 * studio.js เป็น ES module ถ้า import ตัวใดตัวหนึ่งพัง หรือมีบรรทัดบนสุดโยน error
 * เบราว์เซอร์จะหยุดรันไฟล์ทั้งไฟล์เงียบ ๆ ปุ่มทุกปุ่มบนหน้าจะไม่ถูกผูก event เลย
 * ผลคือกดอะไรก็ไม่มีอะไรเกิดขึ้น และไม่มีข้อความใดบอกว่าเกิดอะไรขึ้น
 * ไฟล์นี้เป็นสคริปต์ธรรมดา (ไม่ใช่ module) จึงรันได้เสมอแม้ module จะพัง
 */
(() => {
  window.__studioBooted = false;

  const show = (title, detail) => {
    let box = document.getElementById('bootError');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bootError';
      box.style.cssText =
        'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:#2a1116;' +
        'border:1px solid #a1414f;border-radius:12px;padding:14px 16px;color:#ffd9d9;' +
        'font:13px/1.6 system-ui,sans-serif;max-height:45vh;overflow:auto;white-space:pre-wrap;' +
        'box-shadow:0 12px 30px #0008';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = `⚠ ${title}\n${detail}`.slice(0, 4000);
    box.appendChild(rescueButton());
  };

  /**
   * ทางออกฉุกเฉินเมื่อหน้าจอถูกซ่อนหมดจนไม่เหลืออะไรให้กด
   *
   * ตัวจัดการปุ่มหลายตัวซ่อนหน้าจอปัจจุบันก่อนแล้วค่อยทำงานต่อ ถ้าพังกลางทาง
   * หน้าจะเหลือแต่พื้นเปล่า ไม่มีปุ่มไหนให้กดเพื่อออกจากสภาพนั้นเลย
   * ทางเดียวคือรีโหลดหน้า ซึ่งไม่มีใครบอกไว้ และดูเหมือนโปรแกรมพังไปทั้งตัว
   * งานทั้งหมดอยู่ใน IndexedDB อยู่แล้ว การพากลับหน้าเริ่มต้นจึงไม่ทำให้เสียอะไร
   */
  const SCREENS = ['start', 'resume', 'progress', 'editor', 'imagePhase', 'done'];

  function rescueButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'กลับหน้าเริ่มต้น';
    btn.style.cssText =
      'display:block;margin-top:10px;padding:8px 14px;border:0;border-radius:8px;' +
      'background:#a1414f;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer';
    btn.onclick = () => {
      restoreStart();
      document.getElementById('bootError')?.remove();
    };
    return btn;
  }

  function restoreStart() {
    for (const id of SCREENS) document.getElementById(id)?.classList.add('hidden');
    document.getElementById('start')?.classList.remove('hidden');
    document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' });
  }

  /** ไม่มีหน้าจอไหนมองเห็นอยู่เลย = หน้าตายแล้ว ต้องพากลับเองโดยไม่ต้องรอผู้ใช้เดา */
  function reviveIfBlank() {
    const anyVisible = SCREENS.some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
    if (!anyVisible) restoreStart();
  }

  window.addEventListener('error', (e) => {
    const where = e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : '';
    show('เกิดข้อผิดพลาดในหน้า Studio', `${e.message || e.error || 'ไม่ทราบสาเหตุ'}\n${where}`);
    reviveIfBlank();
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    show('งานเบื้องหลังล้มเหลว', r?.stack || r?.message || String(r));
    reviveIfBlank();
  });

  // module ที่โหลดไม่ผ่านจะไม่โยน error ที่จับได้เสมอไป จึงต้องเช็คว่ามันบูตจริงไหมด้วย
  setTimeout(() => {
    if (!window.__studioBooted)
      show(
        'สคริปต์ของหน้านี้โหลดไม่สำเร็จ',
        'ปุ่มทุกปุ่มจะไม่ทำงานจนกว่าจะแก้\nเปิด DevTools (F12) แท็บ Console ที่หน้านี้เพื่อดูบรรทัดที่พัง',
      );
  }, 3000);
})();
