import './panel-activity.js';
const $ = (id) => document.getElementById(id);
async function openPage(buttonId, type, label) {
  const button = $(buttonId);
  button.disabled = true;
  $('live').textContent = `กำลังเปิด ${label}...`;
  try {
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) throw new Error(result?.error || `เปิด ${label} ไม่สำเร็จ`);
    $('live').textContent = `เปิด ${label} แล้ว`;
  } catch (error) {
    $('live').textContent = `เปิด ${label} ไม่สำเร็จ: ${error.message}`;
  } finally { button.disabled = false; }
}
$('studio').onclick = () => openPage('studio', 'sw.openStudio', 'Studio');
$('chat').onclick = () => openPage('chat', 'sw.focusChat', 'ChatGPT');
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'ui.status') $('live').textContent = m.message || 'กำลังทำงาน...';
});
