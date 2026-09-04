/**
 * Content script — "มือ" ของระบบ และเป็นส่วนที่เปราะที่สุด
 * ทุกอย่างที่ต้องพึ่งหน้าตาเว็บของ ChatGPT อยู่ในไฟล์นี้ไฟล์เดียว
 * ถ้าเว็บเปลี่ยน ให้แก้ที่ DEFAULT_SELECTORS หรือทับค่าจากหน้าตั้งค่าของ Studio
 */
(() => {
  if (window.__ebookAutoAdapter) return;
  window.__ebookAutoAdapter = true;

  const DEFAULT_SELECTORS = {
    composer: '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"]',
    sendButton: '[data-testid="send-button"], button[aria-label*="send" i], button[aria-label*="ส่ง" i], button[title*="send" i]',
    stopButton: '[data-testid="stop-button"], button[aria-label*="Stop" i]',
    assistantTurn: '[data-message-author-role="assistant"]',
    turnContainer: 'main',
    codeBlock: 'pre code',
    copyButton: '[data-testid="copy-turn-action-button"], button[aria-label*="Copy" i]',
    modelBadge: '[data-testid="model-switcher-dropdown-button"]',
    newChatButton: '[data-testid="create-new-chat-button"], button[aria-label*="new chat" i], button[title*="new chat" i], a[aria-label*="new chat" i], a[href="/"]',
    errorRetry: '[data-testid="regenerate-thread-error-button"]',
    limitNotice:
      '[role="alert"], [role="dialog"], [aria-live="assertive"], [data-testid*="limit" i], [data-testid*="usage" i], [class*="toast" i]',
    images: 'img[src*="oaiusercontent"], img[alt][src^="https://"]',
    fileInput: 'input[type="file"]',
  };

  // วลีที่แปลว่า "ชนลิมิต" — เพิ่มได้จากหน้าตั้งค่า
  const DEFAULT_LIMIT_PATTERNS = [
    "you've reached",
    'you have reached',
    'usage limit',
    'message limit',
    'limit reached',
    'try again later',
    'plus limit',
    'ถึงขีดจำกัด',
    'ใช้ครบแล้ว',
  ];

  let S = { ...DEFAULT_SELECTORS };
  let LIMITS = [...DEFAULT_LIMIT_PATTERNS];

  chrome.storage.local.get(['selectors', 'limitPatterns']).then((o) => {
    if (o.selectors) S = { ...DEFAULT_SELECTORS, ...o.selectors };
    if (o.limitPatterns?.length) LIMITS = o.limitPatterns;
  });

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * รอแบบขับด้วยเหตุการณ์ ไม่ใช่นาฬิกา
   *
   * ตรวจทันทีหนึ่งครั้ง แล้วตรวจซ้ำทุกครั้งที่ DOM ขยับ — ของมาเมื่อไรได้เมื่อนั้น
   * timeout มีไว้กันค้างอย่างเดียว ไม่ใช่จังหวะการทำงานปกติ
   */
  function waitForDom(fn, { timeoutMs = 45000, root = document.documentElement } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      const check = () => {
        let v = null;
        try {
          v = fn();
        } catch (_) {
          v = null; /* ระหว่างหน้ากำลังเรนเดอร์ การอ่าน DOM อาจพังชั่วคราว */
        }
        if (v) finish(v);
      };
      const obs = new MutationObserver(check);
      const timer = setTimeout(() => finish(null), timeoutMs);
      obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      check();
    });
  }

  /**
   * ต้นเหตุอาการ "ต้องกดสองสามรอบถึงจะดึงข้อมูลให้"
   *
   * ChatGPT เป็น SPA ที่ tab.status = 'complete' มาถึงก่อนที่ React จะวาดช่องพิมพ์เสร็จ
   * (ยิ่งช้าเมื่อเพิ่งเปิดแท็บ เพิ่งสลับบัญชี หรือแท็บถูกพักไว้แล้วถูกปลุก)
   * เดิมเราหยิบช่องพิมพ์ด้วย $(S.composer) ทันทีแล้วโยน composer_not_found ทิ้งเลย
   * เทิร์นจึงล้มทันทีทั้งที่หน้าเว็บกำลังจะพร้อมอยู่แล้ว ผู้ใช้เลยต้องกดซ้ำจนกว่าจะทัน
   * ตอนนี้รอให้ช่องพิมพ์โผล่และใช้งานได้จริงก่อนเสมอ
   */
  function composerReady() {
    const box = $(S.composer);
    if (!box) return null;
    if (box.disabled || box.getAttribute('contenteditable') === 'false') return null;
    if (box.offsetParent === null && getComputedStyle(box).position !== 'fixed') return null;
    return box;
  }

  const waitForComposer = (timeoutMs = 45000) => waitForDom(composerReady, { timeoutMs });

  /** ข้อความล่าสุดที่ "เรา" ส่ง ใช้เป็นหมุดว่าอะไรคือคำตอบของเทิร์นนี้ */
  function lastUserTurn() {
    const turns = $$('[data-message-author-role="user"]');
    return turns[turns.length - 1] || null;
  }

  /**
   * คำตอบของเทิร์นนี้ = คำตอบตัวสุดท้ายที่อยู่ "หลัง" ข้อความที่เราเพิ่งส่ง
   *
   * เดิมใช้วิธีจำจำนวน/รหัสคำตอบก่อนส่งแล้วเทียบ ซึ่งต้องรอให้หน้าเว็บวาดบทสนทนาเสร็จก่อน
   * ถึงจะจำได้ถูก การเทียบตำแหน่งใน DOM ให้คำตอบเดียวกันโดยไม่ต้องรออะไรเลยสักมิลลิวินาที
   */
  function assistantAfter(anchor) {
    const turns = $$(S.assistantTurn);
    if (!anchor) return turns[turns.length - 1] || null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (anchor.compareDocumentPosition(turns[i]) & Node.DOCUMENT_POSITION_FOLLOWING) return turns[i];
    }
    return null;
  }

  /**
   * แถบปุ่ม (คัดลอก ฯลฯ) ใต้คำตอบ จะโผล่ก็ต่อเมื่อคำตอบนั้นจบแล้วเท่านั้น
   *
   * เดิมยึด turn.closest('article') ชั้นเดียว พอหน้า ChatGPT เปลี่ยนโครงสร้างจนแถบปุ่ม
   * ไปอยู่นอก <article> ก็หาไม่เจอถาวร แล้วเทิร์นสร้างภาพจะไม่มีวันจบ
   * ตอนนี้ไต่ขึ้นทีละชั้นจนเจอ และหยุดทันทีที่ชั้นนั้นคาบเกี่ยวคำตอบอื่น
   * เพื่อไม่ให้ไปหยิบแถบปุ่มของคำตอบก่อนหน้ามาใช้
   */
  /**
   * ปุ่มคัดลอกของ "บล็อกโค้ด" ไม่ใช่แถบปุ่มใต้คำตอบ และโผล่ตั้งแต่ยังพ่นไม่จบ
   *
   * เดิมกันด้วย b.closest('pre') อย่างเดียว ซึ่งกันไม่ได้จริง เพราะหัวบล็อกโค้ดของ ChatGPT
   * (แถบที่เขียนว่า json พร้อมปุ่ม Copy) เป็น "พี่น้อง" ของ <pre> ไม่ได้อยู่ข้างใน
   * ผลคือพอ JSON เริ่มพ่นได้ไม่กี่ตัวอักษร ระบบก็เห็น "แถบปุ่ม" แล้ว → ข้ามด่านปุ่มหยุด
   * → พ่นสะดุดเกิน 120ms เมื่อไรก็ปิดเทิร์นทันที แล้วอ่านคำตอบที่ยังไม่จบกลับไป
   * (อาการที่เห็น: "ไม่พบสารบัญที่เลือกได้ในคำตอบ [ยาว 39 ตัวอักษร ...]")
   */
  function inCodeBlock(btn) {
    if (btn.closest('pre')) return true;
    for (let el = btn.parentElement, i = 0; el && i < 4; el = el.parentElement, i++) {
      if (el.matches?.(S.assistantTurn)) break;
      if (el.querySelector('pre')) return true;
    }
    return false;
  }

  function actionBarFor(turn) {
    const root = $(S.turnContainer) || document.body;
    let el = turn;
    for (let depth = 0; el && el !== root && depth < 8; el = el.parentElement, depth++) {
      // เจอคำตอบอื่นในชั้นนี้ = ไต่พ้นเทิร์นตัวเองไปแล้ว
      if (el !== turn && $$(S.assistantTurn, el).length > 1) break;

      const exact = el.querySelector('[data-testid="copy-turn-action-button"]');
      if (exact) return exact;

      // ในกล่องคำตอบเองไม่เคยมีแถบปุ่มจริง มีแต่ปุ่มของบล็อกโค้ด
      // จึงยอมรับเฉพาะ testid ตรงตัวเท่านั้น ส่วน selector สำรองใช้ได้แค่ชั้นนอกกล่อง
      if (el !== turn) {
        const any = [...el.querySelectorAll(S.copyButton)].find((b) => !inCodeBlock(b));
        if (any) return any;
      }

      /**
       * ห้ามไต่พ้นขอบเทิร์น
       *
       * เกณฑ์ "เจอคำตอบอื่นในชั้นนี้" ใช้ไม่ได้เลยในห้องแชตใหม่ที่มีคำตอบเดียว
       * การไต่จึงไม่มีวันหยุด แล้วไปกวาดทั้ง <main> จนเจอปุ่มที่มี aria-label ว่า Copy
       * ของแถบเครื่องมืออื่นในหน้า แล้วนับว่า "คำตอบจบแล้ว" ตั้งแต่พ่นได้สิบกว่าตัวอักษร
       * (อาการที่เห็น: ตอบเป็นข้อความแทนภาพ: "ตอนนี้ระบบสร้าง")
       */
      if (el !== turn && el.matches?.('article, [data-testid^="conversation-turn"]')) break;
    }
    return null;
  }

  /**
   * ข้อความชั่วคราวระหว่าง ChatGPT กำลังคิด ไม่ใช่คำตอบ
   *
   * โมเดลสายคิดก่อนตอบจะวาดคำว่า "Thinking" ไว้ในกล่องคำตอบก่อน แล้วค่อยแทนที่ด้วยของจริง
   * ถ้าจังหวะนั้นหน้าเว็บนิ่งพอดี ระบบจะปิดเทิร์นแล้วอ่านคำว่า "Thinking" กลับมาเป็นคำตอบ
   * (อาการที่เห็น: ปกหน้า ล้มเหลว — ChatGPT ตอบเป็นข้อความแทนภาพ: "Thinking")
   * ต้องเทียบทั้งก้อน ไม่ใช่ขึ้นต้นด้วย เพราะคำตอบจริงมักขึ้นต้นว่า "Thought for 12s" แล้วตามด้วยเนื้อหา
   */
  const PLACEHOLDER =
    /^(thinking|reasoning|analy[sz]ing|searching(?: the web)?|working on it|thought for [^\n]{0,24}|กำลังคิด[^\n]{0,24}|กำลังค้นหา[^\n]{0,24})[.…\s]*$/i;
  const isThinkingOnly = (turn) => PLACEHOLDER.test((turn?.innerText || '').trim());

  function report(turnId, phase, detail, note) {
    chrome.runtime.sendMessage({ type: 'gpt.progress', turnId, phase, detail, note }).catch(() => {});
  }

  function hitLimit() {
    // ห้ามสแกน document.body: เนื้อหาหนังสือหรือ prompt อาจพูดถึงคำว่า
    // "usage limit" เอง ทำให้ระบบหยุดทั้งที่ ChatGPT ไม่ได้ติดลิมิตจริง
    // ตรวจเฉพาะ UI แจ้งเตือนนอกกล่องข้อความสนทนาเท่านั้น
    return $$(S.limitNotice).some((el) => {
      if (el.closest('[data-message-author-role]') || el.closest(S.composer)) return false;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      const t = (el.innerText || el.textContent || '').toLowerCase();
      return LIMITS.some((p) => t.includes(p.toLowerCase()));
    });
  }

  /**
   * "ยังพ่นอยู่" ต้องดูจากปุ่มหยุดที่มองเห็นจริงเท่านั้น
   *
   * เดิมใช้ $(S.stopButton) เฉย ๆ ซึ่งเจอ element ที่ซ่อนอยู่ใน DOM ด้วย
   * หน้า ChatGPT เก็บปุ่มไว้หลายตัวโดยไม่ถอดทิ้ง และ selector สำรอง button[aria-label*="Stop"]
   * ยังไปโดนปุ่มโหมดเสียง/อัดเสียงเข้าอีก ผลคือระบบเชื่อว่ากำลังพ่นอยู่ตลอดเวลา
   * คำตอบที่จบไปแล้วจึงไม่มีวันถูกอ่าน ต้องรอจนหมดเวลา 5 นาทีแล้วนับเป็น timeout ทุกครั้ง
   * (อาการที่เห็น: ChatGPT วาดภาพเสร็จมีปุ่ม Edit แล้ว แต่ Studio ยังนับ "รอคำตอบ 201 วินาที")
   */
  function stopButtonVisible() {
    const visible = (b) => {
      if (!b || b.disabled) return false;
      if (b.offsetParent === null && getComputedStyle(b).position !== 'fixed') return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // testid ของปุ่มหยุดจริงคือตัวชี้ขาด ถ้ามีและมองเห็นอยู่ ไม่ต้องดูอย่างอื่นแล้ว
    if ($$('[data-testid="stop-button"]').some(visible)) return true;

    /**
     * selector สำรอง button[aria-label*="Stop"] ไปโดนปุ่มโหมดเสียงเข้าด้วย
     *
     * ปุ่มพวกนั้น ("Stop voice mode", "Stop dictation", ไมโครโฟน) อยู่ในหน้าตลอดเวลา
     * ถ้านับเป็น "ยังพ่นอยู่" ทุกด่านที่รอให้พ่นจบจะไม่มีวันผ่าน:
     *   waitUntilIdle รอเปล่า 90 วินาทีก่อนทุกเทิร์น
     *   pollForImage ไม่ยอมเลิกรอจนครบ 5 นาทีเต็มแม้หน้าจอนิ่งสนิท
     * รวมกันแล้วเห็นเป็น "ค้าง" ทั้งที่ ChatGPT ตอบจบไปนานแล้ว
     */
    return $$(S.stopButton).some((b) => {
      if (!visible(b)) return false;
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''}`.toLowerCase();
      if (/voice|dictat|microphone|mic\b|speech|audio|record|ไมโครโฟน|เสียง|อัดเสียง/.test(label)) return false;
      return true;
    });
  }

  function lastAssistantTurn() {
    const turns = $$(S.assistantTurn);
    return turns[turns.length - 1] || null;
  }

  function currentModel() {
    const el = $(S.modelBadge);
    return el ? el.innerText.trim().replace(/\s+/g, ' ') : '';
  }

  // ---------- แนบไฟล์ ----------
  /**
   * ยัดไฟล์เข้าช่องแนบของ ChatGPT
   *
   * หน้าเว็บไม่มี API ให้เรียก มีแต่ input[type=file] ที่ซ่อนอยู่หลังปุ่มคลิปหนีบ
   * ทางเดียวที่ทำได้จากสคริปต์คือสร้าง DataTransfer ขึ้นมาเอง ยัดใส่ input.files
   * แล้วส่งเหตุการณ์ change ให้ React รู้ตัว — เป็นของจริงตามสเปก ไม่ใช่เหตุการณ์สังเคราะห์
   * ที่ Chrome ปฏิเสธแบบเดียวกับ ClipboardEvent
   *
   * ถ้าช่องนั้นหาไม่เจอหรือไม่ตอบสนอง ยังเหลือทางหย่อนไฟล์ใส่ช่องพิมพ์
   * ซึ่งเป็นเส้นทางเดียวกับที่ผู้ใช้ลากรูปมาวางเอง
   */
  async function attachFiles(files = []) {
    const wanted = files.filter((f) => f?.dataUrl);
    if (!wanted.length) return { attached: 0, errors: [] };

    const errors = [];
    const before = countAttachmentThumbs();

    let list;
    try {
      list = await buildFileList(wanted);
    } catch (e) {
      return { attached: 0, errors: [`สร้างไฟล์จากรูปที่ส่งมาไม่ได้: ${e?.message || e}`] };
    }

    // ทางที่ 1 — ช่องแนบไฟล์จริงของหน้าเว็บ
    const inputs = $$(S.fileInput).filter((el) => !el.accept || /image|\*/i.test(el.accept));
    for (const input of inputs) {
      try {
        input.files = list;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (await waitForThumbs(before + wanted.length)) return { attached: wanted.length, errors, via: 'file_input' };
      } catch (e) {
        errors.push(`ใส่ไฟล์ในช่องแนบไม่สำเร็จ: ${e?.message || e}`);
      }
    }

    // ทางที่ 2 — หย่อนไฟล์ลงช่องพิมพ์ เหมือนผู้ใช้ลากรูปมาวาง
    const box = $(S.composer);
    if (box) {
      try {
        const dt = new DataTransfer();
        for (const f of list) dt.items.add(f);
        for (const type of ['dragenter', 'dragover', 'drop']) {
          box.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
        if (await waitForThumbs(before + wanted.length)) return { attached: wanted.length, errors, via: 'drop' };
      } catch (e) {
        errors.push(`หย่อนไฟล์ลงช่องพิมพ์ไม่สำเร็จ: ${e?.message || e}`);
      }
    }

    errors.push('แนบไฟล์แล้วแต่ไม่เห็นรูปขึ้นในช่องพิมพ์');
    return { attached: 0, errors };
  }

  async function buildFileList(files) {
    const dt = new DataTransfer();
    for (const f of files) {
      const blob = await (await fetch(f.dataUrl)).blob();
      dt.items.add(new File([blob], f.name || 'reference.jpg', { type: blob.type || 'image/jpeg' }));
    }
    return dt.files;
  }

  /**
   * รูปที่แนบสำเร็จจะถูกแสดงเป็นภาพย่อที่หน้าเว็บสร้างจาก blob: ในเครื่อง
   * ต่างจากรูปในบทสนทนาซึ่งมาจากเซิร์ฟเวอร์ จึงใช้แยกกันได้ว่าไฟล์เข้าไปแล้วจริง
   */
  const countAttachmentThumbs = () => $$('img[src^="blob:"]').length;

  const waitForThumbs = (want) =>
    waitForDom(() => countAttachmentThumbs() >= want, { timeoutMs: 15000 }).then((v) => !!v);

  // ---------- ฉีดข้อความ ----------
  async function injectText(text) {
    const box = await waitForComposer();
    if (!box) throw new Error('composer_not_found');

    /**
     * Prompt เดิมค้างอยู่ในช่องแล้ว ไม่ต้องพิมพ์ทับ
     *
     * เกิดตอนรอบก่อนพิมพ์สำเร็จแต่กดส่งไม่ติด การล้างแล้วพิมพ์ใหม่ทั้งก้อน
     * (ยาวสองพันกว่าตัวอักษร) ใช้เวลานานและเสี่ยงถูก re-render ตัดกลางคันซ้ำอีก
     */
    const already = (box.innerText || box.textContent || '').trim();
    if (already && already === String(text).trim()) return box;

    /**
     * ต้องล้างให้ "ว่างจริง" ไม่ใช่แค่สั่งล้างแล้วเชื่อว่าล้างแล้ว
     *
     * selectAll + delete ไม่ได้ผลทุกครั้งในตัวแก้ไขแบบนี้ ของเดิมที่ค้างอยู่จึงยังอยู่
     * แล้วข้อความใหม่ไปต่อท้าย ผลคือคำสั่งมีบรรทัดซ้ำ
     * (เห็นกับตา: "รอบก่อนยังไม่ได้ภาพกลับมา..." โผล่สองรอบติดกันในคำสั่งเดียว)
     */
    for (let i = 0; i < 3; i++) {
      box.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await frame();
      if (!(box.innerText || box.textContent || '').trim()) break;
      // ล้างไม่ลง ลองล้าง DOM ตรง ๆ แล้วแจ้งให้ตัวแก้ไขรู้
      box.textContent = '';
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await frame();
    }

    /**
     * วางผ่านคลิปบอร์ดจริงเป็นทางหลัก
     *
     * ช่องพิมพ์ของ ChatGPT เป็น ProseMirror ซึ่งไม่ได้อ่านจาก DOM แต่เก็บสถานะของตัวเอง
     * ปุ่มส่งจะเปิดใช้งานก็ต่อเมื่อสถานะนั้นบันทึกว่ามีเนื้อหา
     *
     * ทางที่ลองมาแล้วและใช้ไม่ได้จริง:
     *   - execCommand('insertText') — ตัวอักษรขึ้นจอ แต่กับข้อความยาว ๆ ไม่ commit เข้าสถานะ
     *   - new ClipboardEvent('paste', { clipboardData }) — Chrome ไม่ยอมให้เหตุการณ์สังเคราะห์
     *     พกข้อมูลคลิปบอร์ดไปด้วย ฝั่งรับจึงได้ค่าว่างเสมอ เท่ากับไม่ได้ทำอะไรเลย
     * ทั้งสองทางจบเหมือนกัน: เห็นข้อความเต็มช่อง แต่ปุ่มส่งเทาตลอด กดไม่ได้ไม่ว่าจะรอนานแค่ไหน
     *
     * ทางนี้ต่างออกไป — เขียนลงคลิปบอร์ดของเครื่องจริง แล้วสั่งวางด้วยคำสั่งของเบราว์เซอร์
     * ส่วนขยายที่มีสิทธิ์คลิปบอร์ดทำได้ และเบราว์เซอร์จะสร้างเหตุการณ์วางของจริงให้
     * ProseMirror จึงรับเข้าสถานะครบเหมือนคนกด Ctrl+V เอง
     */
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      box.focus();
      ok = document.execCommand('paste');
      await frame();
      ok = ok && !!box.innerText.trim();
    } catch (_) {
      ok = false;
    }

    // ทางสำรองที่ 1: คำสั่งแทรกข้อความของเบราว์เซอร์
    if (!box.innerText.trim()) {
      ok = document.execCommand('insertText', false, text);
      await frame();
    }

    // ทางสำรองที่ 2: ยัด DOM ตรง ๆ แล้วแจ้ง input event
    if (!box.innerText.trim()) {
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await frame();
    }
    /**
     * ต้องได้ข้อความ "ตรงตามที่ตั้งใจส่ง" ไม่ใช่แค่ "ยาวพอประมาณ"
     *
     * เกณฑ์เดิมจับเฉพาะตอนยาวเกิน 1.5 เท่า ซึ่งพลาดกรณีที่ซ้ำแค่บรรทัดแรกไม่กี่สิบตัวอักษร
     * แต่คำสั่งที่มีบรรทัดซ้ำก็คือคำสั่งที่ผิดอยู่ดี เทียบตรง ๆ ว่าเท่ากันไหมชัดเจนกว่า
     * (ตัวเปรียบเทียบยุบช่องว่างซ้อนก่อน เพราะตัวแก้ไขจัดบรรทัดใหม่ได้เล็กน้อยเป็นปกติ)
     */
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const want = norm(text);
    let got = norm(box.innerText);

    for (let i = 0; i < 2 && want && got !== want; i++) {
      // ข้อความไม่ตรง = ล้างแล้วพิมพ์ใหม่ ไม่ต้องรายงานออกไป เพราะ injectText ถูกเรียกก่อนรู้ turnId
      box.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await frame();
      box.textContent = '';
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await frame();
      box.focus();
      document.execCommand('insertText', false, text);
      await frame();
      got = norm(box.innerText);
    }

    if (!got) throw new Error('composer_write_failed');
    return box; // ส่งต่อให้ clickSend ใช้ element เดียวกัน ไม่ใช่ไปหาใหม่แล้วได้คนละตัว
  }

  /**
   * รอให้ ChatGPT ว่างจริงก่อนพิมพ์/กดส่งเทิร์นถัดไป
   *
   * สำคัญมากกับเทิร์นสร้างภาพ: หลังภาพแรกเรนเดอร์เสร็จ หน้าเว็บอาจยังอยู่ในสถานะ "กำลังทำงาน"
   * (ปุ่ม Stop ยังอยู่ / ปุ่ม Send ยัง disabled) ถ้ายัด Prompt ถัดไปตอนนั้น ปุ่มส่งจะกดไม่ติด
   * แล้ว Prompt จะค้างอยู่ในช่องพิมพ์โดยไม่ถูกส่ง ซึ่งเป็นอาการ "ค้างที่ปกหลัง" ที่เจอจริง
   */
  async function waitUntilIdle(timeoutMs = 25000) {
    // ว่างแล้วไปต่อทันที ไม่ต้องนับว่าว่างต่อเนื่องกี่มิลลิวินาทีอีก
    // เพราะ clickSend ยืนยันผลจริงหลังคลิกอยู่แล้ว (ข้อความของเราต้องเพิ่มขึ้นจริง)
    return !!(await waitForDom(() => (stopButtonVisible() ? null : true), { timeoutMs }));
  }

  /**
   * กระตุ้นให้ตัวแก้ไขข้อความของ ChatGPT รับรู้ว่ามีข้อความอยู่จริง
   *
   * ปุ่มส่งของ ChatGPT จะ disabled อยู่จนกว่า state ภายในของตัวแก้ไข (ProseMirror)
   * จะบันทึกว่ามีเนื้อหา การยัดข้อความด้วย execCommand บางครั้งขึ้นจอแล้วแต่ state ยังไม่ขยับ
   * — เห็นข้อความเต็มช่องแต่ปุ่มส่งยังกดไม่ได้ ซึ่งคืออาการที่เจอ
   * เติมช่องว่างแล้วลบออกหนึ่งจังหวะ บังคับให้มัน commit transaction ใหม่
   */
  async function nudgeComposer(box) {
    if (!box?.isConnected) return;
    box.focus();
    try {
      document.execCommand('insertText', false, ' ');
      await frame();
      document.execCommand('delete', false, null);
      await frame();
    } catch (_) {
      /* ตัวแก้ไขบางรุ่นไม่รับ execCommand ไม่เป็นไร ยังมีทาง Enter */
    }
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
    await frame();

    /**
     * ห้ามวางข้อความซ้ำในนี้เด็ดขาด
     *
     * เคยใส่ท่า "เลือกทั้งหมดแล้ว paste ทับ" ไว้ตรงนี้ ด้วยความหวังว่าจะปลุกสถานะภายในได้
     * แต่ selectAll ไม่ได้เลือกจริงเสมอไปในตัวแก้ไขแบบนี้ paste จึงกลายเป็นการต่อท้าย
     * ผลคือคำสั่งถูกส่งไปเป็นข้อความเดียวกันสองรอบติดกัน
     * (เห็นกับตา: "วาดรูปแมวสีส้มนั่งบนกล่องกระดาษ 1 ภาพวาดรูปแมวสีส้มนั่งบนกล่องกระดาษ 1 ภาพ")
     * งานกระตุ้นคือกระตุ้น ไม่ใช่แก้ไขเนื้อหา ถ้าปุ่มยังไม่เปิดยังมีทาง Enter และทางให้คนกดเอง
     */
  }

  function sendCandidates(box) {
    // ต้องหาใหม่ทุกครั้ง หน้า ChatGPT สร้างปุ่มชุดใหม่ทุกครั้งที่ re-render
    const form = box?.isConnected ? box.closest('form') : null;
    const roots = form ? [form, document] : [document];
    const seen = new Set();
    const out = [];
    for (const root of roots) {
      for (const sel of [
        '[data-testid="send-button"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="ส่ง" i]',
        'button[title*="send" i]',
        'button[type="submit"]',
      ]) {
        for (const b of root.querySelectorAll(sel)) {
          if (!seen.has(b)) {
            seen.add(b);
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  const sendUsable = (b) => {
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    if (b.offsetParent === null && getComputedStyle(b).position !== 'fixed') return false;
    const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''} ${b.textContent || ''}`.trim();
    return !/stop|หยุด|attach|แนบ|upload|อัปโหลด|voice|microphone|ไมโครโฟน/i.test(label);
  };

  function pressEnter(box) {
    if (!box?.isConnected) return;
    box.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      box.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  async function clickSend(composer = null, timeoutMs = 20000) {
    const t0 = Date.now();
    const box = composer?.isConnected ? composer : await waitForComposer(15000);
    if (!box) throw new Error('composer_not_found_before_send'); // ผู้เรียกครอบ try ไว้แล้ว

    const textNow = () => (box.isConnected ? (box.innerText || box.textContent || '').trim() : '');
    const userCountBefore = $$('[data-message-author-role="user"]').length;
    const stopBefore = stopButtonVisible();

    /**
     * "ส่งแล้วหรือยัง" มีหลักฐานที่เชื่อได้จริงอยู่อย่างเดียว: ข้อความของเราโผล่ในบทสนทนา
     *
     * เกณฑ์ "ช่องพิมพ์ว่าง = ส่งแล้ว" เป็นกับดัก เพราะหน้า ChatGPT สร้างช่องพิมพ์ใหม่
     * ทุกครั้งที่ re-render ตัวแปร box ที่เราถืออยู่จึงกลายเป็น element ที่หลุดจากหน้าไปแล้ว
     * ซึ่งอ่าน innerText ได้ค่าว่างเสมอ — ระบบเลยสรุปว่า "ส่งสำเร็จ" ทั้งที่ Prompt
     * ยังนอนอยู่ในช่องพิมพ์ให้เห็นเต็มตา แล้วไปนั่งรอคำตอบที่ไม่มีวันมาจนหมดเวลา
     */
    const accepted = async (waitMs = 1800) =>
      !!(await waitForDom(
        () => {
          if ($$('[data-message-author-role="user"]').length > userCountBefore) return true;
          if (box.isConnected && !textNow()) return true;
          if (!stopBefore && stopButtonVisible()) return true;
          return null;
        },
        { timeoutMs: waitMs },
      ));

    /**
     * หน้าเว็บติดสถานะ "กำลังตอบ" ค้าง = ปุ่มส่งกลายเป็นปุ่มหยุด กดส่งไม่ได้ตลอดกาล
     *
     * เห็นกับตาในหน้าจอจริง: Prompt นอนอยู่ในช่องพิมพ์เต็ม ๆ ส่วนมุมขวาล่างเป็นปุ่มสี่เหลี่ยม
     * (ปุ่มหยุด) ไม่ใช่ลูกศรส่ง ทั้งที่ ChatGPT วาดภาพเสร็จไปแล้วและหน้าจอนิ่งสนิท
     * สถานะนี้ไม่หายเอง รอไปก็เท่านั้น — ต้องกดหยุดให้มันคืนสภาพ แล้วค่อยส่ง
     */
    const stopControl = () =>
      $$('[data-testid="stop-button"]').find((b) => {
        if (!b || b.disabled) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) || null;

    if (stopControl()) {
      // ให้โอกาสมันจบเองก่อน เผื่อกำลังตอบอยู่จริง
      const finished = await waitForDom(() => (stopControl() ? null : true), { timeoutMs: 20000 });
      const stuck = stopControl();
      if (!finished && stuck) {
        stuck.click(); // ปลดสถานะค้าง เพื่อให้ปุ่มส่งกลับมา
        await waitForDom(() => (stopControl() ? null : true), { timeoutMs: 5000 });
      }
    }

    /**
     * รอให้ปุ่มส่ง "กดได้" ก่อน แล้วค่อยกด
     *
     * ปุ่มที่ยัง disabled คือสัญญาณว่าตัวแก้ไขข้อความยังไม่นับว่ามีเนื้อหา
     * ของเดิมข้ามปุ่มที่กดไม่ได้แล้วไปงมทางอื่นทันที ทั้งที่แค่รออีกวินาทีเดียวมันก็เปิด
     */
    let ready = await waitForDom(() => (sendCandidates(box).some(sendUsable) ? true : null), { timeoutMs: 4000 });
    if (!ready) {
      await nudgeComposer(box);
      ready = await waitForDom(() => (sendCandidates(box).some(sendUsable) ? true : null), { timeoutMs: 6000 });
    }

    // รอบแรก: กดปุ่มส่งที่กดได้จริง
    for (const btn of sendCandidates(box).filter(sendUsable)) {
      btn.click();
      if (await accepted()) return true;
    }

    // รอบสอง: Enter บนช่องพิมพ์ (ใช้ได้แม้ตอนที่หาปุ่มไม่เจอ)
    pressEnter(box);
    if (await accepted(2200)) return true;

    // รอบสาม: ปุ่มอาจเพิ่งเปิดใช้งานหลังหน้าเว็บวาดเสร็จ กดทันทีที่มีปุ่มที่กดได้
    while (Date.now() - t0 <= timeoutMs) {
      const btn = await waitForDom(() => sendCandidates(box).find(sendUsable) || null, {
        timeoutMs: Math.max(500, timeoutMs - (Date.now() - t0)),
      });
      if (!btn) break;
      btn.click();
      if (await accepted(800)) return true;
      pressEnter(box);
      if (await accepted(800)) return true;
    }
    throw new Error('send_action_not_accepted');
  }

  // ---------- รู้ได้อย่างไรว่าตอบจบ ----------
  /**
   * รู้ได้อย่างไรว่าตอบจบ — ทุกอย่างขับด้วยเหตุการณ์ ไม่ใช่นาฬิกา
   *
   * เวอร์ชันแรกดูปุ่มหยุดเป็นสัญญาณหลัก ซึ่งพังเงียบ ๆ ได้ถ้าตัวเลือกปุ่มไม่ตรง
   * เวอร์ชันถัดมาจึงรอ "ข้อความหยุดยาวพอ" แทน ซึ่งถูกต้องแต่เสียเวลาฟรีเกือบสองวินาทีทุกเทิร์น
   *
   * ตอนนี้ยึดสองหมุดที่ตรงกับความจริงและรู้ผลทันที
   *   - คำตอบของเทิร์นนี้ = คำตอบที่อยู่หลังข้อความที่เราเพิ่งส่ง (เทียบตำแหน่งใน DOM)
   *   - จบแล้ว = ปุ่มหยุดหายไป และแถบปุ่มใต้คำตอบโผล่ขึ้นมา (ไม่นับปุ่มคัดลอกของบล็อกโค้ด
   *     ซึ่งโผล่ตั้งแต่ยังพ่นไม่จบ)
   * MutationObserver เป็นตัวปลุกให้ตรวจ ได้ครบเมื่อไรคืนเมื่อนั้น
   * เกณฑ์ "ข้อความหยุดยาว" เหลือไว้เป็นทางสำรองเผื่อหน้าเว็บเปลี่ยนโครงสร้างจนหาแถบปุ่มไม่เจอ
   */
  /** ภาพที่ไม่เปลี่ยนอีกเลยนานขนาดนี้ ถือว่าเป็นภาพจริง ไม่ใช่ Preview ระหว่างสร้าง */
  const IMAGE_SETTLED_MS = 12000;

  /**
   * หาภาพไม่เจอเลยแต่หน้าเว็บนิ่งสนิทมานานขนาดนี้ = จบเทิร์นแล้วแน่ ๆ เพียงแต่เราหาไม่เจอ
   * ต้องปล่อยให้ชั้นบนรายงานว่าเห็นอะไรบ้าง ดีกว่าค้างจนครบ 5 นาทีแล้วนับเป็น timeout
   * ซึ่งไม่ได้บอกอะไรเลยและเผาโควตาลองใหม่ต่อทันที
   */
  const IMAGE_GIVEUP_MS = 45000;

  /** ข้อความไม่ยาวขึ้นเลยนานขนาดนี้ ให้ถือว่าจบ แม้ปุ่มหยุดจะยังบอกว่ากำลังพ่นอยู่ */
  const STUCK_MS = 25000;

  function waitForAnswer(
    turnId,
    anchor,
    {
      quietMs = 1800,
      timeoutMs = 300000,
      startMs = 120000,
      minAssistantCount = 0,
      wantImages = false,
      imageKey = () => '',
    } = {},
  ) {
    return new Promise((resolve) => {
      const root = $(S.turnContainer) || document.body;
      const t0 = Date.now();
      let started = false;
      let lastLen = -1;
      let stableSince = 0;
      let barLen = -1;
      let nudge = 0;
      let imgSig = '';
      let imgSince = 0;
      let stuckSince = 0;
      let done = false;

      const finish = (status) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(hb);
        clearTimeout(nudge);
        resolve(status);
      };

      // คำตอบใหม่คือคำตอบที่อยู่หลังข้อความที่เราเพิ่งส่ง ตรวจได้ทันทีโดยไม่ต้องรอ
      // minAssistantCount เป็นตัวกันพลาดเฉพาะกรณีที่ปักหมุดไม่สำเร็จเท่านั้น
      const isNew = () => !!assistantAfter(anchor) && $$(S.assistantTurn).length >= minAssistantCount;

      const check = () => {
        if (done) return;
        if (hitLimit()) return finish('rate_limited');
        if ($(S.errorRetry)) return finish('error');

        if (!started) {
          if (isNew()) {
            started = true;
            report(turnId, 'streaming');
          } else if (Date.now() - t0 > startMs) {
            return finish('no_response');
          }
          return;
        }

        const turn = assistantAfter(anchor);
        if (!turn) return;

        // ยังคิดอยู่ ไม่ว่าหน้าเว็บจะนิ่งแค่ไหนก็ยังไม่ใช่คำตอบ
        if (isThinkingOnly(turn) && !turn.querySelector('img')) return;

        const len = (turn.innerText || '').length;
        const hasImg = !!turn.querySelector('img');

        const bar = actionBarFor(turn);

        // ยังพ่นอยู่ — แต่ถ้าแถบปุ่มของ "คำตอบนี้" โผล่แล้ว แปลว่าคำตอบนี้จบแน่นอน
        // ปุ่มหยุดที่ยังเจอตอนนั้นจึงเป็นของเทิร์นอื่นหรือของที่ค้างใน DOM ไม่ใช่หลักฐานอีกต่อไป
        if (!bar && stopButtonVisible()) {
          /**
           * ด่านกันค้างสำหรับเทิร์นข้อความ
           *
           * ถ้าปุ่มหยุดบอกว่า "ยังพ่นอยู่" แต่ความยาวข้อความไม่ขยับเลยนานมาก
           * ให้เชื่อข้อความ ไม่ใช่เชื่อปุ่ม เพราะปุ่มที่ค้างใน DOM หรือปุ่มที่จับผิดตัว
           * จะทำให้เทิร์นไม่มีวันจบ ต้องรอจนหมดเวลา 5 นาทีแล้วนับเป็น timeout ทุกครั้ง
           * ผลปลายทางคือตอนนั้นถูกบันทึกเป็นตอนว่าง แล้วเล่มออกมาเป็นหน้าเปล่า
           */
          if (len > 0 && len === lastLen) {
            if (!stuckSince) stuckSince = Date.now();
            if (Date.now() - stuckSince >= STUCK_MS) return finish('ok');
          } else {
            stuckSince = 0;
          }
          stableSince = 0;
          lastLen = len;
          return;
        }
        stuckSince = 0;
        /**
         * เทิร์นสร้างภาพต้องใช้เกณฑ์คนละชุด
         *
         * คำตอบของ ChatGPT ตอนสร้างภาพมักไม่มีข้อความเลย (ยาว 0 ตัวอักษร) และภาพจริง
         * ถูกวาดนอกกล่อง [data-message-author-role="assistant"] ด้วย
         * ถ้าใช้เกณฑ์ "ต้องมีข้อความ" แบบเทิร์นปกติ จะรอสิ่งที่ไม่มีวันมาจนหมดเวลา 5 นาทีทุกครั้ง
         * แล้วจบเป็น timeout → machine ลองใหม่ → เจอแบบเดิม → "ปกหน้า: ไม่พบไฟล์ภาพ"
         * นี่คือสาเหตุที่ Phase 2 ไม่เคยสร้างปกได้สักครั้ง
         */
        // เลิกใช้แล้วสำหรับเทิร์นสร้างภาพ — runTurn แยกไปใช้ pollForImage ก่อนถึงตรงนี้
        // เก็บไว้เผื่อกรณีที่เรียก waitForAnswer ตรง ๆ พร้อม wantImages จากที่อื่นในอนาคต
        if (wantImages) {
          /**
           * เทิร์นสร้างภาพต้องจบให้ได้เสมอ ไม่ว่าจะหาภาพเจอหรือไม่
           *
           * นาฬิกา "นิ่ง" เดินตามการเปลี่ยนของ (ความยาวข้อความ + รายการภาพ) อย่างเดียว
           * ห้ามให้ปุ่มหยุดที่กะพริบตอนหน้าเว็บ re-render มารีเซ็ตทิ้ง ไม่งั้นไม่มีวันครบเกณฑ์
           */
          const key = imageKey();
          const sig = `${len}|${key}`;
          if (sig !== imgSig) {
            imgSig = sig;
            imgSince = Date.now();
          }

          // แถบปุ่มโผล่ = คำตอบจบ แต่ต้องยืนยันอีกจังหวะสั้น ๆ ว่าไม่โตต่อจริง
          // เหมือนที่เทิร์นข้อความทำ ไม่งั้นแถบปุ่มที่โผล่ผิดจังหวะจะตัดคำตอบกลางคัน
          if (bar) {
            if (barLen === len) return finish('ok');
            barLen = len;
            clearTimeout(nudge);
            nudge = setTimeout(check, 150);
            return;
          }
          barLen = -1;

          // เจอภาพแล้วและนิ่ง → จบเร็ว · ไม่เจอเลยแต่นิ่งนานมาก → เลิกรอแล้วให้ชั้นบนรายงานหลักฐาน
          const need = key ? IMAGE_SETTLED_MS : IMAGE_GIVEUP_MS;
          if (!stopButtonVisible() && Date.now() - imgSince >= need) return finish('ok');
          return;
        }

        if (len === 0 && !hasImg) return; // ยังไม่มีอะไรเลย รอต่อ

        // สัญญาณตรงว่าจบแล้ว: แถบปุ่มใต้คำตอบโผล่ขึ้นมา
        // ยืนยันอีกจังหวะสั้น ๆ ว่าข้อความไม่โตต่อแล้วจริง กันกรณีที่หน้าเว็บโชว์แถบปุ่ม
        // ของช่วงค้นเว็บหรือของข้อความก่อนหน้า แล้วเราไปอ่านคำตอบที่ยังไม่จบมา
        if (bar) {
          if (barLen === len) return finish('ok');
          barLen = len;
          clearTimeout(nudge);
          nudge = setTimeout(check, 120); // เสี้ยววินาที ไม่ใช่วินาที
          return;
        }
        barLen = -1;

        // สำรองเผื่อเว็บเปลี่ยนโครงสร้างจนหาแถบปุ่มไม่เจอ ค่อยถอยไปใช้เกณฑ์ "ข้อความหยุดยาว"
        if (len !== lastLen) {
          lastLen = len;
          stableSince = Date.now();
          return;
        }
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince < quietMs) return;

        finish('ok');
      };

      const obs = new MutationObserver(check);
      obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

      /**
       * บอกให้เห็นกับตาว่า "รออะไรอยู่" ระหว่างที่ยังไม่จบ
       * ถ้าเทิร์นค้างอีก จะรู้ทันทีว่าติดด่านไหน โดยไม่ต้องเดาหรือเปิด DevTools
       */
      const diag = () => {
        const turn = assistantAfter(anchor);
        return [
          started ? 'เห็นคำตอบใหม่แล้ว' : 'ยังไม่เห็นคำตอบใหม่',
          `ยาว ${turn ? (turn.innerText || '').length : 0} ตัวอักษร`,
          stopButtonVisible() ? 'ยังพ่นอยู่' : 'หยุดพ่นแล้ว',
          turn && actionBarFor(turn) ? 'เจอแถบปุ่มแล้ว' : 'ยังไม่เจอแถบปุ่ม',
          wantImages ? `ภาพใหม่ ${(imageKey() || '').split('|').filter(Boolean).length} รูป` : '',
          wantImages && imgSince
            ? `นิ่งมา ${Math.round((Date.now() - imgSince) / 1000)}/${(imgSig.split('|')[1] ? IMAGE_SETTLED_MS : IMAGE_GIVEUP_MS) / 1000} วินาที`
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
      };

      const hb = setInterval(() => {
        check();
        if (Date.now() - t0 > timeoutMs) finish('timeout');
        else report(turnId, 'waiting', Math.round((Date.now() - t0) / 1000), diag());
      }, 1000);

      check();
    });
  }

  // ---------- ดึงเนื้อหากลับ ----------
  function readAnswer(anchor) {
    const turn = assistantAfter(anchor) || lastAssistantTurn();
    if (!turn) return { text: '', blocks: 0 };
    const codes = $$(S.codeBlock, turn);
    if (codes.length) {
      // ใช้บล็อกโค้ดทั้งหมดต่อกัน เผื่อโมเดลแตกเป็นหลายบล็อก
      return { text: codes.map((c) => c.textContent).join('\n'), blocks: codes.length };
    }
    // ไม่มีบล็อกโค้ด — คืนข้อความล้วนให้ชั้นบนตัดสินใจ
    return { text: turn.innerText || '', blocks: 0 };
  }

  /**
   * เก็บรายการภาพก่อนส่ง เพื่อให้รู้ว่าภาพไหนเป็นของใหม่
   * จำเป็นเพราะ ChatGPT แสดงภาพที่สร้างในหน้าต่างแคนวาสแยก ไม่ได้อยู่ในกล่องคำตอบ
   * การไล่หาเฉพาะใน [data-message-author-role="assistant"] จึงไม่เจอ
   */
  function imageSources(img) {
    const out = [img.currentSrc, img.src, img.getAttribute('src')];
    const srcset = img.getAttribute('srcset') || '';
    for (const part of srcset.split(',')) {
      const src = part.trim().split(/\s+/)[0];
      if (src) out.push(src);
    }
    return [...new Set(out.filter(Boolean))];
  }

  function snapshotImages() {
    const elements = $$('img');
    return {
      // จำทั้ง URL และ DOM element เพราะหน้าสร้างภาพของ ChatGPT บางครั้งสร้าง <img> ใหม่
      // แต่ใช้ blob/CDN URL เดิมหรือสลับ currentSrc ภายหลัง ถ้าจำแต่ URL ภาพที่ 2 จะถูกมองว่าเป็นภาพเก่า
      sources: new Set(elements.flatMap(imageSources)),
      elements: new Set(elements),
    };
  }

  /**
   * หาภาพที่ "เทิร์นนี้สร้างขึ้นมา" จากในบทสนทนา
   *
   * เดิมคัดด้วยรายชื่อโดเมนอย่างเดียว (oaiusercontent / /sandbox/ / /files/) ซึ่งพังทันที
   * ที่ ChatGPT เปลี่ยนที่เก็บไฟล์ภาพ เพราะภาพจริงจะถูกทิ้งทั้งหมดแล้วรายงานว่า "ไม่พบไฟล์ภาพ"
   *
   * เกณฑ์ใหม่ยึดตำแหน่งแทนชื่อโดเมน: ต้องอยู่ในกล่องบทสนทนา อยู่หลังข้อความที่เราเพิ่งส่ง
   * และเป็นของใหม่ในเทิร์นนี้ — ภาพโปรโมท/ไอคอนในไซด์บาร์จึงเข้าเงื่อนไขไม่ได้อยู่แล้ว
   * ส่วนชื่อโดเมนเหลือไว้เป็นแค่ตัวจัดลำดับความน่าเชื่อถือ ไม่ใช่ประตูปิดตาย
   */
  function scanImages(before = { sources: new Set(), elements: new Set() }, anchor = null) {
    const beforeSources = before?.sources instanceof Set ? before.sources : before instanceof Set ? before : new Set();
    const beforeElements = before?.elements instanceof Set ? before.elements : new Set();
    const scope = $(S.turnContainer) || document.body;
    const cand = [];
    const seen = [];

    for (const i of $$('img', scope)) {
      if (anchor && !(anchor.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const w = i.naturalWidth || 0;
      const h = i.naturalHeight || 0;
      const src0 = i.currentSrc || i.src || i.getAttribute('src') || '';
      const newElement = !beforeElements.has(i);
      // เก็บไว้รายงานตอนหาไม่เจอ จะได้รู้ว่าหน้าเว็บให้อะไรมาจริง ๆ
      seen.push(`${w}x${h}${i.complete ? '' : ' (ยังโหลดไม่เสร็จ)'}${newElement ? '' : ' (ของเดิม)'} ${src0.slice(0, 110)}`);

      // ภาพที่ยังโหลด/เรนเดอร์ไม่เสร็จห้ามนับ ไม่งั้นจะได้ภาพตัวอย่างเบลอ ๆ ระหว่างสร้าง
      if (!i.complete || !w) continue;

      for (const src of imageSources(i)) {
        // ภาพถือว่าใหม่ถ้า URL ใหม่ หรือเป็น DOM element ที่เพิ่งเกิดในเทิร์นนี้
        if (!newElement && beforeSources.has(src)) continue;
        const hosted =
          /:\/\/(?:[a-z0-9-]+\.)*oaiusercontent\.com(?::\d+)?\//i.test(src) ||
          /\/(?:sandbox|files|backend-api)\//i.test(src);
        const blobOrData = /^blob:|^data:image\//.test(src);
        // ที่ไม่ได้มาจากที่เก็บไฟล์ของ ChatGPT ต้องใหญ่พอจะเป็นภาพที่สร้างขึ้นจริง ไม่ใช่ไอคอน
        if (!hosted && !blobOrData && Math.min(w, h) < 256) continue;
        const fetchable = /^https?:/.test(src) ? 1 : 0;
        const dataUrl = /^data:image\//.test(src) ? 1 : 0;
        cand.push({
          src,
          score: (hosted ? 1 : 0) * 1000000000000 + fetchable * 100000000000 + dataUrl * 50000000000 + w * h,
        });
      }
    }

    cand.sort((a, b) => b.score - a.score);
    return { images: [...new Set(cand.map((x) => x.src))], seen };
  }

  function readImages(before, anchor) {
    return scanImages(before, anchor).images;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('image_filereader_failed'));
      fr.readAsDataURL(blob);
    });
  }

  /**
   * ดึง bytes ของภาพในบริบทหน้า ChatGPT ก่อนส่งผลกลับ Studio
   * สำคัญกับภาพที่ 2+ เพราะหน้าเว็บบางครั้งให้ blob: URL ซึ่ง Studio/extension page fetch ไม่ได้
   * แต่ content script ที่อยู่กับหน้า ChatGPT ยังเข้าถึง blob นั้นได้
   */
  async function captureImageData(sources = []) {
    const errors = [];
    for (const src of sources) {
      try {
        if (/^data:image\//.test(src)) {
          return { dataUrl: src, src, type: src.slice(5, src.indexOf(';')) || 'image/*', bytes: 0 };
        }
        const res = await fetch(src, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!blob.size) throw new Error('empty_image_blob');
        // ยืนยันว่าเป็นภาพจริงก่อนส่งข้อมูลหลาย MB ผ่าน runtime messaging
        const bmp = await createImageBitmap(blob);
        const width = bmp.width;
        const height = bmp.height;
        bmp.close?.();
        if (width < 128 || height < 128) throw new Error(`image_too_small_${width}x${height}`);
        return {
          dataUrl: await blobToDataUrl(blob),
          src,
          type: blob.type || 'image/*',
          bytes: blob.size,
          width,
          height,
        };
      } catch (e) {
        errors.push(`${String(src).slice(0, 120)} => ${e?.message || e}`);
      }
    }
    return { dataUrl: '', src: '', errors };
  }

  /**
   * คำตอบแบบสร้างภาพมักมีข้อความตอบมาก่อน แล้วรูปจริงค่อย render ทีหลังหลายวินาที
   * ถ้าอ่าน DOM ทันทีจะได้ res.images=[] ทั้งที่ผู้ใช้เห็นรูปอยู่บนจอในภายหลัง
   * จึงรอ "ภาพใหม่ที่มีขนาดจริง" ให้เสถียรก่อนส่งผลกลับ Studio
   */
  function waitForImages(before = new Set(), { timeoutMs = 240000, settleMs = 1000, anchor = null } = {}) {
    return new Promise((resolve) => {
      let done = false;
      let lastKey = '';
      let settleTimer = 0;
      // ไม่เจอภาพเลยก็ต้องเลิกรอ ไม่ใช่นั่งรอจนครบ 4 นาทีทั้งที่เทิร์นจบไปแล้ว
      const giveUp = setTimeout(finishIfEmpty, IMAGE_GIVEUP_MS);
      function finishIfEmpty() {
        if (!done && !readImages(before, anchor).length) finish();
      }
      const finish = () => {
        if (done) return;
        done = true;
        obs.disconnect();
        document.removeEventListener('load', check, true);
        clearTimeout(settleTimer);
        clearTimeout(giveUp);
        clearTimeout(hardTimer);
        resolve(readImages(before, anchor));
      };
      const check = () => {
        // ยังพ่นอยู่ = ยังสร้างไม่เสร็จ อย่าเพิ่งหยิบของระหว่างทาง
        // (ต่างจากเทิร์นข้อความ ตรงนี้รอครู่เดียวคุ้มกว่าเยอะ เพราะหยิบพลาดทีเสียเวลาสร้างใหม่ทั้งรูป)
        if (stopButtonVisible()) return;
        const images = readImages(before, anchor);
        if (!images.length) return;
        const key = images.join('|');
        if (key === lastKey) return; // ไม่มีอะไรใหม่ ปล่อยให้ตัวจับเวลาที่ตั้งไว้ทำงาน
        lastKey = key;
        // ภาพอาจถูกสลับ src อีกครั้งหลังเรนเดอร์ กันไว้แค่แป๊บเดียวว่าไม่มีอันใหม่ตามมา
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, settleMs);
      };
      const obs = new MutationObserver(check);
      const hardTimer = setTimeout(finish, timeoutMs);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      document.addEventListener('load', check, true); // ภาพโหลดเสร็จไม่ได้ทำให้ DOM ขยับเสมอไป
      check();
    });
  }

  const napMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * วนหาภาพตั้งแต่วินาทีที่กดส่ง — เจอเมื่อไรเอาเมื่อนั้น
   *
   * ของเดิมถามคำถามที่ตอบยาก: "ChatGPT ตอบจบหรือยัง" ซึ่งหน้าเว็บไม่มีสัญญาณบอก
   * ต้องเดาจากความนิ่ง แล้วต้องรอให้แน่ใจทุกครั้ง (12 วิเมื่อเจอภาพ · 45 วิเมื่อไม่เจอ)
   * เดาผิดเมื่อไรก็ทิ้งทั้งเทิร์นทั้งที่ภาพวาดเสร็จอยู่บนจอ
   *
   * ตัวนี้ถามคำถามที่ตอบง่ายแทน: "ภาพมาหรือยัง" — เช็คตรง ๆ ได้ทุก 2.5 วินาที
   * ภาพมาก็เอาไปเลยไม่ต้องรอยืนยันอะไร ยังไม่มาก็รอต่อตราบใดที่หน้าเว็บยังขยับ
   * เลิกรอต่อเมื่อหน้าเว็บนิ่งสนิทและปุ่มหยุดหายไปแล้วจริง ๆ เท่านั้น
   * ผลคือทั้งเร็วขึ้นและพลาดยากขึ้นพร้อมกัน ไม่ต้องแลกกัน
   */
  /**
   * ข้อความที่ ChatGPT ใช้บอกว่า "เครื่องมือสร้างภาพของฉันเองล้มเหลว"
   *
   * เจอแล้วไม่ต้องรออะไรอีก ภาพจะไม่มาแน่นอน การนั่งรออีกหกสิบวินาทีเพื่อยืนยัน
   * สิ่งที่มันบอกไปแล้วคือการเสียเวลาเปล่า และทำให้ผู้ใช้เห็นหน้าจอค้างโดยไม่จำเป็น
   */
  const GEN_FAILED = /something went wrong while generating your image|error generating image|image generation failed|เกิดข้อผิดพลาดขณะสร้างภาพ|สร้างภาพไม่สำเร็จ/i;

  async function pollForImage(
    turnId,
    anchor,
    before,
    { intervalMs = 2500, timeoutMs = 300000, idleGiveUpMs = 60000, startMs = 120000 } = {},
  ) {
    const t0 = Date.now();
    let lastSig = '';
    let lastChange = Date.now();
    let started = false;
    let lastCaptureErrors = [];

    while (Date.now() - t0 < timeoutMs) {
      if (hitLimit()) return { status: 'rate_limited', seen: [] };
      if ($(S.errorRetry)) return { status: 'error', seen: [] };

      const scan = scanImages(before, anchor);
      if (scan.images.length) {
        const captured = await captureImageData(scan.images);
        // เห็นภาพแล้วแต่ไฟล์ยังดึงไม่ได้ = ยังโหลดไม่เสร็จ รอรอบหน้า ไม่ใช่ความล้มเหลว
        if (captured.dataUrl) return { status: 'ok', images: scan.images, captured, seen: scan.seen };
        // แต่ต้องจำเหตุผลไว้ ถ้าสุดท้ายดึงไม่ได้เลยจะได้บอกได้ว่าติดตรงไหน
        // ไม่ใช่รายงานว่า "ไม่พบภาพ" ทั้งที่ภาพอยู่บนจอให้เห็นชัด ๆ
        lastCaptureErrors = captured.errors || lastCaptureErrors;
      }

      const turn = assistantAfter(anchor);
      if (turn && !stopButtonVisible() && GEN_FAILED.test(turn.innerText || '')) {
        return { status: 'generation_failed', seen: scan.seen, errors: lastCaptureErrors };
      }
      if (!started && (turn || stopButtonVisible())) started = true;
      if (!started && Date.now() - t0 > startMs) return { status: 'no_response', seen: scan.seen };

      // ลายเซ็นของ "หน้าเว็บกำลังขยับอยู่" — ข้อความยาวขึ้น ภาพโผล่เพิ่ม หรือยังพ่นอยู่
      // ลายเซ็นของ "หน้าเว็บกำลังขยับ" ต้องดูที่เนื้อหาจริงเท่านั้น
      // ปุ่มหยุดเป็นแค่ตัวช่วยตัดสินใจ ห้ามให้มันเป็นส่วนหนึ่งของลายเซ็น
      // ไม่งั้นปุ่มที่กะพริบตอน re-render จะรีเซ็ตนาฬิกานิ่งทิ้งเรื่อย ๆ จนไม่มีวันครบเกณฑ์
      const sig = `${(turn?.innerText || '').length}|${scan.seen.length}`;
      if (sig !== lastSig) {
        lastSig = sig;
        lastChange = Date.now();
      }
      const idleFor = Date.now() - lastChange;
      if (!stopButtonVisible() && idleFor >= idleGiveUpMs) {
        return { status: 'no_image', seen: scan.seen, errors: lastCaptureErrors };
      }
      /**
       * ด่านกันค้างขั้นสุดท้าย
       *
       * ถ้าหน้าเว็บไม่ขยับเลยนานเป็นสามเท่าของเกณฑ์ปกติ ก็เลิกรอ ไม่ว่าปุ่มหยุดจะบอกว่าอะไร
       * เพราะถึงตอนนั้นปุ่มหยุดที่ยังเห็นอยู่คือปุ่มที่ค้างใน DOM ไม่ใช่หลักฐานว่ายังทำงานอยู่
       */
      if (idleFor >= idleGiveUpMs * 3) {
        return { status: 'no_image', seen: scan.seen, errors: lastCaptureErrors };
      }

      report(
        turnId,
        'waiting',
        Math.round((Date.now() - t0) / 1000),
        [
          started ? 'เห็นคำตอบแล้ว' : 'ยังไม่เห็นคำตอบ',
          stopButtonVisible() ? 'ยังพ่นอยู่' : 'หยุดพ่นแล้ว',
          `ภาพในคำตอบ ${scan.images.length} รูป`,
          `นิ่งมา ${Math.round((Date.now() - lastChange) / 1000)}/${idleGiveUpMs / 1000} วินาที`,
        ].join(' · '),
      );
      await napMs(intervalMs);
    }
    return { status: 'timeout', seen: scanImages(before, anchor).seen };
  }

  /**
   * รอให้ "ช่องพิมพ์ตัวเดิม" อยู่นิ่งจริง ไม่ใช่แค่โผล่มา
   *
   * หลังกดเริ่มแชตใหม่ ChatGPT ยังวาดหน้าไม่จบ — ช่องพิมพ์โผล่มาก่อน แล้วถูกสร้างใหม่
   * อีกรอบเมื่อ route ลงตัว ถ้าเราพิมพ์ Prompt ลงไปในจังหวะระหว่างนั้น
   * ข้อความจะถูกล้างทิ้งพร้อมกับ element เก่า เห็นเป็น "วาง Prompt แล้วขึ้นแชตใหม่ทันที"
   * แล้ววนแบบนั้นไปเรื่อย ๆ เพราะรอบใหม่ก็เจอจังหวะเดิม
   */
  async function waitComposerStable(quietMs = 900, timeoutMs = 10000) {
    const t0 = Date.now();
    let last = null;
    let since = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const box = $(S.composer);
      if (box && box === last) {
        if (Date.now() - since >= quietMs) return box;
      } else {
        last = box;
        since = Date.now();
      }
      await napMs(120);
    }
    return $(S.composer);
  }

  // ---------- เธรดใหม่ ----------
  /**
   * เปิดเธรดใหม่ให้ "เกิดขึ้นจริง" ก่อนคืนค่า
   *
   * แค่ช่องพิมพ์โผล่ยังไม่พอ เพราะช่องพิมพ์ของเธรดเดิมยังอยู่ในหน้าระหว่างกำลังเปลี่ยนเธรด
   * ถ้าคืนค่าตอนนั้นแล้วพิมพ์ทันที Prompt จะหล่นลงเธรดเก่าหรือหายไปพร้อมการเปลี่ยนหน้า
   * เทิร์นแรกของ Phase 2 (ปกหน้า) เป็นเทิร์นเดียวที่เปิดเธรดใหม่ จึงเป็นรูปที่พลาดซ้ำ ๆ อยู่รูปเดียว
   *
   * หลักฐานว่าเปลี่ยนเธรดแล้วจริง: URL เปลี่ยน หรือบทสนทนาถูกล้างจนว่าง
   */
  async function newThread({ mustBeEmpty = false } = {}) {
    const beforeUrl = location.href;
    const beforeTurns = $$(S.assistantTurn).length;

    const clickNewChat = () => {
      const btn = $(S.newChatButton);
      if (btn) {
        btn.click();
        return true;
      }
      // สำรอง: หาเมนู/ปุ่มเริ่มแชตใหม่จากข้อความที่มองเห็น
      const visible = [...document.querySelectorAll('button,a')].find((el) => {
        if (el.offsetParent === null) return false;
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim();
        return /new chat|new conversation|แชตใหม่|แชทใหม่|สนทนาใหม่/i.test(label);
      });
      if (!visible) return false;
      visible.click();
      return true;
    };

    if (!clickNewChat()) return { ok: false, reason: 'หาปุ่มเริ่มแชตใหม่ในหน้า ChatGPT ไม่เจอ' };

    // ถ้าหน้าว่างอยู่แล้ว เงื่อนไขนี้เป็นจริงทันที ไม่มีการรอเปล่า
    const switched = await waitForDom(
      () =>
        location.href !== beforeUrl ||
        $$(S.assistantTurn).length < beforeTurns ||
        $$(S.assistantTurn).length === 0
          ? true
          : null,
      { timeoutMs: 10000 },
    );
    if (!(await waitForComposer(20000))) return { ok: false, reason: 'ช่องพิมพ์ของห้องแชตใหม่ยังไม่พร้อม' };

    /**
     * ผลของการรอเคยถูกทิ้ง ทำให้คลิกไม่ติดแล้วเดินต่อเงียบ ๆ ในห้องเดิม
     *
     * นี่คือหลุมที่อธิบายอาการ "เครื่องมือสร้างภาพตีความว่าเป็นงานแก้ไขภาพ" ได้ตรงที่สุด
     * เพราะห้องเดิมมีภาพของรูปก่อนหน้าค้างอยู่ เครื่องมือจึงเข้าโหมดแก้ภาพเองโดยอัตโนมัติ
     * ต่อให้เขียนกำกับในคำสั่งหนักแค่ไหนก็ไม่ชนะบริบทของห้อง
     */
    const after = $$(S.assistantTurn).length;
    if (!switched && after > 0 && after >= beforeTurns) {
      return { ok: false, reason: `คลิกเริ่มแชตใหม่แล้วแต่ยังอยู่ห้องเดิม (คำตอบเดิมค้างอยู่ ${after} รายการ · URL ไม่เปลี่ยน)` };
    }
    /**
     * เทิร์นสร้างภาพต้องได้ห้องว่างจริงเท่านั้น
     *
     * ต้อง "รอ" ให้ว่าง ไม่ใช่เช็คแวบเดียวแล้วตัดสิน เพราะหน้า ChatGPT ยังวาดข้อความของห้องเดิม
     * ค้างไว้อีกเสี้ยววินาทีหลัง URL เปลี่ยนแล้ว ถ้าเช็คจังหวะนั้นจะฟ้องผิดทุกครั้ง
     */
    if (mustBeEmpty) {
      const empty = await waitForDom(() => ($$(S.assistantTurn).length === 0 ? true : null), { timeoutMs: 8000 });
      if (!empty) {
        return {
          ok: false,
          reason: `ห้องแชตใหม่ยังมีคำตอบเดิมค้างอยู่ ${$$(S.assistantTurn).length} รายการ — เครื่องมือสร้างภาพจะเข้าโหมดแก้ภาพเดิม`,
        };
      }
    }
    // ห้ามคืนค่าตอนหน้าเว็บยังวาดไม่จบ ไม่งั้น Prompt ที่พิมพ์ต่อจากนี้จะถูกล้างทิ้ง
    await waitComposerStable();
    return { ok: true };
  }

  // ---------- หนึ่งเทิร์นเต็ม ----------
  async function runTurn(turnId, prompt, opts = {}) {
    const t0 = Date.now();
    try {
      // ต้องรอหน้าเว็บพร้อมก่อนทุกอย่าง ไม่งั้นเทิร์นจะล้มทันทีเพราะหน้ายังวาดไม่เสร็จ
      report(turnId, 'waiting_ready', 'รอให้หน้า ChatGPT วาดช่องพิมพ์เสร็จก่อนส่งงาน');
      if (!(await waitForComposer(opts.readyTimeoutMs ?? 60000))) {
        return {
          turnId,
          status: 'error',
          text: '',
          meta: { error: 'chat_page_not_ready', url: location.href },
        };
      }

      if (opts.newThread) {
        report(turnId, 'new_thread');
        // เทิร์นสร้างภาพบังคับให้ห้องต้องว่างจริง ไม่งั้นเครื่องมือสร้างภาพจะเข้าโหมดแก้ภาพเดิม
        const nt = await newThread({ mustBeEmpty: !!opts.wantImages });
        if (!nt.ok) {
          report(turnId, 'new_thread_failed', nt.reason);
          return {
            turnId,
            status: 'error',
            text: '',
            meta: { error: 'new_thread_not_ready', detail: nt.reason, url: location.href },
          };
        }
      }
      if (hitLimit()) return { turnId, status: 'rate_limited', text: '' };

      const modelBefore = currentModel();
      if (opts.expectModel && modelBefore && !modelBefore.includes(opts.expectModel)) {
        return { turnId, status: 'wrong_model', text: '', meta: { model: modelBefore } };
      }

      const imgsBefore = opts.wantImages ? snapshotImages() : new Set();

      // ต้องรอให้เทิร์นก่อนหน้าจบสนิทก่อน ไม่งั้นปุ่มส่งจะยัง disabled แล้ว Prompt จะค้างในช่องพิมพ์
      report(turnId, 'waiting_idle', 'รอให้ ChatGPT ตอบเทิร์นก่อนหน้าจบก่อนส่งงานถัดไป');
      await waitUntilIdle();

      const userBefore = $$('[data-message-author-role="user"]').length;
      const assistantBefore = $$(S.assistantTurn).length;

      /**
       * แนบไฟล์ก่อนพิมพ์ข้อความเสมอ
       *
       * หน้าเว็บล้างช่องพิมพ์ทิ้งได้ตอนอัปโหลดรูปเสร็จแล้ววาดใหม่
       * ถ้าพิมพ์ก่อนแนบ Prompt ที่พิมพ์ไว้จะหายไปพร้อมการวาดใหม่นั้น
       */
      let attachment = null;
      if (opts.attachments?.length) {
        report(turnId, 'attaching', `กำลังแนบรูปอ้างอิง ${opts.attachments.length} ไฟล์`);
        attachment = await attachFiles(opts.attachments);
        report(
          turnId,
          'attaching',
          attachment.attached
            ? `แนบรูปอ้างอิงสำเร็จ ${attachment.attached} ไฟล์`
            : `แนบรูปอ้างอิงไม่สำเร็จ — ${attachment.errors[0] || 'ไม่ทราบสาเหตุ'}`,
        );
        await waitComposerStable(600, 8000);
      }

      report(turnId, 'typing', `กำลังส่ง Prompt ไป ChatGPT:\n${String(prompt).slice(0, 4000)}`);
      /**
       * เขียนข้อความไม่สำเร็จ ก็ต้องเดินต่อไปหาทางสำรองเหมือนกัน
       *
       * บทเรียนจากบั๊กเดียวกันที่ clickSend: ฟังก์ชันที่ throw จะพาออกไป catch ชั้นนอก
       * แล้วจบเทิร์นทันที ทางสำรองที่อยู่ถัดไปจึงเป็นโค้ดที่ไม่มีวันถูกเรียก
       * ถ้าเขียนลงช่องไม่ได้ ยังเหลือทางให้เบราว์เซอร์พิมพ์ให้ และทางให้ผู้ใช้พิมพ์เอง
       */
      let composerBox = null;
      try {
        composerBox = await injectText(prompt);
      } catch (e) {
        report(turnId, 'typing', `เขียนลงช่องพิมพ์ไม่สำเร็จ (${e?.message || e}) — จะลองทางสำรอง`);
        composerBox = $(S.composer);
      }

      /**
       * ยืนยันว่า Prompt ยังอยู่จริงหลังหน้าเว็บวาดเสร็จ
       *
       * การพิมพ์สำเร็จ ณ วินาทีนั้นไม่ได้แปลว่ามันจะยังอยู่ในวินาทีถัดไป
       * ChatGPT สร้างช่องพิมพ์ใหม่ได้ตลอดเวลา และข้อความหายไปพร้อมของเก่าแบบเงียบ ๆ
       * ถ้าไม่ตรวจซ้ำ ขั้นกดส่งจะไปกดกับช่องว่าง แล้วจบเป็น "ส่งไม่ออก" โดยไม่มีใครรู้สาเหตุ
       */
      for (let i = 0; i < 3; i++) {
        await napMs(450);
        const live = $(S.composer);
        if (live && (live.innerText || live.textContent || '').trim()) {
          composerBox = live;
          break;
        }
        report(turnId, 'typing', 'ช่องพิมพ์ถูกล้างตอนหน้าเว็บวาดใหม่ — พิมพ์ Prompt ซ้ำอีกครั้ง');
        await waitComposerStable(600, 6000);
        try {
          composerBox = await injectText(prompt);
        } catch (e) {
          report(turnId, 'typing', `พิมพ์ซ้ำไม่สำเร็จ (${e?.message || e})`);
          break;
        }
      }

      report(turnId, 'sending', 'กำลังกดส่งข้อมูลที่พิมพ์ลงใน ChatGPT');
      /**
       * กดส่งไม่สำเร็จ ต้อง "เดินต่อ" ไม่ใช่โยน error ทิ้งทั้งเทิร์น
       *
       * clickSend โยน send_action_not_accepted เมื่อกดไม่ติด ซึ่งวิ่งออกไปถึง catch ชั้นนอก
       * แล้วจบเทิร์นทันที — ทางสำรองทั้งหมดที่เขียนไว้ข้างล่าง (กดส่งซ้ำ, ให้เบราว์เซอร์
       * พิมพ์และกด Enter ให้, ขอให้ผู้ใช้กดเอง) จึงไม่เคยถูกเรียกใช้เลยสักครั้ง
       * นี่คือเหตุผลที่ระบบยังค้างเหมือนเดิมทั้งที่แก้ทางส่งไปหลายรอบ
       */
      try {
        await clickSend(composerBox);
      } catch (e) {
        report(turnId, 'sending', `กดส่งด้วยวิธีปกติไม่สำเร็จ (${e?.message || e}) — ลองทางสำรอง`);
      }

      // ปักหมุดที่ "ข้อความของเราที่เพิ่งเพิ่มขึ้นจริง" หน้าเว็บวาดให้แทบจะทันทีหลังกดส่ง
      // ถ้าปักไม่ได้ (เว็บเปลี่ยนโครงสร้าง) ค่อยถอยไปใช้ข้อความล่าสุด
      // แล้วบังคับเพิ่มว่าจำนวนคำตอบต้องมากขึ้นจริง กันการอ่านคำตอบเก่าซ้ำ
      let fresh = await waitForDom(
        () => {
          const t = $$('[data-message-author-role="user"]');
          return t.length > userBefore ? t[t.length - 1] : null;
        },
        { timeoutMs: 15000 },
      );

      /**
       * ยืนยันซ้ำว่า Prompt ถูกส่งจริง ก่อนจะไปนั่งรอคำตอบ
       *
       * ถ้าข้อความของเราไม่โผล่ในบทสนทนาเลย แปลว่ามันยังค้างอยู่ในช่องพิมพ์
       * การเดินหน้าไปรอคำตอบตรงนั้นคือการรอสิ่งที่ไม่มีวันมา แล้วจบเป็น timeout
       * เผาเวลาสองนาทีต่อครั้งโดยไม่มีใครรู้ว่าติดตรงไหน — ลองกดส่งซ้ำหนึ่งครั้ง
       * ถ้ายังไม่ไป ให้ล้มทันทีพร้อมบอกตรง ๆ ว่า Prompt ยังไม่ถูกส่ง
       */
      if (!fresh) {
        report(turnId, 'sending', 'ข้อความยังไม่โผล่ในบทสนทนา — กดส่งซ้ำอีกครั้ง');
        try {
          await clickSend(composerBox);
        } catch (_) {
          /* ค่อยไปสรุปด้วยหลักฐานข้างล่าง */
        }
        fresh = await waitForDom(
          () => {
            const t = $$('[data-message-author-role="user"]');
            return t.length > userBefore ? t[t.length - 1] : null;
          },
          { timeoutMs: 8000 },
        );
      }

      /**
       * กดส่งเองไม่ได้ ไม่ใช่เหตุผลที่จะทิ้งเทิร์น
       *
       * ปุ่มส่งของ ChatGPT เป็นของหน้าเว็บที่เราคุมไม่ได้จริง ๆ มันค้างเป็นวงกลมหมุนได้
       * และไม่มีท่าไหนใน DOM ที่บังคับให้มันยอมส่งได้ทุกครั้ง
       * แต่สิ่งหนึ่งที่ได้ผลเสมอคือคนกด Enter เอง — ใช้เวลาหนึ่งวินาที
       *
       * แทนที่จะล้มทั้งเทิร์นแล้วให้เริ่มใหม่ทั้งรอบ ให้ค้าง Prompt ไว้ในช่องอย่างนั้น
       * บอกผู้ใช้ว่าให้ไปกด Enter แล้วเฝ้าดูต่อ พอข้อความโผล่ในบทสนทนาก็เดินงานต่อเองทันที
       * ราคาของความล้มเหลวจึงเหลือแค่การกดปุ่มหนึ่งครั้ง ไม่ใช่ทั้งรอบงาน
       */
      /**
       * วิธีปกติแพ้แล้ว — ให้เบราว์เซอร์พิมพ์และกด Enter ให้เอง
       *
       * ล้างช่องก่อนเสมอ เพราะข้อความที่ค้างอยู่คือของที่ ProseMirror ไม่รู้จัก
       * ถ้าป้อนทับลงไปจะได้ข้อความซ้อนกันสองชุด
       */
      if (!fresh) {
        try {
          const composer = $(S.composer);
          if (composer) {
            composer.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await frame();
            composer.focus();
          }
          report(turnId, 'sending', 'กดส่งเองไม่ติด — ให้เบราว์เซอร์พิมพ์และกด Enter ให้แทน');
          const forced = await chrome.runtime.sendMessage({ type: 'sw.forceSend', text: prompt });
          if (forced?.ok) {
            fresh = await waitForDom(
              () => {
                const t = $$('[data-message-author-role="user"]');
                return t.length > userBefore ? t[t.length - 1] : null;
              },
              { timeoutMs: 12000 },
            );
            if (fresh) report(turnId, 'sending', 'ส่งสำเร็จด้วยช่องทางสำรองของเบราว์เซอร์');
          } else if (forced?.error) {
            report(turnId, 'sending', `ช่องทางสำรองส่งไม่ได้: ${forced.error}`);
          }
        } catch (e) {
          report(turnId, 'sending', `ช่องทางสำรองส่งไม่ได้: ${e?.message || e}`);
        }
      }

      if (!fresh) {
        const stuck = (($(S.composer)?.innerText || '').trim().length > 0);
        if (stuck) {
          const waitMs = opts.handoffMs ?? 180000;
          report(
            turnId,
            'awaiting_user_send',
            'กดส่งอัตโนมัติไม่ติด — Prompt อยู่ในช่องพิมพ์ของ ChatGPT แล้ว กด Enter ในแท็บนั้นหนึ่งครั้ง ระบบจะทำต่อเอง',
          );
          fresh = await waitForDom(
            () => {
              const t = $$('[data-message-author-role="user"]');
              return t.length > userBefore ? t[t.length - 1] : null;
            },
            { timeoutMs: waitMs },
          );
          if (fresh) report(turnId, 'sending', 'ผู้ใช้กดส่งเองแล้ว — ทำงานต่ออัตโนมัติ');
        }
      }

      if (!fresh) {
        const stuck = (($(S.composer)?.innerText || '').trim().length > 0);
        return {
          turnId,
          status: 'error',
          text: '',
          meta: {
            error: 'prompt_not_sent',
            detail: stuck
              ? 'Prompt อยู่ในช่องพิมพ์ของ ChatGPT แล้วแต่กดส่งไม่ติด และรอผู้ใช้กด Enter จนหมดเวลา'
              : 'กดส่ง Prompt แล้วแต่ข้อความไม่โผล่ในบทสนทนา',
            url: location.href,
          },
        };
      }

      const anchor = fresh;
      const minAssistantCount = 0;

      /**
       * เทิร์นสร้างภาพใช้เส้นทางของตัวเอง ไม่ต้องผ่านตัวเดาว่า "ตอบจบหรือยัง" อีกแล้ว
       * สิ่งที่เทิร์นนี้ต้องการมีอย่างเดียวคือไฟล์ภาพ เจอแล้วก็จบงาน ไม่ต้องสนใจอย่างอื่น
       */
      if (opts.wantImages) {
        report(turnId, 'waiting', 0);
        const r = await pollForImage(turnId, anchor, imgsBefore, {
          intervalMs: opts.imagePollMs ?? 2500,
          timeoutMs: opts.imageTimeoutMs ?? 300000,
          idleGiveUpMs: opts.imageIdleMs ?? 60000,
          startMs: opts.startMs ?? 120000,
        });
        if (r.status === 'rate_limited') return { turnId, status: 'rate_limited', text: '' };

        const { text: imgText, blocks: imgBlocks } = readAnswer(anchor);
        const captured = r.captured || { dataUrl: '', src: '', errors: [] };
        const images = r.images || [];
        report(
          turnId,
          'received',
          `จบเทิร์นสร้างภาพ (${r.status}) · ${images.length} ภาพ${captured.dataUrl ? ' · ดึงไฟล์แล้ว' : ''}\n${String(imgText).slice(0, 2000)}`,
        );
        return {
          turnId,
          status: captured.dataUrl || images.length ? 'ok' : r.status === 'error' ? 'error' : 'ok',
          text: imgText,
          images,
          imageDataUrl: captured.dataUrl || '',
          meta: {
            model: modelBefore,
            blocks: imgBlocks,
            ms: Date.now() - t0,
            imageCapture: {
              src: captured.src || images[0] || '',
              bytes: captured.bytes || 0,
              type: captured.type || '',
              width: captured.width || 0,
              height: captured.height || 0,
              errors: captured.errors?.length ? captured.errors : r.errors || [],
              reason: r.status,
              seen: images.length ? [] : (r.seen || []).slice(-6),
            },
          },
        };
      }

      report(turnId, 'waiting', 0);
      const status = await waitForAnswer(turnId, anchor, {
        quietMs: opts.quietMs ?? 1800,
        timeoutMs: opts.timeoutMs ?? 300000,
        startMs: opts.startMs ?? 120000,
        minAssistantCount,
        wantImages: !!opts.wantImages,
        imageKey: () => readImages(imgsBefore, anchor).join('|'),
      });

      if (status !== 'ok') return { turnId, status, text: '', meta: { model: modelBefore } };

      const { text, blocks } = readAnswer(anchor);
      const images = opts.wantImages
        ? await waitForImages(imgsBefore, { timeoutMs: opts.imageTimeoutMs ?? 240000, anchor })
        : [];
      const captured = opts.wantImages && images.length
        ? await captureImageData(images)
        : { dataUrl: '', src: '', errors: [] };
      report(
        turnId,
        'received',
        `ได้รับคำตอบจาก ChatGPT แล้ว (${text.length.toLocaleString()} ตัวอักษร · ${images.length} ภาพ${captured.dataUrl ? ' · ดึงไฟล์ภาพแล้ว' : ''}):\n${String(text).slice(0, 5000)}`,
      );

      return {
        turnId,
        // งานสร้างภาพถือว่าสำเร็จเมื่อจับภาพใหม่ได้ แม้คำตอบจะไม่มีข้อความเลย
        status: text.trim() || images.length || captured.dataUrl ? 'ok' : 'empty',
        text,
        images,
        // ส่ง bytes ของภาพที่ดึงจากหน้า ChatGPT โดยตรง เพื่อไม่ให้ Studio ต้อง fetch blob: URL ข้าม origin
        imageDataUrl: captured.dataUrl || '',
        meta: {
          model: currentModel(),
          blocks,
          ms: Date.now() - t0,
          // ฝั่ง Studio ต้องรู้ว่ารูปอ้างอิงเข้าไปถึง ChatGPT จริงไหม ไม่ใช่เดาเอาจากที่สั่งไป
          attachment,
          imageCapture: opts.wantImages
            ? {
                src: captured.src || images[0] || '',
                bytes: captured.bytes || 0,
                type: captured.type || '',
                width: captured.width || 0,
                height: captured.height || 0,
                errors: captured.errors || [],
                // หาภาพไม่เจอ ต้องบอกว่าหน้าเว็บมีภาพอะไรอยู่บ้าง ไม่ใช่เงียบแล้วบอกแค่ "ไม่พบไฟล์ภาพ"
                seen: images.length ? [] : scanImages(imgsBefore, anchor).seen.slice(-6),
              }
            : undefined,
        },
      };
    } catch (e) {
      // ข้อความของ error ที่เราโยนเองเป็นรหัสอยู่แล้ว (send_action_not_accepted ฯลฯ)
      // ชั้นบนใช้รหัสนี้แยกว่า "ล้มก่อนเสียโควตา" หรือ "ล้มหลังคุยกับ ChatGPT แล้ว"
      const code = String(e?.message || e);
      return { turnId, status: 'error', text: '', meta: { error: code, detail: code, url: location.href } };
    }
  }

  // ---------- ตรวจสุขภาพ selector ----------
  async function healthcheck() {
    const found = {};
    for (const [k, sel] of Object.entries(S)) found[k] = !!$(sel);
    const critical = ['composer'];
    const missing = critical.filter((k) => !found[k]);
    return { ok: missing.length === 0, found, missing, model: currentModel(), url: location.href };
  }

  // ---------- รับคำสั่ง ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'gpt.ping') {
      sendResponse({ ok: true, url: location.href });
      return false;
    }
    if (msg?.type === 'gpt.health') {
      healthcheck().then(sendResponse);
      return true;
    }
    /**
     * ทางมือ: ผู้ใช้เห็นกับตาว่าภาพเสร็จแล้ว แล้วสั่งให้ไปคว้ามาเดี๋ยวนี้
     * ไม่ต้องพึ่งตัวตรวจจับใด ๆ ซึ่งเป็นจุดที่พังบ่อยที่สุดของทั้งระบบ
     */
    if (msg?.type === 'gpt.grabImage') {
      (async () => {
        const empty = { sources: new Set(), elements: new Set() };
        const scan = scanImages(empty, lastUserTurn());
        if (!scan.images.length) {
          sendResponse({ ok: false, error: 'ไม่พบภาพในคำตอบล่าสุดของหน้านี้', seen: scan.seen.slice(-6) });
          return;
        }
        const captured = await captureImageData(scan.images);
        if (!captured.dataUrl) {
          sendResponse({ ok: false, error: `ดึงไฟล์ภาพไม่สำเร็จ: ${captured.errors?.[0] || 'ไม่ทราบสาเหตุ'}` });
          return;
        }
        sendResponse({ ok: true, dataUrl: captured.dataUrl, width: captured.width, height: captured.height, bytes: captured.bytes });
      })();
      return true;
    }

    if (msg?.type === 'gpt.run') {
      // ตอบรับทันที แล้วส่งผลกลับทีหลังเป็น gpt.result
      sendResponse({ ok: true, accepted: msg.turnId });
      runTurn(msg.turnId, msg.prompt, msg.opts).then((res) => {
        chrome.runtime.sendMessage({ type: 'gpt.result', ...res }).catch(() => {});
      });
      return false;
    }
    return false;
  });
})();
