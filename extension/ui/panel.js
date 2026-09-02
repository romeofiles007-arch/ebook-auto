import * as db from '../core/db.js';
import * as W from '../core/workspace.js';

const $ = (id) => document.getElementById(id);
let folderHandle = null;

async function showWorkspace(handle) {
  if (!handle) return;
  try {
    const merged = await W.mergeLocalProjectsToWorkspace();
    const info = await W.getWorkspaceInfo();
    const shortId = info?.id ? info.id.slice(0, 8) : 'ไม่ทราบ';
    $('folder').textContent = `${handle.name} · Workspace ${shortId} · ${merged.shared || 0} โครงการ`;
  } catch {
    $('folder').textContent = `${handle.name} · Shared Workspace`;
  }
}

async function pick() {
  if (!('showDirectoryPicker' in window)) {
    $('live').textContent = 'เบราว์เซอร์ไม่รองรับการเลือกโฟลเดอร์ จะใช้ Downloads';
    return;
  }
  try {
    folderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await W.useDirectoryHandle(folderHandle);
    await showWorkspace(folderHandle);
    $('live').textContent = `เลือก Shared Workspace ${folderHandle.name} แล้ว`;
  } catch (e) {
    if (e.name !== 'AbortError') $('live').textContent = e.message;
  }
}

async function create() {
  const title = $('title').value.trim();
  if (!title) {
    $('title').focus();
    return;
  }
  const audience = $('audience').value.trim();
  const author = $('author').value.trim();
  await Promise.all([db.setting('defaultAudience', audience), db.setting('defaultAuthor', author)]);
  if (folderHandle) await W.useDirectoryHandle(folderHandle);
  $('live').textContent = 'กำลังเปิด Studio และเริ่มงาน...';
  $('create').disabled = true;
  chrome.runtime.sendMessage(
    { type: 'ui.command', command: 'createBook', title, audience, author, contentMode: $('contentMode').value },
    () => {
      if (chrome.runtime.lastError) {
        $('live').textContent = chrome.runtime.lastError.message;
        $('create').disabled = false;
      } else {
        $('live').textContent = 'เริ่มแล้ว — ดูการทำงานใน Studio และ ChatGPT';
      }
    },
  );
}

$('pick').onclick = pick;
$('create').onclick = create;
$('random').onclick = async () => {
  const title = $('title').value.trim();
  const audience = $('audience').value.trim();
  const author = $('author').value.trim();
  await Promise.all([db.setting('defaultAudience', audience), db.setting('defaultAuthor', author)]);
  $('live').textContent = 'กำลังเปิด Studio เพื่อค้นกระแสปัจจุบัน...';
  chrome.runtime.sendMessage({ type: 'ui.command', command: 'trendRandom', title, audience, author, contentMode: $('contentMode').value });
};
$('ideas').onclick = async () => {
  const title = $('title').value.trim();
  const audience = $('audience').value.trim();
  const author = $('author').value.trim();
  await Promise.all([db.setting('defaultAudience', audience), db.setting('defaultAuthor', author)]);
  $('live').textContent = 'กำลังเปิด Studio เพื่อคิดชื่อ...';
  chrome.runtime.sendMessage({ type: 'ui.command', command: 'titleIdeas', title, audience, author, contentMode: $('contentMode').value });
};
$('studio').onclick = () => chrome.runtime.sendMessage({ type: 'sw.openStudio' });
$('chat').onclick = () => chrome.runtime.sendMessage({ type: 'sw.focusChat' });
$('title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') create();
});
chrome.runtime.onMessage.addListener((m) => {
  // ui.status มาจาก Studio และมีชื่อโหมดติดมาด้วย จึงให้ความสำคัญกว่า gpt.progress ดิบ ๆ
  if (m?.type === 'ui.status') $('live').textContent = m.message || 'กำลังทำงาน...';
  else if (m?.type === 'gpt.progress') $('live').textContent = m.message || m.phase || 'ChatGPT กำลังทำงาน...';
});

(async () => {
  try {
    const [h, audience, author] = await Promise.all([
      db.setting('exportDirectory'),
      db.setting('defaultAudience'),
      db.setting('defaultAuthor'),
    ]);
    if (h && typeof h.queryPermission === 'function' && (await h.queryPermission({ mode: 'readwrite' })) === 'granted') {
      folderHandle = h;
      await W.useDirectoryHandle(h);
      await showWorkspace(h);
    }
    if (audience) $('audience').value = audience;
    if (author) $('author').value = author;
  } catch {}
})();
