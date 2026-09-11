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
    assistantTurn: '[data-message-author-role="assistant"], [data-turn="assistant"]:not(:has([data-message-author-role="assistant"]))',
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
    attachmentRemove:
      'button[aria-label*="remove" i], button[aria-label*="delete" i], button[aria-label*="ลบ" i], button[data-testid*="remove" i], button[data-testid*="delete" i]',
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

  /**
   * โควตาภาพหมด — ประกาศที่ไม่เหมือนลิมิตอื่นเลยสองอย่าง
   *
   * หนึ่ง มันมาเป็น "คำตอบของ ChatGPT" ในกล่องสนทนา ไม่ใช่แถบแจ้งเตือนนอกกล่อง
   * ตัวจับลิมิตเดิมจึงมองไม่เห็น เพราะมันตัดทุกอย่างที่อยู่ในข้อความสนทนาทิ้งตั้งแต่ต้น
   * (ซึ่งถูกแล้วสำหรับกรณีอื่น เพราะเนื้อหาหนังสือเองก็พูดถึงคำว่า usage limit ได้)
   *
   * สอง มันบอกเวลาเป็นตัวเลข "try again in 4 hours" ไม่ใช่ "try again later"
   * วลีเดิมทุกตัวจึงไม่ตรงสักตัว
   *
   * ผลที่เกิดจริงคือเราอ่านมันเป็นคำตอบธรรมดาที่บังเอิญไม่มีภาพ แล้วสั่งวาดใหม่วนไป
   * ทั้งที่อีกสี่ชั่วโมงข้างหน้าไม่มีทางได้ภาพสักใบ
   */
  const IMAGE_QUOTA_PATTERNS = [
    /out of image generation/i,
    /image generation (?:messages|limit)/i,
    /no more image generations?/i,
    /(?:reached|hit) [^.]{0,40}image generation/i,
    /โควตา[^.\n]{0,20}(?:ภาพ|รูป)/,
    /สร้าง(?:ภาพ|รูป)[^.\n]{0,20}ครบ/,
  ];

  /**
   * คืนข้อความประกาศถ้าคำตอบนี้คือ "โควตาภาพหมด" ไม่ใช่คำตอบจริง
   *
   * กันจับผิดตัวด้วยความยาวก่อนเสมอ: ประกาศของหน้าเว็บเป็นประโยคเดียวสั้น ๆ
   * ส่วนคำตอบจริงที่พูดถึงเรื่องโควตาได้ (เช่นเนื้อหาหนังสือ) จะยาวกว่านี้มาก
   * และตัวนี้ถูกเรียกเฉพาะตอนเทิร์นวาดภาพไม่ได้ภาพกลับมาเท่านั้น
   */
  function imageQuotaNotice(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 400) return '';
    return IMAGE_QUOTA_PATTERNS.some((re) => re.test(t)) ? t.replace(/\s+/g, ' ').slice(0, 200) : '';
  }

  let S = { ...DEFAULT_SELECTORS };
  let LIMITS = [...DEFAULT_LIMIT_PATTERNS];

  chrome.storage.local.get(['selectors', 'limitPatterns']).then((o) => {
    if (o.selectors) S = { ...DEFAULT_SELECTORS, ...o.selectors };
    // Migrate the old saved selector too: image-only replies now use data-turn.
    if (S.assistantTurn === '[data-message-author-role="assistant"]') {
      S.assistantTurn = DEFAULT_SELECTORS.assistantTurn;
    }
    if (o.limitPatterns?.length) LIMITS = o.limitPatterns;
  });

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * รอให้หน้านี้ได้โฟกัสจริง ก่อนจะแตะคลิปบอร์ด
   *
   * navigator.clipboard.writeText ใช้ได้เฉพาะตอนเอกสาร "โฟกัสอยู่" เท่านั้น
   * service worker สั่ง activate แท็บและ focus หน้าต่างก่อนยิงงานมาก็จริง
   * แต่คำสั่งพวกนั้นคืนค่าก่อนที่โฟกัสจะมาถึงหน้าเว็บจริง และในสภาพที่ระบบปฏิบัติการ
   * ไม่ยอมยกโฟกัสให้ (จอดับ ล็อกหน้าจอ ต่อผ่าน Remote Desktop หน้าต่างอื่นครองอยู่)
   * มันไม่มีวันมาถึงเลย — เขียนคลิปบอร์ดตอนนั้นจะได้ NotAllowedError ทุกครั้ง
   */
  async function waitFocus(timeoutMs = 1500) {
    const until = Date.now() + timeoutMs;
    while (!document.hasFocus() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return document.hasFocus();
  }
  const imageTurns = new Map();

  /**
   * ห้องแชตเดียวกันหรือเปล่า — ต้องดูที่ตัวห้อง ไม่ใช่ที่ URL ตรงตัว
   *
   * ห้องแชตใหม่เริ่มต้นที่ URL ที่ยังไม่มีชื่อห้อง (chatgpt.com/ หรือมี ?model=…)
   * พอข้อความแรกถูกส่ง ChatGPT เขียน URL ทับเป็น /c/<id> ด้วย history ของหน้าเว็บเอง
   * เอกสารเดิม ห้องเดิม ข้อความเดิมทุกอย่าง เปลี่ยนแค่ชื่อที่แถบที่อยู่
   *
   * แต่หลักฐานของเทิร์นภาพถูกจดไว้ "ตอนส่ง" ซึ่งเกิดก่อนการเขียนทับนั้นเสมอ
   * การเทียบ URL ตรงตัวจึงไม่ตรงกันทุกครั้งที่เป็นภาพแรกของห้องใหม่ แล้วเราตอบว่า
   * image_turn_not_available — ตัวคว้าภาพยอมแพ้ทันทีโดยไม่ลองซ้ำ ทั้งที่ภาพวาดเสร็จ
   * อยู่บนจอตรงหน้า สุดท้ายก็สั่งวาดใหม่ แล้ววนแบบนั้นไปเรื่อย ๆ
   *
   * หลักฐานจริงที่ยืนยันว่าเป็นห้องเดิมคือ anchor.isConnected — ข้อความของเราเองยังอยู่ใน
   * เอกสารนี้ ซึ่งเป็นเงื่อนไขที่แข็งกว่าและถูกตรวจอยู่แล้ว ที่นี่จึงเหลือหน้าที่กันแค่
   * "คนละเว็บ" กับ "คนละห้องที่มีชื่อคนละชื่อ" ส่วนห้องที่เพิ่งได้ชื่อ ถือเป็นห้องเดิม
   */
  const conversationId = (href) => {
    try {
      // ไม่ใส่ base โดยตั้งใจ — ค่าที่เก็บไว้เป็น href เต็มเสมอ
      // ถ้าใส่ base ค่าที่ใช้ไม่ได้ (ว่าง/พัง) จะถูกแปลงเป็น URL ปัจจุบันแล้วผ่านไปเงียบ ๆ
      return new URL(href).pathname.match(/\/c\/([^/?#]+)/)?.[1] || '';
    } catch {
      return '';
    }
  };
  function sameConversation(was) {
    if (!was) return false; // ไม่มีหลักฐานว่าจดมาจากห้องไหน = ไม่รับ
    let origin = '';
    try {
      origin = new URL(was).origin;
    } catch {
      return false;
    }
    if (origin !== location.origin) return false;
    const before = conversationId(was);
    // ตอนจดยังไม่มีชื่อห้อง = ห้องใหม่ที่เพิ่งถูกตั้งชื่อ ไม่ใช่การย้ายห้อง
    return !before || before === conversationId(location.href);
  }
  // จำเฉพาะเทิร์นภาพที่ดึง bytes สำเร็จแล้ว เพื่อปลด spinner ที่ค้างก่อนส่งภาพถัดไปได้อย่างปลอดภัย
  let completedImageTurn = null;
  const normalizePrompt = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const composerMatches = (prompt) => {
    const box = $(S.composer);
    return !!box && normalizePrompt(box.innerText || box.textContent) === normalizePrompt(prompt);
  };

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
    /**
     * ไต่จนถึงขอบกล่องคำตอบ ไม่ใช่แค่ 4 ชั้นตายตัว เพราะ ChatGPT ห่อหัวบล็อกโค้ดลึกขึ้นทุกครั้งที่ปรับหน้า
     * ถ้าไต่ไม่ถึง ปุ่ม Copy ของบล็อกโค้ดจะถูกนับเป็นแถบปุ่มใต้คำตอบ แล้วตัดคำตอบกลางคัน
     *
     * แต่ห้ามไต่เลยกล่องคำตอบออกไป: ชั้นที่ครอบกล่องคำตอบทั้งกล่อง (เช่น <article>)
     * ย่อมมี <pre> ของคำตอบอยู่ข้างในเสมอ ถ้าไต่ต่อ ปุ่มของแถบปุ่มจริงจะถูกตีเป็นปุ่มบล็อกโค้ดไปด้วย
     * แล้วเทิร์นจะไม่มีวันเจอแถบปุ่มเลย ต้องรอครบเวลานิ่งทุกครั้ง
     */
    for (let el = btn.parentElement, i = 0; el && i < 12; el = el.parentElement, i++) {
      if (el.matches?.(S.assistantTurn) || el.querySelector(S.assistantTurn)) break;
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
   *
   * ป้ายระหว่างค้นเว็บก็เป็นข้อความชั่วคราวแบบเดียวกัน แถมมีตัวนับต่อท้ายที่ขยับช้ามาก
   * ("Searching websites 4") เดิม regex ครอบแค่ "Searching the web" ป้ายที่มีคำว่า
   * websites/sites หรือมีตัวเลขจึงหลุดออกมาเป็น "คำตอบ" ยาว 21 ตัวอักษร แล้วถูกส่งไปแปลงเป็น JSON
   * (อาการที่เห็น: ค้นกระแสไม่สำเร็จ — อ่านคำตอบเป็น JSON ไม่ได้ ค้นข้อความ: Searching websites 4)
   */
  const PLACEHOLDER =
    /^(?:thinking|reasoning|analy[sz]ing|working on it|thought for [^\n]{0,24}|(?:search|brows|read|find|gather|visit|check)(?:ing|ed|s)?(?:\s+\d{1,4})?(?:\s+(?:the\s+)?(?:web|websites?|sites?|sources?|results?|links?|pages?))?(?:\s+\d{1,4})?|กำลัง(?:คิด|ค้นหา|ค้น|อ่าน|ตรวจ|รวบรวม)[^\n]{0,24})[.…·\s]*$/i;
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
   * ท่อสตรีมคำตอบขาดกลางทาง — หน้าเว็บบอกเองตั้งแต่วินาทีแรก แต่เดิมเราไม่ฟัง
   *
   * ChatGPT วาดกล่องแดง "Error in message stream" แทนคำตอบ แล้ว "ไม่" ขึ้นปุ่ม Retry เสมอไป
   * ตัวจับข้อผิดพลาดเดิมมีตัวเดียวคือปุ่ม Retry เทิร์นแบบนี้จึงไม่มีอะไรจับได้เลย
   * ต้องรอจนหมดเพดาน (เทิร์นภาพ 8 นาที) แล้วจบเป็น outcome_unknown ซึ่งเป็นรหัสที่สั่งหยุดทั้งเล่ม
   * โดยไม่ผ่านผู้คุมกระบวนการ — นี่คือสาเหตุตรง ๆ ที่ CEO ไม่เคยถูกปลุกในเคสนี้
   *
   * รู้ตั้งแต่ต้นว่าล้ม = จบเทิร์นเป็น error ธรรมดา ซึ่งเดินเข้าเส้นทางลองใหม่และผู้คุมได้ตามปกติ
   *
   * กันจับผิดตัวสามชั้น เพราะเนื้อหาหนังสือเองก็พูดถึงคำว่า error ได้:
   *   - ดูเฉพาะกล่องที่หน้าเว็บทำเครื่องหมายว่าเป็นข้อผิดพลาด (role/class) ไม่ใช่ทั้งหน้า
   *   - ข้อความต้องสั้น กล่องแจ้งพังไม่มีทางยาวเป็นย่อหน้า
   *   - ต้องอยู่หลังข้อความที่เราเพิ่งส่ง ไม่งั้นแผลเก่าในห้องจะฆ่าเทิร์นใหม่ทุกครั้ง
   */
  const STREAM_ERROR =
    /error in (?:the )?message stream|something went wrong|network error|เกิดข้อผิดพลาดในการ|เกิดข้อผิดพลาด/i;
  const ERROR_BOX = '[role="alert"], [class*="error" i], [class*="text-red" i], [class*="danger" i]';

  function streamErrorAfter(anchor) {
    return (
      $$(ERROR_BOX).find((el) => {
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
        if (anchor && !(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        const t = (el.innerText || '').trim();
        return t.length > 0 && t.length <= 200 && STREAM_ERROR.test(t);
      }) || null
    );
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
  function visibleStopButton() {
    const visible = (b) => {
      if (!b || b.disabled) return false;
      if (b.offsetParent === null && getComputedStyle(b).position !== 'fixed') return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // testid ของปุ่มหยุดจริงคือตัวชี้ขาด ถ้ามีและมองเห็นอยู่ ไม่ต้องดูอย่างอื่นแล้ว
    const exact = $$('[data-testid="stop-button"]').find(visible);
    if (exact) return exact;

    /**
     * selector สำรอง button[aria-label*="Stop"] ไปโดนปุ่มโหมดเสียงเข้าด้วย
     *
     * ปุ่มพวกนั้น ("Stop voice mode", "Stop dictation", ไมโครโฟน) อยู่ในหน้าตลอดเวลา
     * ถ้านับเป็น "ยังพ่นอยู่" ทุกด่านที่รอให้พ่นจบจะไม่มีวันผ่าน:
     *   waitUntilIdle รอเปล่า 90 วินาทีก่อนทุกเทิร์น
     *   pollForImage ไม่ยอมเลิกรอจนครบ 5 นาทีเต็มแม้หน้าจอนิ่งสนิท
     * รวมกันแล้วเห็นเป็น "ค้าง" ทั้งที่ ChatGPT ตอบจบไปนานแล้ว
     */
    return $$(S.stopButton).find((b) => {
      if (!visible(b)) return false;
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''}`.toLowerCase();
      if (/voice|dictat|microphone|mic\b|speech|audio|record|ไมโครโฟน|เสียง|อัดเสียง/.test(label)) return false;
      return true;
    }) || null;
  }
  function stopButtonVisible() { return !!visibleStopButton(); }

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

    /**
     * ต้องเริ่มจากช่องที่ว่างจริง ไม่ใช่ช่องที่ "นับของค้างไว้แล้วบวกเพิ่ม"
     * ถ้าล้างไม่หมด ต้องพูดออกมา เพราะรูปส่วนเกินจะไปถึงโมเดลพร้อมคำสั่งรอบนี้
     */
    const swept = await clearAttachments();
    if (swept.left) {
      errors.push(
        `มีรูปค้างอยู่ในช่องพิมพ์ ${swept.left} ใบและลบไม่ออก — รูปเหล่านี้จะถูกส่งไปพร้อมคำสั่งรอบนี้ด้วย`,
      );
    }

    const before = countAttachmentThumbs();

    let list;
    try {
      list = await buildFileList(wanted);
    } catch (e) {
      return { attached: 0, errors: [`สร้างไฟล์จากรูปที่ส่งมาไม่ได้: ${e?.message || e}`] };
    }

    /**
     * "ยังไม่เห็นภาพย่อ" ไม่ได้แปลว่า "ไฟล์ไม่เข้า" — และการเดาผิดตรงนี้ทำให้แนบซ้ำ
     *
     * หน้า ChatGPT มีช่องแนบไฟล์ที่เข้าเกณฑ์มากกว่าหนึ่งช่อง ของเดิมวนใส่ไฟล์ทีละช่อง
     * แล้วรอภาพย่อ 15 วินาที ถ้าไม่ขึ้นก็ไปใส่ช่องถัดไปต่อ แต่ตอนอัปโหลดช้ากว่านั้น
     * ช่องแรกรับไฟล์ไปแล้วจริง ๆ พอไปใส่ช่องที่สองอีก สุดท้ายภาพย่อขึ้นสองใบ
     * (เห็นกับตา: รูปผู้เขียนใบเดียวกันแนบไปกับคำสั่งสองใบ)
     *
     * ChatGPT ได้รูปเดียวกันซ้อนสองใบแล้วตีความว่าเป็นงานเทียบภาพหรืองานแก้ภาพ
     * ไม่ใช่งานวาดใหม่ — ซึ่งเป็นคนละเรื่องกับที่ prompt สั่งไว้ทั้งฉบับ
     *
     * เกณฑ์ที่ถูกคือดูว่า "จำนวนภาพย่อขยับขึ้นหรือยัง" ขยับเมื่อไรแปลว่าช่องนั้นรับไปแล้ว
     * ห้ามยิงช่องทางอื่นซ้ำอีก ให้รอต่อในช่องทางเดิมจนกว่าจะครบหรือหมดเวลา
     */
    const thumbsAdded = () => countAttachmentThumbs() - before;

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
      if (thumbsAdded() > 0) {
        errors.push('ช่องแนบรับไฟล์ไปแล้วแต่ภาพย่อขึ้นช้ากว่าที่รอ จึงไม่ยิงช่องอื่นซ้ำ');
        const full = await waitForThumbs(before + wanted.length);
        return { attached: full ? wanted.length : thumbsAdded(), errors, via: 'file_input_slow' };
      }
    }

    // ทางที่ 2 — หย่อนไฟล์ลงช่องพิมพ์ เหมือนผู้ใช้ลากรูปมาวาง
    const box = thumbsAdded() > 0 ? null : $(S.composer);
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
  const attachmentThumbs = () => {
    /**
     * ต้องมองแค่ในกรอบช่องพิมพ์ ไม่ใช่ทั้งหน้า
     *
     * ภาพที่ ChatGPT วาดเสร็จก็เป็น blob: เหมือนกัน (ตัวคว้าภาพรองรับเคสนี้อยู่แล้ว)
     * การนับทั้งหน้าจึงนับภาพในบทสนทนาเป็น "ไฟล์แนบ" ไปด้วย แล้วตัวล้างก็ไปไล่หา
     * ปุ่มลบของภาพในบทสนทนา ซึ่งไม่มี — เจอ null แล้ว break ออกทันที ไม่ได้ล้างอะไรเลย
     *
     * ผลคือรูปผู้เขียนพอกในช่องพิมพ์ทีละใบทุกรอบ (เห็นกับตา: แนบไปสองใบในเทิร์นเดียว)
     * และ ChatGPT ที่ได้รูปเดียวกันซ้อนกันหลายใบตีความว่าเป็นงานเทียบภาพหรือแก้ภาพ
     * ไม่ใช่งานวาดใหม่ — แล้วก็หยุดคิดกลางคัน ไม่ได้ภาพสักใบ
     */
    const form = $(S.composer)?.closest('form');
    return form ? $$('img[src^="blob:"]', form) : [];
  };
  const countAttachmentThumbs = () => attachmentThumbs().length;

  /**
   * ล้างรูปที่ค้างอยู่ในช่องพิมพ์ก่อนแนบรูปของรอบใหม่
   *
   * ของเดิมนับภาพย่อที่มีอยู่แล้วเป็น before แล้วรอให้ครบ before + จำนวนที่จะแนบ
   * ซึ่งแปลว่า "รูปที่ค้างจากรอบก่อน" ถือเป็นเรื่องปกติ ไม่มีใครล้าง ไม่มีใครทัก
   * รูปจึงพอกขึ้นทีละใบทุกรอบ — เห็นกับตา: คำสั่งภาพรูปที่แปดมีรูปผู้เขียนแนบไป 8 ใบ
   *
   * ผลไม่ใช่แค่เปลืองอัปโหลด ChatGPT ที่ได้รูปเดียวกันซ้อนกันหลายใบตีความว่า
   * เป็นงานเทียบภาพหรืองานแก้ภาพ ไม่ใช่งานวาดใหม่ตามคำสั่ง ซึ่งเป็นอาการเดียวกับ
   * ที่เคยแก้ไปแล้วตอนแนบซ้ำสองใบ แค่คราวนี้ต้นตออยู่คนละที่
   */
  async function clearAttachments() {
    let left = countAttachmentThumbs();
    if (!left) return { cleared: 0, left: 0 };

    const started = left;
    // กันลูปไม่รู้จบเมื่อปุ่มลบหาไม่เจอหรือกดแล้วไม่หาย
    for (let round = 0; round < started + 3 && left; round++) {
      const thumb = attachmentThumbs()[0];
      if (!thumb) break;

      // ปุ่มลบอยู่ในกล่องของภาพย่อนั้น ไต่ขึ้นไปหาแทนการเดา class ของหน้าเว็บ
      let btn = null;
      for (let el = thumb; el && el !== document.body && !btn; el = el.parentElement) {
        btn = el.querySelector?.(S.attachmentRemove) || null;
      }
      /**
       * ป้ายกำกับของปุ่มลบเปลี่ยนตามภาษาและตามรุ่นของหน้าเว็บ พึ่งอย่างเดียวไม่พอ
       * ในกรอบช่องพิมพ์มีปุ่มอยู่ไม่กี่ตัว และปุ่มที่นั่งอยู่กับภาพย่อคือปุ่มลบของมันเอง
       */
      if (!btn) {
        for (let el = thumb; el && el !== document.body && !btn; el = el.parentElement) {
          btn = [...(el.querySelectorAll?.('button') || [])].find((b) => !b.disabled && !b.contains(thumb)) || null;
        }
      }
      if (!btn) break;

      btn.click();
      await waitForDom(() => countAttachmentThumbs() < left, { timeoutMs: 4000 });
      const now = countAttachmentThumbs();
      if (now >= left) break; // กดแล้วไม่ลด — เลิกดันต่อ
      left = now;
    }
    return { cleared: started - left, left };
  }

  // 15 วินาทีสั้นเกินไปสำหรับรูปหลาย MB บนเน็ตช้า และการหมดเวลาที่นี่คือจุดที่ทำให้แนบซ้ำ
  const waitForThumbs = (want) =>
    waitForDom(() => countAttachmentThumbs() >= want, { timeoutMs: 45000 }).then((v) => !!v);

  // ---------- ฉีดข้อความ ----------
  async function injectText(text, turnId = null) {
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
    /**
     * การล้างระดับ DOM "ดูเหมือนสำเร็จ" เสมอ ทั้งที่อาจไม่สำเร็จเลย
     *
     * box.textContent = '' ทำให้ innerText ว่างทันที ตัวตรวจจึงผ่านทุกครั้ง
     * แต่ ProseMirror เก็บเอกสารของมันเองไว้ต่างหาก ของเก่าที่ยังอยู่ในสถานะนั้น
     * จะกลับมาตอนวางข้อความใหม่ ได้ Prompt ที่มีเนื้อครบสองรอบต่อกันในข้อความเดียว
     * ที่นี่จึงล้างได้ แต่ห้ามเชื่อผลของมัน — คนตัดสินคือตัวเทียบข้อความท้ายฟังก์ชัน
     */
    await clearComposer(box);

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
    /**
     * ทางหลักคือให้เบราว์เซอร์พิมพ์ให้ เพราะไม่ต้องพึ่งโฟกัสเลย
     *
     * ทางคลิปบอร์ดใช้ได้เฉพาะตอนเอกสารโฟกัสอยู่ ซึ่งเป็นเงื่อนไขที่ระบบนี้คุมไม่ได้จริง —
     * งานเดินตอนไม่มีคนนั่งเฝ้า จอดับ ล็อกหน้าจอ หรือต่อผ่าน Remote Desktop
     * โฟกัสจึงกลายเป็นตัวแปรสุ่ม แล้วการวางข้อความก็ดีบ้างพังบ้างตามนั้น
     * (เดิมทางนี้ถูกใช้เป็นทางสุดท้ายเท่านั้น จึงไม่เคยได้แก้ปัญหาที่ต้นเหตุ)
     *
     * ราคาที่จ่ายคือแถบ "กำลังดีบัก" ของ Chrome ที่โผล่ระหว่างพิมพ์แล้วหายไปเอง
     * และถ้า DevTools เปิดค้างบนแท็บนั้นอยู่ ช่องทางนี้จะแนบไม่ได้ — ตกไปใช้คลิปบอร์ดตามเดิม
     */
    let typeError = '';
    try {
      /**
       * ต้องมีเพดานเวลา เพราะทางนี้ค้างได้แบบไม่มีอะไรมาปลด
       *
       * มันวิ่งไปที่ service worker ซึ่งต่อ debugger เข้ากับแท็บแล้วสั่งพิมพ์
       * chrome.debugger.attach และ chrome.scripting.executeScript ไม่มีเพดานเวลาของตัวเอง
       * แท็บที่ไม่ตอบสนองจะทำให้ callback ไม่ถูกเรียกเลย แล้ว sendMessage ก็รอไปเรื่อย ๆ
       * (เห็นจริงในบันทึก: ค้างที่ขั้น "พิมพ์ Prompt ลงช่อง" 584 วินาที จนนาฬิกาใหญ่ตัดที่ 601 วินาที)
       *
       * ตัว insertText เป็นคำสั่งเดียวจบไม่ว่าข้อความจะยาวแค่ไหน ช้าได้แค่ตอนต่อ debugger
       * 45 วินาทีจึงเหลือเฟือสำหรับทางที่ทำงานได้จริง และตัดทางที่ค้างทิ้งเร็วพอ
       * หมดเวลาแล้วไม่ใช่จุดจบ — ตกไปใช้ทางคลิปบอร์ดต่อ ซึ่งเป็นทางที่เขียนรองรับไว้อยู่แล้ว
       */
      const typed = await Promise.race([
        chrome.runtime.sendMessage({ type: 'sw.forceSend', text, send: false }),
        new Promise((r) => setTimeout(() => r({ ok: false, error: 'ให้เบราว์เซอร์พิมพ์ให้ไม่ตอบใน 45 วินาที' }), 45000)),
      ]);
      if (typed?.ok) {
        await frame();
        ok = !!box.innerText.trim();
      } else {
        typeError = typed?.error || 'ไม่ทราบสาเหตุ';
      }
    } catch (e) {
      typeError = e?.message || String(e);
    }
    if (typeError && turnId) {
      report(turnId, 'typing', `ให้เบราว์เซอร์พิมพ์ให้ไม่ได้ (${typeError}) — ลองทางคลิปบอร์ดแทน`);
    }

    // ทางสำรองที่ 1: คลิปบอร์ดจริง ใช้ได้เมื่อแท็บโฟกัสอยู่เท่านั้น
    let clipboardError = '';
    if (!ok) {
      const hasFocus = await waitFocus(1500);
      clipboardError = hasFocus ? '' : 'แท็บ ChatGPT ไม่ได้โฟกัส';
      try {
        await navigator.clipboard.writeText(text);
        box.focus();
        ok = document.execCommand('paste');
        await frame();
        ok = ok && !!box.innerText.trim();
        if (ok) clipboardError = '';
      } catch (e) {
        ok = false;
        clipboardError = e?.message || String(e);
      }
      if (clipboardError && turnId) {
        report(turnId, 'typing', `วางผ่านคลิปบอร์ดไม่ได้ (${clipboardError}) — ใช้ทางสำรองสุดท้าย ซึ่งพลาดง่ายกับ Prompt ยาว`);
      }
    }

    // ทางสำรองที่ 1: คำสั่งแทรกข้อความของเบราว์เซอร์
    if (!box.innerText.trim()) {
      ok = document.execCommand('insertText', false, text);
      await frame();
    }

    // Do not mutate the editor DOM behind its document state. The caller can
    // recover through browser input if paste/insertText was not accepted.
    if (!box.innerText.trim()) throw new Error('composer_write_failed');
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
      // ข้อความไม่ตรง = ล้างแล้ววางใหม่ ไม่ต้องรายงานออกไป เพราะ injectText ถูกเรียกก่อนรู้ turnId
      // ต้องวางทับด้วยทางเดียวกับรอบแรก ไม่ใช่ insertText ซึ่งเป็นการ "แทรกเพิ่ม"
      // ถ้าของเก่ายังไม่หมดจริง insertText จะต่อท้ายให้ยาวขึ้นอีกเท่าตัวทุกรอบ
      await clearComposer(box);
      box.focus();
      try {
        await waitFocus(800);
        await navigator.clipboard.writeText(text);
        document.execCommand('paste');
      } catch (_) {
        document.execCommand('insertText', false, text);
      }
      await frame();
      got = norm(box.innerText);
    }

    if (!got) throw new Error('composer_write_failed');
    /**
     * ข้อความไม่ตรง = ห้ามส่ง ต้องล้มเทิร์นนี้ทิ้ง
     *
     * เดิมตรงนี้ปล่อยผ่าน ขอแค่มีตัวอักษรอยู่ในช่องก็กดส่งเลย ผลคือ Prompt ที่ซ้ำสองรอบ
     * ถูกส่งเข้า ChatGPT จริง — คำสั่งแปดพันตัวอักษรที่สั่งซ้ำและขัดกันเอง
     * ซึ่งคือเทิร์นที่กลับมาเป็น "Stopped thinking" หรือ Something went wrong
     * ความผิดพลาดนี้อยู่ในกลุ่มไม่เสียโควตา (ยังไม่ได้ส่งอะไรออกไป) ชั้นบนจะลองใหม่ให้เอง
     */
    if (want && got !== want) throw new Error('composer_text_mismatch');
    return box; // ส่งต่อให้ clickSend ใช้ element เดียวกัน ไม่ใช่ไปหาใหม่แล้วได้คนละตัว
  }

  /**
   * รอให้ ChatGPT ว่างจริงก่อนพิมพ์/กดส่งเทิร์นถัดไป
   *
   * สำคัญมากกับเทิร์นสร้างภาพ: หลังภาพแรกเรนเดอร์เสร็จ หน้าเว็บอาจยังอยู่ในสถานะ "กำลังทำงาน"
   * (ปุ่ม Stop ยังอยู่ / ปุ่ม Send ยัง disabled) ถ้ายัด Prompt ถัดไปตอนนั้น ปุ่มส่งจะกดไม่ติด
   * แล้ว Prompt จะค้างอยู่ในช่องพิมพ์โดยไม่ถูกส่ง ซึ่งเป็นอาการ "ค้างที่ปกหลัง" ที่เจอจริง
   */
  /**
   * รอให้เทิร์นก่อนหน้าจบ โดยไม่ยอมนั่งเงียบจนหมดเพดานเวลา
   *
   * waitForDom ทำงานด้วย MutationObserver ล้วน ๆ — หน้าเว็บที่ค้างสถานะ "กำลังตอบ"
   * ไม่มี mutation ให้จับเลยสักครั้ง เงื่อนไขจึงไม่เคยถูกตรวจซ้ำ และการรอกินเวลาเต็มเพดานเสมอ
   * (อาการที่เห็นใน log: "ค้างที่ขั้น กดส่ง Prompt มา 491 วินาที" แล้วจบด้วยวางสารบัญไม่สำเร็จ
   *  เพราะสามรอบลองใหม่ × สามนาที กับหน้าจอที่นิ่งสนิทมาตั้งแต่วินาทีแรก)
   *
   * ตัวนี้จึงเดินด้วยนาฬิกา ดูจากเนื้อหาที่โตขึ้นจริง ไม่ใช่ดูแค่ปุ่ม
   * และรายงานทุกวินาทีว่ารออะไรอยู่ · คืน 'done' | 'stale' (ปุ่มค้างแต่หน้านิ่ง) | 'timeout'
   */
  async function waitForBusyToClear(isBusy, { timeoutMs = 180000, staleMs = 45000, turnId = null, label = '' } = {}) {
    /**
     * สัญญาณชีพของหน้าเว็บ — ต้องจับ "ตอนที่มันกำลังคิด" ให้ได้ด้วย
     *
     * ของเดิมอ่านแค่ความยาวข้อความของคำตอบล่าสุดกับจำนวนรูป ซึ่งพังกับโมเดลที่คิดก่อนตอบ:
     * ระหว่างคิด ยังไม่มีก้อนคำตอบให้อ่านเลย (lastAssistantTurn เป็น null) และยังไม่มีรูป
     * ค่าจึงค้างเป็น "0|N" ตลอดสองนาทีที่มันกำลังวาดภาพอยู่จริง ๆ
     * แล้วเราสรุปว่าหน้าเว็บค้าง → กดปุ่มหยุด → ฆ่างานที่กำลังวาดของตัวเอง
     * (เห็นจริงบนจอ: "Worked for 2m 5s" ได้ภาพ ส่วนเทิร์นถัดมาเป็น "Stopped thinking" ทุกอัน)
     *
     * ตัวจับเวลาที่ ChatGPT โชว์ระหว่างคิดเดินทุกวินาที การอ่านข้อความของทั้งกล่องสนทนา
     * จึงเห็นมันขยับแน่นอน ต่อให้ยังไม่มีคำตอบและยังไม่มีรูปสักใบ
     */
    const sig = () => {
      const box = $(S.turnContainer) || document.body;
      // textContent ไม่บังคับให้เบราว์เซอร์คำนวณ layout ใหม่ ต่างจาก innerText
      // ตัวนี้ถูกเรียกทุกวินาทีระหว่างรอ และบทสนทนายาวได้มาก จึงต้องเบาที่สุด
      const live = (box?.textContent || '').length;
      return `${live}|${(lastAssistantTurn()?.innerText || '').length}|${$$('img').length}`;
    };
    const t0 = Date.now();
    let last = sig();
    let lastChangeAt = t0;
    while (Date.now() - t0 < timeoutMs) {
      if (!isBusy()) return 'done';
      const now = sig();
      if (now !== last) {
        last = now;
        lastChangeAt = Date.now();
      }
      /**
       * "ค้าง" = ไม่ขยับมานานเท่า staleMs นับจากการขยับครั้งล่าสุด
       *
       * เกณฑ์เดิมคือ "ต้องไม่ขยับเลยแม้แต่ครั้งเดียวตั้งแต่เริ่มรอ" ซึ่งพังในทางปฏิบัติ:
       * หน้าเว็บที่ค้างยังกะพริบได้หนึ่งครั้งจากการ re-render แล้วธงก็ติดค้างว่า "กำลังทำงาน"
       * ตลอดกาล ตัวรอจึงกินเวลาเต็มเพดานทุกครั้ง (เห็นจริงใน log: รอเทิร์นก่อนหน้าจบ 239 วินาที
       * แล้วจบด้วย previous_turn_running ทั้งที่ภาพวาดเสร็จไปหลายชั่วโมงแล้ว)
       *
       * เกณฑ์ใหม่ให้เวลาความเงียบต่อเนื่องเป็นตัวตัดสิน ซึ่งยังกันการกดหยุดใส่งานที่ทำอยู่จริงได้
       * เพราะงานที่เดินอยู่จะขยับอะไรสักอย่างภายในช่วงเวลานั้นเสมอ
       */
      if (Date.now() - lastChangeAt >= staleMs) return 'stale';
      if (turnId) report(turnId, 'waiting_idle', `${label}${Math.round((Date.now() - t0) / 1000)} วินาที`);
      await napMs(1000);
    }
    return isBusy() ? 'timeout' : 'done';
  }

  /** หน้าเว็บที่นิ่งสนิทนานเท่านี้ทั้งที่ปุ่มหยุดยังอยู่ = ค้างจริง ไม่ใช่กำลังคิด */
  const STUCK_SILENCE_MS = 120000;
  /** ภาพถูกดึงเก็บสำเร็จแล้ว แต่ ChatGPT ลืมคืนปุ่มส่ง: รอเพียงช่วงสั้นก่อนปลด spinner */
  const CAPTURED_IMAGE_STUCK_SILENCE_MS = 8000;
  /**
   * งานภาพรอหน้าเว็บว่างได้แค่นี้ก่อนเปิดห้องใหม่ทับไปเลย
   * สั้นพอที่จะไม่เสียเวลากับอาการค้าง และยาวพอให้เทิร์นที่กำลังจะจบจริง ๆ ได้จบก่อน
   */
  const IMAGE_IDLE_GRACE_MS = 30000;
  /** ปุ่มส่งเป็นวงกลม/disabled โดยไม่มีปุ่ม Stop ไม่ใช่งานสร้างที่ยังเดินอยู่ รอสั้นกว่าได้ */
  const COMPOSER_STUCK_SILENCE_MS = 30000;

  const idleSilenceMs = (capturedImageIsLast) =>
    capturedImageIsLast ? CAPTURED_IMAGE_STUCK_SILENCE_MS : STUCK_SILENCE_MS;

  async function waitUntilIdle(timeoutMs = 25000, turnId = null) {
    const capturedImageIsLast = !!completedImageTurn && lastUserTurn() === completedImageTurn.anchor;
    const how = await waitForBusyToClear(stopButtonVisible, {
      timeoutMs,
      staleMs: idleSilenceMs(capturedImageIsLast),
      turnId,
      label: 'รอเทิร์นก่อนหน้าจบ ',
    });
    if (how !== 'stale') return how !== 'timeout';

    if (capturedImageIsLast) {
      /**
       * pollForImage ส่งผลกลับได้ต่อเมื่อ fetch ภาพและแปลงเป็น data URL สำเร็จแล้วเท่านั้น
       * เมื่อ Machine เรียกเทิร์นถัดมา ภาพนั้นจึงถูกตรวจและบันทึกเรียบร้อยแล้ว หากปุ่มยังหมุนทั้งที่
       * หน้าไม่ขยับ การกดหยุดเป็นเพียงการคืนช่องพิมพ์ ไม่ได้ทิ้งภาพหรือส่งคำสั่งซ้ำ
       */
      report(turnId, 'waiting_idle', 'ภาพก่อนหน้าดึงและบันทึกแล้ว แต่ปุ่มส่งยังหมุนค้าง — ปลดสถานะค้างเพื่อส่งภาพถัดไป');
      visibleStopButton()?.click();
      for (let i = 0; i < 24 && stopButtonVisible(); i++) await napMs(125);
      return !stopButtonVisible();
    }

    /**
     * ความเงียบอย่างเดียวไม่ได้แปลว่าเทิร์นก่อนหน้าจบ — ถูกต้อง จึงไม่ส่งงานทับทันที
     * แต่หน้าเว็บที่นิ่งสนิทสองนาทีทั้งที่ปุ่มหยุดยังอยู่ คือสถานะค้างที่ไม่หายเอง
     * ปล่อยไว้แปลว่าทุกเทิร์นถัดจากนี้จะเสียเวลาเต็มเพดานแล้วล้มด้วยเหตุผลเดิมตลอดไป
     * (เห็นจริงใน log: รอ 239 วินาที แล้วจบด้วย previous_turn_running ทั้งที่ภาพเสร็จไปนานแล้ว)
     *
     * กดปุ่มหยุดหนึ่งครั้งคือทางเดียวที่ปลดสถานะนี้ได้ และปลอดภัย:
     * มันไม่ส่งอะไรใหม่ ไม่ทำให้เกิดงานซ้อน ส่วนภาพที่วาดเสร็จแล้วยังอยู่ในหน้าให้คว้าได้เหมือนเดิม
     */
    report(turnId, 'waiting_idle', 'หน้าเว็บค้างสถานะ “กำลังตอบ” โดยไม่ขยับสองนาที — กดปุ่มหยุดหนึ่งครั้งเพื่อปลดสถานะ');
    /**
     * ห้ามกดหยุดถ้าเทิร์นที่ค้างอยู่คือคำสั่งวาดภาพที่ยังไม่ได้ภาพกลับมา
     *
     * นี่คือความผิดพลาดที่แพงที่สุดที่เคยเกิด: โมเดลสายคิดก่อนตอบใช้เวลาวาดเป็นนาที
     * ระหว่างนั้นหน้าเว็บแทบไม่ขยับ เราตัดสินว่าค้างแล้วกดหยุด — ฆ่างานของตัวเอง
     * ผลบนจอคือ "Stopped thinking" ทุกเทิร์น ไม่ได้ภาพสักใบ แล้ววนสั่งวาดใหม่ไม่จบ
     * ทุกครั้งที่วนคือจ่ายโควตาภาพใหม่เต็มราคาสำหรับงานที่เราเพิ่งฆ่าไปเอง
     *
     * ปล่อยให้มันวาดต่อแล้วรายงานว่ายังไม่ว่าง ปลอดภัยกว่าเสมอ — ชั้นบนรอแล้วลองใหม่ได้
     */
    const pendingImage = [...imageTurns.values()].some(
      (t) => t.anchor?.isConnected && t.anchor === lastUserTurn() && t.anchor !== completedImageTurn?.anchor,
    );
    if (pendingImage) {
      report(turnId, 'waiting_idle', 'เทิร์นที่ค้างอยู่คือคำสั่งวาดภาพที่ยังไม่ได้ภาพกลับมา — ปล่อยให้วาดต่อ ไม่กดหยุดทับงานตัวเอง');
      return false;
    }

    visibleStopButton()?.click();
    for (let i = 0; i < 20 && stopButtonVisible(); i++) await napMs(150);
    return !stopButtonVisible();
  }

  /** ล้างช่องพิมพ์ให้สุดความสามารถ — ผลลัพธ์ต้องไปพิสูจน์ด้วยการเทียบข้อความอีกที */
  async function clearComposer(box) {
    for (let i = 0; i < 3; i++) {
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      await frame();
      if (!(box.innerText || box.textContent || '').trim()) return;
    }
    throw new Error('composer_write_failed');
  }


  function sendCandidates(box) {
    // ต้องหาใหม่ทุกครั้ง หน้า ChatGPT สร้างปุ่มชุดใหม่ทุกครั้งที่ re-render
    const form = box?.isConnected ? box.closest('form') : null;
    const roots = form ? [form] : [];
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

  /**
   * วงกลมหมุนที่ตำแหน่งปุ่มส่ง = หน้าเว็บยังไม่ว่าง ไม่ใช่ "กดส่งไม่ติด"
   *
   * หลังเทิร์นสร้างภาพ ปุ่มส่งถูกแทนด้วยวงกลมหมุน ซึ่งบางครั้งไม่เหลือ element ที่นับเป็นปุ่มส่งเลย
   * ตัวนับปุ่มเดิม (sendCandidates) จึงได้ศูนย์ แล้ว clickSend ก็ล้มในสี่วินาทีด้วย
   * send_action_not_accepted ทั้งที่อาการจริงคือหน้าเว็บค้าง ซึ่งเป็นคนละอย่างกัน
   * รหัสที่ผิดทำให้ CEO ไม่เคยถูกเรียกมาโหลดหน้าใหม่ให้ ทั้งที่นั่นคือท่าเดียวที่ปลดสถานะนี้ได้
   *
   * ดูเฉพาะในกรอบของช่องพิมพ์ จึงไม่ไปโดน spinner ของคำตอบที่กำลังพ่นอยู่ด้านบน
   */
  const SPINNER_SELECTORS = [
    '[data-testid="send-button"][disabled]',
    '[data-testid="send-button"][aria-disabled="true"]',
    '[aria-busy="true"]',
    '[role="progressbar"]',
    '[class*="animate-spin" i]',
    '[class*="spinner" i]',
    'svg[class*="spin" i]',
  ];

  /**
   * ปลดวงกลมที่ค้างด้วยตัวเองก่อน แทนที่จะส่งต่อให้คนอื่นตัดสินใจ
   *
   * สิ่งที่คนทำเมื่อเจอหน้าจอแบบนี้คือกดที่ปุ่มนั้นหนึ่งครั้งแล้วมันก็คืนช่องพิมพ์ให้
   * ระบบเรากลับไม่เคยลองท่านั้นเลยในเส้นทางนี้ ได้แต่รอจนครบเกณฑ์แล้วโยนรหัสความล้ม
   * ขึ้นไปให้ชั้นบนไปเรียกผู้คุมกระบวนการมาสั่งโหลดหน้าใหม่ ซึ่งช้ากว่าและแพงกว่ามาก
   *
   * ปลอดภัยเพราะกดหลังจากหน้าไม่ขยับเลย 30 วินาทีแล้วเท่านั้น (เกณฑ์เดียวกับที่
   * waitUntilIdle ใช้กดปุ่มหยุดอยู่ก่อนแล้ว) งานที่เดินอยู่จริงจะขยับอะไรสักอย่างเสมอ
   * และการกดปุ่มนี้ไม่ส่งอะไรใหม่ ไม่ทำให้เกิดงานซ้อน
   */
  function releaseStuckComposer(box) {
    /**
     * ห้ามกดปุ่มหยุดตรงนี้เด็ดขาด — ปุ่มหยุดที่มองเห็นแปลว่า "กำลังทำงานอยู่"
     *
     * ของเดิมถอยไปกดปุ่มหยุดเมื่อไม่เจอวงกลมในช่องพิมพ์ ซึ่งกลับหัวกลับหางกับเจตนา:
     * สิ่งที่เราอยากปลดคือช่องพิมพ์ที่ค้างโดยไม่มีงานเดินอยู่ ส่วนปุ่มหยุดคือหลักฐานว่ามีงานเดินอยู่
     * การกดมันคือการฆ่างานของตัวเองที่กำลังวาดภาพอยู่ แล้วจ่ายโควตาใหม่เพื่อวาดซ้ำ
     *
     * ฟังก์ชันนี้ต้องแตะได้แค่วงกลมในกรอบช่องพิมพ์เท่านั้น ไม่เจอก็คือไม่ทำอะไร
     */
    if (stopButtonVisible()) return false;
    const btn = composerSpinner(box)?.closest?.('button:not([disabled])');
    if (!btn) return false;
    btn.click();
    return true;
  }

  function composerSpinner(box) {
    const form = box?.isConnected ? box.closest('form') : null;
    if (!form) return null;
    const visible = (el) => {
      if (!el) return false;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sel of SPINNER_SELECTORS) {
      const hit = $$(sel, form).find(visible);
      if (hit) return hit;
    }
    return null;
  }


  /**
   * หลักฐานว่า "ยังไม่ได้ส่ง" ที่แน่นอนที่สุดเท่าที่หน้าเว็บมีให้
   *
   * ChatGPT ล้างช่องพิมพ์ทันทีที่รับข้อความเข้าบทสนทนา ถ้า Prompt ของเรายังอยู่ในช่องครบทุกตัว
   * และไม่มีปุ่มหยุดโผล่ขึ้นมา แปลว่าการกดส่งไม่ติด ไม่มีอะไรออกไปจากเครื่องเรา
   * — ไม่ใช่ "ตอบไม่ได้ว่าส่งไปหรือยัง" ซึ่งเป็นรหัสที่กันตัวกู้ทุกตัวออกไปแล้วหยุดทั้งงาน
   *
   * ต้องเช็คปุ่มหยุดด้วย เพราะระหว่างที่ ChatGPT เริ่มตอบ หน้าอาจวาดช่องพิมพ์กลับมาพร้อม
   * ข้อความเดิมได้ชั่วขณะ ถ้าดูแต่ช่องพิมพ์อย่างเดียวจะสรุปผิดว่ายังไม่ส่งแล้วยิงซ้ำ
   */
  const nothingWasSent = (prompt) => composerMatches(prompt) && !stopButtonVisible();

  const normalizeMessage = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  function userMessageKey(node) {
    return node.getAttribute('data-message-id') ||
      node.closest('[data-testid^="conversation-turn"]')?.getAttribute('data-testid') || '';
  }
  /**
   * ลำดับของเทิร์นในบทสนทนา — ตัวเลขที่เพิ่มขึ้นเรื่อย ๆ และไม่ย้อนกลับ
   *
   * ใช้แทนการ "นับจำนวนข้อความที่หน้าตาเหมือนกัน" ซึ่งพังเมื่อหน้าเว็บถอดข้อความเก่า
   * ที่เลื่อนพ้นจอออกจาก DOM (ChatGPT ทำแบบนี้เมื่อบทสนทนายาว) จำนวนที่นับได้จึงลดลง
   * ทั้งที่มีข้อความใหม่เพิ่มเข้ามาจริง แล้วเราสรุปว่า "ยังไม่มีข้อความใหม่"
   */
  const turnIndexOf = (node) => {
    const id = node?.closest?.('[data-testid^="conversation-turn"]')?.getAttribute('data-testid') || '';
    const m = id.match(/(\d+)\s*$/);
    return m ? Number(m[1]) : NaN;
  };
  function snapshotUserMessages() {
    const rows = $$('[data-message-author-role="user"]').map(node => ({
      key:userMessageKey(node), text:normalizeMessage(node.innerText || node.textContent),
      turn:turnIndexOf(node),
    }));
    // ลำดับสูงสุดที่เคยเห็น เก็บติดไปกับก้อนเดียวกัน ผู้เรียกจะได้ไม่ต้องรู้เรื่องนี้เอง
    rows.maxTurn = rows.reduce((m, r) => (Number.isFinite(r.turn) && r.turn > m ? r.turn : m), -1);
    return rows;
  }
  /**
   * ใบเสร็จของข้อความที่เราส่ง — เทียบทั้งก้อนไม่ได้ เพราะหน้าเว็บพับข้อความยาว
   *
   * ChatGPT ย่อข้อความผู้ใช้ที่ยาวมากให้เหลือบางส่วนพร้อมปุ่มขยาย ซึ่ง Prompt ของระบบนี้
   * ยาวหลายพันตัวอักษรแทบทุกอัน การเทียบว่า "เท่ากันเป๊ะ" จึงไม่เจอใบเสร็จของตัวเอง
   * ทั้งที่ข้อความถูกส่งไปแล้วจริง แล้วจบเป็น outcome_unknown → หยุดทั้งงานโดยไม่มีเหตุ
   * (เห็นจริง: งานค้างอยู่ 40 นาทีที่ขั้นคิดชื่อ ทั้งที่ ChatGPT ตอบไปแล้ว)
   *
   * การพับตัดท้ายเสมอ หัวข้อความจึงเป็นลายเซ็นที่รอด และยังเข้มพอ:
   * ต้องขึ้นต้นตรงกัน 120 ตัวอักษรแรก และต้องเป็นข้อความที่เพิ่งโผล่ใหม่เท่านั้น
   */
  function findUserReceipt(prompt, before) {
    const expected = normalizeMessage(prompt);
    const head = expected.slice(0, 120);
    const sameMessage = (text) => text === expected || (!!head && text.startsWith(head));
    const all = $$('[data-message-author-role="user"]');
    const matches = all.filter(node =>
      sameMessage(normalizeMessage(node.innerText || node.textContent)));
    const oldKeys = new Set(before.map(row=>row.key).filter(Boolean));
    const identified = matches.find(node => userMessageKey(node) && !oldKeys.has(userMessageKey(node)));
    if (identified) return identified;

    /**
     * ข้อความล่าสุดที่มีลำดับสูงกว่าที่เคยเห็น = ข้อความใหม่ แน่นอนโดยไม่ต้องนับอะไรเลย
     *
     * ทางนับจำนวนข้างล่างพังกับ Phase 2 โดยเฉพาะ เพราะคำสั่งภาพทุกใบในเล่มขึ้นต้น
     * เหมือนกันเป๊ะ 120 ตัวแรก ("วาดภาพต่อไปนี้ให้หน่อย ตอบกลับมาเป็นภาพอย่างเดียว…")
     * ทุกใบจึงนับเป็น "ข้อความเดียวกัน" หมด พอบทสนทนายาวขึ้นและหน้าเว็บถอดข้อความเก่า
     * ที่พ้นจอออกจาก DOM จำนวนที่นับได้จะเท่าเดิมหรือลดลง ทั้งที่เราเพิ่งส่งไปจริง ๆ
     * ผลคือ "กด Enter แล้วแต่จับข้อความที่ส่งไม่ได้" แล้วหยุดทั้งงานกลาง Phase 2
     * — ยิ่งเข้าไปลึกยิ่งเจอ เพราะยิ่งลึกยิ่งมีข้อความเก่าถูกถอดออกมาก
     *
     * ข้อความล่าสุดอยู่ท้ายจอเสมอ จึงไม่เคยถูกถอด และลำดับเทิร์นก็ไม่ย้อนกลับ
     */
    const tail = all[all.length - 1];
    if (tail && sameMessage(normalizeMessage(tail.innerText || tail.textContent))) {
      const seen = Number(before?.maxTurn ?? -1);
      const now = turnIndexOf(tail);
      if (Number.isFinite(now) && now > seen) return tail;
      // ไม่มีเลขลำดับให้อ่าน ใช้ "ก่อนหน้านี้ไม่มีข้อความผู้ใช้เลย" เป็นหลักฐานแทน
      if (!Number.isFinite(now) && !before.length) return tail;
    }

    const oldCount = before.filter(row=>sameMessage(row.text)).length;
    return matches.length > oldCount ? matches.at(-1) : null;
  }

  async function clickSend(composer = null, timeoutMs = 12000, expectedPrompt = null, turnId = null, before = null) {
    const box = composer?.isConnected ? composer : await waitForComposer(15000);
    if (!box) throw new Error('composer_not_found_before_send');
    if (stopButtonVisible()) throw new Error('previous_turn_running');
    before ||= snapshotUserMessages();
    const received = () => findUserReceipt(expectedPrompt, before);
    if (received()) return received();

    /**
     * หลังเทิร์นสร้างภาพ ปุ่มส่งกลายเป็นวงกลมหมุน (ไม่ใช่ปุ่มหยุด) และค้างแบบนั้นได้นานมาก
     *
     * สถานะนี้ไม่ถูกจับด้วยตัวไหนเลย: ไม่มี stop-button ให้เห็น ตัวรอ "เทิร์นก่อนหน้าจบ" จึงผ่านฉลุย
     * แล้วมาตายตรงนี้ในสี่วินาทีด้วย send_action_not_accepted ทั้งที่หน้าเว็บแค่ยังไม่ว่าง
     * ผลคือทุกเทิร์นหลังสร้างภาพล้มด้วยเหตุผลเดียวกันซ้ำ ๆ (อาการ "มันเกิดขึ้นตลอด")
     *
     * ปุ่มที่มีอยู่แต่กดไม่ได้ = หน้าเว็บยังไม่ว่าง ต้องรอด้วยเกณฑ์เดียวกับที่รอเทิร์นก่อนหน้าจบ
     * ไม่ใช่ล้มทันที และไม่ใช่รอไม่มีที่สิ้นสุด
     */
    const usableButton = () => sendCandidates($(S.composer)).find(sendUsable) || null;
    // ปุ่มที่มีอยู่แต่กดไม่ได้ หรือวงกลมหมุนที่มาแทนที่ปุ่ม — สองอย่างนี้คือหน้าเว็บยังไม่ว่างเหมือนกัน
    const composerBusy = () => sendCandidates($(S.composer)).length > 0 || !!composerSpinner($(S.composer));
    let btn = await waitForDom(usableButton, { timeoutMs: 4000 });
    if (!btn && composerBusy()) {
      report(turnId, 'sending', 'ปุ่มส่งเป็นวงกลมหมุนหรือกดไม่ได้ (หน้าเว็บยังไม่ว่างหลังเทิร์นก่อนหน้า) — รอให้ว่างก่อน');
      const how = await waitForBusyToClear(() => !usableButton(), {
        timeoutMs: 180000,
        staleMs: COMPOSER_STUCK_SILENCE_MS,
        turnId,
        label: 'รอปุ่มส่งกลับมากดได้ ',
      });
      /**
       * นิ่งครบเกณฑ์ (stale) และหมุนยาวจนครบสามนาที (timeout) คืออาการค้างอย่างเดียวกัน
       * ทั้งคู่ยังไม่ได้ส่งอะไรออกไป จึงส่งต่อให้ CEO ตัดสินได้ทั้งคู่ — เดิม timeout ตกไปเป็น
       * send_action_not_accepted ซึ่งพา CEO ออกนอกเส้นทางโหลดหน้าใหม่
       */
      if (how !== 'done') {
        // ลองปลดเองหนึ่งครั้งก่อนยอมแพ้ — ถ้าคืนช่องพิมพ์ได้ก็ส่งงานต่อได้เลยในเทิร์นนี้
        if (releaseStuckComposer($(S.composer))) {
          report(turnId, 'sending', 'กดปลดวงกลมที่ค้างหนึ่งครั้ง — รอช่องพิมพ์กลับมา');
          btn = await waitForDom(usableButton, { timeoutMs: 8000 });
        }
        if (!btn) throw new Error('composer_busy_stuck');
      } else {
        // วงกลมหายแล้วแต่ปุ่มจริงเพิ่งถูกวาดกลับเข้ามา ให้เวลา DOM ตั้งหลักก่อนตัดสินว่ากดไม่ได้
        btn = usableButton() || (await waitForDom(usableButton, { timeoutMs: 4000 }));
      }
    }
    if (!btn) throw new Error('send_action_not_accepted');
    if (received()) return received();
    if (stopButtonVisible()) throw new Error('previous_turn_running');
    if (!composerMatches(expectedPrompt)) throw new Error('composer_text_mismatch');
    btn.click();
    return await waitForDom(received, {timeoutMs});
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

  /**
   * เจอแถบปุ่มแล้วยังต้องดูอีกจังหวะว่าข้อความไม่โตต่อ
   *
   * เดิม 120ms ซึ่งสั้นกว่าช่วงพ่นสะดุดปกติของ ChatGPT เอง คำตอบที่ยังพ่นไม่จบ
   * จึงถูกตัดกลางคันถ้าบังเอิญเจอแถบปุ่มผิดตัว ครึ่งวินาทีต่อเทิร์นถูกกว่าการยิงใหม่ทั้งเทิร์นมาก
   */
  const BAR_CONFIRM_MS = 500;

  /** แถบปุ่มบอกว่าจบ แต่ปุ่มหยุดยังอยู่ — ให้เวลาพิสูจน์ตัวเองเท่านี้ก่อนเชื่อแถบปุ่ม */
  const BAR_STUCK_MS = 2500;

  let completedSetupReply = null;
  function setupJson(turn, keys = []) {
    if (!turn || !keys.length) return '';
    const codes = $$(S.codeBlock, turn);
    const raw = (codes.length ? codes.map(c=>c.textContent).join('\n') : turn.innerText || '').trim();
    try {
      const value = JSON.parse(raw);
      return keys.some(key => Array.isArray(value?.[key]) && value[key].length > 0) ? raw : '';
    } catch { return ''; }
  }
  function acceptedSetupStillCurrent() {
    const saved = completedSetupReply;
    return !!saved && lastAssistantTurn() === saved.turn && setupJson(saved.turn, saved.keys) === saved.raw;
  }

  function waitForAnswer(
    turnId,
    anchor,
    {
      quietMs = 1800,
      timeoutMs = 300000,
      startMs = 120000,
      minAssistantCount = 0,
      wantImages = false,
      expectedJsonKeys = [],
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
      let jsonSignature = '', jsonSince = 0;

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
        // ท่อสตรีมขาด = คำตอบไม่มีทางมาแล้ว จบทันทีแทนการรอจนหมดเพดานแล้วนับเป็น "ยืนยันผลไม่ได้"
        if (streamErrorAfter(anchor)) {
          report(turnId, 'received', 'ChatGPT ขึ้นข้อผิดพลาดของตัวเองแทนคำตอบ (สตรีมขาด) — ไม่รอต่อ');
          return finish('error');
        }

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

        /**
         * ประกาศโควตาภาพหมดมาแทนภาพ — จบทันที ไม่ต้องรอจนหมดเพดาน
         *
         * มันเป็นคำตอบที่สมบูรณ์แล้วในตัวเอง ไม่มีภาพตามมาทีหลังแน่นอน
         * รอต่ออีกเก้าสิบวินาทีจึงเป็นการนั่งดูคำตอบที่อ่านจบไปแล้ว
         */
        if (!turn.querySelector('img')) {
          const quota = imageQuotaNotice(turn.innerText);
          if (quota) {
            report(turnId, 'received', `ChatGPT แจ้งว่าโควตาสร้างภาพหมด: ${quota}`);
            return finish('rate_limited');
          }
        }

        // ยังคิดอยู่ ไม่ว่าหน้าเว็บจะนิ่งแค่ไหนก็ยังไม่ใช่คำตอบ
        if (isThinkingOnly(turn) && !turn.querySelector('img')) return;

        const len = (turn.innerText || '').length;
        const hasImg = !!turn.querySelector('img');

        const bar = actionBarFor(turn);
        // Explicit structured setup contract: complete JSON is stronger evidence than
        // a global Stop button. Never apply this shortcut to prose or image turns.
        const json = !wantImages ? setupJson(turn, expectedJsonKeys) : '';
        if (json !== jsonSignature) { jsonSignature = json; jsonSince = Date.now(); }
        if (json && Date.now() - jsonSince >= 2500) {
          completedSetupReply = {turn, keys:expectedJsonKeys, raw:json};
          report(turnId, 'received', 'JSON ครบและนิ่งแล้ว — ส่งต่อให้ตรวจรายการ');
          return finish('ok');
        }

        /**
         * ปุ่มหยุดคือคำตัดสินว่า "ยังพ่นอยู่" แถบปุ่มแย้งมันไม่ได้
         *
         * เดิมเขียนว่า `!bar && stopButtonVisible()` คือให้แถบปุ่มชนะปุ่มหยุด
         * ซึ่งเปิดช่องให้ "แถบปุ่มปลอม" ตัดคำตอบกลางคัน: หัวบล็อกโค้ดของ ChatGPT
         * มีปุ่ม Copy ตั้งแต่ JSON เริ่มพ่นตัวแรก ถ้า inCodeBlock ไล่ชั้นไม่ทันโครงสร้างใหม่
         * ระบบจะเห็นเป็นแถบปุ่ม แล้วปิดเทิร์นทันทีที่พ่นสะดุดเกินเสี้ยววินาที
         * (อาการที่เห็น: ไม่พบรายการชื่อในคำตอบ [ยาว 31 ตัวอักษร · ตัดกลางคัน] — คิดชื่อต้องยิงซ้ำสามรอบ)
         *
         * ตอนนี้กลับด้าน: ปุ่มหยุดมองเห็นอยู่ = ยังไม่จบ ไม่ว่าจะเจอแถบปุ่มหรือไม่
         * ถ้าสัญญาณขัดกัน ต้องมีแถบจบคำตอบจริงด้วย ไม่ตัดสินจากความนิ่งอย่างเดียว
         */
        if (stopButtonVisible()) {
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
            /**
             * เจอแถบปุ่มพร้อมกับปุ่มหยุด = ขัดกันเอง หนึ่งในสองตัวผิดแน่ ๆ
             * ไม่ตัดสินทันทีเหมือนเดิม (ซึ่งทำให้คำตอบขาดกลาง) แต่ก็ไม่ต้องรอเต็ม 25 วินาที
             * ข้อความที่ไม่ขยับเลยสองวินาทีครึ่งทั้งที่ "จบแล้ว" ตามแถบปุ่ม ถือว่าจบจริง
             */
            if (bar && Date.now() - stuckSince >= BAR_STUCK_MS) return finish('ok');
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

        // สัญญาณตรงว่าจบแล้ว: ปุ่มหยุดหายไปแล้ว และแถบปุ่มใต้คำตอบโผล่ขึ้นมา
        // ยืนยันอีกจังหวะว่าข้อความไม่โตต่อแล้วจริง กันจังหวะที่ปุ่มหยุดกะพริบหายไปหนึ่งเฟรม
        // ตอนหน้าเว็บ re-render พร้อมกับที่เจอปุ่ม Copy ของบล็อกโค้ดพอดี
        if (bar) {
          if (barLen === len) return finish('ok');
          barLen = len;
          clearTimeout(nudge);
          nudge = setTimeout(check, BAR_CONFIRM_MS);
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
    const nextUser = anchor && $$('[data-message-author-role="user"]').find(
      (node) => node !== anchor && (anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    const beforeSources = before?.sources instanceof Set ? before.sources : before instanceof Set ? before : new Set();
    const beforeElements = before?.elements instanceof Set ? before.elements : new Set();
    // ChatGPT รุ่นใหม่แยกภาพที่สร้างเสร็จไปใส่ portal/อีก <main> หนึ่งตัวได้
    // การหยิบแค่ <main> ตัวแรกจึงเห็นข้อความแต่ไม่เห็นภาพที่ผู้ใช้เห็นเต็มจอ
    // ตัวกรอง anchor, nextUser และ user-role ด้านล่างยังจำกัดให้เหลือภาพของเทิร์นนี้
    const scope = document.body || $(S.turnContainer) || document.documentElement;
    const cand = [];
    const seen = [];

    for (const i of $$('img', scope)) {
      if (nextUser && (nextUser.contains(i) ||
          (nextUser.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING))) continue;
      if (anchor && !(anchor.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      /**
       * ตัดเฉพาะรูปที่อยู่ใน "ข้อความของผู้ใช้" ซึ่งคือไฟล์ที่เราแนบไปเอง
       *
       * ถ้าไม่ตัด รูปผู้เขียนที่แนบไปกับคำสั่งจะถูกนับเป็นภาพที่ ChatGPT วาด
       * แล้วไปโผล่เป็นหน้าปกในเล่มจริง ซึ่งเคยเกิดมาแล้ว
       *
       * เคยเขียนข้อนี้เป็น "ห้ามอยู่ข้างใน anchor" (DOCUMENT_POSITION_CONTAINED_BY)
       * ซึ่งกว้างเกินไปและอันตราย เพราะขึ้นกับว่า anchor ที่จับได้เป็น element ชั้นไหน
       * ถ้าหน้าเว็บครอบข้อความของเรากับคำตอบไว้ในกล่องเดียวกัน ภาพที่ ChatGPT วาดมา
       * ก็จะนับเป็น "อยู่ข้างใน" ไปด้วย แล้วถูกทิ้งทั้งที่เป็นภาพที่เรารออยู่
       * เกณฑ์ที่ตรงกับเจตนาจริงคือดูว่ารูปนั้นอยู่ในข้อความฝั่งผู้ใช้หรือเปล่า ไม่เกี่ยวกับ anchor
       */
      if (i.closest('[data-message-author-role="user"]')) continue;
      /**
       * เคยเผลอเพิ่ม "ทั้งเทิร์นที่มีข้อความผู้ใช้ = ของที่เราแนบเอง" ตรงนี้ แล้วพังทันที
       *
       * หน้าเว็บครอบข้อความของเรากับคำตอบไว้ในกล่อง conversation-turn เดียวกันได้
       * ภาพที่ ChatGPT วาดจึงถูกตัดทิ้งไปด้วย — เห็นกับตา: ภาพขึ้นเต็มจอแล้ว
       * แต่บันทึกฟ้องว่า "ภาพในคำตอบ 0 รูป" แล้ววนรอจนหมดเวลา
       * เป็นกับดักตัวเดียวกับที่คอมเมนต์ข้างบนเตือนไว้ แค่เปลี่ยนจาก anchor เป็น turn
       *
       * งานแยก "รูปผู้เขียนที่เราแนบไป" ออกจาก "ภาพที่โมเดลวาด" ไม่ใช่งานของตัวสแกน DOM
       * เพราะตำแหน่งในหน้าเว็บเปลี่ยนได้ตลอดและเดาผิดแล้วเสียหายทั้งสองทาง
       * ตัวที่รู้แน่คือลายนิ้วมือของภาพ (imageAHash) ซึ่งเทียบ "ภาพเดียวกัน" ได้แม้ถูกบีบอัดใหม่
       * และทำงานอยู่ในเครื่องผลิตแล้ว — ตรงนั้นปฏิเสธได้ถูกต้องโดยไม่ต้องเดาจากตำแหน่ง
       */
      // ภาพย่อในช่องพิมพ์ยังไม่ได้ถูกส่งด้วยซ้ำ ห้ามนับเด็ดขาด — อันนี้แน่นอนไม่ใช่การเดา
      if (i.closest('form')?.contains($(S.composer))) continue;
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
          el: i, // เก็บตัว element ไว้ด้วย เผื่อ fetch ไม่ได้แล้วต้องวาดลงผ้าใบแทน
          score: (hosted ? 1 : 0) * 1000000000000 + fetchable * 100000000000 + dataUrl * 50000000000 + w * h,
        });
      }
    }

    cand.sort((a, b) => b.score - a.score);
    // src → element ตัวแรกที่เจอ ใช้ตอนต้องวาดลงผ้าใบแทนการ fetch
    const nodeBySrc = new Map();
    for (const c of cand) if (!nodeBySrc.has(c.src)) nodeBySrc.set(c.src, c.el);
    return { images: [...new Set(cand.map((x) => x.src))], seen, nodeBySrc };
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
  /**
   * วาดภาพที่เห็นอยู่บนจอลงผ้าใบแล้วอ่าน bytes ออกมา
   *
   * ใช้ตอน fetch ไม่ได้ ซึ่งเกิดจริงบ่อย: blob: URL ที่หมดอายุแล้ว, การตอบ 403 จากที่เก็บไฟล์,
   * หรือหน้าเว็บถอด src เดิมทิ้งหลังเรนเดอร์เสร็จ ทางนี้ไม่ยุ่งกับเครือข่ายเลย
   * อ่านจากพิกเซลที่เบราว์เซอร์วาดไว้แล้วตรง ๆ — ถ้าตาเห็นภาพ ทางนี้ก็ได้ภาพ
   *
   * ข้อจำกัดเดียวคือผ้าใบจะ "เปื้อน" ถ้าภาพมาจากโดเมนอื่นที่ไม่อนุญาต CORS
   * กรณีนั้น toBlob จะโยน error ซึ่งเราจับไว้แล้วไปลองทางถัดไป
   */
  async function captureFromElement(img) {
    if (!img?.complete || !img.naturalWidth) throw new Error('element_not_painted');
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    cv.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((res, rej) =>
      cv.toBlob((b) => (b ? res(b) : rej(new Error('canvas_to_blob_failed'))), 'image/png'));
    if (!blob.size) throw new Error('canvas_blob_empty');
    return blob;
  }

  /**
   * ให้ service worker ไปดึงแทน — มันมีสิทธิ์ host ของตัวเอง ไม่ติดกฎของหน้าเว็บ
   * ใช้ได้เฉพาะ URL แบบ http(s) เพราะ blob: มีความหมายเฉพาะในหน้านั้น
   */
  async function captureViaWorker(src) {
    if (!/^https?:/.test(src)) throw new Error('not_fetchable_by_worker');
    const r = await chrome.runtime.sendMessage({ type: 'sw.fetchImage', url: src });
    if (!r?.ok || !r.dataUrl) throw new Error(r?.error || 'worker_fetch_failed');
    return r.dataUrl;
  }

  async function captureImageData(sources = [], nodeBySrc = null) {
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
        /**
         * ทางหลักพลาดไม่ใช่จุดจบ — ภาพยังอยู่บนจอตรงหน้า
         *
         * "ดึง bytes ไม่ได้" คือความล้มที่แพงที่สุดของทั้งระบบ เพราะภาพถูกวาดเสร็จแล้ว
         * จ่ายโควตาไปแล้ว แล้วเราทิ้งมันเพราะเอาไฟล์ออกมาไม่ได้ทางเดียวที่ลอง
         * สองทางข้างล่างใช้กลไกคนละอย่างกับ fetch จึงรอดตอนที่ fetch ไม่รอด
         */
        const el = nodeBySrc?.get?.(src);
        if (el) {
          try {
            const blob = await captureFromElement(el);
            return { dataUrl: await blobToDataUrl(blob), src, type: blob.type || 'image/png',
              bytes: blob.size, width: el.naturalWidth, height: el.naturalHeight, via: 'canvas' };
          } catch (e2) {
            errors.push(`${String(src).slice(0, 60)} (ผ้าใบ) => ${e2?.message || e2}`);
          }
        }
        try {
          const dataUrl = await captureViaWorker(src);
          return { dataUrl, src, type: 'image/png', bytes: 0, via: 'worker' };
        } catch (e3) {
          errors.push(`${String(src).slice(0, 60)} (service worker) => ${e3?.message || e3}`);
        }
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
    /**
     * เวลาของงานสร้างภาพวัดกันเป็นนาที ไม่ใช่วินาที
     *
     * หลักฐานจากหน้าจอจริง: เทิร์นที่สำเร็จขึ้นว่า "Worked for 3m 13s" — 193 วินาที
     * ขณะที่เกณฑ์เดิมเลิกรอที่ 180 วินาที คือยอมแพ้ก่อนภาพจะมาถึงสิบกว่าวินาที
     * ทุกครั้ง เทิร์นที่กำลังจะสำเร็จจึงถูกทิ้งแล้วสั่งใหม่วนไป
     */
    { intervalMs = 2500, timeoutMs = 480000, idleGiveUpMs = 90000, startMs = 120000 } = {},
  ) {
    const t0 = Date.now();
    let lastSig = '';
    let lastChange = Date.now();
    let started = false;
    let lastCaptureErrors = [];

    /**
     * ปุ่ม Retry ของ ChatGPT นับเป็นความผิดพลาด "ของเทิร์นนี้" เท่านั้น
     *
     * เดิมมองทั้งหน้าเว็บ ซึ่งพังหนักในห้องที่เคยพลาดมาก่อน เพราะปุ่ม Retry ของเทิร์นเก่า
     * ไม่ได้หายไปไหน มันค้างอยู่ในบทสนทนาตลอด ทุกเทิร์นสร้างภาพหลังจากนั้นจึงคืนค่า
     * 'error' ตั้งแต่รอบตรวจแรกภายในเสี้ยววินาที โดยไม่เคยรอภาพเลยสักครั้ง
     * — เห็นเป็นอาการ "ยิงไปกี่รูปก็ไม่ได้ภาพ แล้วเปิดแชตใหม่ไปเรื่อย ๆ"
     * ปุ่มที่อยู่ก่อนข้อความที่เราเพิ่งส่งคือแผลเก่า ไม่ใช่ผลของคำสั่งรอบนี้
     */
    const errorAfterAnchor = () =>
      $$(S.errorRetry).some(
        (b) => !anchor || anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      ) || !!streamErrorAfter(anchor);

    while (Date.now() - t0 < timeoutMs) {
      if (hitLimit()) return { status: 'rate_limited', seen: [] };
      if (errorAfterAnchor()) return { status: 'error', seen: scanImages(before, anchor).seen };

      const scan = scanImages(before, anchor);
      if (scan.images.length) {
        const captured = await captureImageData(scan.images, scan.nodeBySrc);
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
      // A quiet image render is not a completed text reply. Only end early
      // when this reply has its final action bar and no image candidates.
      if (turn && actionBarFor(turn) && !isThinkingOnly(turn) && !stopButtonVisible() &&
          !scan.images.length && idleFor >= idleGiveUpMs) {
        return { status: 'no_image', seen: scan.seen, errors: lastCaptureErrors };
      }
      /**
       * ด่านกันค้างขั้นสุดท้าย
       *
       * ถ้าหน้าเว็บไม่ขยับเลยนานเป็นสามเท่าของเกณฑ์ปกติ ก็เลิกรอ ไม่ว่าปุ่มหยุดจะบอกว่าอะไร
       * เพราะถึงตอนนั้นปุ่มหยุดที่ยังเห็นอยู่คือปุ่มที่ค้างใน DOM ไม่ใช่หลักฐานว่ายังทำงานอยู่
       */
      if (idleFor >= idleGiveUpMs * 5) {
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

      const acceptedSetup = opts.recoverCompletedSetup && acceptedSetupStillCurrent();
      if (acceptedSetup && stopButtonVisible()) opts = {...opts, newThread:true};
      if (opts.newThread) {
        /**
         * งานภาพ: ห้องใหม่คือ "ทางออกจากสถานะค้าง" ไม่ใช่สิ่งที่ต้องรอให้หายค้างก่อน
         *
         * เดิมรอให้หน้าเว็บว่างก่อนเสมอ นานได้ถึงสี่นาที แล้วถ้ายังไม่ว่างก็ยอมแพ้ด้วย
         * previous_turn_running — ซึ่งกลับหัวกับสิ่งที่เรากำลังจะทำ เพราะการเปิดห้องใหม่
         * นั่นแหละคือสิ่งที่ปลดสถานะค้างได้ การรอจึงเป็นการนั่งดูอาการที่เรามีวิธีแก้อยู่ในมือ
         * (เห็นในบันทึกจริง: waiting_idle · "รอให้ ChatGPT ตอบเทิร์นก่อนหน้าจบ" ซ้ำไม่จบ)
         *
         * ยังให้เวลาสั้น ๆ ก่อน เผื่อเทิร์นก่อนหน้ากำลังจะจบอยู่แล้วจริง ๆ — ถ้าจบทันก็ไม่ต้อง
         * กวนหน้าเว็บให้วาดใหม่ทั้งหน้าโดยไม่จำเป็น แต่ครบเวลาแล้วเดินหน้าเปิดห้องใหม่เลย
         *
         * ปลอดภัยเพราะภาพของเทิร์นก่อนถูกไล่คว้าจนสุดทางและเขียนลงโฟลเดอร์ไปแล้ว
         * ส่วนงานข้อความยังรอเต็มเวลาเหมือนเดิม เพราะที่นั่นการรอคือการรักษาคำตอบไว้จริง ๆ
         */
        const idleBudget = opts.wantImages ? IMAGE_IDLE_GRACE_MS : (opts.imageTimeoutMs ?? 240000);
        const idle = acceptedSetup || (await waitUntilIdle(idleBudget, turnId));
        if (!idle && !opts.wantImages) {
          return {turnId,status:'error',text:'',meta:{error:'previous_turn_running'}};
        }
        if (!idle) {
          report(turnId, 'new_thread', `หน้าเว็บยังไม่ว่างใน ${IMAGE_IDLE_GRACE_MS / 1000} วินาที — เปิดห้องใหม่เลย เพราะห้องใหม่คือทางออกจากสถานะค้าง`);
        }
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
        completedSetupReply = null;
        completedImageTurn = null;
      }
      if (hitLimit()) return { turnId, status: 'rate_limited', text: '' };

      const modelBefore = currentModel();
      if (opts.expectModel && modelBefore && !modelBefore.includes(opts.expectModel)) {
        return { turnId, status: 'wrong_model', text: '', meta: { model: modelBefore } };
      }

      const imgsBefore = opts.wantImages ? snapshotImages() : new Set();

      // ต้องรอให้เทิร์นก่อนหน้าจบสนิทก่อน ไม่งั้นปุ่มส่งจะยัง disabled แล้ว Prompt จะค้างในช่องพิมพ์
      report(turnId, 'waiting_idle', 'รอให้ ChatGPT ตอบเทิร์นก่อนหน้าจบก่อนส่งงานถัดไป');
      /**
       * งานภาพเพิ่งเปิดห้องว่างมาหมาด ๆ ถ้ายังไม่ว่างตรงนี้แปลว่าหน้าเว็บค้างจริง
       * รอต่ออีกสี่นาทีไม่ได้อะไรกลับมา — ยอมแพ้เร็ว ๆ แล้วให้ชั้นบนสั่งใหม่จะดีกว่า
       * เพราะรอบใหม่ของงานภาพเปิดห้องใหม่ให้อีกครั้ง ซึ่งเป็นท่าที่ปลดสถานะค้างได้จริง
       */
      if (!(await waitUntilIdle(opts.wantImages ? IMAGE_IDLE_GRACE_MS : (opts.imageTimeoutMs ?? 240000), turnId))) {
        return { turnId, status: 'error', text: '', meta: { error: 'previous_turn_running' } };
      }

      const userMessagesBefore = snapshotUserMessages();

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
        if (attachment.attached !== opts.attachments.length || attachment.errors.length) {
          return { turnId, status: 'error', text: '', meta: {
            error: 'attachment_failed', attachment,
            detail: `แนบรูปอ้างอิงไม่สำเร็จ — ยังไม่ได้ส่งคำสั่ง: ${attachment.errors[0] || 'จำนวนรูปแนบไม่ครบ'}`,
          } };
        }
        report(
          turnId,
          'attaching',
          attachment.attached
            ? `แนบรูปอ้างอิงสำเร็จ ${attachment.attached} ไฟล์`
            : `แนบรูปอ้างอิงไม่สำเร็จ — ${attachment.errors[0] || 'ไม่ทราบสาเหตุ'}`,
        );
        await waitComposerStable(600, 8000);
      } else {
        /**
         * เทิร์นที่ไม่ได้ขอรูปแนบ ต้องส่งไปโดยไม่มีรูปติดไปด้วยจริง ๆ
         *
         * ของค้างจากเทิร์นก่อนไม่หายไปเอง และคำสั่งภาพที่ฉากไม่มีคนอยู่เลย
         * ถ้ามีรูปคนแนบไปด้วย โมเดลจะพยายามหาที่ยัดคนลงไปในภาพหรือสลับไปโหมดแก้ภาพ
         */
        const swept = await clearAttachments();
        if (swept.cleared) {
          report(turnId, 'attaching', `ล้างรูปที่ค้างในช่องพิมพ์ ${swept.cleared} ใบก่อนส่งงานนี้`);
        }
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
        composerBox = await injectText(prompt, turnId);
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
          composerBox = await injectText(prompt, turnId);
        } catch (e) {
          report(turnId, 'typing', `พิมพ์ซ้ำไม่สำเร็จ (${e?.message || e})`);
          break;
        }
      }

      report(turnId, 'sending', 'กำลังกดส่ง และรอยืนยันข้อความในบทสนทนา');
      const sendStartedAt = Date.now();
      let fresh = null, sendError = '';

      /**
       * ใช้ input ของเบราว์เซอร์กด Enter เป็นทางหลัก เหมือนผู้ใช้วาง Prompt แล้วกดส่งเอง
       *
       * injectText ด้านบนใช้ช่องทางเดียวกันพิมพ์ข้อความไว้แล้ว ตรงนี้ให้เบราว์เซอร์เลือกข้อความ
       * ตรวจซ้ำว่า draft ตรงกัน แล้วกด Enter จริงในครั้งเดียว วิธีนี้ไม่ผูกกับปุ่ม React ที่อาจถูก
       * สร้างใหม่หรือค้างเป็นวงกลมระหว่างที่เรากำลังหา element
       */
      try {
        const native = await chrome.runtime.sendMessage({type:'sw.forceSend',text:prompt,requireDraft:true});
        sendError = native?.error || '';
        if (native?.ok) {
          fresh = await waitForDom(()=>findUserReceipt(prompt,userMessagesBefore),{timeoutMs:15000});
          // Enter ถูกกดไปแล้ว ถ้ายังหาใบเสร็จไม่เจอ ผลลัพธ์ไม่แน่นอน ห้ามไปคลิกซ้ำ
          // Prompt ยังอยู่ในช่องพิมพ์ครบ = Enter ไม่ติด ไม่ต้องเดา และลองใหม่ได้ปลอดภัย
          if (!fresh && nothingWasSent(prompt)) return {turnId,status:'error',text:'',meta:{
            error:'send_action_not_accepted',
            detail:'กด Enter แล้วแต่ Prompt ยังอยู่ในช่องพิมพ์ครบและยังไม่มีการตอบ — คำสั่งไม่ได้ถูกส่ง ลองใหม่ได้',
            sendMs:Date.now()-sendStartedAt,
          }};
          if (!fresh) return {turnId,status:'error',text:'',meta:{
            error:'outcome_unknown',
            detail:'เบราว์เซอร์กด Enter แล้ว แต่ยังจับข้อความที่ส่งไม่ได้ — ไม่กดซ้ำเพื่อป้องกันงานซ้อน',
            sendMs:Date.now()-sendStartedAt,
          }};
        }
      } catch (e) {
        sendError = e?.message || String(e);
      }

      // ช่องทางเบราว์เซอร์ปฏิเสธก่อนแตะ input จึงยังใช้ปุ่มบนหน้าเป็นทางสำรองได้โดยไม่ส่งซ้ำ
      if (!fresh) {
        if (stopButtonVisible()) return {turnId,status:'error',text:'',meta:{error:'previous_turn_running'}};
        try {
          fresh = await clickSend(composerBox, 12000, prompt, turnId, userMessagesBefore);
        } catch (e) {
          sendError = e?.message || String(e);
          if (sendError === 'previous_turn_running')
            return {turnId,status:'error',text:'',meta:{error:sendError}};
          // ปุ่มส่งยัง disabled และเราไม่ได้คลิกอะไรเลย ผลลัพธ์จึงแน่นอนว่า prompt ยังไม่ถูกส่ง
          // ห้ามยุบเป็น outcome_unknown เพราะรหัสนั้นจะกัน CEO ออกจากการโหลดหน้าเพื่อกู้สถานะค้าง
          if (sendError === 'composer_busy_stuck')
            return {turnId,status:'error',text:'',meta:{
              error:sendError,
              detail:'ปุ่มส่งค้างเป็นวงกลมโดยหน้าไม่ขยับ 30 วินาที — คำสั่งยังไม่ได้ส่ง',
              sendMs:Date.now()-sendStartedAt,
            }};
        }
      }
      fresh ||= findUserReceipt(prompt, userMessagesBefore);
      if (!fresh && (stopButtonVisible() || !composerMatches(prompt))) {
        // Empty/replaced composer is ambiguous, NOT evidence that nothing was sent.
        fresh = await waitForDom(()=>findUserReceipt(prompt,userMessagesBefore),{timeoutMs:15000});
        if (!fresh) return {turnId,status:'error',text:'',meta:{
          error:'outcome_unknown', detail:'ช่องพิมพ์เปลี่ยนหรือเริ่มตอบแล้ว แต่ยังจับข้อความที่ส่งไม่ได้ — ไม่ส่งซ้ำ',
          sendMs:Date.now()-sendStartedAt,
        }};
      }
      // ทางสำรองก็เช่นกัน — ช่องพิมพ์ที่ยังเต็มคือคำตอบ ไม่ใช่คำถาม
      if (!fresh && nothingWasSent(prompt)) return {turnId,status:'error',text:'',meta:{
        error:'send_action_not_accepted',
        detail:`ส่งไม่ออกและ Prompt ยังอยู่ในช่องพิมพ์ครบ · ${sendError || 'ไม่พบข้อความใหม่'} — คำสั่งไม่ได้ถูกส่ง ลองใหม่ได้`,
        sendMs:Date.now()-sendStartedAt,
      }};
      if (!fresh) return {turnId,status:'error',text:'',meta:{
        error:'outcome_unknown',
        detail:`ยังยืนยันข้อความที่ส่งไม่ได้ · ช่องทางสำรอง: ${sendError || 'ไม่พบข้อความใหม่'} · เก็บงานไว้โดยไม่ยิงซ้ำ`,
        sendMs:Date.now()-sendStartedAt,
      }};
      // ตั้งแต่วินาทีนี้มีข้อความผู้ใช้รายการใหม่แล้ว หลักฐานของภาพเทิร์นก่อนจึงหมดหน้าที่
      completedImageTurn = null;
      report(turnId,'submitted',`ยืนยันข้อความตรงกับ Prompt แล้ว · ${((Date.now()-sendStartedAt)/1000).toFixed(1)} วินาที`);
      const submittedAt = Date.now();
      const sendMs = submittedAt - sendStartedAt;

      const anchor = fresh;
      if (opts.wantImages) {
        imageTurns.set(turnId, { anchor, url: location.href });
        if (imageTurns.size > 40) imageTurns.delete(imageTurns.keys().next().value);
      }
      const minAssistantCount = 0;

      /**
       * เทิร์นสร้างภาพใช้เส้นทางของตัวเอง ไม่ต้องผ่านตัวเดาว่า "ตอบจบหรือยัง" อีกแล้ว
       * สิ่งที่เทิร์นนี้ต้องการมีอย่างเดียวคือไฟล์ภาพ เจอแล้วก็จบงาน ไม่ต้องสนใจอย่างอื่น
       */
      if (opts.wantImages) {
        report(turnId, 'waiting', 0);
        const r = await pollForImage(turnId, anchor, imgsBefore, {
          intervalMs: opts.imagePollMs ?? 2500,
          timeoutMs: opts.imageTimeoutMs ?? 480000,
          idleGiveUpMs: opts.imageIdleMs ?? 90000,
          startMs: opts.startMs ?? 120000,
        });
        if (r.status === 'rate_limited') {
          // ข้อความที่หน้าเว็บบอก (เช่น "อีก 4 ชั่วโมงค่อยลองใหม่") คือข้อมูลเดียวที่วางแผนต่อได้
          const said = readAnswer(anchor).text;
          return { turnId, status: 'rate_limited', text: said, meta: { limit: imageQuotaNotice(said) } };
        }

        const { text: imgText, blocks: imgBlocks } = readAnswer(anchor);
        const captured = r.captured || { dataUrl: '', src: '', errors: [] };
        const images = r.images || [];

        /**
         * ไม่ได้ภาพ + คำตอบคือประกาศโควตาภาพหมด = หยุด ไม่ใช่ลองใหม่
         *
         * ต่างจากความล้มอื่นตรงที่ลองใหม่ไม่มีทางสำเร็จ หน้าเว็บบอกเวลามาแล้วว่าอีกกี่ชั่วโมง
         * ปล่อยให้วนต่อคือเผาเวลาและเทิร์นข้อความไปกับงานที่รู้อยู่แล้วว่าทำไม่ได้
         */
        const quota = captured.dataUrl ? '' : imageQuotaNotice(imgText);
        if (quota) {
          report(turnId, 'received', `ChatGPT แจ้งว่าโควตาสร้างภาพหมด — หยุดงานภาพไว้ก่อน: ${quota}`);
          return { turnId, status: 'rate_limited', text: imgText, meta: { limit: quota } };
        }
        if (captured.dataUrl) completedImageTurn = { anchor, at: Date.now(), src: captured.src || images[0] || '' };
        report(
          turnId,
          'received',
          `จบเทิร์นสร้างภาพ (${r.status}) · ${images.length} ภาพ${captured.dataUrl ? ' · ดึงไฟล์แล้ว' : ''}\n${String(imgText).slice(0, 2000)}`,
        );
        return {
          turnId,
          status: captured.dataUrl ? 'ok' : r.status === 'timeout' ? 'timeout' : 'error',
          text: imgText,
          images,
          imageDataUrl: captured.dataUrl || '',
          meta: {
            model: modelBefore,
            blocks: imgBlocks,
            ms: Date.now() - t0,
            sendMs, answerMs:Date.now()-submittedAt,
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
        expectedJsonKeys: opts.expectedJsonKeys || [],
        imageKey: () => readImages(imgsBefore, anchor).join('|'),
      });

      if (status !== 'ok') return { turnId, status, text: '', meta: {
        model: modelBefore,
        sendMs, answerMs:Date.now()-submittedAt,
        ...(['timeout','no_response'].includes(status) ? {error:'outcome_unknown', detail:'ข้อความส่งถึงบทสนทนาแล้ว แต่ยังไม่ได้คำตอบที่ยืนยันได้ จึงไม่ส่งข้อความซ้ำ'} : {}),
      } };

      const { text, blocks } = readAnswer(anchor);

      /**
       * ด่านสุดท้าย: ป้ายชั่วคราวไม่ใช่คำตอบ
       *
       * ถึงจะกันไว้ตั้งแต่ตอนรอแล้ว แต่ถ้าหน้าเว็บเปลี่ยนคำบนป้ายจนเล็ดลอดออกมาได้
       * ต้องคืนเป็น empty ให้ชั้นบนลองใหม่ ดีกว่าปล่อยข้อความอย่าง "Searching websites 4"
       * ไปให้ Studio แปลงเป็น JSON แล้วฟ้องว่า "อ่านคำตอบเป็น JSON ไม่ได้"
       */
      if (!opts.wantImages && text.trim() && PLACEHOLDER.test(text.trim())) {
        return {
          turnId,
          status: 'empty',
          text: '',
          meta: { model: currentModel(), note: `ได้แค่ป้ายชั่วคราว: ${text.trim().slice(0, 60)}` },
        };
      }
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
          sendMs, answerMs:Date.now()-submittedAt,
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
  let activeTurnId = null;
  const completedTurns = new Map();
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
        const source = msg.turnId ? imageTurns.get(msg.turnId) : null;
        if (msg.turnId && (!source || !sameConversation(source.url) || !source.anchor.isConnected)) {
          sendResponse({ ok: false, error: 'image_turn_not_available' });
          return;
        }
        const empty = { sources: new Set(), elements: new Set() };
        const scan = scanImages(empty, source?.anchor || lastUserTurn());
        if (!scan.images.length) {
          sendResponse({ ok: false, error: 'ไม่พบภาพในคำตอบล่าสุดของหน้านี้', seen: scan.seen.slice(-6) });
          return;
        }
        const captured = await captureImageData(scan.images, scan.nodeBySrc);
        if (!captured.dataUrl) {
          sendResponse({ ok: false, error: `ดึงไฟล์ภาพไม่สำเร็จ: ${captured.errors?.[0] || 'ไม่ทราบสาเหตุ'}` });
          return;
        }
        sendResponse({ ok: true, dataUrl: captured.dataUrl, width: captured.width, height: captured.height, bytes: captured.bytes });
      })();
      return true;
    }

    /**
     * เทิร์นหายไปเฉย ๆ — ถามหน้าเว็บว่าเกิดอะไรขึ้นจริง แทนการเดาจากขั้นล่าสุดที่ได้ยิน
     *
     * ข้อความความคืบหน้ากับผลลัพธ์วิ่งผ่าน chrome.runtime ซึ่งขาดได้ (service worker หลับ ·
     * แท็บถูกพักเพราะอยู่หลัง · หน้าวาดใหม่) พอขาดแล้วฝั่ง Studio จะค้างอยู่ที่ขั้นสุดท้าย
     * ที่ได้ยิน แล้วเข้าใจว่างานหยุดตรงนั้น ทั้งที่ ChatGPT ตอบจนจบไปนานแล้ว
     * (เห็นจริง: คำตอบเต็ม ๆ อยู่บนจอ แต่บันทึกบอกว่าค้างที่ "พิมพ์ Prompt ลงช่อง" 590 วินาที)
     *
     * ตัวหน้าเว็บเองรู้คำตอบทั้งสามข้อ และรู้แน่นอน ไม่ใช่การอนุมาน:
     *   done         เก็บผลไว้แล้ว — ส่งกลับไปเลย ไม่ต้องสั่งใหม่ ไม่เสียโควตาเพิ่ม
     *   running      ยังทำอยู่จริง — ห้ามส่งซ้ำเด็ดขาด
     *   not_sent     ไม่มีข้อความของเราบนหน้าเลย — ยังไม่เคยส่ง ลองใหม่ได้ปลอดภัย
     *   sent_unknown ข้อความขึ้นไปแล้วแต่ไม่มีผล — ตอบไม่ได้ว่าจบยัง ต้องระวังไว้ก่อน
     */
    if (msg?.type === 'gpt.recoverTurn') {
      const done = completedTurns.get(msg.turnId);
      if (done) {
        sendResponse({ state: 'done', result: done });
        return false;
      }
      if (activeTurnId && activeTurnId === msg.turnId) {
        sendResponse({ state: 'running' });
        return false;
      }
      let posted = false;
      try {
        posted = !!findUserReceipt(msg.prompt || '', []);
      } catch (_) {
        posted = true; // อ่านหน้าไม่ได้ = ตอบไม่ได้ ต้องถือว่าอาจส่งไปแล้ว
      }
      sendResponse({ state: posted ? 'sent_unknown' : 'not_sent' });
      return false;
    }

    if (msg?.type === 'gpt.run') {
      if (completedTurns.has(msg.turnId)) {
        sendResponse({ok:true,accepted:msg.turnId});
        chrome.runtime.sendMessage({type:'gpt.result',...completedTurns.get(msg.turnId)}).catch(()=>{});
        return false;
      }
      if (activeTurnId) {
        sendResponse(activeTurnId === msg.turnId ? {ok:true,accepted:msg.turnId} : {ok:false,error:'previous_turn_running'});
        return false;
      }
      activeTurnId = msg.turnId;
      // ตอบรับทันที แล้วส่งผลกลับทีหลังเป็น gpt.result
      sendResponse({ ok: true, accepted: msg.turnId });
      runTurn(msg.turnId, msg.prompt, msg.opts).then((res) => {
        completedTurns.set(msg.turnId,res);
        if (completedTurns.size > 10) completedTurns.delete(completedTurns.keys().next().value);
        activeTurnId = null;
        chrome.runtime.sendMessage({ type: 'gpt.result', ...res }).catch(() => {});
      });
      return false;
    }
    return false;
  });
})();
