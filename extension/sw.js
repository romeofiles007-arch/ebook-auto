/**
 * Service worker = ตัวส่งต่อข้อความอย่างเดียว ห้ามเก็บสถานะสำคัญไว้ที่นี่
 * MV3 ฆ่า service worker เมื่อไม่มีงานราว 30 วินาที สมองจึงอยู่ที่ ui/studio.html
 * ทุกอย่างที่ต้องจำข้ามการตายของ worker เก็บใน chrome.storage.session
 */

const STUDIO_URL = chrome.runtime.getURL('ui/studio.html');
const CHAT_MATCH = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
let activityWrite = Promise.resolve();

// ---------- state ที่ทนต่อการตายของ worker ----------
const S = {
  async get(k, d = null) {
    const o = await chrome.storage.session.get(k);
    return k in o ? o[k] : d;
  },
  async set(k, v) {
    await chrome.storage.session.set({ [k]: v });
  },
};

// ---------- ไอคอน = เปิดแถบข้าง ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---------- หา/เปิดแท็บ ----------
const isChatUrl = (url = '') => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url);

async function findTab(urlPatterns) {
  const tabs = await chrome.tabs.query({ url: urlPatterns });
  return tabs.find((t) => !t.discarded) || tabs[0] || null;
}

/**
 * จำแท็บ ChatGPT ที่ผู้ใช้แตะล่าสุด เพื่อให้ Phase 2 ใช้ "บัญชีที่เพิ่งสลับไป"
 * แทนการสุ่มหยิบ ChatGPT แท็บแรกใน browser profile
 */
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isChatUrl(tab?.url)) await S.set('chatTabId', tab.id);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if ((changeInfo.status === 'complete' || changeInfo.url) && tab?.active && isChatUrl(tab?.url || changeInfo.url)) {
      await S.set('chatTabId', tabId);
    }
  } catch {}
});

async function ensureStudioTab(focus = false) {
  let tab = await findTab([STUDIO_URL + '*']);
  if (!tab) {
    tab = await chrome.tabs.create({ url: STUDIO_URL, pinned: true, active: focus });
  } else {
    // A failed navigation can retain the Studio URL without a live extension
    // document. Focusing that tab alone leaves Chrome's error page in place.
    // Do not navigate a healthy Studio: it may be generating a book.
    let needsNavigation = !!tab.discarded;
    if (!needsNavigation && tab.status === 'complete' && chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] });
      needsNavigation = contexts.length === 0;
    }
    if (needsNavigation) {
      tab = await chrome.tabs.update(tab.id, { url: STUDIO_URL, ...(focus ? { active: true } : {}) });
    } else if (focus) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (focus) await chrome.windows.update(tab.windowId, { focused: true });
  }
  await S.set('studioTabId', tab.id);
  return tab;
}

async function ensureChatTab() {
  let tab = null;

  // 1) ใช้แท็บ ChatGPT ที่ผู้ใช้แตะล่าสุดก่อน — สำคัญมากสำหรับ Phase 2 ที่ผู้ใช้สลับบัญชี
  const rememberedId = await S.get('chatTabId');
  if (rememberedId != null) {
    try {
      const remembered = await chrome.tabs.get(rememberedId);
      if (!remembered.discarded && isChatUrl(remembered.url)) tab = remembered;
    } catch {}
  }

  // 2) ถ้าแท็บเดิมหาย ให้เลือกแท็บ ChatGPT ที่ active ล่าสุดก่อน แล้วค่อย fallback ไปแท็บแรก
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: CHAT_MATCH });
    tab = tabs.find((t) => t.active && !t.discarded) ||
      tabs.filter((t) => !t.discarded).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] ||
      tabs[0] || null;
  }

  if (!tab) {
    // เปิดในหน้าต่างแยก ไม่ย่อลง เพื่อลดการถูกหน่วงของแท็บพื้นหลัง
    const win = await chrome.windows.create({
      url: 'https://chatgpt.com/',
      focused: false,
      width: 900,
      height: 900,
    });
    tab = win.tabs[0];
    await waitForComplete(tab.id);
  }
  // แท็บที่ถูกพักไว้ (discarded) หรือยังโหลดไม่จบ ยังฉีด content script ลงไปไม่ได้จริง
  // ถ้าคืนแท็บแบบนั้นออกไป เทิร์นแรกจะล้มทุกครั้งจนผู้ใช้ต้องกดปุ่มซ้ำหลายรอบ
  try {
    let fresh = await chrome.tabs.get(tab.id);
    if (fresh.discarded) {
      await chrome.tabs.reload(tab.id);
      fresh = await waitForComplete(tab.id);
    } else if (fresh.status !== 'complete') {
      fresh = await waitForComplete(tab.id);
    }
    if (fresh) tab = fresh;
  } catch (_) {
    /* โหลดไม่ทันก็ปล่อยผ่าน ชั้น adapter มีนาฬิการอของตัวเองอีกชั้น */
  }

  await S.set('chatTabId', tab.id);
  return tab;
}

function waitForComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const stop = () => {
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const ok = (tab) => {
      if (done) return;
      stop();
      resolve(tab);
    };
    const bad = (why) => {
      if (done) return;
      stop();
      reject(new Error(why));
    };
    // โหลดจบเมื่อไร Chrome บอกเมื่อนั้น ไม่ต้องคอยถามเป็นระยะ
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === 'complete') ok(tab);
    };
    const onRemoved = (id) => {
      if (id === tabId) bad('tab_gone');
    };
    const timer = setTimeout(() => bad('tab_load_timeout'), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') ok(tab); // จบไปแล้วตั้งแต่ก่อนเริ่มฟัง
      })
      .catch(() => bad('tab_gone'));
  });
}

/** ฉีด content script ซ้ำ เผื่อแท็บเปิดอยู่ก่อนติดตั้งส่วนขยาย */
async function ensureAdapter(tabId, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  const ping = async () => {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'gpt.ping' });
      return !!pong?.ok;
    } catch (_) {
      return false; /* ยังไม่มี adapter หรือหน้ายังไม่รับข้อความ */
    }
  };

  // executeScript คืนค่าหลังสคริปต์รันจบ แปลว่า listener ติดตั้งเรียบร้อยแล้ว
  // จึง ping ต่อได้ทันที ไม่ต้องหน่วงเผื่อ
  for (;;) {
    if (await ping()) return true;
    let injected = false;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['adapter/chatgpt.js'] });
      injected = true;
    } catch (_) {
      /* แท็บกำลังเปลี่ยนหน้าอยู่ ฉีดยังไม่ได้ */
    }
    if (injected && (await ping())) return true;
    if (Date.now() >= until) return false;
    // ฉีดไม่ติด = แท็บกำลังโหลด รอเหตุการณ์ "โหลดจบ" แล้วลองใหม่ทันที ไม่ใช่นับเวลาเอา
    if (!injected) {
      await waitForComplete(tabId, Math.max(0, until - Date.now())).catch(() => {});
      if (await ping()) return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100)); // กันวนรัวเมื่อฉีดได้แต่ยังไม่ตอบ
  }
}

// ---------- เส้นทางข้อความ ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'ui.activity': {
        const event = msg.event;
        if (!event?.id || sender.id !== chrome.runtime.id) return sendResponse({ ok: false });
        activityWrite = activityWrite.catch(() => {}).then(async () => {
          const snapshot = await S.get('activitySnapshot', { events: [], crew: null });
          if (event.crew) snapshot.crew = event.crew;
          if (event.message) snapshot.events = [...snapshot.events, event].slice(-200);
          snapshot.at = event.at;
          await S.set('activitySnapshot', snapshot);
        });
        await activityWrite;
        return sendResponse({ ok: true });
      }
      case 'ui.activitySnapshot': {
        await activityWrite.catch(() => {});
        return sendResponse(await S.get('activitySnapshot', { events: [], crew: null }));
      }
      // Studio ขอให้เริ่มหนึ่งเทิร์น — ไม่รอผล ผลจะกลับมาเป็น gpt.result
      case 'sw.runTurn': {
        await S.set('studioTabId', sender.tab?.id ?? (await S.get('studioTabId')));
        const chat = await ensureChatTab();
        if (msg.opts?.wantImages) {
          const sources = await S.get('imageTurnTabs', {});
          sources[msg.turnId] = chat.id;
          for (const id of Object.keys(sources).slice(0, -40)) delete sources[id];
          await S.set('imageTurnTabs', sources);
        }
        await chrome.tabs.update(chat.id, { active: true });
        if (chat.windowId != null) await chrome.windows.update(chat.windowId, { focused: true });
        const ok = await ensureAdapter(chat.id);
        if (!ok) return sendResponse({ ok: false, error: 'adapter_unavailable' });
        await chrome.tabs.sendMessage(chat.id, {
          type: 'gpt.run',
          turnId: msg.turnId,
          prompt: msg.prompt,
          opts: msg.opts || {},
        });
        return sendResponse({ ok: true });
      }

      // Content script ส่งผลกลับ → กระจายให้ extension pages
      // สำคัญ: studio.html เป็น extension page ไม่ใช่ content script
      // จึงห้ามใช้ chrome.tabs.sendMessage() กับ Studio
      case 'gpt.result':
      case 'gpt.progress': {
        chrome.runtime.sendMessage({ ...msg, _relayed: true }).catch(() => {});
        return sendResponse({ ok: true });
      }

      // Studio รายงานสถานะ → กระจายให้แถบข้าง
      case 'ui.status': {
        chrome.runtime.sendMessage({ ...msg, _relayed: true }).catch(() => {});
        return sendResponse({ ok: true });
      }

      // Side Panel สั่งงาน → กระจายให้ extension pages
      // Studio จะรับเฉพาะ command ที่ตัวเองรู้จัก
      case 'ui.command': {
        if (msg.command === 'createBook' || msg.command === 'titleIdeas' || msg.command === 'trendRandom') {
          await S.set('pendingUiCommand', msg);
          const studio = await ensureStudioTab(true);
          return sendResponse({ ok: true, tabId: studio.id });
        }
        /**
         * หยุด/ทำต่อ สั่งงานที่กำลังเดินอยู่ในหน้า Studio ที่เปิดค้างไว้เท่านั้น
         *
         * ห้ามเปิดแท็บใหม่ให้เหมือนคำสั่งข้างบน เพราะหน้าที่เพิ่งเปิดไม่มีงานเดินอยู่
         * แล้วคำสั่งจะเงียบหายไปทั้งที่ผู้ใช้เห็นว่า "สั่งแล้ว"
         * ถ้าไม่มีหน้าไหนรับ ต้องตอบกลับไปให้แผงข้างบอกผู้ใช้ได้ตรง ๆ
         */
        if (msg.command === 'stopJob' || msg.command === 'resumeJob') {
          const reply = await chrome.runtime.sendMessage({ ...msg, _relayed: true }).catch(() => null);
          return sendResponse(
            reply?.ok ? reply : { ok: false, error: 'ไม่มีหน้า Studio ที่เปิดค้างอยู่' },
          );
        }
        chrome.runtime.sendMessage({ ...msg, _relayed: true }).catch(() => {});
        return sendResponse({ ok: true });
      }

      case 'sw.openStudio': {
        const t = await ensureStudioTab(true);
        return sendResponse({ ok: true, tabId: t.id });
      }

      case 'sw.focusChat': {
        const t = await ensureChatTab();
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
        return sendResponse({ ok: true });
      }

      /**
       * ทางสุดท้ายของการส่ง Prompt — ใช้ช่องทาง input จริงของเบราว์เซอร์
       *
       * ช่องพิมพ์ของ ChatGPT เป็น ProseMirror ที่เก็บสถานะของตัวเองแยกจาก DOM
       * ทุกวิธีที่สคริปต์ในหน้าเว็บทำได้ (execCommand, เหตุการณ์สังเคราะห์, คลิปบอร์ด)
       * ล้วนมีโอกาสไม่ commit เข้าสถานะ แล้วจบที่ "ข้อความเต็มช่อง แต่ปุ่มส่งเทา"
       *
       * ช่องทางนี้ต่างออกไปโดยสิ้นเชิง: เบราว์เซอร์เป็นคนป้อนข้อความและกดปุ่มให้เอง
       * เหตุการณ์ที่ออกมาจึงเป็นของจริงทุกประการ เหมือนคนพิมพ์และกด Enter
       * แลกกับแถบเตือน "กำลังดีบัก" ที่จะโผล่ขึ้นระหว่างใช้ — จึงใช้เฉพาะตอนวิธีปกติแพ้แล้วเท่านั้น
       * และถอนตัวออกทันทีที่เสร็จ เพื่อให้แถบหายไป
       */
      case 'sw.forceSend': {
        // The content script requesting recovery owns the composer. Never
        // redirect its text to whichever ChatGPT tab was activated last.
        if (!sender.tab?.id || !isChatUrl(sender.tab.url)) {
          return sendResponse({ ok: false, error: 'invalid_composer_tab' });
        }
        const chat = sender.tab;
        const target = { tabId: chat.id };
        const text = String(msg.text || '');
        if (!text) return sendResponse({ ok: false, error: 'ไม่มีข้อความให้ส่ง' });

        const cmd = (method, params) =>
          new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(target, method, params, (r) =>
              chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r),
            );
          });

        let attached = false;
        try {
          await new Promise((resolve, reject) => {
            chrome.debugger.attach(target, '1.3', () =>
              chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(),
            );
          });
          attached = true;

          const [focused] = await chrome.scripting.executeScript({
            target,
            func: () => {
              const box = document.querySelector('#prompt-textarea');
              if (!box) return false;
              box.focus();
              return document.activeElement === box;
            },
          });
          if (!focused?.result) throw new Error('composer_not_found');
          // Select through browser input so the editor's document, not only
          // its rendered DOM, is replaced. insertText alone appends a second copy.
          await cmd('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
          });
          await cmd('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
          });
          await cmd('Input.insertText', { text });
          await new Promise((r) => setTimeout(r, 400));

          const [verified] = await chrome.scripting.executeScript({
            target,
            args: [text],
            func: (expected) => {
              const box = document.querySelector('#prompt-textarea');
              const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
              return !!box && document.activeElement === box && norm(box.innerText) === norm(expected);
            },
          });
          if (!verified?.result) throw new Error('composer_text_mismatch');

          if (msg.send !== false) {
            for (const type of ['keyDown', 'char', 'keyUp']) {
              await cmd('Input.dispatchKeyEvent', {
                type,
                key: 'Enter',
                code: 'Enter',
                text: type === 'char' ? '\r' : undefined,
                unmodifiedText: type === 'char' ? '\r' : undefined,
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13,
              });
            }
          }
          return sendResponse({ ok: true });
        } catch (e) {
          return sendResponse({ ok: false, error: String(e?.message || e) });
        } finally {
          // ต้องถอนตัวเสมอ ไม่งั้นแถบเตือนจะค้างอยู่ทั้งวัน
          if (attached) chrome.debugger.detach(target, () => void chrome.runtime.lastError);
        }
      }

      // ผู้ใช้กด "ภาพเสร็จแล้ว" ที่หน้า Studio — ไปคว้าภาพล่าสุดจากแท็บ ChatGPT มาเลย
      case 'sw.grabImage': {
        const pinnedId = msg.turnId ? (await S.get('imageTurnTabs', {}))[msg.turnId] : null;
        if (msg.turnId && pinnedId == null) {
          return sendResponse({ ok: false, error: 'image_turn_not_available' });
        }
        const chat = pinnedId != null ? await chrome.tabs.get(pinnedId) : await ensureChatTab();
        const ok = await ensureAdapter(chat.id);
        if (!ok) return sendResponse({ ok: false, error: 'ติดตั้ง content script ของ ChatGPT ไม่สำเร็จ' });
        try {
          const result = await chrome.tabs.sendMessage(chat.id, { type: 'gpt.grabImage', turnId: msg.turnId });
          return sendResponse(result || { ok: false, error: 'หน้า ChatGPT ไม่ตอบ' });
        } catch (e) {
          return sendResponse({ ok: false, error: `content script ไม่ตอบ: ${e?.message || e}` });
        }
      }

      case 'sw.healthChat': {
        const chat = await ensureChatTab();
        await chrome.tabs.update(chat.id, { active: true });
        if (chat.windowId != null) await chrome.windows.update(chat.windowId, { focused: true });
        const ok = await ensureAdapter(chat.id);
        if (!ok) return sendResponse({ ok: false, error: 'ติดตั้ง content script ของ ChatGPT ไม่สำเร็จ' });
        try {
          const result = await chrome.tabs.sendMessage(chat.id, { type: 'gpt.health' });
          return sendResponse(result || { ok: false, error: 'ChatGPT ไม่ตอบ healthcheck' });
        } catch (e) {
          return sendResponse({ ok: false, error: `content script ไม่ตอบ: ${e?.message || e}` });
        }
      }

      case 'sw.registerStudio': {
        await S.set('studioTabId', sender.tab?.id);
        await S.set('watchdog', msg.watchdog ? 1 : 0);
        const pending = await S.get('pendingUiCommand');
        if (pending) await S.set('pendingUiCommand', null);
        return sendResponse({ ok: true, pending });
      }

      case 'sw.download': {
        const id = await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          saveAs: !!msg.saveAs,
        });
        return sendResponse({ ok: true, id });
      }

      default:
        return sendResponse({ ok: false, error: 'unknown_message' });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));

  return true; // async
});

// ---------- watchdog: ถ้า Studio หายไปกลางงาน ให้เปิดคืน ----------
chrome.alarms.create('studio-watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'studio-watchdog') return;
  if (!(await S.get('watchdog'))) return;
  const id = await S.get('studioTabId');
  let alive = false;
  if (id != null) {
    try {
      const t = await chrome.tabs.get(id);
      alive = !!t && !t.discarded;
    } catch (_) {
      alive = false;
    }
  }
  if (!alive) await ensureStudioTab(false);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await S.get('studioTabId'))) await S.set('studioTabId', null);
  if (tabId === (await S.get('chatTabId'))) await S.set('chatTabId', null);
});
